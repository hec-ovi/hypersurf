// The live track (docs/research.md §2.2): a SongMap that grows while the
// song plays. Nodes and blocks are committed H = 2 s ahead of the heard
// time; the view, the rules and the HUD read the same arrays a file's
// SongMap has (map.nodes, map.blocks), which grow in place.
//
//   nodes    committed up to now + H from the live intensity measured now
//            (smoothed: 0.5 s attack, 2 s release), so slope, speed and
//            colour trail the music by about two seconds; that lag is the
//            price of hearing the song as it plays. Past the horizon a
//            provisional tail extends the track to the draw distance by
//            holding the current intensity; it is rebuilt as commits catch
//            up and reports the first changed node (changedFrom) so the
//            view can rebuild what it drew there.
//   grid     the block grid follows the tracker's, but its phase and tempo
//            may move only 25% of a period per beat, so nothing jumps
//   blocks   placed on predicted beats (and strong off-beats) when the
//            tracker is confident (c > 0.6) and its beats keep landing
//            (hit rate ≥ 0.5). They start as ghosts (40%) gliding with the
//            grid; the next beat an onset confirms within ±40 ms makes them
//            solid, and a ghost still unconfirmed 1 s ahead fades out and
//            is withdrawn from the rules (map.cancelled).
//   lanes    a pattern memory of the last 16 beats (two slots per beat)
//            remembers the strength and band of what was heard at each bar
//            position; a future slot takes the lane its band suggests (low
//            centre, high outer, mid alternating), and weak beats turn grey
//   power    after 16 bars of locked beats the next downbeat is a power
//            block; drops cannot be predicted, so there are no loops
//
// Pure: no DOM, no audio. Times are song seconds.

import { NODE_RATE, LEAD_IN, BLOCK, MODES, LAYOUT } from '../audio/songmap.js';
import { mulberry32, seedFromString } from '../audio/random.js';
import { gradientAt } from '../game/palette.js';

export const LIVE = Object.freeze({
  horizon: 2, // H: seconds ahead nodes and blocks are committed
  solidBy: 1, // a ghost still unconfirmed this close is withdrawn
  ghostAlpha: 0.4,
  confirm: 0.04, // an onset within this of a grid beat confirms it
  maxShift: 0.25, // of a period per period: how fast the block grid may move
  minConfidence: 0.6,
  minHitRate: 0.5,
  pbBeats: 64, // 16 bars of locked beats earn a power block
  tailDistance: 720, // metres of provisional track past the horizon
  tailMaxSeconds: 30,
  signalEvery: 0.25, // seconds between reports of rebuilt nodes to the view
  memory: 32, // pattern memory slots: 16 beats × 2
  offbeatStrength: 0.5, // an off-beat slot needs this remembered strength
  silentBeat: 0.02, // a beat slot that remembered less stays empty
});

/** Block status in map.blocks.status. */
export const STATUS = Object.freeze({ GHOST: 0, SOLID: 1, GONE: 2 });

const DEG = Math.PI / 180;
const NODE_FIELDS = { intensity: 1, speed: 1, pitch: 1, yaw: 1, roll: 1, beat: 1, fwd: 3, up: 3, color: 3 };
const BLOCK_FIELDS = {
  time: Float64Array, lane: Int8Array, type: Uint8Array, strength: Float32Array, band: Uint8Array, spanEnd: Float64Array,
  pbRank: Uint8Array, filler: Uint8Array, snapped: Uint8Array, status: Uint8Array, alpha: Float32Array, beatPos: Float64Array,
};

function allocNodes(capacity) {
  const n = { capacity, dist: new Float64Array(capacity), pos: new Float64Array(capacity * 3), loop: new Uint8Array(capacity) };
  for (const [k, w] of Object.entries(NODE_FIELDS)) n[k] = new Float32Array(capacity * w);
  return n;
}

function allocBlocks(capacity) {
  const b = { capacity, count: 0 };
  for (const [k, T] of Object.entries(BLOCK_FIELDS)) b[k] = new T(capacity);
  return b;
}

