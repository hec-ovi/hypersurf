// Voxel helpers shared by the voxel vehicles: a palette-indexed grid, a
// mesher that turns it into one merged, indexed BufferGeometry, and a box
// writer for CPU-animated voxel strips (trails, sparkles).
//
// The mesher emits one quad per exposed face (hidden faces between filled
// cells are culled), wound counter-clockwise from outside, with flat
// normals and vertex colours that bake a fixed per-direction shade and
// classic 3-neighbour vertex ambient occlusion. Everything is unlit, so the
// look is the same under WebGPU and the WebGL2 fallback.

import * as THREE from 'three/webgpu';

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** '#RRGGBB' → linear RGB [r, g, b]. */
export function linearRGB(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [srgbToLinear(((v >> 16) & 255) / 255), srgbToLinear(((v >> 8) & 255) / 255), srgbToLinear((v & 255) / 255)];
}

/** A dense grid of palette indices (0 = empty). x across, y up, z along +z. */
export class VoxelGrid {
  constructor(nx, ny, nz) {
    this.nx = nx; this.ny = ny; this.nz = nz;
    this.data = new Uint8Array(nx * ny * nz);
  }
  inside(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.nx && y < this.ny && z < this.nz; }
  get(x, y, z) { return this.inside(x, y, z) ? this.data[x + this.nx * (y + this.ny * z)] : 0; }
  set(x, y, z, v) { if (this.inside(x, y, z)) this.data[x + this.nx * (y + this.ny * z)] = v; }
  clear() { this.data.fill(0); }
}

/**
 * Close every edge-only contact (two filled cells sharing an edge while both
 * cells completing the square are empty), which would mesh as a non-manifold
 * edge. The upper of the two cells grows sideways by one voxel of its own
 * colour (for a same-height pair, the first). Returns the voxels added.
 */
export function bridgeEdgeContacts(grid) {
  const { nx, ny, nz } = grid;
  const A = [0, 0, 0], B = [0, 0, 0], C1 = [0, 0, 0], C2 = [0, 0, 0];
  let added = 0;
  for (let pass = 0; pass < 4; pass++) {
    let changed = 0;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      if (!grid.get(x, y, z)) continue;
      A[0] = x; A[1] = y; A[2] = z;
      for (let d1 = 0; d1 < 3; d1++) for (let d2 = d1 + 1; d2 < 3; d2++) for (let s1 = -1; s1 <= 1; s1 += 2) for (let s2 = -1; s2 <= 1; s2 += 2) {
        B[0] = x; B[1] = y; B[2] = z; B[d1] += s1; B[d2] += s2;
        if (!grid.get(B[0], B[1], B[2])) continue;
        C1[0] = x; C1[1] = y; C1[2] = z; C1[d1] += s1;
        C2[0] = x; C2[1] = y; C2[2] = z; C2[d2] += s2;
        if (grid.get(C1[0], C1[1], C1[2]) || grid.get(C2[0], C2[1], C2[2])) continue;
        const C = C2[1] > C1[1] ? C2 : C1;
        const src = C[1] === B[1] && B[1] !== A[1] ? B : A;
        grid.set(C[0], C[1], C[2], grid.get(src[0], src[1], src[2]));
        changed++;
      }
    }
    added += changed;
    if (!changed) break;
  }
  return added;
}

/**
 * Brightness per face direction, as if lit from above: top full, the side
 * faces (x) nearly full so sprite art reads true, ends (z) darker, belly
 * darkest. Order: +x, -x, +y, -y, +z, -z.
 */
export const FACE_SHADE = Object.freeze([0.93, 0.93, 1.0, 0.52, 0.76, 0.76]);
/** Vertex AO by the number of occluding neighbours (0..3). */
export const AO_LEVELS = Object.freeze([1, 0.84, 0.72, 0.6]);

/**
 * Mesh a grid. `colors[i]` is the linear RGB of palette index i, or six of
 * them (one per face direction, +x -x +y -y +z -z) for a two-tone voxel,
 * e.g. an outline pixel that is black on the sprite flanks only. Cell
 * (x, y, z) spans origin + [x, x+1] · size (and so on). Returns an indexed
 * BufferGeometry with position, normal and color.
 */
