// SongMap: analysis features → the track and everything placed on it.
//
//   nodes    30 Hz samples of speed, slope, heading, roll, position and colour
//   blocks   one per onset (snapped to the beat grid), density-capped per
//            mode, with greys, chain spans and deterministic musical lanes
//   power    power blocks at the biggest rises in energy, each with a loop
//   features spectacle tied to the song's structure: twists (a 360° roll of
//            the track) at strong section changes, a flip (a half-twist
//            into an upside-down stretch and another out) where the song
//            falls into a calmer section, and banked sweeping curves in
//            between whose bank follows intensity. At most one big moment
//            (loop, twist or flip) per 8 s of gap, none in the first 10 s.
//
// Pure and deterministic: the same features, mode and seed always give the
// same map (and the same hash). All randomness comes from a PRNG seeded by
// the analysis ID.

import { mulberry32, seedFromString, Hasher } from './random.js';
import { sampleSeries } from './dsp.js';
import { gradientAt } from '../game/palette.js';

export const SONGMAP_VERSION = 2;
export const NODE_RATE = 30;
/** Seconds of track before the song starts (swoop-in) and after it ends. */
export const LEAD_IN = 3;
export const TAIL = 3;

export const BLOCK = Object.freeze({ COLOUR: 0, GREY: 1, POWER: 2 });
/**
 * Shapes the track takes (map.nodes.loop marks their rolling nodes).
 * PLAIN: a vertical 360° loop; CORKSCREW / DOUBLE: one or two barrel rolls
 * around an axis above the track; TWIST: a 360° roll of the track about
 * its own centre; FLIP: a half-twist into an upside-down stretch and a
 * half-twist out (only the twists are marked in nodes.loop).
 */
export const LOOP = Object.freeze({ NONE: 0, PLAIN: 1, CORKSCREW: 2, DOUBLE: 3, TWIST: 4, FLIP: 5 });

/**
 * Mode parameters. Speeds in m/s (lane spacing is 3 m); maxRate is the
 * density cap in blocks per second (BSMG Easy/Hard/Expert).
 */
export const MODES = Object.freeze({
  mono: Object.freeze({ speedMin: 25, speedMax: 70, maxRate: 5.2, greyFraction: 0.23, spanGreyFraction: 0.05, extraPowerBlocks: 2, maxPowerBlocks: Infinity }),
  ninja: Object.freeze({ speedMin: 25 * 1.26, speedMax: 70 * 1.26, maxRate: 7.8, greyFraction: 0.35, spanGreyFraction: 0.05, extraPowerBlocks: 2, maxPowerBlocks: Infinity }),
  casual: Object.freeze({ speedMin: 25 * 0.8, speedMax: 70 * 0.8, maxRate: 2.3, greyFraction: 0.23, spanGreyFraction: 0.05, extraPowerBlocks: 0, maxPowerBlocks: 2 }),
});

/** Layout constants (seconds, degrees and metres). */
export const LAYOUT = Object.freeze({
  snapWindow: 0.035,
  mergeWindow: 0.03,
  capWindow: 4,
  quietGap: 3,
  silenceLufs: -60,
  noveltyWindow: 4,
  noveltyMin: 0.2,
  pbSpacing: 12,
  pbNotBefore: 20,
  pbClear: 0.15,
  loopLength: 2.75,
  spanRatio: 0.6,
  spanFluxRatio: 0.5,
  spanMin: 0.25,
  spanMax: 2,
  sameLaneGap: 0.12,
  typeGap: 0.15,
  outerPairGap: 0.2,
  patternBeats: 8,
  patternSimilarity: 0.9,
  pitchUp: 10 * 0.8,
  pitchDown: 24 * 1.55,
  pitchRate: 12,
  yawAmplitude: 15,
  corkscrewRadius: 6,
  loopSideShift: 14,
  // Structure features (twists, flips, sweeps).
  featureNotBefore: 10, // no big moment starts in the first 10 s
  featureGap: 8, // seconds between any two big moments (loops, twists, flips)
  featureNovelty: 1.8, // section-change score (× the song's typical bar-to-bar change) a twist or flip needs
  flipFall: 0.15, // intensity fall across a section change that makes it a flip
  flipBars: 4, // bars upside down (from the change to the half-twist out)
  maxFlips: 2,
  twistRadius: 1.2, // twists and flips roll about a line this far above the surface
  sweepClear: 2, // seconds a sweep keeps from any big moment
  sweepMin: 6, // shortest sweep, seconds
  sweepBars: 8,
  sweepIntensity: 0.3, // quieter stretches stay straight
  sweepYaw: 14, // degrees of heading swing at intensity 0, plus sweepYawI · I
  sweepYawI: 22,
  bankGain: 0.8, // of the banking a real curve at this speed would want
  bankMax: 30, // degrees, scaled by 0.35 + 0.65 · I
  bankRate: 40, // degrees per second
  bankFade: 1.5, // seconds over which the bank fades out next to a big moment
});

const DEG = Math.PI / 180;
const q = (v, step) => Math.round(v / step) * step;

// --- beat grid ---------------------------------------------------------------

/** The tracked beats extended at the ends so every song time has a grid position. */
export function makeGrid(beats, bpm, duration) {
  const period = 60 / (bpm > 0 ? bpm : 120);
  const src = beats.length ? Array.from(beats) : [0];
  const pre = [], post = [];
  for (let t = src[0] - period; t > -period * 2; t -= period) pre.unshift(t);
  for (let t = src[src.length - 1] + period; t < duration + period * 2; t += period) post.push(t);
  return { times: Float64Array.from([...pre, ...src, ...post]), offset: pre.length, period };
}

