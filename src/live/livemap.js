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
//            may move only 25% of a period per beat, so nothing jumps. The
//            beat numbering stays on the beats it was locked to: when the
//            tracker strays by half a beat (onto off-beats) and comes back,
//            the grid glides back the way it went, never on a full beat
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
//   bars     every heard beat span goes to a BarTracker (bars.js): the
//            downbeat, 8/16-bar phrase lines and builds
//   loops    the same shapes as a file's (a plain loop, a corkscrew, a
//            double corkscrew), scheduled far enough ahead that they are
//            drawn on the provisional tail and foreshadowed on the horizon
//            like a file's, never while the tracker or the bar and phrase
//            estimates are unsure, and at least 12 s apart:
//              - a build (three bars of rising intensity and onset energy)
//                predicts a drop on the next phrase line at least
//                loopLead ahead: a corkscrew there, a double one for a
//                big build. The loop plays whether or not the drop comes,
//                but its power block, on the first downbeat after the
//                drop, is held as a ghost until the drop is heard (a kick
//                and a jump in the low bands) and withdrawn if it is not.
//              - 16 bars of locked beats earn a power block, placed with a
//                plain loop on the next phrase line (or bar line) ahead.
//   features the file's twists and flips: a strong section change heard on
//            a phrase line puts a twist (a flip when the song falls into a
//            calmer section) on the next phrase line ahead, keeping the
//            file's 8 s from every other shape; a loop scheduled later
//            takes the place of one not yet committed
//   sweeps   the file's banked sweeping curves, in 8-bar stretches clear of
//            the shapes, but laid out over the ground (as is the heading
//            noise) and planned past the provisional tail's reach: a heading
//            change swings all the track after it, so a planned sweep never
//            changes, and a change of speed or slope only resamples it. The swing is set by the intensity
//            heard when it was planned (up to a tail's length early); every
//            node is banked into its curve by the intensity it is committed
//            at (rate limited, faded out next to shapes)
//
// Shapes (loops and features) follow their beat on the gliding grid until
// the nodes under them are committed; from then on they are committed
// geometry. The tail draws them before that, so a shape is on the horizon
// seconds early.
//
// Pure: no DOM, no audio. Times are song seconds.

import {
  NODE_RATE, LEAD_IN, BLOCK, MODES, LAYOUT, LOOP, shapePose, makePose, smootherstep, twistLength, flipHalf, sweepYawAt, bankTarget,
} from '../audio/songmap.js';
import { BarTracker, BARS } from './bars.js';
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
  pbWait: 16, // …placed on a phrase line; while the phrases are unsure it waits this many more beats before taking a bar line
  tailDistance: 720, // metres of provisional track past the horizon
  tailMaxSeconds: 30,
  signalEvery: 0.25, // seconds between reports of rebuilt nodes to the view
  memory: 32, // pattern memory slots: 16 beats × 2
  offbeatStrength: 0.35, // an off-beat slot needs this remembered strength (beats sit near 1)
  silentBeat: 0.02, // a beat slot that remembered less stays empty
  loopLead: 3.9, // a loop's centre is at least this far ahead when scheduled (its start past the horizon)
  dropLead: 3.5, // …a predicted drop's, which is heard late (its start still past the horizon)
  loopReach: 20, // …and at most this far
  loopSpacing: 12, // seconds between loop centres
  loopStreak: 16, // locked beats before any loop (a beat out of lock costs as many)
  downbeatConfidence: 0.15, // for a power block's plain loop on a bar line
  phraseDownbeat: 0.2, // for anything placed on a phrase line: the downbeat reached this confidence
  downbeatPeak: 32, // …within this many beats (it sags in a breakdown with no kick),
  downbeatHeld: 16, // …and has not moved for this many
  featurePhrase: 0.4, // phrase confidence a twist or flip needs,
  featureLines: 3, // …with this many section lines heard
  phraseConfidence: 0.3,
  buildReach: 4, // a build predicts a drop on a phrase line at most this many bars after it
  bigBuild: 1.8, // build score for a double corkscrew, or
  bigDepth: 0.5, // …a build out of a breakdown this far below the loudest of the last 32 bars
  dropKick: 0.5, // a drop brings a kick (on its downbeat or up to the next beat) at least this strong…
  dropKickJump: 1.3, // …that is this much stronger than the bar before, or
  dropLift: 0.04, // …lifts the intensity this much above the bar before;
  dropKickSoft: 0.25, // or a moderate kick with
  dropLiftClear: 0.08, // …a clear lift
  pbCheck: 1.25, // a held power block sits this far past the beat after its drop (so the drop is heard first)
  featureNovelty: 2.2, // section-change score (× the typical bar-line change) that gets a twist or flip
  shapeClear: 3, // seconds a loop keeps from a twist or flip already committed
  sweepLead: 100, // metres past the tail's reach that sweeps are planned (a planned sweep never rewrites drawn track)
  settleSlip: 0.3, // of a period: a tracker move this big is ambiguous; the grid glides back toward where it locked
});

/** Block status in map.blocks.status. */
export const STATUS = Object.freeze({ GHOST: 0, SOLID: 1, GONE: 2 });