function grow(obj, keys, capacity) {
  for (const k of keys) {
    const old = obj[k], per = old.length / obj.capacity;
    const next = new old.constructor(Math.round(capacity * per));
    next.set(old);
    obj[k] = next;
  }
  obj.capacity = capacity;
}

export class LiveMap {
  /**
   * @param mode      'mono' | 'ninja' | 'casual'
   * @param seed      lane PRNG seed ('yt:<id>', 'live:demo')
   * @param duration  song length if known (Infinity otherwise)
   * @param minutes   initial capacity; arrays grow past it
   */
  constructor({ mode = 'mono', seed = 'live', duration = Infinity, minutes = 10 } = {}) {
    const cfg = MODES[mode];
    if (!cfg) throw new Error(`unknown mode ${mode}`);
    this.live = true;
    this.mode = mode;
    this.seed = seed;
    this.cfg = cfg;
    this.duration = duration;
    this.hash = 'live';
    this.bpm = 0;
    this.beats = new Float64Array(0);
    this.powerBlocks = [];
    this.rand = mulberry32(seedFromString(`${seed}|${mode}|live`));
    this.waves = [[0.013, 0.5], [0.029, 0.3], [0.047, 0.2]].map(([f, a]) => [f, a, this.rand() * 2 * Math.PI]);

    const cap = Math.ceil((minutes * 60 + LEAD_IN + LIVE.tailMaxSeconds) * NODE_RATE) + 4;
    this.nodes = allocNodes(cap);
    this.nodes.rate = NODE_RATE;
    this.nodes.t0 = -LEAD_IN;
    this.nodes.count = 0;
    this.blocks = allocBlocks(1024);
    this.skyline = { rate: 1, bands: 16, data: new Uint8Array(16 * 1024), frames: 0 };
    this.rings = { list: new Int32Array(512), count: 0 };
    this.cancelled = { list: new Int32Array(256), count: 0 }; // ring; readers keep their own count

    // Block grid (song time): beat number n sits at a0 + (n − n0)·T.
    this.grid = { valid: false, a0: 0, n0: 0, T: 0.5 };
    this.octave = 0;
    this.nextSlot = 0;
    this.evalBeat = 0; // next grid beat number to evaluate
    this.memSlot = 0; // next slot number to remember
    this.memStrength = new Float32Array(LIVE.memory);
    this.memBand = new Uint8Array(LIVE.memory);
    this.memSet = new Uint8Array(LIVE.memory);
    this.onsetTime = new Float64Array(64);
    this.onsetStrength = new Float32Array(64);
    this.onsetBand = new Uint8Array(64);
    this.onsetCount = 0;
    this.strengths = new Float32Array(64);
    this.strengthCount = 0;
    this.bucket = 2;
    this.bucketTime = -Infinity;
    this.locked = 0; // consecutive locked beats
    this.lastMid = 0;
    this.aliveFrom = 0; // first block still worth animating
    this.firstGhost = 0;
    this.iHist = new Uint32Array(50);
    this.iCount = 0;
    this.lastRing = -Infinity;
    this.cost = new Float64Array(3);
    this.rgb = [0, 0, 0];

    // Integrators: the committed track and a scratch copy for the tail.
    this.st = { p: 0, x: 0, y: 0, z: 0, dist: 0, beat: 0, speed: 0 };
    this.tailSt = { p: 0, x: 0, y: 0, z: 0, dist: 0, beat: 0, speed: 0 };
    this.committed = 0;
    this.tailFrom = 0; // committed count when the tail was last rebuilt
    this.changedFrom = Infinity; // lowest node rewritten since the view last synced
    this.pendingFrom = Infinity;
    this.lastSignal = -Infinity;
    this.now = -LEAD_IN;
    this.analysed = -Infinity;
    this.intensity = 0;
    this.gate = false;
    this.stats = { confirmed: 0, missed: 0, ghosts: 0, withdrawn: 0, placed: 0, powerBlocks: 0 };

    this._commit(LIVE.horizon - LEAD_IN, 0);
    this._tail(0);
    this.changedFrom = 0;
  }