/** Fractional index of time t in the grid. */
export function gridPosition(grid, t) {
  const g = grid.times, n = g.length;
  if (t <= g[0]) return (t - g[0]) / grid.period;
  if (t >= g[n - 1]) return n - 1 + (t - g[n - 1]) / grid.period;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (g[mid] <= t) lo = mid; else hi = mid;
  }
  return lo + (t - g[lo]) / (g[hi] - g[lo]);
}

export function gridTime(grid, pos) {
  const g = grid.times, n = g.length;
  if (pos <= 0) return g[0] + pos * grid.period;
  if (pos >= n - 1) return g[n - 1] + (pos - (n - 1)) * grid.period;
  const i = Math.floor(pos), f = pos - i;
  return g[i] + (g[i + 1] - g[i]) * f;
}

// --- blocks ------------------------------------------------------------------

function candidatesFrom(features, grid) {
  const { times, strength, band } = features.onsets;
  const out = [];
  for (let i = 0; i < times.length; i++) {
    // Quantise first so tiny cross-engine differences do not move layout decisions.
    const raw = q(times[i], 1e-3);
    const s = q(strength[i], 1e-3);
    const pos = gridPosition(grid, raw);
    const qpos = Math.round(pos * 4) / 4;
    const snappedTime = gridTime(grid, qpos);
    const snapped = Math.abs(snappedTime - raw) <= LAYOUT.snapWindow;
    out.push({ t: snapped ? snappedTime : raw, raw, strength: s, band: band[i], snapped, pos: snapped ? qpos : pos, filler: false });
  }
  out.sort((a, b) => a.t - b.t);
  // Snapping can pull two onsets onto one grid point: keep the stronger.
  const merged = [];
  for (const c of out) {
    const last = merged[merged.length - 1];
    if (last && c.t - last.t < LAYOUT.mergeWindow) {
      if (c.strength > last.strength) merged[merged.length - 1] = c;
    } else merged.push(c);
  }
  return merged;
}

/**
 * Power-block times: peaks of novelty, at least 12 s apart, not in the first
 * 20 s, snapped to the nearest beat. Novelty is the rise from the previous
 * 4 s to the next 4 s in intensity, plus half the rise in onset density, plus
 * the rise in low-band (< 200 Hz) level. The last term pins the peak to the
 * drop itself: builds get loud and busy before it, but the kick and bass
 * come back exactly on it.
 */
export function findPowerBlocks(features, candidates, grid, count) {
  const I = features.intensity.raw, rate = features.intensity.rate, n = I.length;
  const W = Math.round(LAYOUT.noveltyWindow * rate);
  const pI = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pI[i + 1] = pI[i] + I[i];
  const dens = new Float64Array(n);
  for (const c of candidates) {
    const k = Math.min(n - 1, Math.max(0, Math.round(c.t * rate)));
    dens[k]++;
  }
  const pD = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pD[i + 1] = pD[i] + dens[i];
  let maxWin = 1;
  for (let i = 0; i + W <= n; i++) maxWin = Math.max(maxWin, pD[i + W] - pD[i]);
  // Low-band power resampled to the intensity rate, over its 95th percentile, clamped.
  const lowBand = features.bandPower[0], fr = features.frameRate;
  const low = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const a = Math.round((k / rate) * fr), b = Math.min(lowBand.length, Math.max(a + 1, Math.round(((k + 1) / rate) * fr)));
    let acc = 0;
    for (let j = a; j < b; j++) acc += lowBand[j];
    low[k] = b > a ? acc / (b - a) : 0;
  }
  const p95 = Float64Array.from(low).sort()[Math.floor(n * 0.95)] || 1;
  const pL = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pL[i + 1] = pL[i] + Math.min(1, low[i] / p95);
  const mean = (p, a, b) => {
    const lo = Math.max(0, a), hi = Math.min(n, b);
    return hi > lo ? (p[hi] - p[lo]) / (hi - lo) : 0;
  };
  const nov = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const dI = mean(pI, k, k + W) - mean(pI, k - W, k);
    const dD = (mean(pD, k, k + W) - mean(pD, k - W, k)) * (W / maxWin);
    const dL = mean(pL, k, k + W) - mean(pL, k - W, k);
    nov[k] = dI + 0.5 * dD + dL;
  }
  const duration = features.duration;
  const peaks = [];
  for (let k = 1; k + 1 < n; k++) {
    const t = k / rate;
    if (t < LAYOUT.pbNotBefore || t > duration - 5) continue;
    if (nov[k] >= LAYOUT.noveltyMin && nov[k] >= nov[k - 1] && nov[k] > nov[k + 1]) peaks.push({ k, v: nov[k] });
  }
  peaks.sort((a, b) => b.v - a.v || a.k - b.k);
  const chosen = [];
  for (const p of peaks) {
    if (chosen.length >= count) break;
    if (chosen.every((c) => Math.abs(c.k - p.k) / rate >= LAYOUT.pbSpacing)) chosen.push(p);
  }
  const pbs = chosen.map((p, i) => {
    const t = p.k / rate;
    const beat = gridTime(grid, Math.round(gridPosition(grid, t)));
    return { time: Math.abs(beat - t) <= grid.period / 2 ? beat : t, novelty: q(p.v, 1e-4), rank: i + 1 };
  });
  return pbs.sort((a, b) => a.time - b.time);
}

