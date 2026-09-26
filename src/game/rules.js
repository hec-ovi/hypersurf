// Gameplay rules for Mono and its variants (Ninja, Casual). Pure: no DOM,
// no GPU, no clock of its own. The game loop feeds it song time and ship x
// at a fixed step; it resolves block hits, runs the match timer and keeps
// the score. Rules follow docs/research.md §1.2.
//
// The grid is 3 columns × 7 rows with gravity, and Mono has a single block
// colour, so the grid is fully described by its column heights: with the
// centre column filled every block touches every other one, and with it
// empty the outer columns are separate groups.

import { BLOCK } from '../audio/songmap.js';

export const COLUMNS = 3;
export const ROWS = 7;

/** Lane centres are at x = 3·lane; dividers at ±1.5, shoulders at ±4.5. */
export const LANE_WIDTH = 3;
export const SHOULDER_X = 4.5;
/** Past this |x| a ship on a shoulder touches nothing. */
export const SHOULDER_EDGE = (LANE_WIDTH + SHOULDER_X) / 2;

/**
 * Hit windows in seconds around the block's time: a block can be taken from
 * `early` before it to `late` after it. Colours (and power blocks) are
 * forgiving, greys tight, in AS2's ~4:1 ratio.
 */
export const HIT_WINDOW = Object.freeze({
  colour: Object.freeze({ early: 0.02, late: 0.07 }),
  grey: Object.freeze({ early: 0.01, late: 0.018 }),
});

export const SCORE = Object.freeze({
  /** Points per match: base · n². */
  base: 35,
  /** Power block with a live match. */
  pbMultiplier: 1.5,
  bigPbMultiplier: 2,
  /**
   * An overfill this soon after a power block pays only a fraction, so a
   * duplicated grid cannot be cashed in at once. AS2 calls it a "much
   * smaller" result without a number; the quarter is our starting value.
   */
  pbOverfillWindow: 1,
  pbOverfillFactor: 0.25,
  /** A falling block holds the timer for fallBase + fallPerRow · empty rows. */
  fallBase: 0.25,
  fallPerRow: 0.1,
});

/** Lane under ship x: -1, 0, 1, or null on a shoulder. */
export function laneAt(x, shoulders = false) {
  if (shoulders && Math.abs(x) > SHOULDER_EDGE) return null;
  return x < -LANE_WIDTH / 2 ? -1 : x > LANE_WIDTH / 2 ? 1 : 0;
}

/** Clamp ship x to the drivable width. */
export function clampShipX(x, shoulders = false) {
  const m = shoulders ? SHOULDER_X : LANE_WIDTH;
  return x < -m ? -m : x > m ? m : x;
}

export function hitWindow(type) {
  return type === BLOCK.GREY ? HIT_WINDOW.grey : HIT_WINDOW.colour;
}

/** Whether a block of this type can be hit dt seconds after its time (dt < 0: early). */
export function inHitWindow(type, dt) {
  const w = hitWindow(type);
  return dt >= -w.early && dt <= w.late;
}

/** Points for one connected match of n blocks. */
export const matchPoints = (n) => SCORE.base * n * n;

/** Timer hold for a block falling into a column that holds `height` blocks. */
export const fallHold = (height) => SCORE.fallBase + SCORE.fallPerRow * (ROWS - height);

/**
 * Sizes of the groups that would score, from column heights [left, centre, right].
 * With the centre filled everything is one group; with it empty each outer
 * column is its own group and scores only with more than two blocks.
 */
export function scoringGroups(heights) {
  const [l, c, r] = heights;
  if (c > 0) return l + c + r >= 3 ? [l + c + r] : [];
  const out = [];
  if (l > 2) out.push(l);
  if (r > 2) out.push(r);
  return out;
}

/** Whether the grid holds a match (≥ 3 connected blocks). */
export function hasMatch(heights) {
  return heights[1] > 0 ? heights[0] + heights[1] + heights[2] >= 3 : heights[0] > 2 || heights[2] > 2;
}

// --- modes -------------------------------------------------------------------

export const GREY_EFFECT = Object.freeze({ ERASE_ONE: 0, ERASE_ALL: 1 });

/**
 * Per-mode rules. Speed and density differences (Ninja faster and denser,
 * Casual slower with fewer power blocks) live in the SongMap's MODES.
 *   timer        match collection seconds
 *   grey         what a grey does: eraseone (Mono/Casual) or eraseall (Ninja spike)
 *   greyResets   whether a grey hit resets the match timer
 *   shoulders    whether the ship can ride the shoulders, where nothing is hit
 *   cleanFinish  bonus fraction for ending with an empty grid
 *   stealth      bonus fraction for hitting no spikes
 */
