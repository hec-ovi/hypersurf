// Capture-latency calibration (docs/research.md §2.2). Tab audio reaches
// us some tens of milliseconds after it plays (Chromium's loopback, plus
// our own analysis framing). The game plays eight clicks through its own
// output, listens for them in the capture and takes the median offset;
// every live onset time is then moved back by it.
//
// The clicks are spaced irregularly, and the detector slides the whole
// train over the recorded onset function to find the lag that lines all
// eight up (a matched filter), so it also works under music when the
// calibration has to run again mid-song. Each click's own peak near that
// lag gives one offset; the median of at least five is the answer.
//
// DriftWatch decides when to run it again: while the tempo is steady, the
// beats an onset confirmed lie on a straight line; when the newest eight
// sit more than 25 ms off the line the older ones draw, and sit there flat
// (a step, not the ramp of a tempo change), the capture delay has most
// likely moved (the loopback can grow mid-session).

import { SpectralFlux, TRACKER } from './tracker.js';
import { mulberry32 } from '../audio/random.js';

export const CALIBRATION = Object.freeze({
  gaps: Object.freeze([0.37, 0.29, 0.43, 0.33, 0.47, 0.31, 0.39]), // seconds between the 8 clicks
  maxLatency: 0.35, // seconds searched
  agree: 0.02, // a click's own offset must sit this close to the train's
  minFound: 5,
  prominence: 4, // a click peak must reach this many times the recording's median
});

/** Context times of the eight clicks, the first at `start`. */
export function clickTimes(start) {
  const out = new Float64Array(CALIBRATION.gaps.length + 1);
  out[0] = start;
  for (let i = 0; i < CALIBRATION.gaps.length; i++) out[i + 1] = out[i] + CALIBRATION.gaps[i];
  return out;
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
 * Records the onset function of captured audio against context time while
 * a click train plays. push(hop, t) with t the context time of the hop's
 * first sample.
 */
export class ClickListener {
  constructor(sampleRate, seconds = 6) {
    this.flux = new SpectralFlux(sampleRate, TRACKER);
    this.hopDur = TRACKER.hop / sampleRate;
    const cap = Math.ceil(seconds / this.hopDur);
    this.odf = new Float32Array(cap);
    this.times = new Float64Array(cap);
    this.count = 0;
  }

  push(hop, t) {
    const v = this.flux.push(hop);
    if (this.count >= this.odf.length) return;
    this.odf[this.count] = v;
    this.times[this.count] = t + this.hopDur / 2; // the tracker's frame-time convention
    this.count++;
  }

  /** Median capture latency for `clicks` (context times), or null. */
  measure(clicks) {
    return measureLatency(this.odf.subarray(0, this.count), this.times.subarray(0, this.count), clicks, this.hopDur);
  }
}

/**
 * Median offset between scheduled clicks and their peaks in an onset
 * function sampled at uniform `times`. Returns { latency, found, spread }
 * (seconds; spread is the median absolute deviation) or null when fewer
 * than five clicks stand out.
 */
export function measureLatency(odf, times, clicks, hopDur) {
  const n = odf.length;
  if (n < 8) return null;
  const sorted = Float32Array.from(odf).sort();
  const floor = Math.max(1e-9, sorted[n >> 1]);
  const t0 = times[0];
  const frameAt = (t) => Math.round((t - t0) / hopDur);
  // Slide the train: the lag whose frames hold the most onset energy.
  let bestLag = 0, bestScore = -1;
  for (let lag = 0; lag <= CALIBRATION.maxLatency + 1e-9; lag += 0.001) {
    let s = 0;
    for (let i = 0; i < clicks.length; i++) {
      const f = frameAt(clicks[i] + lag);
      if (f >= 0 && f < n) s += odf[f];
    }
    if (s > bestScore) { bestScore = s; bestLag = lag; }
  }
  // Each click's own peak near that lag, to sub-frame precision.
  const offsets = [];
  for (let i = 0; i < clicks.length; i++) {
    const c = frameAt(clicks[i] + bestLag);
    let p = -1;
    for (let f = Math.max(1, c - 2); f <= Math.min(n - 2, c + 2); f++) if (p < 0 || odf[f] > odf[p]) p = f;
    if (p < 0 || odf[p] < CALIBRATION.prominence * floor) continue;
    const a = odf[p - 1], b = odf[p], d = odf[p + 1];
    const den = a - 2 * b + d;
    const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - d)) / den)) : 0;
    const off = times[p] + frac * hopDur - clicks[i];
    if (Math.abs(off - bestLag) <= CALIBRATION.agree + hopDur) offsets.push(off);
  }
  if (offsets.length < CALIBRATION.minFound) return null;
  offsets.sort((x, y) => x - y);
  const latency = offsets[offsets.length >> 1];
  const dev = offsets.map((o) => Math.abs(o - latency)).sort((x, y) => x - y);
  return { latency, found: offsets.length, spread: dev[dev.length >> 1] };
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