  /** Skyline frames arrive at the tracker's frame rate. */
  setSkylineRate(rate) {
    this.skyline.rate = rate;
  }

  /** ×2 (1), ÷2 (−1) or as tracked (0): the block grid's metrical level. */
  setOctave(octave) {
    const o = Math.max(-1, Math.min(1, Math.round(octave)));
    if (o === this.octave) return;
    const last = this.blocks.count ? this.blocks.time[this.blocks.count - 1] : this.now;
    this.octave = o;
    this.memSet.fill(0);
    if (this.grid.valid) {
      this.nextSlot = Math.ceil(this._slotAt(Math.max(last + 0.1, this.now + LIVE.solidBy + 0.25)));
      this.memSlot = Math.ceil(this._slotAt(this.analysed));
    }
  }

  // --- inputs -------------------------------------------------------------------

  /** An onset heard at song time t (strength 0..1, band 0 low / 1 mid / 2 high). */
  onset(t, strength, band) {
    const i = this.onsetCount % 64;
    this.onsetTime[i] = t;
    this.onsetStrength[i] = strength;
    this.onsetBand[i] = band;
    this.onsetCount++;
  }

  /** Skyline levels (16 × 0..255) of the audio at song time t. */
  skylineFrame(t, levels) {
    const sky = this.skyline, f = Math.round(t * sky.rate);
    if (f < 0) return;
    if ((f + 1) * 16 > sky.data.length) {
      const next = new Uint8Array(Math.max(sky.data.length * 2, (f + 1) * 16));
      next.set(sky.data);
      sky.data = next;
    }
    sky.data.set(levels, f * 16);
    if (f + 1 > sky.frames) sky.frames = f + 1;
  }

  /**
   * Advance to heard song time `now`.
   * @param g         tracker grid in song time: { anchor, period, confidence, hitRate } (anchor NaN if none)
   * @param intensity live intensity 0..1
   * @param analysed  song time up to which onsets have been reported
   */
  update(now, g, intensity, analysed) {
    const dt = Math.max(0, Math.min(0.25, now - this.now));
    this.now = now;
    this.analysed = analysed;
    this.intensity = intensity;
    this.gate = !!g && Number.isFinite(g.anchor) && g.confidence >= LIVE.minConfidence && g.hitRate >= LIVE.minHitRate;
    if (g && Number.isFinite(g.anchor)) this._follow(now, g, dt);
    if (this.grid.valid) {
      this._evaluate(analysed);
      this._remember(analysed);
    }
    const before = this.committed;
    this._commit(now + LIVE.horizon, intensity);
    if (this.grid.valid) this._place(now, now + LIVE.horizon);
    this._animate(now, dt);
    if (this.committed - this.tailFrom >= 4 || this.committed !== before && this.nodes.count <= this.committed) this._tail(intensity);
    if (this.pendingFrom < Infinity && now - this.lastSignal >= LIVE.signalEvery) {
      this.changedFrom = Math.min(this.changedFrom, this.pendingFrom);
      this.pendingFrom = Infinity;
      this.lastSignal = now;
    }
    this.bpm = this.grid.valid ? 60 / this.grid.T : 0;
  }

  /** Withdraw every ghost (the run is ending). */
  dropGhosts() {
    const b = this.blocks;
    for (let i = this.firstGhost; i < b.count; i++) if (b.status[i] === STATUS.GHOST) this._withdraw(i);
  }

  // --- grid ---------------------------------------------------------------------

  /** Continuous beat position of song time t on the block grid. */
  beatAt(t) {
    const g = this.grid;
    return g.n0 + (t - g.a0) / g.T;
  }

  timeAtBeat(n) {
    const g = this.grid;
    return g.a0 + (n - g.n0) * g.T;
  }

  _slotsPerBeat() {
    return 2 * Math.pow(2, this.octave);
  }

  _slotAt(t) {
    return this.beatAt(t) * this._slotsPerBeat();
  }