export const RULES = Object.freeze({
  mono: Object.freeze({ timer: 1.5, grey: GREY_EFFECT.ERASE_ONE, greyResets: true, shoulders: false, cleanFinish: 0.1, stealth: 0 }),
  ninja: Object.freeze({ timer: 1.5, grey: GREY_EFFECT.ERASE_ALL, greyResets: false, shoulders: false, cleanFinish: 0, stealth: 0.25 }),
  casual: Object.freeze({ timer: 1.75, grey: GREY_EFFECT.ERASE_ONE, greyResets: true, shoulders: true, cleanFinish: 0.1, stealth: 0 }),
});

// --- engine ------------------------------------------------------------------

export const EVENT = Object.freeze({
  HIT: 1, // colour block landed in the grid
  MISS: 2, // block passed untouched
  GREY: 3, // grey took the top block of its column (value: 1 if a block was erased)
  SPIKE: 4, // Ninja spike wiped the grid (count: blocks lost)
  POWER: 5, // power block: mult > 1 multiplied the live match, else the grid was duplicated
  MATCH: 6, // a match formed and the timer started
  COLLECT: 7, // a match was scored (value: points, count: blocks, reason)
});

export const REASON = Object.freeze({ TIMER: 1, OVERFILL: 2, PB_OVERFILL: 3, FINISH: 4 });

const EVENT_POOL = 256;
const PENDING = 0, TAKEN = 1, MISSED = 2;
/** Block state of a block the live map withdrew (a ghost no beat confirmed). */
export const WITHDRAWN = 3;

/** Per-lane union of chain spans as sorted, disjoint [start, end) intervals. */
function spanLanes(blocks) {
  const lanes = [];
  for (let lane = -1; lane <= 1; lane++) {
    const iv = [];
    for (let i = 0; i < blocks.count; i++) {
      if (blocks.lane[i] !== lane || blocks.type[i] === BLOCK.POWER || !(blocks.spanEnd[i] > blocks.time[i])) continue;
      iv.push([blocks.time[i], blocks.spanEnd[i]]);
    }
    iv.sort((a, b) => a[0] - b[0]);
    const start = [], end = [];
    for (const [s, e] of iv) {
      if (end.length && s <= end[end.length - 1]) end[end.length - 1] = Math.max(end[end.length - 1], e);
      else { start.push(s); end.push(e); }
    }
    lanes.push({ start: Float64Array.from(start), end: Float64Array.from(end) });
  }
  return lanes;
}

/** Index of the last interval starting at or before t, or -1. */
function lastStartAtOrBefore(starts, t) {
  let lo = 0, hi = starts.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (starts[m] <= t) lo = m + 1; else hi = m; }
  return lo - 1;
}

/**
 * One play of one SongMap. Drive it with step(songTime, shipX) at a fixed
 * rate in increasing time, then finish() at the end of the song and read
 * results(). step() allocates nothing: hits, misses and cash-ins are
 * reported through a pooled event list (events[0 … eventCount)) that the
 * caller empties with clearEvents() once per frame.
 *
 * Within a step the ship is taken to be in lane(shipX) for the whole
 * interval (previous time, songTime]. A block is taken when its hit window
 * overlaps that interval with the ship in its lane, at the start of the
 * overlap; everything else in the step happens in time order.
 *
 * A live map's blocks grow while it plays (blocks.count rises; chain spans
 * never appear there): new blocks are counted as they arrive, and withdraw()
 * takes back one that was placed but never confirmed.
 *
 * @param blocks  SongMap blocks ({ count, time, lane, type, spanEnd, pbRank })
 * @param mode    'mono' | 'ninja' | 'casual'
 */
