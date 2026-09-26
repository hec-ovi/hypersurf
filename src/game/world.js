// The world around the track (docs/research.md §4, all instanced):
//   sky      a dome that follows the camera: black to a violet horizon
//            band, with a starfield drifting by ∫ I dt
//   skyline  1,152 pillars (384 on the low tier) whose heights follow the
//            song's 16-band spectrum, laid out along the track: a slot
//            every 12th node, 9 pillars per slot in three depth bands, in
//            a ring of slots written only when a slot comes into range or
//            the floating origin moves
//   rings    hoops around the track at its most intense nodes (top 18%),
//            flashing on the beat
//   debris   4k air particles (1k on the low tier) in a wrap-around volume
//            around the camera; they streak with speed and flash on hits

import * as THREE from 'three/webgpu';
import { uniform, uniformArray } from 'three/tsl';
import { skyMaterial, pillarMaterial, ringMaterial, debrisMaterial } from './materials.js';
import { gradientAt } from './palette.js';
import { mulberry32 } from '../audio/random.js';
import { ringNodes } from './trackpath.js';

const NODES_PER_SLOT = 12;
const PER_SLOT = 9;
const RING = 128;
const DEPTHS = [[60, 150], [150, 400], [400, 900]];
const CLEARANCE = 30; // metres a pillar keeps from the track

const RING_CAP = 64;
const RING_INNER = 10.5;
const RING_WIDTH = 0.45;
const RING_LIFT = 2.2; // ring centre above the track surface

const DEBRIS_MAX = 4096;
const DEBRIS_VOLUME = 110; // metres per side of the wrap-around cube