  _slotTime(m) {
    return this.timeAtBeat(m / this._slotsPerBeat());
  }

  /**
   * Follow the tracker's grid. The first one is adopted outright (nothing
   * is placed yet); after that phase and tempo glide, ghosts with them.
   */
  _follow(now, g, dt) {
    const grid = this.grid;
    if (!grid.valid || g.period / grid.T > 1.3 || grid.T / g.period > 1.3) {
      // First lock, or an octave jump: start the numbering where the old grid was.
      const n = grid.valid ? Math.round(this.beatAt(g.anchor)) : 0;
      grid.a0 = g.anchor;
      grid.T = g.period;
      grid.n0 = n;
      if (!grid.valid) {
        grid.valid = true;
        this.evalBeat = Math.ceil(this.beatAt(this.analysed));
        this.memSlot = Math.ceil(this._slotAt(this.analysed));
      } else this.dropGhosts();
      this.nextSlot = Math.ceil(this._slotAt(now + LIVE.horizon));
      return;
    }
    // Keep a0 on the tracker beat nearest to now, numbering unchanged.
    while (grid.a0 + grid.T < now) { grid.a0 += grid.T; grid.n0 += 1; }
    const tb = g.anchor + Math.round((grid.a0 - g.anchor) / g.period) * g.period;
    const maxStep = LIVE.maxShift * dt;
    const d = tb - grid.a0;
    grid.a0 += Math.max(-maxStep, Math.min(maxStep, d));
    const dT = g.period - grid.T;
    grid.T += Math.max(-maxStep * 0.1, Math.min(maxStep * 0.1, dT));
    // Ghosts glide toward their beat's time on the moved grid.
    const b = this.blocks;
    let prev = -Infinity;
    for (let i = this.firstGhost; i < b.count; i++) {
      if (b.status[i] !== STATUS.GHOST) { prev = b.time[i]; continue; }
      const target = this.timeAtBeat(b.beatPos[i]);
      let t = b.time[i] + Math.max(-maxStep, Math.min(maxStep, target - b.time[i]));
      if (t < prev + 0.05) t = prev + 0.05;
      b.time[i] = t;
      b.spanEnd[i] = t;
      prev = t;
    }
  }

  /** Grid beats whose confirmation window has been heard: confirmed (ghosts solidify) or missed. */
  _evaluate(analysed) {
    const win = LIVE.confirm;
    for (;;) {
      const bt = this.timeAtBeat(this.evalBeat);
      if (bt + win + 0.015 > analysed) break;
      if (this._onsetNear(bt, win) >= 0) {
        this.stats.confirmed++;
        const b = this.blocks;
        for (let i = this.firstGhost; i < b.count; i++) if (b.status[i] === STATUS.GHOST) b.status[i] = STATUS.SOLID;
      } else this.stats.missed++;
      this.locked = this.gate ? this.locked + 1 : 0;
      this.evalBeat++;
    }
  }

  /** Pattern memory: what was heard at each slot of the last 16 beats. */
  _remember(analysed) {
    const win = LIVE.confirm;
    for (;;) {
      const st = this._slotTime(this.memSlot);
      if (st + win + 0.015 > analysed) break;
      const k = this._onsetNear(st, win);
      const idx = ((this.memSlot % LIVE.memory) + LIVE.memory) % LIVE.memory;
      this.memStrength[idx] = k >= 0 ? this.onsetStrength[k] : 0;
      this.memBand[idx] = k >= 0 ? this.onsetBand[k] : 0;
      this.memSet[idx] = 1;
      this.memSlot++;
    }
  }

  /** Ring index of the strongest onset within `win` of t, or −1. */
  _onsetNear(t, win) {
    let best = -1;
    for (let j = Math.max(0, this.onsetCount - 64); j < this.onsetCount; j++) {
      const i = j % 64;
      if (Math.abs(this.onsetTime[i] - t) <= win && (best < 0 || this.onsetStrength[i] > this.onsetStrength[best])) best = i;
    }
    return best;
  }

  // --- blocks -------------------------------------------------------------------

