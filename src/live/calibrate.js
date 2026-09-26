// Capture-latency calibration (docs/research.md §2.2). Tab audio reaches
// us some tens to hundreds of milliseconds after it plays (the browser's
// loopback and its media-stream plumbing, plus our own analysis framing).
// The game plays eight clicks through its own output, listens for them in
// the capture, and every live onset time is then moved back by the delay.
//
// Detection is a matched filter on the waveform, not on the onset
// function: the click is a known, deterministic signal, so the capture is
// cross-correlated with it (both pre-emphasised, which tilts a music bed's
// heavy low end away) and the per-click responses are summed along the
// train's irregular spacing for every lag up to maxLatency. The best lag
// must stand far out of the spread of all the others (peak-to-sidelobe
// ratio), and at least five of the eight clicks must add to it. That finds
// the train under loud music and at any level, where an onset-function
// peak picker loses it.
//
// The live onsets carry the onset front end's own framing delay (a few
// ms, depending on where a click falls in a hop). The reported latency
// includes it: the clean train, delayed by the lag found, is run through
// the same front end on the same hop grid, and its onset peaks give the
// latency the onsets need, exactly as a silent capture would have.
//
// DriftWatch decides when to run it again: while the tempo is steady, the
// beats an onset confirmed lie on a straight line; when the newest eight
// sit more than 25 ms off the line the older ones draw, and sit there flat
// (a step, not the ramp of a tempo change), the capture delay has most
// likely moved (the loopback can grow mid-session).

import { SpectralFlux, TRACKER } from './tracker.js';
import { FFT } from '../audio/fft.js';
import { mulberry32 } from '../audio/random.js';

export const CALIBRATION = Object.freeze({
  gaps: Object.freeze([0.37, 0.29, 0.43, 0.33, 0.47, 0.31, 0.39]), // seconds between the 8 clicks
  maxLatency: 0.8, // seconds searched
  minPsr: 8, // the best lag's peak-to-sidelobe ratio
  minFound: 5, // clicks that must add to the best lag
  clickShare: 0.35, // a click adds when its response reaches this share of the mean
  agree: 0.02, // onset front end: a click's own offset must sit this close to the train's
  prominence: 4, // onset front end: a click peak must reach this many times the median
});

/** Context times of the eight clicks, the first at `start`. */
export function clickTimes(start) {
  const out = new Float64Array(CALIBRATION.gaps.length + 1);
  out[0] = start;
  for (let i = 0; i < CALIBRATION.gaps.length; i++) out[i + 1] = out[i] + CALIBRATION.gaps[i];
  return out;
}

/** Seconds from the first click to the end of the last one heard at the longest delay. */
export function trainSpan() {
  return CALIBRATION.gaps.reduce((a, b) => a + b, 0) + CALIBRATION.maxLatency + 0.02;
}

/** The click: 4 ms of decaying noise over a short 2.5 kHz blip. Deterministic. */
export function synthClick(sampleRate) {
  const n = Math.round(0.012 * sampleRate), out = new Float32Array(n);
  const rand = mulberry32(0xc11c);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    out[i] = 0.7 * (rand() * 2 - 1) * Math.exp(-t / 0.0012) + 0.5 * Math.sin(2 * Math.PI * 2500 * t) * Math.exp(-t / 0.003);
  }
  return out;
}

/**
 * Records captured audio against context time while a click train plays.
 * push(hop, t) with t the context time of the hop's first sample; hops
 * land by their time stamps, so a gap in the capture leaves silence, not
 * a shift.
 */
export class ClickListener {
  constructor(sampleRate, seconds = 6) {
    this.sampleRate = sampleRate;
    this.signal = new Float32Array(Math.ceil(seconds * sampleRate));
    this.t0 = NaN;
    this.length = 0;
  }

  push(hop, t) {
    if (Number.isNaN(this.t0)) this.t0 = t;
    const i0 = Math.round((t - this.t0) * this.sampleRate);
    if (i0 < 0 || i0 >= this.signal.length) return;
    const n = Math.min(hop.length, this.signal.length - i0);
    this.signal.set(n === hop.length ? hop : hop.subarray(0, n), i0);
    if (i0 + n > this.length) this.length = i0 + n;
  }