/** Greedy strongest-first density cap: no window of capWindow seconds holds more than floor(maxRate · W). */
function capDensity(candidates, fixedTimes, maxRate) {
  const W = LAYOUT.capWindow, limit = Math.floor(maxRate * W);
  const accepted = Array.from(fixedTimes).sort((a, b) => a - b);
  const lowerBound = (x) => {
    let lo = 0, hi = accepted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (accepted[m] < x) lo = m + 1; else hi = m; }
    return lo;
  };
  const order = candidates.map((c, i) => i).sort((a, b) => candidates[b].strength - candidates[a].strength || candidates[a].t - candidates[b].t);
  const keep = new Uint8Array(candidates.length);
  const local = [];
  for (const i of order) {
    const t = candidates[i].t;
    const lo = lowerBound(t - W), hi = lowerBound(t + W);
    local.length = 0;
    for (let k = lo; k < hi; k++) local.push(accepted[k]);
    local.push(t);
    local.sort((a, b) => a - b);
    let ok = true;
    // Every window [s, s + W) that contains t, starting at an event.
    for (let a = 0, b = 0; a < local.length && ok; a++) {
      const s = local[a];
      if (s > t) break;
      if (t >= s + W) continue;
      if (b < a) b = a;
      while (b < local.length && local[b] < s + W) b++;
      if (b - a > limit) ok = false;
    }
    if (!ok) continue;
    keep[i] = 1;
    accepted.splice(lowerBound(t), 0, t);
  }
  return candidates.filter((_, i) => keep[i]);
}

/** Band with the most (percentile-normalised) power at time t. */
function dominantBand(features, t, scales) {
  const f = Math.min(features.bandPower[0].length - 1, Math.max(0, Math.round(t * features.frameRate)));
  let best = 0, bestV = -1;
  for (let g = 0; g < 3; g++) {
    const v = features.bandPower[g][f] / scales[g];
    if (v > bestV) { bestV = v; best = g; }
  }
  return best;
}

function bandScales(features) {
  return features.bandPower.map((p) => {
    const a = Float32Array.from(p).sort();
    return Math.max(1e-12, a[Math.floor(a.length * 0.95)] || 1e-12);
  });
}

/**
 * Quiet sections never go blockless for more than quietGap seconds while
 * the song is audible: fill with every other beat of the grid.
 */
function fillQuietGaps(blocks, features, grid, downbeatPhase, scales) {
  const out = blocks.slice();
  const lufs = features.intensity.lufs, rate = features.intensity.rate;
  const times = blocks.map((b) => b.t);
  const first = grid.offset + downbeatPhase;
  for (let i = 0; i + 1 < times.length; i++) {
    const a = times[i], b = times[i + 1];
    if (b - a <= LAYOUT.quietGap) continue;
    const p0 = Math.ceil(gridPosition(grid, a) + 0.5), p1 = Math.floor(gridPosition(grid, b) - 0.5);
    for (let p = p0; p <= p1; p++) {
      if ((((p - first) % 2) + 2) % 2 !== 0) continue;
      const t = gridTime(grid, p);
      if (sampleSeries(lufs, rate, t) <= LAYOUT.silenceLufs) continue;
      out.push({ t, raw: t, strength: 0, band: dominantBand(features, t, scales), snapped: true, pos: p, filler: true });
    }
  }
  return out.sort((x, y) => x.t - y.t);
}

/** Chain span: the onset's band keeps ≥ 60% of its peak level, with no new attack, for ≥ 250 ms. */
function spanEnd(block, features) {
  const fr = features.frameRate;
  const pw = features.bandPower[block.band], flux = features.bandFlux[block.band];
  const n = pw.length;
  const f0 = Math.min(n - 1, Math.max(0, Math.round(block.raw * fr)));
  let pf = f0;
  for (let f = Math.max(0, f0 - 1); f <= Math.min(n - 1, f0 + 2); f++) if (pw[f] > pw[pf]) pf = f;
  let onsetFlux = 0;
  for (let f = Math.max(0, f0 - 1); f <= Math.min(n - 1, f0 + 1); f++) onsetFlux = Math.max(onsetFlux, flux[f]);
  const floor = LAYOUT.spanRatio * Math.sqrt(pw[pf]);
  const maxF = f0 + Math.round(LAYOUT.spanMax * fr);
  let f = pf + 1;
  while (f < n && f < maxF && Math.sqrt(pw[f]) >= floor && flux[f] < LAYOUT.spanFluxRatio * onsetFlux) f++;
  const dur = (f - f0) / fr;
  return dur >= LAYOUT.spanMin ? block.t + q(Math.min(LAYOUT.spanMax, dur), 1e-3) : block.t;
}

function assignGreys(blocks, cfg) {
  const idx = [];
  for (let i = 0; i < blocks.length; i++) if (blocks[i].type !== BLOCK.POWER) idx.push(i);
  const n = idx.length;
  const weakest = idx.slice().sort((a, b) => blocks[a].strength - blocks[b].strength || blocks[a].t - blocks[b].t);
  for (let k = 0; k < Math.floor(cfg.greyFraction * n); k++) blocks[weakest[k]].type = BLOCK.GREY;
  const spans = idx.filter((i) => blocks[i].spanEnd > blocks[i].t)
    .sort((a, b) => (blocks[b].spanEnd - blocks[b].t) - (blocks[a].spanEnd - blocks[a].t) || blocks[a].t - blocks[b].t);
  for (let k = 0; k < Math.min(spans.length, Math.floor(cfg.spanGreyFraction * n)); k++) blocks[spans[k]].type = BLOCK.GREY;
}

// --- lanes -------------------------------------------------------------------

function laneByBand(band, state, rand) {
  const r = rand();
  if (band === 0) return r < 0.6 ? 0 : r < 0.8 ? -1 : 1; // low: centre-weighted
  if (band === 2) return r < 0.15 ? 0 : r < 0.575 ? -1 : 1; // high: outer-weighted
  // mid: alternate sides, sometimes through the centre
  const lane = r < 0.25 ? 0 : state.lastMid === 0 ? (rand() < 0.5 ? -1 : 1) : -state.lastMid;
  if (lane !== 0) state.lastMid = lane;
  return lane;
}