export function meshVoxels(grid, colors, { size = 1, origin = [0, 0, 0], shade = FACE_SHADE, ao = AO_LEVELS } = {}) {
  const { nx, ny, nz } = grid;
  const filled = (c) => grid.get(c[0], c[1], c[2]) !== 0;
  // Count exposed faces first so every buffer is allocated once.
  let faces = 0;
  const c = [0, 0, 0], n = [0, 0, 0];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (!grid.get(x, y, z)) continue;
    for (let d = 0; d < 3; d++) for (let s = -1; s <= 1; s += 2) {
      n[0] = x; n[1] = y; n[2] = z; n[d] += s;
      if (!filled(n)) faces++;
    }
  }
  const pos = new Float32Array(faces * 12), nor = new Float32Array(faces * 12), col = new Float32Array(faces * 12);
  const idx = faces * 4 > 65535 ? new Uint32Array(faces * 6) : new Uint16Array(faces * 6);
  let f = 0;
  const q = [0, 0, 0], occ = [0, 0, 0, 0], p = [0, 0, 0];
  const CORNERS_POS = [[0, 0], [1, 0], [1, 1], [0, 1]]; // CCW seen from +axis
  const CORNERS_NEG = [[0, 0], [0, 1], [1, 1], [1, 0]]; // CCW seen from -axis
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const v = grid.get(x, y, z);
    if (!v) continue;
    const cv = colors[v], perFace = Array.isArray(cv[0]);
    c[0] = x; c[1] = y; c[2] = z;
    for (let d = 0; d < 3; d++) for (let s = -1; s <= 1; s += 2) {
      n[0] = x; n[1] = y; n[2] = z; n[d] += s;
      if (filled(n)) continue;
      const u = (d + 1) % 3, w = (d + 2) % 3;
      const corners = s > 0 ? CORNERS_POS : CORNERS_NEG;
      const dir = d * 2 + (s > 0 ? 0 : 1);
      const k = shade[dir], rgb = perFace ? cv[dir] : cv;
      for (let i = 0; i < 4; i++) {
        const a = corners[i][0], b = corners[i][1];
        // AO: the two edge neighbours and the corner neighbour in front of the face.
        q[0] = n[0]; q[1] = n[1]; q[2] = n[2];
        q[u] += a ? 1 : -1;
        const s1 = filled(q) ? 1 : 0;
        q[w] += b ? 1 : -1;
        const cc = filled(q) ? 1 : 0;
        q[u] -= a ? 1 : -1;
        const s2 = filled(q) ? 1 : 0;
        occ[i] = s1 && s2 ? 3 : s1 + s2 + cc;
        const o = (f * 4 + i) * 3;
        p[d] = c[d] + (s > 0 ? 1 : 0); p[u] = c[u] + a; p[w] = c[w] + b;
        pos[o] = origin[0] + p[0] * size; pos[o + 1] = origin[1] + p[1] * size; pos[o + 2] = origin[2] + p[2] * size;
        nor[o] = d === 0 ? s : 0; nor[o + 1] = d === 1 ? s : 0; nor[o + 2] = d === 2 ? s : 0;
        const m = k * ao[occ[i]];
        col[o] = rgb[0] * m; col[o + 1] = rgb[1] * m; col[o + 2] = rgb[2] * m;
      }
      // Split the quad along the diagonal that keeps AO gradients symmetric.
      const b0 = f * 4, t = f * 6;
      if (occ[0] + occ[2] > occ[1] + occ[3]) {
        idx[t] = b0 + 1; idx[t + 1] = b0 + 2; idx[t + 2] = b0 + 3; idx[t + 3] = b0 + 1; idx[t + 4] = b0 + 3; idx[t + 5] = b0;
      } else {
        idx[t] = b0; idx[t + 1] = b0 + 1; idx[t + 2] = b0 + 2; idx[t + 3] = b0; idx[t + 4] = b0 + 2; idx[t + 5] = b0 + 3;
      }
      f++;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/*
 * Box strips: CPU-animated hexahedra with 24 vertices each (4 per face, so
 * colours stay flat per face). A box is given by its 8 corners c[ix + 2·iy
 * + 4·iz] along three axes (a, b, c) that form a right-handed set (a × b
 * points along c); faces are then wound counter-clockwise from outside.
 */
export const BOX_FACES = [
  [1, 3, 7, 5], // +a
  [0, 4, 6, 2], // -a
  [2, 6, 7, 3], // +b
  [0, 1, 5, 4], // -b
  [4, 5, 7, 6], // +c
  [0, 2, 3, 1], // -c
];

/** Static index buffer for `count` boxes. */
export function boxIndices(count) {
  const idx = count * 24 > 65535 ? new Uint32Array(count * 36) : new Uint16Array(count * 36);
  for (let b = 0; b < count; b++) for (let f = 0; f < 6; f++) {
    const v = b * 24 + f * 4, t = b * 36 + f * 6;
    idx[t] = v; idx[t + 1] = v + 1; idx[t + 2] = v + 2; idx[t + 3] = v; idx[t + 4] = v + 2; idx[t + 5] = v + 3;
  }
  return idx;
}

/** Write one box's flat per-face colours (rgb × FACE_SHADE, a = +x, b = +y, c = +z). */
export function writeBoxColor(col, box, rgb, gain = 1, shade = FACE_SHADE) {
  for (let f = 0; f < 6; f++) {
    const k = shade[f] * gain;
    for (let i = 0; i < 4; i++) {
      const o = (box * 24 + f * 4 + i) * 3;
      col[o] = rgb[0] * k; col[o + 1] = rgb[1] * k; col[o + 2] = rgb[2] * k;
    }
  }
}

/** Write one box's positions from its 8 corners (flat array of 24 floats). */
export function writeBoxCorners(pos, box, corners) {
  for (let f = 0; f < 6; f++) {
    const face = BOX_FACES[f];
    for (let i = 0; i < 4; i++) {
      const o = (box * 24 + f * 4 + i) * 3, k = face[i] * 3;
      pos[o] = corners[k]; pos[o + 1] = corners[k + 1]; pos[o + 2] = corners[k + 2];
    }
  }
}