  _place(now, horizon) {
    const earliest = now + LIVE.solidBy + 0.25;
    for (;;) {
      const m = this.nextSlot, ts = this._slotTime(m);
      if (ts > horizon) break;
      this.nextSlot++;
      if (!this.gate || ts < earliest) continue;
      this._decide(m, ts);
    }
  }

  _decide(m, ts) {
    const idx = ((m % LIVE.memory) + LIVE.memory) % LIVE.memory;
    const set = this.memSet[idx], s = this.memStrength[idx], band = this.memBand[idx];
    const onBeat = m % 2 === 0;
    let type = BLOCK.COLOUR, strength, useBand, rank = 0;
    if (onBeat) {
      if (set && s < LIVE.silentBeat) return;
      strength = set ? s : 0.5;
      useBand = set ? band : 0;
      const beat = Math.round(m / this._slotsPerBeat());
      if (this.locked >= LIVE.pbBeats && ((beat % 4) + 4) % 4 === 0) {
        type = BLOCK.POWER;
        rank = 2;
        this.locked = 0;
      } else if (this._weak(strength)) type = BLOCK.GREY;
      this._noteStrength(strength);
    } else {
      if (this.mode === 'casual' || !set || s < LIVE.offbeatStrength) return;
      strength = s;
      useBand = band;
    }
    // Density cap: a token bucket at the mode's rate (power blocks always fit).
    const rate = this.cfg.maxRate;
    this.bucket = Math.min(2, this.bucket + (ts - this.bucketTime) * rate);
    this.bucketTime = ts;
    if (type !== BLOCK.POWER) {
      if (this.bucket < 1) return;
      this.bucket -= 1;
    }
    const lane = type === BLOCK.POWER ? 0 : this._lane(useBand, type, ts);
    this._add(ts, lane, type, strength, useBand, rank, this.beatAt(ts));
  }

  /** Whether strength s is among the weakest greyFraction of recent beats. */
  _weak(s) {
    const n = Math.min(this.strengthCount, this.strengths.length);
    if (n < 8) return false;
    let below = 0;
    for (let i = 0; i < n; i++) if (this.strengths[i] < s) below++;
    return below / n < this.cfg.greyFraction;
  }

  _noteStrength(s) {
    this.strengths[this.strengthCount % this.strengths.length] = s;
    this.strengthCount++;
  }

  /** Band-biased lane (as offline), moved off lanes that break the spacing rules. */
  _lane(band, type, t) {
    const r = this.rand();
    let lane;
    if (band === 0) lane = r < 0.6 ? 0 : r < 0.8 ? -1 : 1;
    else if (band === 2) lane = r < 0.15 ? 0 : r < 0.575 ? -1 : 1;
    else {
      lane = r < 0.25 ? 0 : this.lastMid === 0 ? (this.rand() < 0.5 ? -1 : 1) : -this.lastMid;
      if (lane !== 0) this.lastMid = lane;
    }
    const b = this.blocks, cost = this.cost, kind = type === BLOCK.GREY ? 1 : 0;
    cost[0] = cost[1] = cost[2] = 0;
    let lastSame = null;
    for (let j = b.count - 1; j >= 0 && t - b.time[j] < LAYOUT.outerPairGap; j--) {
      if (b.status[j] === STATUS.GONE) continue;
      const dt = t - b.time[j], pk = b.type[j] === BLOCK.GREY ? 1 : 0;
      if (dt < LAYOUT.sameLaneGap) cost[b.lane[j] + 1] += 4;
      if (pk !== kind && dt < LAYOUT.typeGap) cost[b.lane[j] + 1] += 2;
      if (lastSame === null && pk === kind) lastSame = b.lane[j];
    }
    if (lastSame !== null && lastSame !== 0) cost[1 - lastSame] += 1;
    if (cost[lane + 1] === 0) return lane;
    // Nearest acceptable lane: the centre first for a centre block, else this side, centre, far side.
    const side = this.rand() < 0.5 ? -1 : 1;
    const second = lane === 0 ? side : 0, third = lane === 0 ? -side : -lane;
    let best = lane;
    if (cost[second + 1] < cost[best + 1]) best = second;
    if (cost[third + 1] < cost[best + 1]) best = third;
    return best;
  }

