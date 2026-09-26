// The skyline's layout, pure so the rule that keeps it out of the player's
// view is testable in Node. world.js owns the GPU side (instanced boxes
// whose heights follow the song's spectrum); this module decides where
// the boxes stand and writes their instance data.
//
//   slots     a slot every 12th node, 9 pillars per slot in three depth
//             bands (60-150, 150-400, 400-900 m out), alternating sides;
//             a ring of 128 slots covers the track from just behind the
//             ship onward. Every pillar is seeded by its slot, so the same
//             track always gets the same skyline.
//   corridor  a pillar stands only outside the view corridor: for every
//             camera position on the track from the ship on, the fan of
//             sight lines from it to the track ahead out to the draw
//             distance (the road, its rails and the space above them),
//             widened by CLEARANCE. Pillars are treated as endless columns,
//             so the rule is a 2D one on the ground plane and holds on
//             curves, climbs, drops and loops alike. A bend's inside is
//             where a pillar "beside" the track would stand in front of
//             the road further on.
//   window    ring entries whose slot left the window (behind the ship, or
//             past the end of a track shorter than the ring, which a live
//             track always is) are hidden, never left standing: their
//             positions are relative to the floating origin, and a re-base
//             would carry them onto the track ahead.
//   live      a live track grows and rewrites its provisional tail, so a
//             pillar that was clear may not stay clear: written slots are
//             re-checked round-robin, a few per frame.
//
// World positions are kept in float64 and written relative to the origin,
// so a re-base only re-translates; it never re-runs the corridor check.

export const NODES_PER_SLOT = 12;
export const PER_SLOT = 9;
export const RING = 128;
export const CLEARANCE = 30; // metres a pillar keeps from any sight line to the track
export const VIEW_REACH = 700; // metres of track ahead a camera sees: the draw distance (650) and a margin
const DEPTHS = [[60, 150], [150, 400], [400, 900]];
const STRIDE = 8; // nodes between the sampled cameras and sight-line ends (7-23 m)
const AHEAD_SPAN = 2400; // metres past its slot a camera could still look back across a pillar
const MAX_WRITES = 16; // new slots written per frame at most, nearest first (a fresh ring fills over 8 frames)
const LIVE_RECHECKS = 2; // live: written slots re-checked per frame

/**
 * Whether a pillar footprint (centre x, z; radius) stands clear of the view
 * corridor of the track in `nodes` for cameras from node `from` on.
 * `k` is the pillar's slot node (it bounds how far ahead cameras can matter).
 */
export function clearOfView(nodes, x, z, radius, k, from = 0) {
  const n = nodes.count, P = nodes.pos, D = nodes.dist;
  if (n < 2) return true;
  const lim = CLEARANCE + radius, lim2 = lim * lim;
  const reach = VIEW_REACH + lim, reach2 = reach * reach;
  const dEnd = D[Math.min(k, n - 1)] + AHEAD_SPAN;
  const last = n - 1;
  for (let a = Math.max(0, Math.min(from, last)); a <= last; a = a === last ? last + 1 : Math.min(a + STRIDE, last)) {
    if (D[a] > dEnd) break;
    const ax = P[a * 3], az = P[a * 3 + 2];
    const px = x - ax, pz = z - az, p2 = px * px + pz * pz;
    if (p2 < lim2) return false;
    if (p2 > reach2) continue;
    // A sight line from a can only come near P if it is at least this long.
    const need = Math.sqrt(p2) - lim, da = D[a];
    for (let b = a; b < last;) {
      b = Math.min(b + STRIDE, last);
      const along = D[b] - da;
      if (along > VIEW_REACH) break;
      if (along < need) continue;
      const sx = P[b * 3] - ax, sz = P[b * 3 + 2] - az, s2 = sx * sx + sz * sz;
      let u = s2 > 0 ? (px * sx + pz * sz) / s2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const ex = px - sx * u, ez = pz - sz * u;
      if (ex * ex + ez * ez < lim2) return false;
    }
  }
  return true;
}

export class Skyline {
  /**
   * @param pos   Float32Array(RING·PER_SLOT·4): x, y, z relative to the origin, band
   * @param size  Float32Array(RING·PER_SLOT·4): width, height, depth below, seed (0 size: hidden)
   */
  constructor(pos, size) {
    this.pos = pos;
    this.size = size;
    this.world = new Float64Array(RING * PER_SLOT * 3);
    this.slotOf = new Int32Array(RING).fill(-1);
    this.nodes = null;
    this.live = false;
    this.cursor = 0;
    this._rs = 0;
  }

  load(nodes, live = false) {
    this.nodes = nodes;
    this.live = !!live;
    this.slotOf.fill(-1);
    this.size.fill(0);
    this.cursor = 0;
  }