  /** The capture latency for `clicks` (context times): { latency, lag, found, spread, psr } or null. */
  measure(clicks) {
    return this._result(clicks, finish(this._steps(clicks)));
  }

  /**
   * measure(), a slice at a time: `pause()` (a promise) runs between the
   * slices (a few milliseconds each), so a calibration under a running
   * game never holds a frame up.
   */
  async measureAsync(clicks, pause) {
    const it = this._steps(clicks);
    for (let s = it.next(); ; s = it.next()) {
      if (s.done) return this._result(clicks, s.value);
      await pause();
    }
  }

  _steps(clicks) {
    return Number.isNaN(this.t0) ? empty() : detectSteps(this.signal.subarray(0, this.length), this.t0, this.sampleRate, clicks);
  }

  _result(clicks, d) {
    if (!d) return null;
    const latency = onsetLatency(clicks, d.lag, this.t0, this.length, this.sampleRate);
    return { latency: latency === null ? d.lag : latency, lag: d.lag, found: d.found, spread: d.spread, psr: d.psr };
  }
}

/**
 * Find a click train in a capture whose first sample plays at context
 * time t0: the lag (seconds, 0..maxLatency) of the matched filter's peak,
 * its peak-to-sidelobe ratio, how many clicks add to it and the spread of
 * their own peaks (median absolute deviation, seconds). Null when the
 * train does not stand out.
 */
export function detectClicks(signal, t0, sampleRate, clicks, options) {
  return finish(detectSteps(signal, t0, sampleRate, clicks, options));
}

/** detectClicks as a generator that yields between slices of the work. */
function* detectSteps(signal, t0, sampleRate, clicks, { maxLatency = CALIBRATION.maxLatency } = {}) {
  const tmpl = preEmphasis(synthClick(sampleRate));
  const m = tmpl.length, n = signal.length;
  const first = Math.round((clicks[0] - t0) * sampleRate);
  const offs = Array.from(clicks, (c) => Math.round((c - clicks[0]) * sampleRate));
  const lags = Math.floor(maxLatency * sampleRate) + 1;
  // The recording must start before the train and hold it at the shortest lag.
  if (first < 0 || first + offs[offs.length - 1] + m > n) return null;
  // r[j]: the click template correlated with the capture at sample j.
  const r = yield* correlate(preEmphasis(signal), tmpl);
  const at = (j) => (j >= 0 && j < r.length ? r[j] : 0);
  const c = new Float64Array(lags);
  let best = 0;
  for (let L = 0; L < lags; L++) {
    let s = 0;
    for (let i = 0; i < offs.length; i++) s += at(first + L + offs[i]);
    c[L] = s;
    if (s > c[best]) best = L;
  }
  if (!(c[best] > 0)) return null;
  // Peak-to-sidelobe ratio: the peak against every lag more than 3 ms away.
  const guard = Math.round(0.003 * sampleRate);
  let sum = 0, sq = 0, cnt = 0;
  for (let L = 0; L < lags; L++) {
    if (Math.abs(L - best) <= guard) continue;
    sum += c[L]; sq += c[L] * c[L]; cnt++;
  }
  const mean = cnt ? sum / cnt : 0, sd = cnt ? Math.sqrt(Math.max(0, sq / cnt - mean * mean)) : 0;
  const psr = sd > 0 ? (c[best] - mean) / sd : Infinity;
  // Clicks that add to the peak, and where each one's own response peaks.
  const share = (CALIBRATION.clickShare * c[best]) / offs.length, near = Math.round(0.0015 * sampleRate);
  const own = [];
  let found = 0;
  for (let i = 0; i < offs.length; i++) {
    const j = first + best + offs[i];
    if (at(j) < share) continue;
    found++;
    let p = j;
    for (let q = j - near; q <= j + near; q++) if (at(q) > at(p)) p = q;
    own.push((p - j) / sampleRate);
  }
  if (psr < CALIBRATION.minPsr || found < CALIBRATION.minFound) return null;
  // Sub-sample peak.
  const a = best > 0 ? c[best - 1] : c[best], b = c[best], d = best < lags - 1 ? c[best + 1] : c[best];
  const den = a - 2 * b + d;
  const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - d)) / den)) : 0;
  own.sort((x, y) => x - y);
  const mid = own[own.length >> 1];
  const dev = own.map((o) => Math.abs(o - mid)).sort((x, y) => x - y);
  return { lag: (best + frac) / sampleRate, psr, found, spread: dev[dev.length >> 1] };
}