/**
 * Deterministic musical lanes. Blocks are grouped into 8-beat windows from
 * the downbeat; a window whose onset pattern (slot × band) matches an
 * earlier one (cosine > 0.9) reuses that pattern's lanes, mirrored on
 * alternate repeats. Everything else draws from band-biased seeded odds.
 */
function assignLanes(blocks, grid, downbeatPhase, rand) {
  const base = grid.offset + downbeatPhase;
  const B = LAYOUT.patternBeats, slots = B * 4;
  const windows = [];
  const state = { lastMid: 0 };
  let i = 0;
  const history = [];
  while (i < blocks.length) {
    const w = Math.floor((blocks[i].pos - base) / B);
    const members = [];
    while (i < blocks.length && Math.floor((blocks[i].pos - base) / B) === w) members.push(blocks[i++]);
    windows.push({ w, members });
  }
  for (const { w, members } of windows) {
    const notes = members.filter((b) => b.type !== BLOCK.POWER);
    const keyOf = (b) => Math.min(slots - 1, Math.max(0, Math.round((b.pos - (base + w * B)) * 4))) * 3 + b.band;
    const vec = new Float32Array(slots * 3);
    for (const b of notes) vec[keyOf(b)] = 1;
    let norm = 0;
    for (let k = 0; k < vec.length; k++) norm += vec[k];
    norm = Math.sqrt(norm);
    let family = null;
    if (notes.length >= 2) {
      for (let h = history.length - 1; h >= 0 && h >= history.length - 64; h--) {
        const o = history[h];
        let dot = 0;
        for (let k = 0; k < vec.length; k++) dot += vec[k] * o.vec[k];
        if (dot / (norm * o.norm) > LAYOUT.patternSimilarity) { family = o.family; break; }
      }
    }
    let mirror = false;
    if (family) {
      family.count++;
      mirror = family.count % 2 === 1;
    } else family = { lanes: new Map(), count: 0 };
    for (const b of members) {
      if (b.type === BLOCK.POWER) { b.lane = 0; continue; }
      const key = keyOf(b);
      let lane = family.lanes.get(key);
      if (lane === undefined) {
        // Stored unmirrored so later repeats mirror consistently.
        const fresh = laneByBand(b.band, state, rand);
        lane = mirror ? -fresh : fresh;
        family.lanes.set(key, lane);
      }
      b.lane = mirror ? -lane : lane;
      if (b.band === 1 && b.lane !== 0) state.lastMid = b.lane;
    }
    if (notes.length >= 2) history.push({ vec, norm, family });
  }
}

/**
 * AS2's spacing rules plus a minimum same-lane gap, applied in time order
 * against every recent block: no two blocks share a lane within 0.12 s,
 * a colour and a grey never share a lane within 0.15 s, and two blocks of a
 * kind less than 0.2 s apart are never outer-outer. A clashing block moves
 * to the least-penalised lane, nearest first.
 */
function enforceSpacing(blocks, rand) {
  const kind = (b) => (b.type === BLOCK.GREY ? 1 : 0);
  const cost = new Float64Array(3);
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === BLOCK.POWER) continue;
    cost.fill(0);
    let lastSame = null;
    for (let j = i - 1; j >= 0 && b.t - blocks[j].t < LAYOUT.outerPairGap; j--) {
      const p = blocks[j], dt = b.t - p.t;
      if (dt < LAYOUT.sameLaneGap) cost[p.lane + 1] += 4;
      if (kind(p) !== kind(b) && dt < LAYOUT.typeGap) cost[p.lane + 1] += 2;
      if (!lastSame && kind(p) === kind(b)) lastSame = p;
    }
    if (lastSame && lastSame.lane !== 0) cost[1 - lastSame.lane] += 1;
    if (cost[b.lane + 1] === 0) continue;
    const order = b.lane === 0 ? (rand() < 0.5 ? [0, -1, 1] : [0, 1, -1]) : [b.lane, 0, -b.lane];
    let best = b.lane, bestCost = Infinity;
    for (const lane of order) if (cost[lane + 1] < bestCost) { bestCost = cost[lane + 1]; best = lane; }
    b.lane = best;
  }
}

// --- shapes ------------------------------------------------------------------

export const smootherstep = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (u * (6 * u - 15) + 10));
/** d/du of smootherstep. */
const smootherstepRate = (u) => (u <= 0 || u >= 1 ? 0 : 30 * u * u * (1 - u) * (1 - u));

/** A reusable record for shapePose. */
export function makePose() {
  return { pitch: 0, roll: 0, rollRate: 0, side: 0, sideRate: 0, radius: 0, mark: 0 };
}

/**
 * The pose a shape gives the track at song time t (start ≤ t ≤ end),
 * written into `out`: extra pitch (a plain loop), roll about a line
 * `radius` above the surface and its rate, the sideways shift that keeps a
 * plain loop from meeting itself and its rate, and the nodes.loop mark.
 * The file and live maps share it, so a loop is the same shape in both.
 */