export class RulesEngine {
  constructor(blocks, mode = 'mono') {
    const rules = RULES[mode];
    if (!rules) throw new Error(`unknown mode ${mode}`);
    this.mode = mode;
    this.rules = rules;
    this.blocks = blocks;
    this.state = new Uint8Array(Math.max(blocks.count, blocks.capacity || 0));
    this.spans = spanLanes(blocks);

    this.now = -Infinity;
    this.lane = 0;
    /** Grid cells, column-major from the bottom: cells[col · ROWS + row] = block index, -1 if empty. */
    this.cells = new Int32Array(COLUMNS * ROWS).fill(-1);
    this.heights = new Uint8Array(COLUMNS);
    this.timerActive = false;
    this.timer = 0;
    this.hold = 0;
    this.multiplier = 1;
    this.lastPowerTime = -Infinity;
    this.score = 0;
    this.finished = false;

    this.stats = {
      colour: 0, colourHit: 0, grey: 0, greyHit: 0, power: 0, powerHit: 0,
      matches: 0, biggestMatch: 0, bestCollect: 0, overfills: 0, pbOverfills: 0, duplications: 0, multiplied: 0,
    };
    this.counted = 0;
    this._admit();

    this.events = Array.from({ length: EVENT_POOL }, () => ({ type: 0, time: 0, block: -1, lane: 0, value: 0, count: 0, mult: 1, reason: 0 }));
    this.eventCount = 0;
    this.droppedEvents = 0;

    this._first = 0;
    this._actIndex = new Int32Array(64);
    this._actTime = new Float64Array(64);
  }

  get timerFraction() {
    return this.timerActive ? this.timer / this.rules.timer : 0;
  }

  clearEvents() {
    this.eventCount = 0;
  }

  /** Count blocks added since the last call (a live map's grow as it plays). */
  _admit() {
    const b = this.blocks;
    if (b.count > this.state.length) {
      const next = new Uint8Array(Math.max(b.count, this.state.length * 2));
      next.set(this.state);
      this.state = next;
    }
    for (let i = this.counted; i < b.count; i++) this._tally(b.type[i], 1);
    this.counted = b.count;
  }

  _tally(type, d) {
    if (type === BLOCK.GREY) this.stats.grey += d; else if (type === BLOCK.POWER) this.stats.power += d; else this.stats.colour += d;
  }

  /** Take back block i before it was played (live ghosts nothing confirmed). */
  withdraw(i) {
    if (i >= this.counted) this._admit();
    if (this.state[i] !== PENDING) return;
    this.state[i] = WITHDRAWN;
    this._tally(this.blocks.type[i], -1);
  }

  /** Advance to song time t with the ship at x (metres from the centre line). */
  step(t, x) {
    if (this.finished || !(t > this.now)) return;
    if (this.blocks.count !== this.counted) this._admit();
    const lane = laneAt(x, this.rules.shoulders);
    this.lane = lane;
    const b = this.blocks, t0 = this.now;
    // Collect this step's hits and misses, then apply them in time order.
    let n = 0;
    for (let i = this._first; i < b.count && b.time[i] - HIT_WINDOW.colour.early <= t; i++) {
      if (this.state[i] !== PENDING) continue;
      const w = hitWindow(b.type[i]);
      const open = b.time[i] - w.early, close = b.time[i] + w.late;
      if (open > t) continue;
      let at;
      if (lane !== null && lane === b.lane[i] && close >= t0) at = open > t0 ? open : t0;
      else if (close <= t) at = close;
      else continue;
      if (n === this._actIndex.length) this._growActions();
      // Insertion sort by time, then block order.
      let k = n++;
      while (k > 0 && this._actTime[k - 1] > at) {
        this._actTime[k] = this._actTime[k - 1];
        this._actIndex[k] = this._actIndex[k - 1];
        k--;
      }
      this._actTime[k] = at;
      this._actIndex[k] = i;
    }
    for (let k = 0; k < n; k++) {
      const i = this._actIndex[k], at = this._actTime[k];
      this._advance(at);
      const hit = lane !== null && lane === b.lane[i] && b.time[i] + hitWindow(b.type[i]).late >= t0;
      if (hit) this._take(i, at);
      else {
        this.state[i] = MISSED;
        this._emit(EVENT.MISS, at, i, b.lane[i], 0, 0, 1, 0);
      }
    }
    this._advance(t);
    while (this._first < b.count && this.state[this._first] !== PENDING) this._first++;
  }

  /**
   * Start a fresh play at song time t instead of the top (practice and
   * debug starts): blocks whose windows closed before t are resolved as
   * missed without events or score, and the clock starts at t.
   */
  skipTo(t) {
    if (!(t > this.now)) return;
    if (this.blocks.count !== this.counted) this._admit();
    const b = this.blocks;
    for (let i = this._first; i < b.count && b.time[i] - HIT_WINDOW.colour.early < t; i++) {
      if (this.state[i] === PENDING && b.time[i] + hitWindow(b.type[i]).late < t) this.state[i] = MISSED;
    }
    while (this._first < b.count && this.state[this._first] !== PENDING) this._first++;
    this.now = t;
  }

