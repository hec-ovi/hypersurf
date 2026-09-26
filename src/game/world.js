// The world around the track: a sky dome that follows the camera, and a
// skyline of instanced pillars whose heights follow the song's 16-band
// spectrum. Pillars are laid out along the track (a slot every 12th node,
// 9 pillars per slot in three depth bands) in a ring of slots, written only
// when a slot comes into range or the floating origin moves.

import * as THREE from 'three/webgpu';
import { skyMaterial, pillarMaterial } from './materials.js';
import { mulberry32 } from '../audio/random.js';

const NODES_PER_SLOT = 12;
const PER_SLOT = 9;
const RING = 128;
const DEPTHS = [[60, 150], [150, 400], [400, 900]];
const CLEARANCE = 30; // metres a pillar keeps from the track

export class World {
  constructor(scene, uniforms, { pillars = true } = {}) {
    this.uniforms = uniforms;
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), skyMaterial(uniforms));
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

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
    g.instanceCount = n;
    this.pillars = new THREE.Mesh(g, pillarMaterial(uniforms));
    this.pillars.frustumCulled = false;
    this.pillars.visible = pillars;
    scene.add(this.pillars);
    this.slotOf = new Int32Array(RING).fill(-1);
    this.map = null;
    this.levels = new Float32Array(16);
  }

  load(map) {
    this.map = map;
    this.slotOf.fill(-1);
    this.aSize.array.fill(0);
    this.aSize.needsUpdate = true;
    this.levels.fill(0);
  }

  setPillars(on) {
    this.pillars.visible = on;
  }

  /**
   * @param nodeIndex ship's node index; dt frame seconds; t song time
   * @param rebased   the floating origin moved: rewrite every slot
   */
  update(nodeIndex, t, dt, origin, rebased, camera) {
    this.sky.position.copy(camera.position);
    const map = this.map;
    if (!map) return;
    this._levels(t, dt);
    if (!this.pillars.visible) return;
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
      const i = r * PER_SLOT + q;
      const [near, far] = DEPTHS[q % 3];
      const side = (q + j) % 2 === 0 ? 1 : -1;
      const out = near + (far - near) * rand();
      const along = (rand() - 0.5) * 40;
      const x = px + rx * side * out + hx * along, z = pz + rz * side * out + hz * along;
      const width = 4 + rand() * (q % 3 === 0 ? 6 : 14);
      const height = (q % 3 === 0 ? 12 : 30) + rand() * (q % 3 === 0 ? 40 : 110);
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