/** y[i] = x[i] − 0.95·x[i−1]: tilts the spectrum toward the click's highs. */
function preEmphasis(x) {
  const y = new Float32Array(x.length);
  let prev = 0;
  for (let i = 0; i < x.length; i++) {
    y[i] = x[i] - 0.95 * prev;
    prev = x[i];
  }
  return y;
}

const BLOCK = 8192;
const fftOf = new Map(); // FFT tables by size

/**
 * r[j] = Σ_k t[k]·x[j + k] for every j, by FFT in overlapping blocks
 * (overlap-save), yielding after each block.
 */
function* correlate(x, t) {
  const m = t.length;
  let size = BLOCK;
  while (size < 4 * m) size *= 2;
  if (!fftOf.has(size)) fftOf.set(size, new FFT(size));
  const fft = fftOf.get(size), step = size - m + 1;
  const tr = new Float64Array(size), ti = new Float64Array(size);
  tr.set(t);
  fft.forward(tr, ti);
  const br = new Float64Array(size), bi = new Float64Array(size);
  const r = new Float32Array(x.length);
  for (let j0 = 0; j0 < x.length; j0 += step) {
    br.fill(0);
    bi.fill(0);
    br.set(x.subarray(j0, Math.min(x.length, j0 + size)));
    fft.forward(br, bi);
    // X · conj(T), then the inverse transform as conj(FFT(conj(·))) / size.
    for (let k = 0; k < size; k++) {
      const re = br[k] * tr[k] + bi[k] * ti[k], im = bi[k] * tr[k] - br[k] * ti[k];
      br[k] = re;
      bi[k] = -im;
    }
    fft.forward(br, bi);
    const n = Math.min(step, x.length - j0);
    for (let j = 0; j < n; j++) r[j0 + j] = br[j] / size;
    yield;
  }
  return r;
}

/** Run a step generator to its end. */
function finish(it) {
  for (let s = it.next(); ; s = it.next()) if (s.done) return s.value;
}

function* empty() {
  return null;
}

/**
 * The latency live onsets need for a train heard `lag` seconds late: the
 * clean train at that lag, on the capture's hop grid (first hop at t0),
 * through the onset front end. Null if it finds
 * fewer than five clicks (it should not).
 */
export function onsetLatency(clicks, lag, t0, length, sampleRate) {
  const hop = TRACKER.hop, click = synthClick(sampleRate), n = Math.max(length, 1);
  const clean = new Float32Array(n + hop);
  for (const c of clicks) {
    const i0 = Math.round((c + lag - t0) * sampleRate);
    for (let i = 0; i < click.length; i++) if (i0 + i >= 0 && i0 + i < clean.length) clean[i0 + i] += click[i];
  }
  const flux = new SpectralFlux(sampleRate, TRACKER);
  const hops = Math.floor(clean.length / hop), hopDur = hop / sampleRate;
  const odf = new Float32Array(hops), times = new Float64Array(hops);
  for (let k = 0; k < hops; k++) {
    odf[k] = flux.push(clean.subarray(k * hop, (k + 1) * hop));
    times[k] = t0 + k * hopDur + hopDur / 2; // the tracker's frame-time convention
  }
  const r = measureOnsets(odf, times, clicks, hopDur, lag);
  return r ? r.latency : null;
}