  _add(t, lane, type, strength, band, rank, beatPos) {
    const b = this.blocks;
    if (b.count === b.capacity) grow(b, Object.keys(BLOCK_FIELDS), b.capacity * 2);
    const i = b.count++;
    b.time[i] = t; b.lane[i] = lane; b.type[i] = type; b.strength[i] = strength; b.band[i] = band;
    b.spanEnd[i] = t; b.pbRank[i] = rank; b.filler[i] = 0; b.snapped[i] = 1;
    b.status[i] = STATUS.GHOST; b.alpha[i] = 0; b.beatPos[i] = beatPos;
    this.stats.placed++;
    if (type === BLOCK.POWER) this.stats.powerBlocks++;
  }

  _withdraw(i) {
    const b = this.blocks;
    b.status[i] = STATUS.GONE;
    const c = this.cancelled;
    c.list[c.count % c.list.length] = i;
    c.count++;
    this.stats.withdrawn++;
  }

  /** Withdraw late ghosts; fade ghosts in to 40%, solids up to 100%, withdrawn out. */
  _animate(now, dt) {
    const b = this.blocks, limit = now + LIVE.solidBy;
    while (this.aliveFrom < b.count && b.time[this.aliveFrom] < now - 1 && b.alpha[this.aliveFrom] <= 0) this.aliveFrom++;
    while (this.aliveFrom < b.count && b.time[this.aliveFrom] < now - 1) this.aliveFrom++;
    let ghosts = 0, firstGhost = -1;
    for (let i = this.aliveFrom; i < b.count; i++) {
      if (b.status[i] === STATUS.GHOST && b.time[i] <= limit) this._withdraw(i);
      const s = b.status[i];
      if (s === STATUS.GHOST) {
        ghosts++;
        if (firstGhost < 0) firstGhost = i;
        b.alpha[i] = Math.min(LIVE.ghostAlpha, b.alpha[i] + dt / 0.2);
      } else if (s === STATUS.SOLID) b.alpha[i] = Math.min(1, b.alpha[i] + dt / 0.15);
      else b.alpha[i] = Math.max(0, b.alpha[i] - dt / 0.2);
    }
    this.firstGhost = firstGhost < 0 ? b.count : firstGhost;
    this.stats.ghosts = ghosts;
  }

  // --- nodes --------------------------------------------------------------------

  _ensureNodes(n) {
    const nd = this.nodes;
    if (n <= nd.capacity) return;
    grow(nd, ['dist', 'pos', 'loop', ...Object.keys(NODE_FIELDS)], Math.max(n, nd.capacity * 2));
  }

  /** Commit nodes up to song time `until` at intensity I. */
  _commit(until, I) {
    const nd = this.nodes;
    const first = this.committed;
    while (nd.t0 + this.committed / NODE_RATE <= until) {
      this._ensureNodes(this.committed + 1);
      this._node(this.committed, I, this.st);
      this._ring(this.committed);
      this.committed++;
    }
    if (this.committed > first) {
      if (nd.count < this.committed) nd.count = this.committed;
      this.pendingFrom = Math.min(this.pendingFrom, first);
    }
  }

  /** The provisional track past the horizon: the current intensity held. */
  _tail(I) {
    const nd = this.nodes, ts = this.tailSt, st = this.st;
    ts.p = st.p; ts.x = st.x; ts.y = st.y; ts.z = st.z; ts.dist = st.dist; ts.beat = st.beat; ts.speed = st.speed;
    const d0 = st.dist, maxN = Math.round(LIVE.tailMaxSeconds * NODE_RATE);
    let k = this.committed;
    for (let j = 0; j < maxN && ts.dist - d0 < LIVE.tailDistance; j++, k++) {
      this._ensureNodes(k + 1);
      this._node(k, I, ts);
    }
    nd.count = k;
    this.pendingFrom = Math.min(this.pendingFrom, this.tailFrom);
    this.tailFrom = this.committed;
  }