export function shapePose(S, t, out) {
  const len = S.end - S.start;
  const u = (t - S.start) / len;
  const e = smootherstep(u), de = smootherstepRate(u) / len;
  out.pitch = 0; out.roll = 0; out.rollRate = 0; out.side = 0; out.sideRate = 0; out.radius = 0; out.mark = S.type;
  const dir = S.dir || 1;
  switch (S.type) {
    case LOOP.PLAIN:
      out.pitch = 2 * Math.PI * e;
      out.side = LAYOUT.loopSideShift * e;
      out.sideRate = LAYOUT.loopSideShift * de;
      break;
    case LOOP.CORKSCREW:
    case LOOP.DOUBLE: {
      const turns = S.type === LOOP.DOUBLE ? 2 : 1;
      out.roll = 2 * Math.PI * turns * e;
      out.rollRate = 2 * Math.PI * turns * de;
      out.radius = LAYOUT.corkscrewRadius;
      break;
    }
    case LOOP.TWIST:
      out.roll = dir * 2 * Math.PI * e;
      out.rollRate = dir * 2 * Math.PI * de;
      out.radius = LAYOUT.twistRadius;
      break;
    case LOOP.FLIP: {
      // Half-twist in, upside down, half-twist on round (a full turn in all).
      out.radius = LAYOUT.twistRadius;
      if (t < S.inEnd) {
        const w = S.inEnd - S.start, v = (t - S.start) / w;
        out.roll = dir * Math.PI * smootherstep(v);
        out.rollRate = (dir * Math.PI * smootherstepRate(v)) / w;
      } else if (t <= S.outStart) {
        out.roll = dir * Math.PI;
        out.mark = 0;
      } else {
        const w = S.end - S.outStart, v = (t - S.outStart) / w;
        out.roll = dir * Math.PI * (1 + smootherstep(v));
        out.rollRate = (dir * Math.PI * smootherstepRate(v)) / w;
      }
      break;
    }
  }
  return out;
}

/** A twist's length in seconds for bars `barLen` long. */
export const twistLength = (barLen) => Math.min(2.4, Math.max(1.6, barLen));
/** Length of each half-twist of a flip for bars `barLen` long. */
export const flipHalf = (barLen) => Math.min(2.2, Math.max(1.4, barLen));

/** A sweep's heading offset (degrees) at time t inside it. */
export function sweepYawAt(W, t) {
  const s = Math.sin((Math.PI * (t - W.start)) / (W.end - W.start));
  return W.dir * W.yaw * s * s;
}

/**
 * The bank (radians) a curve asks for: a share of what a turn at `speed`
 * (m/s) and heading rate `w` (rad/s) would want, capped by intensity I.
 */
export function bankTarget(speed, w, I) {
  const cap = LAYOUT.bankMax * DEG * (0.35 + 0.65 * I);
  const target = Math.atan((speed * w) / 9.81) * LAYOUT.bankGain;
  return Math.max(-cap, Math.min(cap, target));
}

/** Bar start times (from the downbeat) inside [0, duration]. */
function barTimes(grid, downbeatPhase, duration) {
  const first = grid.offset + downbeatPhase;
  const out = [];
  for (let b = Math.ceil(-first / 4); ; b++) {
    const t = gridTime(grid, first + 4 * b);
    if (t > duration) break;
    if (t >= 0) out.push(t);
  }
  return out;
}

const overlaps = (a0, a1, list, gap) => list.some((o) => a0 < o.end + gap && a1 > o.start - gap);

/**
 * Structure features, deterministic from the analysis.
 *
 * Section changes are scored at every bar line: the spectral distance
 * between the two bars after it and the two before, over the song's
 * median (so a chord cycle is the norm, not a change), plus four times
 * the intensity step between the two bars either side. Local peaks scoring at
 * least featureNovelty become big moments, strongest first, each keeping
 * featureGap seconds from every other one and from the power-block loops,
 * none starting in the first featureNotBefore seconds: a fall of
 * flipFall or more is a flip (up to maxFlips), anything else a twist.
 * Twists and flips alternate direction.
 *
 * The stretches between big moments (less sweepClear either side), cut
 * at most sweepBars long on bar lines, get a sweeping curve when their
 * mean intensity reaches sweepIntensity.
 *
 * @param loops  the power-block loops ({ start, end })
 * @returns { features: [{ type, time, start, end, dir, inEnd?, outStart?, score }], sweeps: [{ start, end, yaw, dir }] }
 */