/**
 * Median offset between scheduled clicks and their peaks in an onset
 * function sampled at uniform `times`, near `lag`. Returns { latency,
 * found } or null when fewer than five clicks stand out.
 */
function measureOnsets(odf, times, clicks, hopDur, lag) {
  const n = odf.length;
  if (n < 8) return null;
  const sorted = Float32Array.from(odf).sort();
  const floor = Math.max(1e-9, sorted[n >> 1]);
  const t0 = times[0];
  const frameAt = (t) => Math.round((t - t0) / hopDur);
  const offsets = [];
  for (let i = 0; i < clicks.length; i++) {
    const c = frameAt(clicks[i] + lag);
    let p = -1;
    for (let f = Math.max(1, c - 2); f <= Math.min(n - 2, c + 2); f++) if (p < 0 || odf[f] > odf[p]) p = f;
    if (p < 0 || odf[p] < CALIBRATION.prominence * floor) continue;
    const a = odf[p - 1], b = odf[p], d = odf[p + 1];
    const den = a - 2 * b + d;
    const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - d)) / den)) : 0;
    const off = times[p] + frac * hopDur - clicks[i];
    if (Math.abs(off - lag) <= CALIBRATION.agree + hopDur) offsets.push(off);
  }
  if (offsets.length < CALIBRATION.minFound) return null;
  offsets.sort((x, y) => x - y);
  return { latency: offsets[offsets.length >> 1], found: offsets.length };
}

/**
 * Watches confirmed beats for a jump in capture delay. add(k, t) with k the
 * beat's index along the tracker's grid and t the onset that confirmed it.
 * Returns the drift in seconds when the newest `recent` beats sit more than
 * `limit` off the line through the older ones (and forgets the history),
 * otherwise 0.
 */
export class DriftWatch {
  constructor({ window = 32, recent = 8, limit = 0.025, steady = 0.01 } = {}) {
    this.window = window;
    this.recent = recent;
    this.limit = limit;
    this.steady = steady;
    this.k = new Float64Array(window);
    this.t = new Float64Array(window);
    this.res = new Float64Array(recent);
    this.reset();
  }

  reset() {
    this.count = 0;
  }

  add(k, t) {
    const W = this.window;
    if (this.count > 0 && k <= this.k[(this.count - 1) % W]) this.reset(); // the tracker restarted
    this.k[this.count % W] = k;
    this.t[this.count % W] = t;
    this.count++;
    if (this.count < W) return 0;
    // Line through the older beats.
    const old = W - this.recent;
    let sk = 0, st = 0, skk = 0, skt = 0;
    for (let j = 0; j < old; j++) {
      const i = (this.count - W + j) % W;
      sk += this.k[i]; st += this.t[i]; skk += this.k[i] * this.k[i]; skt += this.k[i] * this.t[i];
    }
    const den = old * skk - sk * sk;
    if (den <= 0) return 0;
    const b = (old * skt - sk * st) / den, a = (st - b * sk) / old;
    let ss = 0;
    for (let j = 0; j < old; j++) {
      const i = (this.count - W + j) % W, r = this.t[i] - (a + b * this.k[i]);
      ss += r * r;
    }
    if (Math.sqrt(ss / old) > this.steady) return 0; // not a steady tempo: no verdict
    for (let j = 0; j < this.recent; j++) {
      const i = (this.count - this.recent + j) % W;
      this.res[j] = this.t[i] - (a + b * this.k[i]);
    }
    const res = this.res.sort(), r = res[this.recent >> 1];
    if (Math.abs(r) <= this.limit) return 0;
    // A delay jump is a step (the beats past it sit flat, off the line); a
    // tempo change is a ramp, which the tracker follows by itself.
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < this.recent; j++) {
      if (Math.abs(res[j]) <= this.limit || Math.sign(res[j]) !== Math.sign(r)) continue;
      if (res[j] < lo) lo = res[j];
      if (res[j] > hi) hi = res[j];
    }
    if (hi - lo > 2 * this.steady) return 0;
    this.reset();
    return r;
  }
}