export class World {
  constructor(scene, uniforms, { pillars = 1152, debris = DEBRIS_MAX } = {}) {
    this.uniforms = uniforms;
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), skyMaterial(uniforms));
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    // --- skyline ---
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const g = new THREE.InstancedBufferGeometry();
    g.index = box.index;
    g.setAttribute('position', box.attributes.position);
    g.setAttribute('normal', box.attributes.normal);
    const n = RING * PER_SLOT;
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    g.setAttribute('aPos', this.aPos);
    g.setAttribute('aSize', this.aSize);
    g.instanceCount = Math.min(n, pillars);
    const rgb = [0, 0, 0];
    const bandColours = [];
    for (let b = 0; b < 16; b++) {
      gradientAt(b / 15, rgb);
      bandColours.push(new THREE.Color(rgb[0], rgb[1], rgb[2]));
    }
    this.pillars = new THREE.Mesh(g, pillarMaterial(uniforms, uniformArray(bandColours, 'color')));
    this.pillars.frustumCulled = false;
    scene.add(this.pillars);
    this.slotOf = new Int32Array(RING).fill(-1);
    this.levels = new Float32Array(16);

    // --- rings ---
    const ringGeo = new THREE.RingGeometry(RING_INNER, RING_INNER + RING_WIDTH, 72, 1);
    this.rings = new THREE.InstancedMesh(ringGeo, ringMaterial(uniforms, RING_INNER, RING_WIDTH), RING_CAP);
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ringInst = new THREE.InstancedBufferAttribute(new Float32Array(RING_CAP * 4), 4);
    this.ringInst.setUsage(THREE.DynamicDrawUsage);
    ringGeo.setAttribute('aInst', this.ringInst);
    this.rings.frustumCulled = false;
    this.rings.count = 0;
    scene.add(this.rings);
    this.ringNodes = new Int32Array(0);

    // --- debris ---
    const quad = new THREE.PlaneGeometry(1, 1);
    const dg = new THREE.InstancedBufferGeometry();
    dg.index = quad.index;
    dg.setAttribute('position', quad.attributes.position);
    const seeds = new Float32Array(DEBRIS_MAX * 4);
    const rand = mulberry32(0xdeb415);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
    dg.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    dg.instanceCount = Math.min(DEBRIS_MAX, debris);
    this.debrisOffset = uniform(new THREE.Vector3());
    this.debris = new THREE.Mesh(dg, debrisMaterial(uniforms, this.debrisOffset, DEBRIS_VOLUME));
    this.debris.frustumCulled = false;
    this.debris.renderOrder = 2;
    scene.add(this.debris);

    this.map = null;
  }

  load(map) {
    this.map = map;
    this.slotOf.fill(-1);
    this.aSize.array.fill(0);
    this.aSize.needsUpdate = true;
    this.levels.fill(0);
    this.ringNodes = ringNodes(map.nodes);
    this.rings.count = 0;
  }

  /** Instance budgets for a quality tier. */
  setBudget({ pillars, debris }) {
    this.pillars.geometry.instanceCount = Math.min(RING * PER_SLOT, pillars);
    this.debris.geometry.instanceCount = Math.min(DEBRIS_MAX, debris);
  }

  /**
   * @param nodeIndex ship's node index; t song time; tAhead song time at the
   *                  draw distance; dt frame seconds
   * @param rebased   the floating origin moved: rewrite every slot
   */
  update(nodeIndex, t, tAhead, dt, origin, rebased, camera) {
    this.sky.position.copy(camera.position);
    // Debris volume offset: the camera's world position mod V, in float64,
    // so particles stay put in the world across floating-origin re-bases.
    const V = DEBRIS_VOLUME;
    const wx = (camera.position.x + origin.x) / V, wy = (camera.position.y + origin.y) / V, wz = (camera.position.z + origin.z) / V;
    this.debrisOffset.value.set(wx - Math.floor(wx), wy - Math.floor(wy), wz - Math.floor(wz));
    const map = this.map;
    if (!map) return;
    this._levels(t, dt);
    this._rings(t, tAhead, origin);
    const nodes = map.nodes;
    const slots = Math.floor((nodes.count - 1) / NODES_PER_SLOT);
    const j0 = Math.max(0, Math.floor(nodeIndex / NODES_PER_SLOT) - 2);
    const j1 = Math.min(slots, j0 + RING - 1);
    let wrote = false;
    for (let j = j0; j <= j1; j++) {
      const r = j % RING;
      if (this.slotOf[r] === j && !rebased) continue;
      this._writeSlot(j, r, origin);
      this.slotOf[r] = j;
      wrote = true;
    }
    if (wrote) {
      this.aPos.needsUpdate = true;
      this.aSize.needsUpdate = true;
    }
  }

  /** Band levels at song time t, gated and smoothed (fast attack, slower release). */
  _levels(t, dt) {
    const sky = this.map.skyline, bands = sky.bands;
    const f = Math.min(Math.floor(sky.data.length / bands) - 1, Math.max(0, Math.round(t * sky.rate)));
    const arr = this.uniforms.bands.array;
    const up = 1 - Math.exp(-dt / 0.04), down = 1 - Math.exp(-dt / 0.25);
    for (let b = 0; b < 16; b++) {
      const raw = t < 0 ? 0 : sky.data[f * bands + (b % bands)] / 255;
      const target = Math.pow(Math.max(0, (raw - 0.4) / 0.6), 1.5);
      const cur = this.levels[b];
      this.levels[b] = cur + (target - cur) * (target > cur ? up : down);
      arr[b] = this.levels[b];
    }
  }

  /** Rings between just behind the ship and the draw distance. */
  _rings(t, tAhead, origin) {
    const nd = this.map.nodes, list = this.ringNodes, m = this.rings.instanceMatrix.array, inst = this.ringInst.array;
    // First ring at or after t − 0.3 s (binary search; no state to reset on seeks).
    const k0 = Math.floor((t - 0.3 - nd.t0) * nd.rate);
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < k0) lo = mid + 1; else hi = mid; }
    let n = 0;
    for (let i = lo; i < list.length && n < RING_CAP; i++) {
      const k = list[i], tk = nd.t0 + k / nd.rate;
      if (tk > tAhead) break;
      const fx = nd.fwd[k * 3], fy = nd.fwd[k * 3 + 1], fz = nd.fwd[k * 3 + 2];
      const ux = nd.up[k * 3], uy = nd.up[k * 3 + 1], uz = nd.up[k * 3 + 2];
      const rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
      const o = n * 16;
      m[o] = rx; m[o + 1] = ry; m[o + 2] = rz; m[o + 3] = 0;
      m[o + 4] = ux; m[o + 5] = uy; m[o + 6] = uz; m[o + 7] = 0;
      m[o + 8] = -fx; m[o + 9] = -fy; m[o + 10] = -fz; m[o + 11] = 0;
      m[o + 12] = nd.pos[k * 3] + ux * RING_LIFT - origin.x;
      m[o + 13] = nd.pos[k * 3 + 1] + uy * RING_LIFT - origin.y;
      m[o + 14] = nd.pos[k * 3 + 2] + uz * RING_LIFT - origin.z;
      m[o + 15] = 1;
      // Fade in over the last second before the draw distance.
      const fade = Math.min(1, (tAhead - tk) / 1.0);
      inst[n * 4] = nd.color[k * 3] * 1.3;
      inst[n * 4 + 1] = nd.color[k * 3 + 1] * 1.3;
      inst[n * 4 + 2] = nd.color[k * 3 + 2] * 1.3;
      inst[n * 4 + 3] = fade;
      n++;
    }
    this.rings.count = n;
    if (n === 0) return;
    const im = this.rings.instanceMatrix;
    im.clearUpdateRanges();
    im.addUpdateRange(0, n * 16);
    im.needsUpdate = true;
    this.ringInst.clearUpdateRanges();
    this.ringInst.addUpdateRange(0, n * 4);
    this.ringInst.needsUpdate = true;
  }

  _writeSlot(j, r, origin) {
    const nd = this.map.nodes, k = j * NODES_PER_SLOT;
    const P = this.aPos.array, S = this.aSize.array;
    const rand = mulberry32(0x5eed + j * 7919);
    const px = nd.pos[k * 3], py = nd.pos[k * 3 + 1], pz = nd.pos[k * 3 + 2];
    // Horizontal right and forward of the node.
    const fx = nd.fwd[k * 3], fz = nd.fwd[k * 3 + 2];
    const fl = Math.hypot(fx, fz) || 1;
    const hx = fx / fl, hz = fz / fl, rx = -hz, rz = hx;
    for (let q = 0; q < PER_SLOT; q++) {
      // Instances are ordered depth-band-major (q · RING + r), so a tier that
      // draws only the first RING · 3 still has pillars in every band.
      const i = q * RING + r;
      const [near, far] = DEPTHS[q % 3];
      const side = (q + j) % 2 === 0 ? 1 : -1;
      const out = near + (far - near) * rand();
      const along = (rand() - 0.5) * 40;
      const x = px + rx * side * out + hx * along, z = pz + rz * side * out + hz * along;
      const width = 3 + rand() * (q % 3 === 0 ? 4 : 11);
      const height = (q % 3 === 0 ? 10 : 26) + rand() * (q % 3 === 0 ? 30 : 100);
      const below = 260 + rand() * 60;
      const y = py - 18 - rand() * 30;
      const band = (j * 7 + q * 5) % 16;
      const clear = this._clearOfTrack(x, z, k, width);
      P[i * 4] = x - origin.x; P[i * 4 + 1] = y - origin.y; P[i * 4 + 2] = z - origin.z; P[i * 4 + 3] = band;
      S[i * 4] = clear ? width : 0; S[i * 4 + 1] = clear ? height : 0; S[i * 4 + 2] = clear ? below : 0; S[i * 4 + 3] = rand();
    }
  }

  /** Whether (x, z) keeps its distance from the track around node k (winding tracks come back). */
  _clearOfTrack(x, z, k, width) {
    const nd = this.map.nodes, n = nd.count;
    const lim = CLEARANCE + width;
    for (let m = Math.max(0, k - 900); m < Math.min(n, k + 900); m += 6) {
      const dx = nd.pos[m * 3] - x, dz = nd.pos[m * 3 + 2] - z;
      if (dx * dx + dz * dz < lim * lim) return false;
    }
    return true;
  }
}