export function planFeatures(features, grid, downbeatPhase, loops) {
  const duration = features.duration;
  const bars = barTimes(grid, downbeatPhase, duration);
  const nb = bars.length;
  const out = { features: [], sweeps: [] };
  if (nb < 4) return out;
  const barLen = 4 * grid.period;

  // Per-bar mean spectrum (skyline bands) and intensity.
  const sky = features.skyline, dims = features.skylineBands || 16, fr = features.frameRate;
  const frames = sky ? Math.floor(sky.length / dims) : 0;
  const spec = new Float64Array(nb * dims);
  for (let j = 0; j < nb; j++) {
    const a = Math.min(frames, Math.round(bars[j] * fr));
    const b = Math.min(frames, Math.max(a + 1, Math.round((j + 1 < nb ? bars[j + 1] : bars[j] + barLen) * fr)));
    for (let f = a; f < b; f++) for (let d = 0; d < dims; d++) spec[j * dims + d] += sky[f * dims + d];
    if (b > a) for (let d = 0; d < dims; d++) spec[j * dims + d] /= b - a;
  }
  const I = features.intensity.raw, rate = features.intensity.rate;
  const meanI = (t0, t1) => {
    const a = Math.max(0, Math.round(t0 * rate)), b = Math.min(I.length, Math.max(a + 1, Math.round(t1 * rate)));
    let acc = 0;
    for (let k = a; k < b; k++) acc += I[k];
    return b > a ? acc / (b - a) : 0;
  };
  const dist = new Float64Array(nb), dI = new Float64Array(nb);
  for (let j = 1; j < nb; j++) {
    const lo = Math.max(0, j - 2), hi = Math.min(nb, j + 2);
    let d = 0;
    for (let c = 0; c < dims; c++) {
      let before = 0, after = 0;
      for (let k = lo; k < j; k++) before += spec[k * dims + c];
      for (let k = j; k < hi; k++) after += spec[k * dims + c];
      d += Math.abs(after / (hi - j) - before / (j - lo));
    }
    dist[j] = d;
    dI[j] = meanI(bars[j], bars[j] + 2 * barLen) - meanI(bars[j] - 2 * barLen, bars[j]);
  }
  const med = Float64Array.from(dist.subarray(1)).sort()[(nb - 1) >> 1] || 0;
  const score = new Float64Array(nb);
  for (let j = 1; j < nb; j++) score[j] = q((med > 1e-9 ? dist[j] / med : 0) + 4 * Math.abs(dI[j]), 1e-4);
  const peaks = [];
  for (let j = 1; j < nb; j++) {
    if (score[j] < LAYOUT.featureNovelty) continue;
    if ((j > 1 && score[j - 1] > score[j]) || (j + 1 < nb && score[j + 1] >= score[j])) continue;
    peaks.push(j);
  }
  peaks.sort((a, b) => score[b] - score[a] || a - b);

  const taken = loops.map((l) => ({ start: l.start, end: l.end }));
  const fits = (s, e) => s >= LAYOUT.featureNotBefore && e <= duration - 3 && !overlaps(s, e, taken, LAYOUT.featureGap);
  let flips = 0;
  for (const j of peaks) {
    const t = bars[j];
    let f = null;
    if (dI[j] <= -LAYOUT.flipFall && flips < LAYOUT.maxFlips && j + LAYOUT.flipBars < nb) {
      const half = flipHalf(barLen);
      const start = t - half / 2, end = bars[j + LAYOUT.flipBars] + half / 2;
      if (fits(start, end)) {
        f = { type: LOOP.FLIP, time: t, start, end, inEnd: start + half, outStart: end - half };
        flips++;
      }
    }
    if (!f) {
      const len = twistLength(barLen);
      if (fits(t - len / 2, t + len / 2)) f = { type: LOOP.TWIST, time: t, start: t - len / 2, end: t + len / 2 };
    }
    if (!f) continue;
    f.score = score[j];
    out.features.push(f);
    taken.push(f);
  }
  out.features.sort((a, b) => a.time - b.time);
  out.features.forEach((f, i) => { f.dir = i % 2 === 0 ? 1 : -1; });

  // Sweeps in the stretches between big moments.
  const busy = taken.slice().sort((a, b) => a.start - b.start);
  const clear = LAYOUT.sweepClear;
  let from = LAYOUT.featureNotBefore, dir = 1;
  for (let i = 0; i <= busy.length; i++) {
    const to = i < busy.length ? busy[i].start - clear : duration - 2;
    let a = from;
    while (to - a >= LAYOUT.sweepMin) {
      // Cut on bar lines: at most sweepBars long, never leaving a stub under sweepMin.
      let b = Math.min(to, a + LAYOUT.sweepBars * barLen);
      if (to - b < LAYOUT.sweepMin) b = to;
      else {
        let k = 0;
        while (k < nb && bars[k] <= b) k++;
        if (k > 0 && bars[k - 1] - a >= LAYOUT.sweepMin) b = bars[k - 1];
      }
      const m = meanI(a, b);
      if (m >= LAYOUT.sweepIntensity) {
        out.sweeps.push({ start: a, end: b, yaw: q(LAYOUT.sweepYaw + LAYOUT.sweepYawI * m, 1e-3), dir });
        dir = -dir;
      }
      a = b;
    }
    if (i < busy.length) from = Math.max(from, busy[i].end + clear);
  }
  return out;
}

// --- nodes -------------------------------------------------------------------

/**
 * @param shapes  loops and big features, sorted by start, never overlapping
 * @param sweeps  sweeping curves ({ start, end, yaw (degrees), dir })
 */