const DEG = Math.PI / 180;
const NOISE_SPEED = 45; // m/s at which the heading noise has the file's frequencies
const mod = (a, n) => ((a % n) + n) % n;
const isFeature = (S) => S.type === LOOP.TWIST || S.type === LOOP.FLIP;
const NODE_FIELDS = { intensity: 1, speed: 1, pitch: 1, yaw: 1, roll: 1, beat: 1, fwd: 3, up: 3, color: 3 };
const BLOCK_FIELDS = {
  time: Float64Array, lane: Int8Array, type: Uint8Array, strength: Float32Array, band: Uint8Array, spanEnd: Float64Array,
  pbRank: Uint8Array, filler: Uint8Array, snapped: Uint8Array, status: Uint8Array, alpha: Float32Array, beatPos: Float64Array,
  held: Uint8Array, // a ghost no beat solidifies (a power block waiting for its drop)
};

function allocNodes(capacity) {
  const n = { capacity, dist: new Float64Array(capacity), ground: new Float64Array(capacity), pos: new Float64Array(capacity * 3), loop: new Uint8Array(capacity) };
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
    this.nodes.live = true; // they grow and their tail is rewritten: whatever is laid out along them re-checks
    this.nodes.count = 0;
    this.blocks = allocBlocks(1024);
    this.skyline = { rate: 1, bands: 16, data: new Uint8Array(16 * 1024), frames: 0 };
    this.rings = { list: new Int32Array(512), count: 0 };
    this.cancelled = { list: new Int32Array(256), count: 0 }; // ring; readers keep their own count

    // Block grid (song time): beat number n sits at a0 + (n − n0)·T.
    this.grid = { valid: false, a0: 0, n0: 0, T: 0.5 };
    this.slip = 0; // periods the grid has glided since it locked
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
    // ground: distance travelled over the ground (the plan view), which lays out the heading.
    this.st = { p: 0, x: 0, y: 0, z: 0, dist: 0, ground: 0, beat: 0, speed: 0, li: 0, side: 0, si: 0, yaw: 0, bank: 0 };
    this.tailSt = { p: 0, x: 0, y: 0, z: 0, dist: 0, ground: 0, beat: 0, speed: 0, li: 0, side: 0, si: 0, yaw: 0, bank: 0 };
    this.committed = 0;
    this.tailFrom = 0; // committed count when the tail was last rebuilt
    this.changedFrom = Infinity; // lowest node rewritten since the view last synced
    this.pendingFrom = Infinity;
    this.lastSignal = -Infinity;
    this.now = -LEAD_IN;
    this.analysed = -Infinity;
    this.intensity = 0;
    this.gate = false;
    this.stats = {
      confirmed: 0, missed: 0, ghosts: 0, withdrawn: 0, placed: 0, powerBlocks: 0,
      loops: 0, predicted: 0, drops: 0, falseDrops: 0, twists: 0, flips: 0, bumped: 0, sweeps: 0,
    };

    // Bars, phrases and loops.
    this.bars = new BarTracker();
    this.spanBeat = 0; // next beat whose span goes to the bar tracker
    this.spanSpec = new Float32Array(16);
    this.dbConf = new Float32Array(LIVE.downbeatPeak); // downbeat confidence over the last beats
    this.dbStable = -1; // the downbeat, once it has held for a bar (a one-beat wobble is not a move)
    this.dbHeld = 0; // beats since it moved there
    this.dbCand = -1;
    this.dbCandBeats = 0;
    this.streak = 0; // locked beats, less loopStreak per beat out of lock (a power block does not reset it)
    this.loops = []; // shapes, by start: { type, time, start, end, beat, dir, predicted, checked, dropOk, pbIndex, fixed, inEnd?, outStart? }
    this.featureLine = NaN; // last bar line judged for a twist or flip
    this.featureDir = 1;
    this.sweeps = []; // { start, end (metres over the ground), yaw (degrees), dir }, by start
    this.sweepEnd = 0; // planned up to here (metres)
    this.pbBeat = new Float64Array(4).fill(NaN); // beats that get a power block…
    this.pbRank = new Uint8Array(4);
    this.pbHeld = new Uint8Array(4);
    this.pbLoop = [null, null, null, null];
    this.pose = makePose();

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
      this._spans(analysed);
      this._checkDrops(analysed);
      this._schedulePower(now);
    }
    this._settleShapes();
    this._planSweeps(now);
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
      this.slip = 0;
      // New beats: bars and pending power blocks start over. Scheduled shapes
      // still play where they are (their beat numbers mean nothing now).
      for (const L of this.loops) L.fixed = true;
      this.bars.reset();
      this.spanBeat = Math.ceil(this.beatAt(this.analysed));
      this.pbBeat.fill(NaN);
      this.pbLoop.fill(null);
      this.nextSlot = Math.ceil(this._slotAt(now + LIVE.horizon));
      return;
    }
    // Keep a0 on the tracker beat nearest to now, numbering unchanged.
    while (grid.a0 + grid.T < now) { grid.a0 += grid.T; grid.n0 += 1; }
    // The tracker beat to glide to: the nearest, unless the tracker moved by
    // a good part of a beat (onto the off-beats, or back): then the one on
    // the side the grid has slipped from, so an excursion and its return
    // cancel and the numbering stays on the beats it was locked to.
    const x = (grid.a0 - g.anchor) / g.period;
    let k = Math.round(x);
    if (Math.abs(x - k) > LIVE.settleSlip) {
      const ref = x - (this.slip * grid.T) / g.period;
      k = Math.abs(Math.floor(x) - ref) <= Math.abs(Math.ceil(x) - ref) ? Math.floor(x) : Math.ceil(x);
    }
    const tb = g.anchor + k * g.period;
    const maxStep = LIVE.maxShift * dt;
    const d = tb - grid.a0;
    const step = Math.max(-maxStep, Math.min(maxStep, d));
    grid.a0 += step;
    this.slip += step / grid.T;
    const dT = g.period - grid.T;
    grid.T += Math.max(-maxStep * 0.1, Math.min(maxStep * 0.1, dT));
    // Ghosts glide toward their beat's time on the moved grid (a power block stays with its loop).
    const b = this.blocks;
    let prev = -Infinity;
    for (let i = this.firstGhost; i < b.count; i++) {
      if (b.status[i] !== STATUS.GHOST || b.type[i] === BLOCK.POWER) { prev = b.time[i]; continue; }
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
        for (let i = this.firstGhost; i < b.count; i++) if (b.status[i] === STATUS.GHOST && !b.held[i]) b.status[i] = STATUS.SOLID;
      } else this.stats.missed++;
      this.locked = this.gate ? this.locked + 1 : 0;
      // A long lock survives a beat or two of doubt (a breakdown); a fresh one does not.
      this.streak = this.gate ? this.streak + 1 : Math.max(0, this.streak - LIVE.loopStreak);
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
    const earliest = now + LIVE.solidBy + 0.25, spb = this._slotsPerBeat();
    for (;;) {
      const m = this.nextSlot, ts = this._slotTime(m);
      if (ts > horizon) break;
      this.nextSlot++;
      if (!this.gate) continue;
      if (ts < earliest) {
        // Updates stalled and this slot crossed the horizon unseen: too late
        // for a ghost, but a scheduled power block (its loop is in the track)
        // still goes in while it is ahead, solid unless it waits for its drop.
        if (ts > now && m % spb === 0 && this._powerAt(m / spb) >= 0) this._decide(m, ts, true);
        continue;
      }
      this._decide(m, ts, false);
    }
  }

  _decide(m, ts, late) {
    const spb = this._slotsPerBeat();
    const q = m % spb === 0 ? this._powerAt(m / spb) : -1;
    if (q >= 0) {
      // A scheduled power block, in the centre lane (always within the density cap).
      const L = this.pbLoop[q];
      const held = this.pbHeld[q] && !(L && L.checked && L.dropOk);
      this.pbBeat[q] = NaN;
      this.pbLoop[q] = null;
      if (L && L.checked && !L.dropOk) return; // its drop never came
      // A loop's own block sits at its centre, where the loop was committed (the grid may have glided since).
      const C = L ? null : this._loopOn(m / spb);
      const t = C ? C.time : ts;
      const i = this._add(t, 0, BLOCK.POWER, 1, 0, this.pbRank[q], this.beatAt(t));
      this.blocks.held[i] = held ? 1 : 0;
      if (late && !held) this.blocks.status[i] = STATUS.SOLID;
      if (L || C) (L || C).pbIndex = i;
      return;
    }
    if (late) return;
    const idx = ((m % LIVE.memory) + LIVE.memory) % LIVE.memory;
    const set = this.memSet[idx], s = this.memStrength[idx], band = this.memBand[idx];
    const onBeat = m % 2 === 0;
    let type = BLOCK.COLOUR, strength, useBand, rank = 0;
    if (onBeat) {
      if (set && s < LIVE.silentBeat) return;
      strength = set ? s : 0.5;
      useBand = set ? band : 0;
      if (this._weak(strength)) type = BLOCK.GREY;
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
    this._add(ts, this._lane(useBand, type, ts), type, strength, useBand, rank, this.beatAt(ts));
  }

  /** Queue slot of a power block scheduled on beat n, or −1. */
  _powerAt(n) {
    for (let q = 0; q < this.pbBeat.length; q++) if (this.pbBeat[q] === n) return q;
    return -1;
  }

  _queueFree() {
    for (let q = 0; q < this.pbBeat.length; q++) if (Number.isNaN(this.pbBeat[q])) return true;
    return false;
  }

  /** Schedule a power block on beat n (held: until its loop's drop is heard). */
  _queuePower(n, rank, held, loop) {
    for (let q = 0; q < this.pbBeat.length; q++) {
      if (!Number.isNaN(this.pbBeat[q])) continue;
      this.pbBeat[q] = n;
      this.pbRank[q] = rank;
      this.pbHeld[q] = held ? 1 : 0;
      this.pbLoop[q] = loop;
      return true;
    }
    return false;
  }

  // --- bars, phrases and loops ----------------------------------------------------

  /** Beat spans heard in full go to the bar tracker; completed bars may schedule a loop or a feature. */
  _spans(analysed) {
    const sky = this.skyline, win = LIVE.confirm, spec = this.spanSpec;
    for (;;) {
      const n = this.spanBeat, t0 = this.timeAtBeat(n), t1 = this.timeAtBeat(n + 1);
      if (t1 + 0.03 > analysed) break;
      this.spanBeat++;
      const f0 = Math.max(0, Math.round(t0 * sky.rate)), f1 = Math.round(t1 * sky.rate);
      let hasSpec = false;
      if (f1 > f0 && f1 <= sky.frames) {
        spec.fill(0);
        for (let f = f0; f < f1; f++) for (let d = 0; d < 16; d++) spec[d] += sky.data[f * 16 + d];
        for (let d = 0; d < 16; d++) spec[d] /= f1 - f0;
        hasSpec = true;
      }
      let accent = 0, kick = 0, energy = 0;
      for (let j = Math.max(0, this.onsetCount - 64); j < this.onsetCount; j++) {
        const i = j % 64, ot = this.onsetTime[i], os = this.onsetStrength[i];
        if (Math.abs(ot - t0) <= win) {
          if (os > accent) accent = os;
          if (this.onsetBand[i] === 0 && os > kick) kick = os;
        }
        if (ot >= t0 - win && ot < t1 - win) energy += os;
      }
      const B = this.bars, bar = B.push(n, hasSpec ? spec : null, accent, kick, energy, this.intensity);
      this.dbConf[mod(n, LIVE.downbeatPeak)] = B.downbeatConfidence;
      if (B.count <= 1) { this.dbStable = -1; this.dbCand = -1; this.dbConf.fill(0); }
      if (B.downbeat === this.dbCand) this.dbCandBeats++;
      else { this.dbCand = B.downbeat; this.dbCandBeats = 1; }
      if (this.dbCandBeats >= 4 && this.dbCand !== this.dbStable) { this.dbStable = this.dbCand; this.dbHeld = this.dbCandBeats - 1; }
      else this.dbHeld++;
      if (!bar) continue;
      if (this.bars.buildScore > 0) this._scheduleBuild(this.bars.buildScore);
      this._scheduleFeature();
    }
  }

  /**
   * Whether the bar tracker is sure of the bar lines, and with phrases of
   * the phrase lines. A power block's loop may take a bar line as soon as
   * the downbeat is confident enough; anything on a phrase line needs a
   * downbeat that reached phraseDownbeat recently and has held for a while
   * (its confidence sags in a breakdown with no kick, not its position).
   */
  _barsSure(phrases) {
    const B = this.bars;
    if (!phrases) return B.downbeatConfidence >= LIVE.downbeatConfidence;
    if (B.downbeat !== this.dbStable || this.dbHeld < LIVE.downbeatHeld) return false;
    let peak = 0;
    for (let i = 0; i < LIVE.downbeatPeak; i++) if (this.dbConf[i] > peak) peak = this.dbConf[i];
    return peak >= LIVE.phraseDownbeat && B.phraseLines > 0 && B.phraseConfidence >= LIVE.phraseConfidence;
  }

  /** Whether a shape on a phrase line may be scheduled at all. */
  _shapesAllowed() {
    return this.gate && this.streak >= LIVE.loopStreak && this._barsSure(true);
  }

  /** Song time of the last committed node. */
  _committedTime() {
    return this.nodes.t0 + (this.committed - 1) / NODE_RATE;
  }

  /**
   * Whether a loop centred at t fits: loopSpacing from every other loop (but `except`)
   * and shapeClear from a twist or flip already committed (one not yet
   * committed makes way for it, see _bump).
   */
  _loopFits(t, except = null) {
    const half = LAYOUT.loopLength / 2, tc = this._committedTime();
    for (let i = this.loops.length - 1; i >= 0; i--) {
      const S = this.loops[i];
      if (S === except) continue;
      if (!isFeature(S)) {
        if (Math.abs(S.time - t) < LIVE.loopSpacing) return false;
      } else if (S.start <= tc && t - half < S.end + LIVE.shapeClear && t + half > S.start - LIVE.shapeClear) return false;
    }
    return true;
  }

  /** Whether a twist or flip over [start, end] keeps featureGap from every other shape (as a file's). */
  _featureFits(start, end) {
    if (start < LAYOUT.featureNotBefore || end > this.duration - 3) return false;
    for (const S of this.loops) if (start < S.end + LAYOUT.featureGap && end > S.start - LAYOUT.featureGap) return false;
    return true;
  }

  /** Twists and flips not yet committed within featureGap of [start, end] make way for a loop. */
  _bump(start, end) {
    const tc = this._committedTime();
    for (let i = this.loops.length - 1; i >= 0; i--) {
      const S = this.loops[i];
      if (!isFeature(S) || S.start <= tc || start >= S.end + LAYOUT.featureGap || end <= S.start - LAYOUT.featureGap) continue;
      this.loops.splice(i, 1);
      this.stats[S.type === LOOP.FLIP ? 'flips' : 'twists']--;
      this.stats.bumped++;
    }
  }

  /** Set shape S's times from its beat on the current grid (a flip spans flipBars bars from it). */
  _shape(S) {
    const t = this.timeAtBeat(S.beat), barLen = 4 * this.grid.T;
    S.time = t;
    if (S.type === LOOP.TWIST) {
      const len = twistLength(barLen);
      S.start = t - len / 2;
      S.end = t + len / 2;
    } else if (S.type === LOOP.FLIP) {
      const half = flipHalf(barLen);
      S.start = t - half / 2;
      S.end = this.timeAtBeat(S.beat + 4 * LAYOUT.flipBars) + half / 2;
      S.inEnd = S.start + half;
      S.outStart = S.end - half;
    } else {
      S.start = t - LAYOUT.loopLength / 2;
      S.end = t + LAYOUT.loopLength / 2;
    }
  }

  /** Insert shape S by start. */
  _insert(S) {
    let i = this.loops.length;
    while (i > 0 && this.loops[i - 1].start > S.start) i--;
    this.loops.splice(i, 0, S);
    return S;
  }

  _addLoop(type, beat, predicted) {
    const L = { type, time: 0, start: 0, end: 0, beat, dir: 1, predicted, checked: false, dropOk: false, pbIndex: -1, fixed: false };
    this._shape(L);
    this._bump(L.start, L.end);
    this._insert(L);
    this.stats.loops++;
    return L;
  }

  /**
   * Shapes whose nodes are not committed yet follow their beat on the
   * gliding grid, so a loop stays on its beat and on its power block; once
   * the first of their nodes is committed they stay where they are.
   */
  _settleShapes() {
    if (!this.grid.valid) return;
    const tc = this._committedTime();
    for (let i = this.loops.length - 1; i >= 0; i--) {
      const S = this.loops[i];
      if (S.start <= tc) break; // sorted by start: every earlier one is committed too
      if (S.fixed) continue;
      const time = S.time, start = S.start, end = S.end, inEnd = S.inEnd, outStart = S.outStart;
      this._shape(S);
      if (S.start <= tc) { S.time = time; S.start = start; S.end = end; S.inEnd = inEnd; S.outStart = outStart; }
    }
  }

  /**
   * A build just ended a bar: the drop is predicted on the phrase line it
   * runs into. Only when every estimate is sure. A double corkscrew for a
   * big build, or for one rising out of a breakdown. A power block's plain
   * loop not yet committed near that line becomes the drop's loop (moved
   * onto the line if its block is still to be placed; the block stays
   * earned); otherwise a new loop goes there if it is still dropLead ahead.
   */
  _scheduleBuild(score) {
    if (!this._shapesAllowed()) return;
    const B = this.bars, now = this.now;
    // One build, one drop: a rise that began before the last predicted drop was that drop's.
    const from = this.timeAtBeat(B.downbeat + 4 * (B.lastBar - BARS.buildBars));
    for (let i = this.loops.length - 1; i >= 0; i--) if (this.loops[i].predicted && this.loops[i].time > from) return;
    // The drop is on the phrase line the build runs into.
    const end = B.downbeat + 4 * (B.lastBar + 1);
    const beat = B.nextPhraseStart(end);
    const t = this.timeAtBeat(beat);
    if (beat - end > 4 * LIVE.buildReach || t - now > LIVE.loopReach) return;
    const type = score >= LIVE.bigBuild || this._depth() >= LIVE.bigDepth ? LOOP.DOUBLE : LOOP.CORKSCREW;
    const E = this._earnedNear(beat);
    if (E) {
      if (E.beat !== beat) {
        this.pbBeat[this._powerAt(E.beat)] = beat;
        this.loops.splice(this.loops.indexOf(E), 1);
        E.beat = beat;
        this._shape(E);
        this._bump(E.start, E.end);
        this._insert(E);
      }
      E.type = type;
      E.predicted = true;
      this.stats.predicted++;
      if (type === LOOP.DOUBLE) {
        const q = this._powerAt(beat);
        if (q >= 0) this.pbRank[q] = 1;
        else if (E.pbIndex >= 0) this.blocks.pbRank[E.pbIndex] = 1;
      }
      return;
    }
    if (t - now < LIVE.dropLead || !this._loopFits(t)) return;
    const L = this._addLoop(type, beat, true);
    this.stats.predicted++;
    this._queuePower(this._afterDrop(beat), type === LOOP.DOUBLE ? 1 : 2, true, L);
  }

  /**
   * A power block's plain loop, not committed, that a drop on beat n can
   * take: on n, or near it with its block still queued and room on n.
   */
  _earnedNear(n) {
    const tc = this._committedTime() + 0.1, t = this.timeAtBeat(n);
    for (let i = this.loops.length - 1; i >= 0; i--) {
      const E = this.loops[i];
      if (E.start <= tc) break;
      if (isFeature(E) || E.predicted || E.fixed || E.type !== LOOP.PLAIN || Math.abs(E.time - t) >= LIVE.loopSpacing) continue;
      if (E.beat === n) return E;
      if (this._powerAt(E.beat) < 0 || t - LAYOUT.loopLength / 2 <= tc || !this._loopFits(t, E)) continue;
      return E;
    }
    return null;
  }

  /** The bar line a drop's held power block waits on: the first after the drop that leaves time to hear it. */
  _afterDrop(beat) {
    let b = this.bars.nextBarStart(beat + 1);
    while (this.timeAtBeat(b) - this.timeAtBeat(beat + 1) < LIVE.pbCheck) b += 4;
    return b;
  }

  /** How far the last 8 bars sank below the loudest of the last 32 (a breakdown before the big drop). */
  _depth() {
    const B = this.bars, last = B.lastBar;
    let hi = 0, lo = Infinity;
    for (let j = last - 31; j <= last; j++) {
      const s = B.downbeat + 4 * j;
      if (!B.has(s) || !B.has(s + 3)) continue;
      const l = (B.levelAt(s) + B.levelAt(s + 1) + B.levelAt(s + 2) + B.levelAt(s + 3)) / 4;
      if (l > hi) hi = l;
      if (j > last - 8 && l < lo) lo = l;
    }
    return lo < Infinity ? hi - lo : 0;
  }

  /** The scheduled loop (not a twist or flip) centred on beat n, if any. */
  _loopOn(n) {
    for (let i = this.loops.length - 1; i >= 0; i--) {
      const L = this.loops[i];
      if (L.beat === n && !L.fixed && !isFeature(L)) return L;
    }
    return null;
  }

  /**
   * 16 locked bars earn a power block with a plain loop: on the next
   * phrase line ahead if the phrases are known, else (after waiting up to
   * pbWait more beats for them) the next bar line, the tracker's own if
   * the bar lines are not known either.
   */
  _schedulePower(now) {
    for (let q = 0; q < this.pbBeat.length; q++) {
      if (!Number.isNaN(this.pbBeat[q]) && this.timeAtBeat(this.pbBeat[q]) < now) { this.pbBeat[q] = NaN; this.pbLoop[q] = null; }
    }
    if (this.locked < LIVE.pbBeats || !this.gate) return;
    if (this.locked < LIVE.pbBeats + LIVE.pbWait && !this._barsSure(true)) return;
    const B = this.bars, first = Math.ceil(this.beatAt(now + LIVE.loopLead));
    let beat = NaN;
    if (this._barsSure(true)) {
      const b = B.nextPhraseStart(first);
      if (this.timeAtBeat(b) - now <= LIVE.loopReach && this._loopFits(this.timeAtBeat(b))) beat = b;
    }
    if (Number.isNaN(beat)) {
      for (let b = this._barsSure(false) ? B.nextBarStart(first) : first + (((-first % 4) + 4) % 4); this.timeAtBeat(b) - now <= LIVE.loopReach; b += 4) {
        if (this._loopFits(this.timeAtBeat(b))) { beat = b; break; }
      }
    }
    if (Number.isNaN(beat) || this._powerAt(beat) >= 0 || !this._queueFree()) return;
    this._addLoop(LOOP.PLAIN, beat, false);
    this._queuePower(beat, 2, false, null);
    this.locked = 0;
  }

  /**
   * Was a predicted drop heard? Judged once the beat after it is heard: a
   * drop brings the low end back, so the strongest low-band onset from its
   * downbeat to the next beat (a kick heard a little late, or a beat late,
   * still counts) must be strong and either well above the bar before or
   * with the intensity lifting, or moderate with a clear lift. Its power
   * block is released (solid at once), or withdrawn.
   */
  _checkDrops(analysed) {
    const B = this.bars, win = LIVE.confirm;
    for (let k = this.loops.length - 1; k >= 0; k--) {
      const L = this.loops[k];
      if (L.end < analysed - 30) break;
      if (!L.predicted || L.checked) continue;
      const t0 = L.time, t1 = t0 + this.grid.T;
      if (t1 + win + 0.015 > analysed) continue;
      let hit = 0;
      for (let j = Math.max(0, this.onsetCount - 64); j < this.onsetCount; j++) {
        const i = j % 64, ot = this.onsetTime[i];
        if (this.onsetBand[i] === 0 && ot >= t0 - win && ot <= t1 + win && this.onsetStrength[i] > hit) hit = this.onsetStrength[i];
      }
      let kick = 0, level = 0, n = 0;
      if (!L.fixed) for (let m = L.beat - 4; m < L.beat; m++) if (B.has(m)) { kick += B.kickAt(m); level += B.levelAt(m); n++; }
      if (n) { kick /= n; level /= n; } else level = this.intensity;
      const lift = this.intensity - level;
      L.checked = true;
      L.dropOk = (hit >= LIVE.dropKick && (hit >= LIVE.dropKickJump * kick || lift >= LIVE.dropLift)) || (hit >= LIVE.dropKickSoft && lift >= LIVE.dropLiftClear);
      if (L.dropOk) this.stats.drops++;
      else this.stats.falseDrops++;
      if (L.dropOk && L.pbIndex >= 0) {
        const b = this.blocks;
        b.held[L.pbIndex] = 0;
        if (b.status[L.pbIndex] === STATUS.GHOST) b.status[L.pbIndex] = STATUS.SOLID;
      }
    }
  }

  /**
   * A bar just completed. If the bar line before it was a phrase line where
   * the song changed strongly (featureNovelty, and more than at the bar
   * line before), a twist goes on the next phrase line at least loopLead
   * ahead (or four bars either side of it, if that one is taken); a flip if
   * the song fell into a calmer section. Directions alternate.
   */
  _scheduleFeature() {
    const B = this.bars, P = B.lastBar - 1;
    if (!this._shapesAllowed() || B.phraseConfidence < LIVE.featurePhrase || B.phraseLines < LIVE.featureLines) return;
    if (P === this.featureLine || mod(P - B.phrase, 8) !== 0) return;
    const nov = B.lineNovelty(P);
    if (!(nov >= LIVE.featureNovelty) || B.lineNovelty(P - 1) > nov) return;
    this.featureLine = P;
    const type = B.lineLift(P) <= -LAYOUT.flipFall ? LOOP.FLIP : LOOP.TWIST;
    const line = B.nextPhraseStart(Math.ceil(this.beatAt(this.now + LIVE.loopLead)));
    for (let c = 0; c < 3; c++) {
      const S = { type, time: 0, start: 0, end: 0, beat: c === 0 ? line : c === 1 ? line - 16 : line + 16, dir: this.featureDir, predicted: false, checked: false, dropOk: false, pbIndex: -1, fixed: false };
      this._shape(S);
      if (S.time - this.now < LIVE.loopLead || S.time - this.now > LIVE.loopReach || !this._featureFits(S.start, S.end)) continue;
      this._insert(S);
      this.featureDir = -this.featureDir;
      this.stats[type === LOOP.FLIP ? 'flips' : 'twists']++;
      return;
    }
  }

  // --- sweeps -------------------------------------------------------------------

  /**
   * Plan the track's heading along its length, sweepLead past the farthest
   * the provisional tail reaches, so a sweep is planned before any of it is
   * drawn and never changes after. 8-bar stretches at the speed heard now
   * (the file's sweeps), stopping sweepClear short of a shape known by then
   * or starting that far after it, none before featureNotBefore. A stretch
   * gets a sweep when the intensity heard now reaches sweepIntensity (its
   * swing grows with it; directions alternate); a quieter one stays
   * straight and is short. A shape scheduled later may land in a sweep:
   * the bank fades out around it, the heading does not.
   */
  _planSweeps(now) {
    const st = this.st, until = st.ground + LIVE.tailDistance + LIVE.sweepLead;
    const speed = Math.max(1, this.cfg.speedMin + (this.cfg.speedMax - this.cfg.speedMin) * Math.pow(this.intensity, 1.3));
    const T = this.grid.valid ? this.grid.T : 0.5, len = speed * Math.min(20, Math.max(LAYOUT.sweepMin, LAYOUT.sweepBars * 4 * T));
    const clear = LAYOUT.sweepClear * speed;
    for (let guard = 0; this.sweepEnd < until && guard < 8; guard++) {
      let start = Math.max(this.sweepEnd, st.ground + 1), end = start + len;
      if (now + LIVE.horizon < LAYOUT.featureNotBefore) { this.sweepEnd = start + speed; continue; }
      for (const S of this.loops) {
        const s0 = this._groundAt(S.start), s1 = this._groundAt(S.end);
        if (s1 + clear <= start) continue;
        if (s0 - clear >= end) break;
        if (s0 - clear - start >= LAYOUT.sweepMin * speed) { end = s0 - clear; break; }
        start = s1 + clear;
        end = start + len;
      }
      if (this.intensity >= LAYOUT.sweepIntensity) {
        const W = this.sweeps, dir = W.length ? -W[W.length - 1].dir : 1;
        W.push({ start, end, yaw: LAYOUT.sweepYaw + LAYOUT.sweepYawI * this.intensity, dir });
        this.stats.sweeps++;
        this.sweepEnd = end;
      } else this.sweepEnd = start + (LAYOUT.sweepMin / 2) * speed;
    }
  }

  /** Ground distance at song time t, as drawn now (past the tail, at its end speed). */
  _groundAt(t) {
    const nd = this.nodes, n = nd.count, x = (t - nd.t0) * NODE_RATE;
    if (n < 2) return 0;
    if (x >= n - 1) return nd.ground[n - 1] + (x - (n - 1)) / NODE_RATE * nd.speed[n - 1];
    const i = Math.max(0, Math.floor(x)), f = Math.max(0, x - i);
    return nd.ground[i] + (nd.ground[i + 1] - nd.ground[i]) * f;
  }

  /** Seconds from t to the nearest shape (0 inside one), looking from shape li − 1 on. */
  _shapeGap(t, li) {
    let gap = Infinity;
    for (let j = Math.max(0, li - 1); j < this.loops.length; j++) {
      const S = this.loops[j];
      if (S.start - t >= LAYOUT.bankFade) break;
      gap = Math.min(gap, Math.max(0, S.start - t, t - S.end));
    }
    return gap;
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
    b.status[i] = STATUS.GHOST; b.alpha[i] = 0; b.beatPos[i] = beatPos; b.held[i] = 0;
    this.stats.placed++;
    if (type === BLOCK.POWER) this.stats.powerBlocks++;
    return i;
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
    grow(nd, ['dist', 'ground', 'pos', 'loop', ...Object.keys(NODE_FIELDS)], Math.max(n, nd.capacity * 2));
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
    ts.p = st.p; ts.x = st.x; ts.y = st.y; ts.z = st.z; ts.dist = st.dist; ts.ground = st.ground; ts.beat = st.beat; ts.speed = st.speed;
    ts.li = st.li; ts.side = st.side; ts.si = st.si; ts.yaw = st.yaw; ts.bank = st.bank;
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
   * pitch as offline (pitch rate-limited to 12°/s), heading along the
   * track's length from seeded slow noise calmer where blocks are dense
   * plus any planned sweep, beat
   * position from the grid, and any scheduled shape (shapePose, as a
   * file's). The frame is analytic: forward from the base heading plus the
   * shape's own motion, up rolled by the shape and banked into the curve
   * (the file's bank: bankTarget from the heading rate, faded out next to
   * shapes, rate limited). Only planned sweeps and shapes are read, so the
   * tail replays exactly what committing would write.
   */
  _node(k, I, st) {
    const nd = this.nodes, cfg = this.cfg, dt = 1 / NODE_RATE;
    const t = nd.t0 + k / NODE_RATE;
    const speed = cfg.speedMin + (cfg.speedMax - cfg.speedMin) * Math.pow(I, 1.3);
    const target = I < 0.5 ? (LAYOUT.pitchUp * (0.5 - I)) / 0.5 : (-LAYOUT.pitchDown * (I - 0.5)) / 0.5;
    const maxStep = LAYOUT.pitchRate * dt;
    if (k === 0) { st.p = target; st.speed = speed; }
    st.p += Math.max(-maxStep, Math.min(maxStep, target - st.p));
    // Heading laid out over the ground (the file's slow noise, at a 45 m/s
    // reference, plus the sweeps): the plan view of the tail is the same
    // curve whatever speed and slope it is drawn at, so a change of
    // intensity never swings it sideways.
    const along = st.ground;
    let noise = 0;
    for (let w = 0; w < 3; w++) noise += this.waves[w][1] * Math.sin(2 * Math.PI * this.waves[w][0] * (along / NOISE_SPEED) + this.waves[w][2]);
    let yawDeg = LAYOUT.yawAmplitude * noise * (1 - 0.6 * this._density(t));
    const W = this.sweeps;
    while (st.si < W.length && along > W[st.si].end) st.si++;
    if (st.si < W.length && along >= W[st.si].start) yawDeg += sweepYawAt(W[st.si], along);
    const yaw = yawDeg * DEG;
    // Loops: plain ones leave the track shifted sideways for good.
    const loops = this.loops, pose = this.pose;
    while (st.li < loops.length && t > loops[st.li].end) {
      if (loops[st.li].type === LOOP.PLAIN) st.side += LAYOUT.loopSideShift;
      st.li++;
    }
    const L = loops[st.li];
    if (L && t >= L.start) shapePose(L, t, pose);
    else { pose.pitch = 0; pose.roll = 0; pose.rollRate = 0; pose.side = 0; pose.sideRate = 0; pose.radius = 0; pose.mark = 0; }
    // Bank into the curve.
    if (k === 0) { st.yaw = yaw; st.bank = 0; }
    let bank = bankTarget(speed, (yaw - st.yaw) * NODE_RATE, I);
    const gap = this._shapeGap(t, st.li);
    if (gap < LAYOUT.bankFade) bank *= smootherstep(gap / LAYOUT.bankFade);
    const bankStep = LAYOUT.bankRate * DEG * dt;
    st.bank += Math.max(-bankStep, Math.min(bankStep, bank - st.bank));
    st.yaw = yaw;
    const pitch = st.p * DEG, pr = pitch + pose.pitch;
    const cp = Math.cos(pr), sp = Math.sin(pr), cy = Math.cos(yaw), sy = Math.sin(yaw);
    const fx = sy * cp, fy = sp, fz = -cy * cp;
    const ux = -sy * sp, uy = cp, uz = cy * sp;
    const rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
    if (k > 0) {
      const ds = 0.5 * (st.speed + speed) * dt;
      st.x += fx * ds; st.y += fy * ds; st.z += fz * ds;
      st.dist += ds;
      st.ground += cp * ds;
    }
    st.speed = speed;
    const rho = pose.roll, R = pose.radius, cr = Math.cos(rho), sr = Math.sin(rho), side = st.side + pose.side;
    const a = R * (1 - cr), c = -R * sr;
    nd.pos[k * 3] = st.x + a * ux + c * rx + side * cy;
    nd.pos[k * 3 + 1] = st.y + a * uy + c * ry;
    nd.pos[k * 3 + 2] = st.z + a * uz + c * rz + side * sy;
    nd.dist[k] = st.dist;
    nd.ground[k] = st.ground;
    // Velocity: along the base heading, plus the roll about its axis and the sideways shift.
    const w = R * pose.rollRate;
    let vx = fx * speed + w * (sr * ux - cr * rx) + pose.sideRate * cy;
    let vy = fy * speed + w * (sr * uy - cr * ry);
    let vz = fz * speed + w * (sr * uz - cr * rz) + pose.sideRate * sy;
    const vl = Math.hypot(vx, vy, vz) || 1;
    vx /= vl; vy /= vl; vz /= vl;
    const lean = rho + st.bank, cl = Math.cos(lean), sl = Math.sin(lean);
    let px = cl * ux + sl * rx, py = cl * uy + sl * ry, pz = cl * uz + sl * rz;
    const d = px * vx + py * vy + pz * vz;
    px -= d * vx; py -= d * vy; pz -= d * vz;
    const pl = Math.hypot(px, py, pz) || 1;
    nd.fwd[k * 3] = vx; nd.fwd[k * 3 + 1] = vy; nd.fwd[k * 3 + 2] = vz;
    nd.up[k * 3] = px / pl; nd.up[k * 3 + 1] = py / pl; nd.up[k * 3 + 2] = pz / pl;
    nd.intensity[k] = I;
    nd.speed[k] = speed;
    nd.pitch[k] = pitch;
    nd.yaw[k] = yaw;
    nd.roll[k] = lean;
    nd.loop[k] = pose.mark;
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
