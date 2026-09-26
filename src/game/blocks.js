// Everything placed on the track, instanced: colour blocks, hazards (greys
// and Ninja spikes), power blocks, chain-span strips and hit shards. The
// visible window is rebuilt every frame from the SongMap and the rules'
// block states, with all matrices written relative to the floating origin.
// Nothing here allocates per frame.

import * as THREE from 'three/webgpu';
import { BLOCK } from '../audio/songmap.js';
import { LANE_WIDTH } from './rules.js';
import { gradientAt } from './palette.js';
import { makeSample } from './trackpath.js';
import { markRange } from './buffers.js';
import { blockMaterial, hazardMaterial, powerMaterial, tintMaterial } from './materials.js';

const TAKEN = 1;
const BLOCK_HALF = [0.85, 0.42, 0.85];
const CAPS = { colour: 512, hazard: 256, power: 16, span: 1536, shard: 256 };
const SHARDS_PER_HIT = 12;
const SHARD_LIFE = 0.25;
const SPAN_STEP = 1 / 30;

function instanced(geometry, material, cap, name) {
  const mesh = new THREE.InstancedMesh(geometry, material, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const inst = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  inst.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aInst', inst);
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.name = name;
  return mesh;
}

/** A stellated icosahedron: a spiky hazard shape that reads by silhouette, not hue. */
function spikeGeometry() {
  const base = new THREE.IcosahedronGeometry(0.55, 0); // polyhedra are already non-indexed
  const p = base.attributes.position.array;
  const out = [];
  for (let f = 0; f < p.length; f += 9) {
    const a = [p[f], p[f + 1], p[f + 2]], b = [p[f + 3], p[f + 4], p[f + 5]], c = [p[f + 6], p[f + 7], p[f + 8]];
    const m = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const l = Math.hypot(...m), apex = m.map((v) => (v / l) * 1.05);
    out.push(...a, ...b, ...apex, ...b, ...c, ...apex, ...c, ...a, ...apex);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}

export class BlockField {
  constructor(scene) {
    this.colour = instanced(new THREE.BoxGeometry(BLOCK_HALF[0] * 2, BLOCK_HALF[1] * 2, BLOCK_HALF[2] * 2), blockMaterial(BLOCK_HALF), CAPS.colour, 'blocks');
    this.hazard = instanced(spikeGeometry(), hazardMaterial(), CAPS.hazard, 'hazards');
    this.power = instanced(new THREE.OctahedronGeometry(1.1, 0), powerMaterial(), CAPS.power, 'power');
    this.span = instanced(new THREE.BoxGeometry(0.7, 0.06, 1), tintMaterial(), CAPS.span, 'spans');
    this.shard = instanced(new THREE.TetrahedronGeometry(0.28, 0), tintMaterial(), CAPS.shard, 'shards');
    for (const m of [this.span, this.colour, this.hazard, this.power, this.shard]) scene.add(m);

    this.map = null;
    this.path = null;
    this.tint = null; // per-block HDR tint (r, g, b)
    this.s = makeSample();
    this.s2 = makeSample();
    this._rgb = [0, 0, 0];
    this.first = 0;
    // Shards: position (float64, world), velocity, birth, colour.
    this.shards = { n: 0, pos: new Float64Array(CAPS.shard * 3), vel: new Float32Array(CAPS.shard * 3), rot: new Float32Array(CAPS.shard * 3), born: new Float64Array(CAPS.shard), rgb: new Float32Array(CAPS.shard * 3) };
    this.visible = 0;
  }

  /** Use a SongMap and its TrackPath; precompute block tints. */
  load(map, path) {
    this.map = map;
    this.path = path;
    const b = map.blocks, n = b.count;
    this.tint = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      path.sample(b.time[i], this.s);
      gradientAt(this.s.intensity, this._rgb);
      const k = 2.5 + 1.5 * b.strength[i];
      this.tint[i * 3] = this._rgb[0] * k;
      this.tint[i * 3 + 1] = this._rgb[1] * k;
      this.tint[i * 3 + 2] = this._rgb[2] * k;
    }
    this.first = 0;
    this.shards.n = 0;
  }

  reset() {
    this.first = 0;
    this.shards.n = 0;
  }

  /**
   * Rebuild the visible instances for song time t.
   * @param state   rules block states (0 pending, 1 taken, 2 missed)
   * @param tAhead  song time at the draw distance
   * @param wallTime seconds, for animation only
   */
  update(t, tAhead, state, origin, wallTime) {
    const map = this.map;
    if (!map) return;
    const b = map.blocks, s = this.s;
    while (this.first < b.count && b.time[this.first] < t - 1) this.first++;
    let nc = 0, nh = 0, np = 0, ns = 0;
    const cm = this.colour.instanceMatrix.array, ci = this.colour.geometry.attributes.aInst.array;
    const hm = this.hazard.instanceMatrix.array, hi = this.hazard.geometry.attributes.aInst.array;
    const pm = this.power.instanceMatrix.array;
    const sm = this.span.instanceMatrix.array, si = this.span.geometry.attributes.aInst.array;
    for (let i = this.first; i < b.count && b.time[i] <= tAhead; i++) {
      const type = b.type[i], taken = state[i] === TAKEN;
      const tb = b.time[i], lane = b.lane[i];
      // Chain span strip under the block, drawn even when the block was taken.
      if (b.spanEnd[i] > tb && type !== BLOCK.POWER) ns = this._span(i, Math.max(tb, t - 0.3), Math.min(b.spanEnd[i], tAhead), lane, sm, si, ns, origin);
      if (taken) continue;
      // Gone 50 ms after passing the ship: the chase camera, 5-7 m back,
      // flies through that spot 0.1-0.25 s later, and a missed block there
      // filled the lower frame.
      if (tb < t - 0.05) continue;
      this.path.sample(tb, s);
      const lx = lane * LANE_WIDTH;
      if (type === BLOCK.POWER) {
        if (np >= CAPS.power) continue;
        const spin = wallTime * 2.2;
        writeMatrix(pm, np, s, lx, 1.3, origin, 1, spin);
        np++;
      } else if (type === BLOCK.GREY) {
        if (nh >= CAPS.hazard) continue;
        writeMatrix(hm, nh, s, lx, 0.75, origin, 1, wallTime * 1.3 + i);
        hi[nh * 4 + 3] = 0;
        nh++;
      } else {
        if (nc >= CAPS.colour) continue;
        writeMatrix(cm, nc, s, lx, 0.62, origin, 1, 0);
        ci[nc * 4] = this.tint[i * 3]; ci[nc * 4 + 1] = this.tint[i * 3 + 1]; ci[nc * 4 + 2] = this.tint[i * 3 + 2];
        // Missed blocks dim as they pass.
        ci[nc * 4 + 3] = 0;
        if (state[i] === 2) { ci[nc * 4] *= 0.25; ci[nc * 4 + 1] *= 0.25; ci[nc * 4 + 2] *= 0.25; }
        nc++;
      }
    }
    commit(this.colour, nc, true);
    commit(this.hazard, nh, true);
    commit(this.power, np, false);
    commit(this.span, ns, true);
    this.visible = nc + nh + np;
    this._updateShards(wallTime, origin);
  }

  _span(i, ta, tb, lane, m, inst, n, origin) {
    if (tb <= ta) return n;
    const a = this.s2, c = this.s;
    const lx = lane * LANE_WIDTH;
    const r = this.tint[i * 3] * 0.35, g = this.tint[i * 3 + 1] * 0.35, bl = this.tint[i * 3 + 2] * 0.35;
    this.path.sample(ta, a);
    for (let t0 = ta; t0 < tb && n < CAPS.span; t0 += SPAN_STEP) {
      const t1 = Math.min(tb, t0 + SPAN_STEP);
      this.path.sample(t1, c);
      // Midpoint frame, stretched to the segment length.
      const ax = a.px + a.rx * lx + a.ux * 0.05, ay = a.py + a.ry * lx + a.uy * 0.05, az = a.pz + a.rz * lx + a.uz * 0.05;
      const bx = c.px + c.rx * lx + c.ux * 0.05, by = c.py + c.ry * lx + c.uy * 0.05, bz = c.pz + c.rz * lx + c.uz * 0.05;
      const len = Math.hypot(bx - ax, by - ay, bz - az) + 0.05;
      const o = n * 16;
      m[o] = a.rx; m[o + 1] = a.ry; m[o + 2] = a.rz; m[o + 3] = 0;
      m[o + 4] = a.ux; m[o + 5] = a.uy; m[o + 6] = a.uz; m[o + 7] = 0;
      m[o + 8] = -a.fx * len; m[o + 9] = -a.fy * len; m[o + 10] = -a.fz * len; m[o + 11] = 0;
      m[o + 12] = (ax + bx) / 2 - origin.x; m[o + 13] = (ay + by) / 2 - origin.y; m[o + 14] = (az + bz) / 2 - origin.z; m[o + 15] = 1;
      inst[n * 4] = r; inst[n * 4 + 1] = g; inst[n * 4 + 2] = bl; inst[n * 4 + 3] = 1;
      n++;
      // Advance: the end sample becomes the next start.
      a.px = c.px; a.py = c.py; a.pz = c.pz; a.rx = c.rx; a.ry = c.ry; a.rz = c.rz;
      a.ux = c.ux; a.uy = c.uy; a.uz = c.uz; a.fx = c.fx; a.fy = c.fy; a.fz = c.fz;
    }
    return n;
  }

  /** Burst of shards where block i was hit (ship frame from `ship`). */
  shatter(i, ship, wallTime) {
    const sh = this.shards, b = this.map.blocks;
    const grey = b.type[i] === BLOCK.GREY, power = b.type[i] === BLOCK.POWER;
    const k = power ? 6 : grey ? 0.9 : 1;
    const r = grey ? 1.1 : this.tint[i * 3] * k, g = grey ? 1.15 : this.tint[i * 3 + 1] * k, bl = grey ? 1.2 : this.tint[i * 3 + 2] * k;
    const lx = b.lane[i] * LANE_WIDTH;
    for (let j = 0; j < SHARDS_PER_HIT; j++) {
      let n = sh.n;
      if (n >= CAPS.shard) { n = (j * 17 + Math.floor(wallTime * 1000)) % CAPS.shard; } else sh.n++;
      const a = (j / SHARDS_PER_HIT) * Math.PI * 2, up = 4 + 5 * pseudo(j * 3.1 + wallTime), side = 7 * Math.cos(a), fwd = 6 * Math.sin(a) + ship.speed;
      sh.pos[n * 3] = ship.px + ship.rx * lx + ship.ux * 0.6;
      sh.pos[n * 3 + 1] = ship.py + ship.ry * lx + ship.uy * 0.6;
      sh.pos[n * 3 + 2] = ship.pz + ship.rz * lx + ship.uz * 0.6;
      sh.vel[n * 3] = ship.rx * side + ship.ux * up + ship.fx * fwd;
      sh.vel[n * 3 + 1] = ship.ry * side + ship.uy * up + ship.fy * fwd;
      sh.vel[n * 3 + 2] = ship.rz * side + ship.uz * up + ship.fz * fwd;
      sh.rot[n * 3] = pseudo(j + 0.5) * 20; sh.rot[n * 3 + 1] = pseudo(j + 1.5) * 20; sh.rot[n * 3 + 2] = pseudo(j + 2.5) * 20;
      sh.born[n] = wallTime;
      sh.rgb[n * 3] = r; sh.rgb[n * 3 + 1] = g; sh.rgb[n * 3 + 2] = bl;
    }
  }

  _updateShards(now, origin) {
    const sh = this.shards, m = this.shard.instanceMatrix.array, inst = this.shard.geometry.attributes.aInst.array;
    let w = 0;
    for (let i = 0; i < sh.n; i++) {
      const age = now - sh.born[i];
      if (age > SHARD_LIFE || age < 0) continue;
      if (w !== i) {
        for (let c = 0; c < 3; c++) {
          sh.pos[w * 3 + c] = sh.pos[i * 3 + c]; sh.vel[w * 3 + c] = sh.vel[i * 3 + c];
          sh.rot[w * 3 + c] = sh.rot[i * 3 + c]; sh.rgb[w * 3 + c] = sh.rgb[i * 3 + c];
        }
        sh.born[w] = sh.born[i];
      }
      const life = 1 - age / SHARD_LIFE;
      const sc = 0.4 + 0.6 * life;
      const ax = sh.rot[w * 3] * age, ay = sh.rot[w * 3 + 1] * age;
      const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
      const o = w * 16;
      // Rotation Ry · Rx, scaled.
      m[o] = cy * sc; m[o + 1] = 0; m[o + 2] = -sy * sc; m[o + 3] = 0;
      m[o + 4] = sy * sx * sc; m[o + 5] = cx * sc; m[o + 6] = cy * sx * sc; m[o + 7] = 0;
      m[o + 8] = sy * cx * sc; m[o + 9] = -sx * sc; m[o + 10] = cy * cx * sc; m[o + 11] = 0;
      m[o + 12] = sh.pos[w * 3] + sh.vel[w * 3] * age - origin.x;
      m[o + 13] = sh.pos[w * 3 + 1] + sh.vel[w * 3 + 1] * age - origin.y;
      m[o + 14] = sh.pos[w * 3 + 2] + sh.vel[w * 3 + 2] * age - origin.z;
      m[o + 15] = 1;
      inst[w * 4] = sh.rgb[w * 3]; inst[w * 4 + 1] = sh.rgb[w * 3 + 1]; inst[w * 4 + 2] = sh.rgb[w * 3 + 2]; inst[w * 4 + 3] = life;
      w++;
    }
    sh.n = w;
    commit(this.shard, w, true);
  }
}

/** Instance matrix from a track sample: basis (right, up, back), lane offset, height, optional spin about up. */
function writeMatrix(m, n, s, lx, height, origin, scale, spin) {
  const o = n * 16;
  let rx = s.rx, ry = s.ry, rz = s.rz, bx = -s.fx, by = -s.fy, bz = -s.fz;
  if (spin !== 0) {
    const c = Math.cos(spin), sn = Math.sin(spin);
    const nrx = rx * c - bx * sn, nry = ry * c - by * sn, nrz = rz * c - bz * sn;
    const nbx = rx * sn + bx * c, nby = ry * sn + by * c, nbz = rz * sn + bz * c;
    rx = nrx; ry = nry; rz = nrz; bx = nbx; by = nby; bz = nbz;
  }
  m[o] = rx * scale; m[o + 1] = ry * scale; m[o + 2] = rz * scale; m[o + 3] = 0;
  m[o + 4] = s.ux * scale; m[o + 5] = s.uy * scale; m[o + 6] = s.uz * scale; m[o + 7] = 0;
  m[o + 8] = bx * scale; m[o + 9] = by * scale; m[o + 10] = bz * scale; m[o + 11] = 0;
  m[o + 12] = s.px + s.rx * lx + s.ux * height - origin.x;
  m[o + 13] = s.py + s.ry * lx + s.uy * height - origin.y;
  m[o + 14] = s.pz + s.rz * lx + s.uz * height - origin.z;
  m[o + 15] = 1;
}

function commit(mesh, count, withInst) {
  mesh.count = count;
  if (count === 0) return;
  markRange(mesh.instanceMatrix, count);
  if (withInst) markRange(mesh.geometry.attributes.aInst, count);
}

/** Cheap deterministic pseudo-random in [0, 1). */
function pseudo(x) {
  const v = Math.sin(x * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}
