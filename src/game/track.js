// The track ribbon: a ring of pooled chunk meshes built lazily from the
// SongMap nodes around the ship. Each chunk stores vertices relative to its
// own first node (computed in float64), and its mesh sits at that node minus
// the floating origin, so float32 precision holds kilometres down the track.

import * as THREE from 'three/webgpu';
import { planChunks, chunkAt } from './trackpath.js';

/**
 * Cross-section, counter-clockwise seen from behind: [lateral, height] per
 * point and a part per segment (0 surface, 1 rail, 2 underside). Segments
 * get their own vertices so each face has a flat normal.
 */
const PROFILE = [
  [-4.7, 0], [4.7, 0], [4.7, 0.45], [5.4, 0.45], [5.4, -0.6], [-5.4, -0.6], [-5.4, 0.45], [-4.7, 0.45],
];
const PARTS = [0, 1, 1, 1, 2, 1, 1, 1];
const SEGMENTS = PROFILE.length;
const RING = SEGMENTS * 2;

export const CHUNK_LENGTH = 50;
export const CHUNK_NODES = 96;

export class TrackMesh {
  constructor(scene, material, { poolSize = 18, behind = 60, ahead = 700 } = {}) {
    this.scene = scene;
    this.material = material;
    this.behind = behind;
    this.ahead = ahead;
    this.pool = [];
    const indices = buildIndices(CHUNK_NODES);
    for (let i = 0; i < poolSize; i++) {
      const g = new THREE.BufferGeometry();
      const n = CHUNK_NODES * RING;
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('aData', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
      g.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
      g.setIndex(new THREE.BufferAttribute(indices, 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
      const mesh = new THREE.Mesh(g, material);
      mesh.visible = false;
      mesh.matrixAutoUpdate = true;
      scene.add(mesh);
      this.pool.push({ mesh, chunk: -1, ox: 0, oy: 0, oz: 0 });
    }
    this.plan = null;
    this.map = null;
    this.beats = null;
    this.active = 0;
    this.builds = 0;
  }

  /** Use a new SongMap; beats is the per-node beat position (nodeBeats). */
  load(map, beats) {
    this.map = map;
    this.beats = beats;
    this.plan = planChunks(map.nodes, CHUNK_LENGTH, CHUNK_NODES);
    for (const slot of this.pool) {
      slot.chunk = -1;
      slot.mesh.visible = false;
    }
  }

  /** Keep the chunks around distance d built and placed relative to origin. */
  update(d, origin) {
    if (!this.plan) return;
    const plan = this.plan;
    const c0 = chunkAt(plan, d - this.behind);
    let c1 = chunkAt(plan, d + this.ahead);
    if (c1 - c0 + 1 > this.pool.length) c1 = c0 + this.pool.length - 1;
    // Free slots outside the range.
    for (const slot of this.pool) {
      if (slot.chunk !== -1 && (slot.chunk < c0 || slot.chunk > c1)) {
        slot.chunk = -1;
        slot.mesh.visible = false;
      }
    }
    for (let c = c0; c <= c1; c++) {
      let found = false;
      for (const slot of this.pool) if (slot.chunk === c) { found = true; break; }
      if (found) continue;
      for (const slot of this.pool) {
        if (slot.chunk !== -1) continue;
        this._build(slot, c);
        break;
      }
    }
    let active = 0;
    for (const slot of this.pool) {
      if (slot.chunk === -1) continue;
      slot.mesh.position.set(slot.ox - origin.x, slot.oy - origin.y, slot.oz - origin.z);
      active++;
    }
    this.active = active;
  }

  _build(slot, c) {
    const nd = this.map.nodes, beats = this.beats;
    const a = this.plan.starts[c], b = this.plan.starts[c + 1];
    const g = slot.mesh.geometry;
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    const Dt = g.attributes.aData.array, T = g.attributes.aTint.array;
    const ox = nd.pos[a * 3], oy = nd.pos[a * 3 + 1], oz = nd.pos[a * 3 + 2];
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let v = 0;
    for (let k = a; k <= b; k++) {
      const fx = nd.fwd[k * 3], fy = nd.fwd[k * 3 + 1], fz = nd.fwd[k * 3 + 2];
      const ux = nd.up[k * 3], uy = nd.up[k * 3 + 1], uz = nd.up[k * 3 + 2];
      const rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
      const px = nd.pos[k * 3] - ox, py = nd.pos[k * 3 + 1] - oy, pz = nd.pos[k * 3 + 2] - oz;
      const t = nd.t0 + k / nd.rate, beat = beats[k], I = nd.intensity[k];
      const cr = nd.color[k * 3], cg = nd.color[k * 3 + 1], cb = nd.color[k * 3 + 2];
      const loopMark = nd.loop[k] > 0 ? 0.25 : 0;
      for (let s = 0; s < SEGMENTS; s++) {
        const p0 = PROFILE[s], p1 = PROFILE[(s + 1) % SEGMENTS];
        const dl = p1[0] - p0[0], dh = p1[1] - p0[1], len = Math.hypot(dl, dh);
        const nl = -dh / len, nh = dl / len;
        const nx = rx * nl + ux * nh, ny = ry * nl + uy * nh, nz = rz * nl + uz * nh;
        for (let e = 0; e < 2; e++) {
          const p = e === 0 ? p0 : p1;
          const x = px + rx * p[0] + ux * p[1], y = py + ry * p[0] + uy * p[1], z = pz + rz * p[0] + uz * p[1];
          P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = z;
          N[v * 3] = nx; N[v * 3 + 1] = ny; N[v * 3 + 2] = nz;
          Dt[v * 4] = p[0]; Dt[v * 4 + 1] = PARTS[s] + loopMark; Dt[v * 4 + 2] = t; Dt[v * 4 + 3] = beat;
          T[v * 4] = cr; T[v * 4 + 1] = cg; T[v * 4 + 2] = cb; T[v * 4 + 3] = I;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
          v++;
        }
      }
    }
    for (const name of ['position', 'normal', 'aData', 'aTint']) {
      const attr = g.attributes[name];
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, v * attr.itemSize);
      attr.needsUpdate = true;
    }
    g.setDrawRange(0, (b - a) * SEGMENTS * 6);
    const sphere = g.boundingSphere;
    sphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    sphere.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
    slot.chunk = c;
    slot.ox = ox; slot.oy = oy; slot.oz = oz;
    slot.mesh.visible = true;
    this.builds++;
  }
}

/** Two triangles per segment per node pair, wound so faces point outward. */
function buildIndices(nodes) {
  const idx = new Uint16Array((nodes - 1) * SEGMENTS * 6);
  let i = 0;
  for (let k = 0; k < nodes - 1; k++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const A = k * RING + s * 2, B = A + 1, C = A + RING, D = C + 1;
      idx[i++] = A; idx[i++] = B; idx[i++] = C;
      idx[i++] = B; idx[i++] = D; idx[i++] = C;
    }
  }
  return idx;
}