  /**
   * Keep the ring on the slots from just behind the ship's node to as far
   * as the ring (or the track) reaches. Returns whether the instance data
   * changed.
   * @param rebased the floating origin moved: re-translate every pillar
   */
  update(nodeIndex, origin, rebased) {
    const nd = this.nodes;
    if (!nd) return false;
    const slots = Math.floor((nd.count - 1) / NODES_PER_SLOT);
    const j0 = Math.max(0, Math.floor(nodeIndex / NODES_PER_SLOT) - 2);
    const j1 = Math.min(slots, j0 + RING - 1);
    const from = Math.max(0, j0 * NODES_PER_SLOT);
    let changed = false;
    for (let r = 0; r < RING; r++) {
      const j = this.slotOf[r];
      if (j !== -1 && (j < j0 || j > j1)) {
        this._hide(r);
        changed = true;
      }
    }
    for (let j = j0, w = 0; j <= j1 && w < MAX_WRITES; j++) {
      const r = j % RING;
      if (this.slotOf[r] === j) continue;
      this._write(j, r, from, origin);
      changed = true;
      w++;
    }
    if (this.live && j1 >= j0) {
      for (let m = 0; m < LIVE_RECHECKS && m <= j1 - j0; m++) {
        if (this.cursor < j0 || this.cursor > j1) this.cursor = j0;
        this._write(this.cursor, this.cursor % RING, from, origin);
        this.cursor++;
      }
      changed = true;
    }
    if (rebased) {
      this._translate(origin);
      changed = true;
    }
    return changed;
  }

  _hide(r) {
    const S = this.size;
    for (let q = 0; q < PER_SLOT; q++) {
      const i = q * RING + r;
      S[i * 4] = 0; S[i * 4 + 1] = 0; S[i * 4 + 2] = 0;
    }
    this.slotOf[r] = -1;
  }

  _translate(origin) {
    const P = this.pos, W = this.world;
    for (let r = 0; r < RING; r++) {
      if (this.slotOf[r] === -1) continue;
      for (let q = 0; q < PER_SLOT; q++) {
        const i = q * RING + r;
        P[i * 4] = W[i * 3] - origin.x; P[i * 4 + 1] = W[i * 3 + 1] - origin.y; P[i * 4 + 2] = W[i * 3 + 2] - origin.z;
      }
    }
  }

  _write(j, r, from, origin) {
    const nd = this.nodes, n = nd.count, k = j * NODES_PER_SLOT;
    const P = this.pos, S = this.size, W = this.world;
    this._rs = (0x5eed + j * 7919) >>> 0;
    const px = nd.pos[k * 3], py = nd.pos[k * 3 + 1], pz = nd.pos[k * 3 + 2];
    // The track's horizontal heading across the slot, from positions: a
    // node's own forward points up or back inside a loop.
    const ka = Math.max(0, k - NODES_PER_SLOT), kb = Math.min(n - 1, k + NODES_PER_SLOT);
    let fx = nd.pos[kb * 3] - nd.pos[ka * 3], fz = nd.pos[kb * 3 + 2] - nd.pos[ka * 3 + 2];
    let fl = Math.hypot(fx, fz);
    if (fl < 1e-6) { fx = nd.fwd[k * 3]; fz = nd.fwd[k * 3 + 2]; fl = Math.hypot(fx, fz) || 1; }
    const hx = fx / fl, hz = fz / fl, rx = -hz, rz = hx;
    for (let q = 0; q < PER_SLOT; q++) {
      // Instances are ordered depth-band-major (q · RING + r), so a tier that
      // draws only the first RING · 3 still has pillars in every band.
      const i = q * RING + r;
      const near = DEPTHS[q % 3][0], far = DEPTHS[q % 3][1];
      const side = (q + j) % 2 === 0 ? 1 : -1;
      const out = near + (far - near) * this._rand();
      const along = (this._rand() - 0.5) * 40;
      const x = px + rx * side * out + hx * along, z = pz + rz * side * out + hz * along;
      const width = 3 + this._rand() * (q % 3 === 0 ? 4 : 11);
      const height = (q % 3 === 0 ? 10 : 26) + this._rand() * (q % 3 === 0 ? 30 : 100);
      const below = 260 + this._rand() * 60;
      const y = py - 18 - this._rand() * 30;
      const band = (j * 7 + q * 5) % 16;
      const seed = this._rand();
      // A box's footprint reaches its half-diagonal from the centre.
      const clear = clearOfView(nd, x, z, width * Math.SQRT1_2, k, from);
      W[i * 3] = x; W[i * 3 + 1] = y; W[i * 3 + 2] = z;
      P[i * 4] = x - origin.x; P[i * 4 + 1] = y - origin.y; P[i * 4 + 2] = z - origin.z; P[i * 4 + 3] = band;
      S[i * 4] = clear ? width : 0; S[i * 4 + 1] = clear ? height : 0; S[i * 4 + 2] = clear ? below : 0; S[i * 4 + 3] = seed;
    }
    this.slotOf[r] = j;
  }

  /** mulberry32 on instance state: the slot writer's PRNG without a closure per slot. */
  _rand() {
    let t = (this._rs = (this._rs + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