  /** End of song: a live match is scored and anything left untouched counts as missed. */
  finish() {
    if (this.finished) return;
    if (this.blocks.count !== this.counted) this._admit();
    if (this.timerActive) this._collect(this.now, REASON.FINISH);
    for (let i = this._first; i < this.blocks.count; i++) if (this.state[i] === PENDING) this.state[i] = MISSED;
    this.finished = true;
  }

  /** Raw score → mode bonuses → final score, plus play statistics. */
  results() {
    this.finish();
    const raw = this.score, bonuses = [];
    const empty = this.heights[0] + this.heights[1] + this.heights[2] === 0;
    if (this.rules.cleanFinish > 0 && empty) {
      bonuses.push({ id: 'clean', label: 'Clean Finish', percent: Math.round(this.rules.cleanFinish * 100), points: Math.round(raw * this.rules.cleanFinish) });
    }
    // Stealth needs at least one spike to have dodged.
    if (this.rules.stealth > 0 && this.stats.grey > 0 && this.stats.greyHit === 0) {
      bonuses.push({ id: 'stealth', label: 'Stealth', percent: Math.round(this.rules.stealth * 100), points: Math.round(raw * this.rules.stealth) });
    }
    const final = raw + bonuses.reduce((a, bn) => a + bn.points, 0);
    return { mode: this.mode, raw, bonuses, final, stats: { ...this.stats } };
  }

  // --- internals ---

  _growActions() {
    const idx = new Int32Array(this._actIndex.length * 2), tm = new Float64Array(this._actTime.length * 2);
    idx.set(this._actIndex); tm.set(this._actTime);
    this._actIndex = idx; this._actTime = tm;
  }

  _emit(type, time, block, lane, value, count, mult, reason) {
    if (this.eventCount === EVENT_POOL) { this.droppedEvents++; return; }
    const e = this.events[this.eventCount++];
    e.type = type; e.time = time; e.block = block; e.lane = lane; e.value = value; e.count = count; e.mult = mult; e.reason = reason;
  }

  /** End of the chain span under the ship at time t, or -1 if not riding one. */
  _rideEnd(t) {
    if (this.lane === null) return -1;
    const s = this.spans[this.lane + 1];
    const k = lastStartAtOrBefore(s.start, t);
    return k >= 0 && s.end[k] > t ? s.end[k] : -1;
  }

  _nextSpanStart(t) {
    if (this.lane === null) return Infinity;
    const s = this.spans[this.lane + 1];
    const k = lastStartAtOrBefore(s.start, t) + 1;
    return k < s.start.length ? s.start[k] : Infinity;
  }

  /** Run the clock to time b: falling blocks hold the timer, riding a chain span pauses it. */
  _advance(b) {
    let t = this.now;
    if (!(b > t)) return;
    if (!this.timerActive) {
      this.hold = Math.max(0, this.hold - (b - t));
      this.now = b;
      return;
    }
    const h = Math.min(this.hold, b - t);
    this.hold -= h;
    t += h;
    while (t < b) {
      const ride = this._rideEnd(t);
      if (ride > t) { t = Math.min(b, ride); continue; }
      const next = Math.min(b, this._nextSpanStart(t));
      if (this.timer <= next - t) {
        t += this.timer;
        this.timer = 0;
        this._collect(t, REASON.TIMER);
        break;
      }
      this.timer -= next - t;
      t = next;
    }
    this.now = b;
  }