  /**
   * Write node k at intensity I, advancing integrator `st`: speed and
   * pitch as offline (pitch rate-limited to 12°/s), heading from seeded
   * slow noise calmer where blocks are dense, beat position from the grid.
   */
  _node(k, I, st) {
    const nd = this.nodes, cfg = this.cfg, dt = 1 / NODE_RATE;
    const t = nd.t0 + k / NODE_RATE;
    const speed = cfg.speedMin + (cfg.speedMax - cfg.speedMin) * Math.pow(I, 1.3);
    const target = I < 0.5 ? (LAYOUT.pitchUp * (0.5 - I)) / 0.5 : (-LAYOUT.pitchDown * (I - 0.5)) / 0.5;
    const maxStep = LAYOUT.pitchRate * dt;
    if (k === 0) { st.p = target; st.speed = speed; }
    st.p += Math.max(-maxStep, Math.min(maxStep, target - st.p));
    let noise = 0;
    for (let w = 0; w < 3; w++) noise += this.waves[w][1] * Math.sin(2 * Math.PI * this.waves[w][0] * t + this.waves[w][2]);
    const yaw = LAYOUT.yawAmplitude * noise * (1 - 0.6 * this._density(t)) * DEG;
    const pitch = st.p * DEG;
    const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
    const fx = sy * cp, fy = sp, fz = -cy * cp;
    if (k > 0) {
      const ds = 0.5 * (st.speed + speed) * dt;
      st.x += fx * ds; st.y += fy * ds; st.z += fz * ds;
      st.dist += ds;
    }
    st.speed = speed;
    nd.pos[k * 3] = st.x; nd.pos[k * 3 + 1] = st.y; nd.pos[k * 3 + 2] = st.z;
    nd.dist[k] = st.dist;
    nd.fwd[k * 3] = fx; nd.fwd[k * 3 + 1] = fy; nd.fwd[k * 3 + 2] = fz;
    nd.up[k * 3] = -sy * sp; nd.up[k * 3 + 1] = cp; nd.up[k * 3 + 2] = cy * sp;
    nd.intensity[k] = I;
    nd.speed[k] = speed;
    nd.pitch[k] = pitch;
    nd.yaw[k] = yaw;
    nd.roll[k] = 0;
    nd.loop[k] = 0;
    // Chevron phase: the block grid where it exists, 120 BPM before.
    st.beat = this.grid.valid ? this.beatAt(t) : t / 0.5;
    nd.beat[k] = st.beat;
    const rgb = gradientAt(I, this.rgb);
    nd.color[k * 3] = rgb[0]; nd.color[k * 3 + 1] = rgb[1]; nd.color[k * 3 + 2] = rgb[2];
  }

  /** Blocks within ±2 s of t, as a share of the mode's densest (heading noise calms down). */
  _density(t) {
    const b = this.blocks;
    let c = 0;
    for (let j = b.count - 1; j >= 0 && b.time[j] > t - 2; j--) if (b.time[j] <= t + 2 && b.status[j] !== STATUS.GONE) c++;
    return Math.min(1, c / (4 * this.cfg.maxRate));
  }

  /** Rings at the most intense committed nodes (top 18% so far, never below 0.5), 12+ nodes apart. */
  _ring(k) {
    const I = this.nodes.intensity[k];
    const bin = Math.min(49, Math.floor(I * 50));
    this.iHist[bin]++;
    this.iCount++;
    let above = 0, threshold = 1;
    for (let b = 49; b >= 0; b--) {
      above += this.iHist[b];
      if (above >= 0.18 * this.iCount) { threshold = b / 50; break; }
    }
    if (I < Math.max(0.5, threshold) || k - this.lastRing < 12) return;
    const r = this.rings;
    if (r.count === r.list.length) {
      const next = new Int32Array(r.list.length * 2);
      next.set(r.list);
      r.list = next;
    }
    r.list[r.count++] = k;
    this.lastRing = k;
  }
}