function buildNodes(features, blocks, shapes, sweeps, cfg, rand) {
  const duration = features.duration;
  const count = Math.ceil((LEAD_IN + duration + TAIL) * NODE_RATE) + 1;
  const dt = 1 / NODE_RATE;
  const I = features.intensity.smooth, rate = features.intensity.rate;
  const intensity = new Float32Array(count), speed = new Float32Array(count), dist = new Float64Array(count);
  const pitch = new Float32Array(count), yaw = new Float32Array(count), roll = new Float32Array(count);
  const loop = new Uint8Array(count);
  const pos = new Float64Array(count * 3), fwd = new Float32Array(count * 3), up = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);

  // Heading noise: three slow sines with seeded phases, calmer where blocks are dense.
  const waves = [[0.013, 0.5], [0.029, 0.3], [0.047, 0.2]].map(([f, a]) => [f, a, rand() * 2 * Math.PI]);
  const times = blocks.map((b) => b.t);
  const densityAt = (t) => {
    let lo = 0, hi = times.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] < t - 2) lo = m + 1; else hi = m; }
    let c = 0;
    for (let k = lo; k < times.length && times[k] <= t + 2; k++) c++;
    return Math.min(1, c / (4 * cfg.maxRate));
  };

  // Speed, slope and heading (noise plus the sweeping curves).
  let p = 0, si = 0;
  for (let k = 0; k < count; k++) {
    const t = -LEAD_IN + k * dt;
    const i = sampleSeries(I, rate, Math.min(duration, Math.max(0, t)));
    intensity[k] = i;
    speed[k] = cfg.speedMin + (cfg.speedMax - cfg.speedMin) * Math.pow(i, 1.3);
    const target = i < 0.5 ? (LAYOUT.pitchUp * (0.5 - i)) / 0.5 : (-LAYOUT.pitchDown * (i - 0.5)) / 0.5;
    const maxStep = LAYOUT.pitchRate * dt;
    p += Math.max(-maxStep, Math.min(maxStep, target - p));
    pitch[k] = p * DEG;
    let noise = 0;
    for (const [f, a, ph] of waves) noise += a * Math.sin(2 * Math.PI * f * t + ph);
    let y = LAYOUT.yawAmplitude * noise * (1 - 0.6 * densityAt(t));
    while (si < sweeps.length && t > sweeps[si].end) si++;
    const W = sweeps[si];
    if (W && t >= W.start) y += sweepYawAt(W, t);
    yaw[k] = y * DEG;
  }

  // Bank into the curves: a share of what the turn at this speed would
  // want, capped by intensity, faded out next to every loop and feature
  // and rate limited.
  const bank = new Float64Array(count);
  let b = 0, hi = 0;
  const bankStep = LAYOUT.bankRate * DEG * dt;
  for (let k = 0; k < count; k++) {
    const t = -LEAD_IN + k * dt;
    const a = Math.max(0, k - 1), c = Math.min(count - 1, k + 1);
    const w = ((yaw[c] - yaw[a]) / (c - a)) * NODE_RATE;
    let target = bankTarget(speed[k], w, intensity[k]);
    while (hi < shapes.length && shapes[hi].end < t - LAYOUT.bankFade) hi++;
    let gap = Infinity;
    for (let j = hi; j < shapes.length && shapes[j].start - t < LAYOUT.bankFade; j++) {
      gap = Math.min(gap, Math.max(0, shapes[j].start - t, t - shapes[j].end));
    }
    if (gap < LAYOUT.bankFade) target *= smootherstep(gap / LAYOUT.bankFade);
    b += Math.max(-bankStep, Math.min(bankStep, target - b));
    bank[k] = b;
  }

  let li = 0, side = 0;
  const pose = makePose();
  const base = [0, 0, 0];
  const offsets = new Float64Array(count * 3);
  const upBase = new Float64Array(count * 3);
  const rgb = [0, 0, 0];
  for (let k = 0; k < count; k++) {
    const t = -LEAD_IN + k * dt;
    // Plain loops leave the track shifted sideways; keep that shift afterwards.
    while (li < shapes.length && t > shapes[li].end) {
      if (shapes[li].type === LOOP.PLAIN) side += LAYOUT.loopSideShift;
      li++;
    }
    const S = shapes[li];
    if (S && t >= S.start) shapePose(S, t, pose);
    else { pose.pitch = 0; pose.roll = 0; pose.side = 0; pose.radius = 0; pose.mark = 0; }
    loop[k] = pose.mark;
    const rho = pose.roll, R = pose.radius, lean = rho + bank[k];
    roll[k] = lean;
    const pr = pitch[k] + pose.pitch, yr = yaw[k];
    const cp = Math.cos(pr), sp = Math.sin(pr), cy = Math.cos(yr), sy = Math.sin(yr);
    const f = [sy * cp, sp, -cy * cp];
    const u = [-sy * sp, cp, cy * sp];
    const r = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];
    if (k > 0) {
      const ds = 0.5 * (speed[k - 1] + speed[k]) * dt;
      dist[k] = dist[k - 1] + ds;
      for (let c = 0; c < 3; c++) base[c] += f[c] * ds;
    }
    const rightFlat = [cy, 0, sy], sh = side + pose.side;
    const cl = Math.cos(lean), sl = Math.sin(lean);
    for (let c = 0; c < 3; c++) {
      offsets[k * 3 + c] = R * (1 - Math.cos(rho)) * u[c] - R * Math.sin(rho) * r[c] + sh * rightFlat[c];
      pos[k * 3 + c] = base[c];
      upBase[k * 3 + c] = cl * u[c] + sl * r[c];
    }
    gradientAt(intensity[k], rgb);
    color[k * 3] = rgb[0]; color[k * 3 + 1] = rgb[1]; color[k * 3 + 2] = rgb[2];
  }
  // Final positions, re-based so the node at song time 0 is the origin.
  const k0 = Math.round(LEAD_IN * NODE_RATE);
  const o = [pos[k0 * 3] + offsets[k0 * 3], pos[k0 * 3 + 1] + offsets[k0 * 3 + 1], pos[k0 * 3 + 2] + offsets[k0 * 3 + 2]];
  const d0 = dist[k0];
  for (let k = 0; k < count; k++) {
    for (let c = 0; c < 3; c++) pos[k * 3 + c] = pos[k * 3 + c] + offsets[k * 3 + c] - o[c];
    dist[k] -= d0;
  }
  // Tangents from the final path; up made orthogonal to them.
  for (let k = 0; k < count; k++) {
    const a = Math.max(0, k - 1), b = Math.min(count - 1, k + 1);
    let fx = pos[b * 3] - pos[a * 3], fy = pos[b * 3 + 1] - pos[a * 3 + 1], fz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    let ux = upBase[k * 3], uy = upBase[k * 3 + 1], uz = upBase[k * 3 + 2];
    const d = ux * fx + uy * fy + uz * fz;
    ux -= d * fx; uy -= d * fy; uz -= d * fz;
    const ul = Math.hypot(ux, uy, uz) || 1;
    fwd[k * 3] = fx; fwd[k * 3 + 1] = fy; fwd[k * 3 + 2] = fz;
    up[k * 3] = ux / ul; up[k * 3 + 1] = uy / ul; up[k * 3 + 2] = uz / ul;
  }
  return { rate: NODE_RATE, t0: -LEAD_IN, count, intensity, speed, dist, pitch, yaw, roll, loop, pos, fwd, up, color };
}

// --- assembly ----------------------------------------------------------------

/**
 * Build the SongMap for a mode.
 * @param features  output of analyzeAudio
 * @param {{ mode?: 'mono'|'ninja'|'casual', seed?: string, maxRate?: number }} options
 *   seed: the analysis ID (file hash, 'yt:<id>' or 'demo'); maxRate overrides the mode's density cap.
 */