  _take(i, at) {
    const b = this.blocks, type = b.type[i], lane = b.lane[i];
    this.state[i] = TAKEN;
    if (type === BLOCK.POWER) {
      this.stats.powerHit++;
      this.lastPowerTime = at;
      if (this.timerActive) {
        const mult = b.pbRank[i] === 1 ? SCORE.bigPbMultiplier : SCORE.pbMultiplier;
        if (mult > this.multiplier) this.multiplier = mult;
        this.stats.multiplied++;
        this._emit(EVENT.POWER, at, i, lane, 0, 0, this.multiplier, 0);
        this._afterChange(at, true);
      } else {
        this._duplicate();
        this.stats.duplications++;
        this._emit(EVENT.POWER, at, i, lane, 0, this.heights[0] + this.heights[1] + this.heights[2], 1, 0);
        this._afterChange(at, true);
      }
      return;
    }
    if (type === BLOCK.GREY) {
      this.stats.greyHit++;
      if (this.rules.grey === GREY_EFFECT.ERASE_ALL) {
        const lost = this.heights[0] + this.heights[1] + this.heights[2];
        this._clear();
        this.multiplier = 1;
        this.timerActive = false;
        this.timer = 0;
        this._emit(EVENT.SPIKE, at, i, lane, 0, lost, 1, 0);
        return;
      }
      const col = lane + 1, h = this.heights[col];
      if (h > 0) {
        this.cells[col * ROWS + h - 1] = -1;
        this.heights[col] = h - 1;
      }
      this._emit(EVENT.GREY, at, i, lane, h > 0 ? 1 : 0, 0, 1, 0);
      this._afterChange(at, this.rules.greyResets);
      return;
    }
    this.stats.colourHit++;
    const col = lane + 1;
    if (this.heights[col] === ROWS) {
      // Overfill: cash in and start a new grid with this block. Blocks that
      // could not score (an outer column of one or two) are dropped with it.
      const pb = at - this.lastPowerTime <= SCORE.pbOverfillWindow;
      if (pb) this.stats.pbOverfills++; else this.stats.overfills++;
      this._collect(at, pb ? REASON.PB_OVERFILL : REASON.OVERFILL);
      this._clear();
    }
    const h = this.heights[col];
    this.cells[col * ROWS + h] = i;
    this.heights[col] = h + 1;
    const hold = fallHold(h);
    if (hold > this.hold) this.hold = hold;
    this._emit(EVENT.HIT, at, i, lane, 0, h + 1, 1, 0);
    this._afterChange(at, true);
  }

  /** Start, reset or stop the timer after the grid changed. */
  _afterChange(at, reset) {
    if (!hasMatch(this.heights)) {
      this.timerActive = false;
      this.timer = 0;
      return;
    }
    if (!this.timerActive) {
      this.timerActive = true;
      this.timer = this.rules.timer;
      this._emit(EVENT.MATCH, at, -1, 0, 0, this.heights[0] + this.heights[1] + this.heights[2], this.multiplier, 0);
    } else if (reset) this.timer = this.rules.timer;
  }

  _duplicate() {
    for (let col = 0; col < COLUMNS; col++) {
      const h = this.heights[col], to = Math.min(ROWS, 2 * h);
      for (let r = h; r < to; r++) this.cells[col * ROWS + r] = this.cells[col * ROWS + r - h];
      this.heights[col] = to;
    }
  }

  _clear() {
    this.cells.fill(-1);
    this.heights.fill(0);
  }

  _clearColumn(col) {
    for (let r = 0; r < ROWS; r++) this.cells[col * ROWS + r] = -1;
    this.heights[col] = 0;
  }

  /** Score every group that can score, remove it, and stop the timer. */
  _collect(at, reason) {
    const h = this.heights;
    let points = 0, blocks = 0, biggest = 0, groups = 0;
    if (h[1] > 0) {
      const n = h[0] + h[1] + h[2];
      if (n >= 3) { points = matchPoints(n); blocks = biggest = n; groups = 1; this._clear(); }
    } else {
      for (let col = 0; col < COLUMNS; col += 2) {
        const n = h[col];
        if (n <= 2) continue;
        points += matchPoints(n); blocks += n; groups++;
        if (n > biggest) biggest = n;
        this._clearColumn(col);
      }
    }
    this.stats.matches += groups;
    const mult = this.multiplier;
    this.multiplier = 1;
    this.timerActive = false;
    this.timer = 0;
    if (!blocks) return;
    const value = Math.round(points * mult * (reason === REASON.PB_OVERFILL ? SCORE.pbOverfillFactor : 1));
    this.score += value;
    if (biggest > this.stats.biggestMatch) this.stats.biggestMatch = biggest;
    if (value > this.stats.bestCollect) this.stats.bestCollect = value;
    this._emit(EVENT.COLLECT, at, -1, 0, value, blocks, mult, reason);
  }
}

/** SongMap-shaped block arrays from a list of { t, lane, type, span?, rank? } (tests, live mode). */
export function makeBlocks(list) {
  const sorted = list.slice().sort((a, b) => a.t - b.t);
  const n = sorted.length;
  const out = {
    count: n, time: new Float64Array(n), lane: new Int8Array(n), type: new Uint8Array(n),
    spanEnd: new Float64Array(n), pbRank: new Uint8Array(n),
  };
  sorted.forEach((b, i) => {
    out.time[i] = b.t; out.lane[i] = b.lane; out.type[i] = b.type ?? BLOCK.COLOUR;
    out.spanEnd[i] = b.t + (b.span ?? 0); out.pbRank[i] = b.rank ?? 0;
  });
  return out;
}