export function buildSongMap(features, { mode = 'mono', seed = 'demo', maxRate } = {}) {
  const base = MODES[mode];
  if (!base) throw new Error(`unknown mode ${mode}`);
  const cfg = { ...base, maxRate: maxRate ?? base.maxRate };
  const rand = mulberry32(seedFromString(`${seed}|${mode}`));
  const duration = features.duration;
  const { bpm, beats, downbeatPhase } = features.tempo;
  const grid = makeGrid(beats, bpm, duration);
  const scales = bandScales(features);

  const candidates = candidatesFrom(features, grid);
  const minutes = duration / 60;
  const pbCount = Math.min(cfg.maxPowerBlocks, Math.floor(minutes) + cfg.extraPowerBlocks);
  const power = findPowerBlocks(features, candidates, grid, pbCount);
  const nearPower = (t) => power.some((pb) => Math.abs(pb.time - t) < LAYOUT.pbClear);
  const kept = capDensity(candidates.filter((c) => !nearPower(c.t)), power.map((pb) => pb.time), cfg.maxRate);
  let blocks = fillQuietGaps(kept, features, grid, downbeatPhase, scales);
  for (const b of blocks) {
    b.type = BLOCK.COLOUR;
    b.spanEnd = spanEnd(b, features);
    b.pbRank = 0;
  }
  assignGreys(blocks, cfg);
  for (const pb of power) {
    blocks.push({ t: pb.time, raw: pb.time, strength: 1, band: 0, snapped: true, pos: gridPosition(grid, pb.time), filler: false, type: BLOCK.POWER, spanEnd: pb.time, pbRank: pb.rank });
  }
  blocks.sort((a, b) => a.t - b.t || a.type - b.type);
  assignLanes(blocks, grid, downbeatPhase, rand);
  enforceSpacing(blocks, rand);

  const loops = power.map((pb) => ({
    time: pb.time,
    rank: pb.rank,
    type: pb.rank === 1 ? LOOP.DOUBLE : power.length > 1 && pb.rank === power.length ? LOOP.PLAIN : LOOP.CORKSCREW,
    start: pb.time - LAYOUT.loopLength / 2,
    end: pb.time + LAYOUT.loopLength / 2,
  }));
  const plan = planFeatures(features, grid, downbeatPhase, loops);
  const shapes = [...loops, ...plan.features].sort((a, b) => a.start - b.start);
  const nodes = buildNodes(features, blocks, shapes, plan.sweeps, cfg, rand);

  const n = blocks.length;
  const out = {
    time: new Float64Array(n), lane: new Int8Array(n), type: new Uint8Array(n), strength: new Float32Array(n),
    band: new Uint8Array(n), spanEnd: new Float64Array(n), pbRank: new Uint8Array(n), filler: new Uint8Array(n), snapped: new Uint8Array(n),
  };
  blocks.forEach((b, i) => {
    out.time[i] = b.t; out.lane[i] = b.lane; out.type[i] = b.type; out.strength[i] = b.strength; out.band[i] = b.band;
    out.spanEnd[i] = b.spanEnd; out.pbRank[i] = b.pbRank; out.filler[i] = b.filler ? 1 : 0; out.snapped[i] = b.snapped ? 1 : 0;
  });
  out.count = n;

  const I = features.intensity.smooth, rate = features.intensity.rate;
  let quiet = 0;
  while (quiet < I.length && I[quiet] < 0.1) quiet++;
  const skipIntroTo = quiet / rate > 4 ? Math.max(0, quiet / rate - 1) : null;

  const map = {
    version: SONGMAP_VERSION,
    mode, seed, duration,
    bpm: features.tempo.bpm,
    beats: Float64Array.from(features.tempo.beats),
    downbeatPhase,
    nodes,
    blocks: out,
    powerBlocks: power.map((pb) => ({ ...pb, loop: loops.find((l) => l.time === pb.time) })),
    features: plan.features,
    sweeps: plan.sweeps,
    skyline: { rate: features.frameRate, bands: features.skylineBands, data: features.skyline.slice() },
    skipIntroTo,
    stats: {
      onsets: features.onsets.times.length,
      blocks: n,
      colour: count(out.type, BLOCK.COLOUR),
      grey: count(out.type, BLOCK.GREY),
      power: power.length,
      spans: out.spanEnd.reduce((a, e, i) => a + (e > out.time[i] ? 1 : 0), 0),
      fillers: count(out.filler, 1),
      snapped: count(out.snapped, 1),
      trackLength: nodes.dist[nodes.count - 1] - nodes.dist[0],
    },
  };
  map.hash = songMapHash(map);
  return map;
}

function count(arr, v) {
  let c = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] === v) c++;
  return c;
}

/** Stable hash of everything gameplay and scoring depend on. */
export function songMapHash(map) {
  const h = new Hasher();
  h.int(map.version).int(seedFromString(map.mode)).int(seedFromString(map.seed)).num(map.duration, 1e-3).num(map.bpm, 1e-3);
  const b = map.blocks;
  h.array(b.time, 1e-4).array(b.lane, 1).array(b.type, 1).array(b.strength, 1e-3).array(b.band, 1).array(b.spanEnd, 1e-4).array(b.pbRank, 1);
  const nd = map.nodes;
  h.array(nd.pos, 1e-3).array(nd.up, 1e-4).array(nd.speed, 1e-3).array(nd.intensity, 1e-4).array(nd.loop, 1);
  for (const pb of map.powerBlocks) h.num(pb.time, 1e-4).int(pb.rank).int(pb.loop.type);
  for (const f of map.features) h.int(f.type).num(f.start, 1e-4).num(f.end, 1e-4).int(f.dir);
  for (const w of map.sweeps) h.num(w.start, 1e-4).num(w.end, 1e-4).num(w.yaw, 1e-3).int(w.dir);
  return h.digest();
}
