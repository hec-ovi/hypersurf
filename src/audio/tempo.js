// Tempo and beats: a windowed onset-autocorrelation tempogram with a
// log-normal tempo prior (librosa's tempo()), and Ellis' dynamic-programming
// beat tracker (2007) with librosa's first/last-beat and edge-trim rules.

import { RealFFT } from './fft.js';
import { hann } from './dsp.js';

export const TEMPO_DEFAULTS = Object.freeze({
  window: 8, // seconds of onset envelope per autocorrelation
  stride: 4, // frames between tempogram columns
  startBpm: 120,
  stdOctaves: 1,
  maxBpm: 320,
  minBpm: 30,
});

const nextPow2 = (n) => 1 << Math.ceil(Math.log2(Math.max(2, n)));

/**
 * Autocorrelation tempogram. Column c describes the envelope centred on frame
 * c · stride; each column is normalised to its lag-0 value.
 * Returns { lags, stride, columns, data: Float32Array(columns × lags) }.
 */
export function tempogram(envelope, frameRate, options = {}) {
  const o = { ...TEMPO_DEFAULTS, ...options };
  const win = Math.max(8, Math.round(o.window * frameRate));
  const size = nextPow2(2 * win);
  const fft = new RealFFT(size);
  const buf = new Float32Array(size);
  const bins = size / 2 + 1;
  const re = new Float64Array(bins), im = new Float64Array(bins);
  const w = hann(win, false);
  const half = win >> 1;
  const columns = Math.max(1, Math.ceil(envelope.length / o.stride));
  const lags = win;
  const data = new Float32Array(columns * lags);
  const even = new Float32Array(size);
  for (let c = 0; c < columns; c++) {
    const center = c * o.stride;
    for (let i = 0; i < size; i++) {
      const j = center - half + i;
      buf[i] = i < win && j >= 0 && j < envelope.length ? envelope[j] * w[i] : 0;
    }
    // Wiener-Khinchin: the autocorrelation is the inverse DFT of the power
    // spectrum. That spectrum is real and even, so a forward DFT gives N·r[l].
    fft.forward(buf, re, im);
    for (let k = 0; k < bins; k++) even[k] = re[k] * re[k] + im[k] * im[k];
    for (let k = bins; k < size; k++) even[k] = even[size - k];
    fft.forward(even, re, im);
    const base = c * lags, a0 = re[0];
    for (let l = 0; l < lags; l++) data[base + l] = a0 > 1e-12 ? re[l] / a0 : 0;
  }
  return { lags, stride: o.stride, columns, data, frameRate };
}

function logPrior(bpm, center, stdOctaves) {
  const z = (Math.log2(bpm) - Math.log2(center)) / stdOctaves;
  return -0.5 * z * z;
}

/** Best lag of an autocorrelation row under a tempo prior, refined to a fraction of a frame. */
function bestLag(row, frameRate, center, stdOctaves, minBpm, maxBpm) {
  let best = -1, bestScore = -Infinity;
  for (let l = 1; l < row.length; l++) {
    const bpm = (60 * frameRate) / l;
    if (bpm > maxBpm || bpm < minBpm) continue;
    const s = Math.log1p(1e6 * Math.max(0, row[l])) + logPrior(bpm, center, stdOctaves);
    if (s > bestScore) { bestScore = s; best = l; }
  }
  if (best < 1) return { lag: NaN, strength: 0 };
  let lag = best;
  if (best > 1 && best + 1 < row.length) {
    const a = row[best - 1], b = row[best], c = row[best + 1];
    const den = a - 2 * b + c;
    if (den < 0) lag += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
  }
  return { lag, strength: row[best] };
}

/**
 * Global tempo from the mean tempogram. Returns { bpm, period (frames), strength, tg }.
 */
export function estimateTempo(envelope, frameRate, options = {}) {
  const o = { ...TEMPO_DEFAULTS, ...options };
  const tg = options.tempogram || tempogram(envelope, frameRate, o);
  const mean = new Float64Array(tg.lags);
  for (let c = 0; c < tg.columns; c++) for (let l = 0; l < tg.lags; l++) mean[l] += tg.data[c * tg.lags + l];
  for (let l = 0; l < tg.lags; l++) mean[l] /= tg.columns;
  const { lag, strength } = bestLag(mean, frameRate, o.startBpm, o.stdOctaves, o.minBpm, o.maxBpm);
  return { bpm: (60 * frameRate) / lag, period: lag, strength, tempogram: tg };
}

/**
 * Per-frame tempo (aggregate=None), constrained near the global tempo so it
 * cannot jump an octave, median-smoothed over `smooth` seconds.
 * Returns Float32Array of periods in frames, one per envelope frame.
 */
export function localPeriods(tg, globalBpm, frameRate, nFrames, { stdOctaves = 0.25, smooth = 8 } = {}) {
  const col = new Float32Array(tg.columns);
  const row = new Float32Array(tg.lags);
  for (let c = 0; c < tg.columns; c++) {
    row.set(tg.data.subarray(c * tg.lags, (c + 1) * tg.lags));
    const { lag } = bestLag(row, frameRate, globalBpm, stdOctaves, 30, 320);
    col[c] = Number.isFinite(lag) ? lag : (60 * frameRate) / globalBpm;
  }
  const k = Math.max(1, Math.round((smooth * frameRate) / tg.stride / 2));
  const med = new Float32Array(tg.columns);
  const scratch = [];
  for (let c = 0; c < tg.columns; c++) {
    scratch.length = 0;
    for (let j = Math.max(0, c - k); j <= Math.min(tg.columns - 1, c + k); j++) scratch.push(col[j]);
    scratch.sort((a, b) => a - b);
    med[c] = scratch[scratch.length >> 1];
  }
  const out = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    const x = i / tg.stride, c = Math.min(tg.columns - 1, Math.floor(x)), f = x - c;
    out[i] = c + 1 < tg.columns ? med[c] + (med[c + 1] - med[c]) * f : med[c];
  }
  return out;
}

/** Local score: the onset envelope over its std, smoothed by a Gaussian of σ = period/32. */
export function beatLocalScore(envelope, period) {
  const n = envelope.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += envelope[i];
  m /= n || 1;
  let v = 0;
  for (let i = 0; i < n; i++) v += (envelope[i] - m) ** 2;
  const sd = Math.sqrt(v / Math.max(1, n - 1)) || 1;
  const half = Math.round(period);
  const kernel = new Float64Array(2 * half + 1);
  for (let k = -half; k <= half; k++) kernel[k + half] = Math.exp(-0.5 * ((k * 32) / period) ** 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
    for (let j = lo; j <= hi; j++) s += kernel[j - i + half] * envelope[j];
    out[i] = s / sd;
  }
  return out;
}

/**
 * Ellis DP beat tracker. `periods` is a number or a per-frame Float32Array
 * (frames per beat). Returns beat positions in (fractional) frames.
 */
export function trackBeats(envelope, periods, { tightness = 100, trim = true } = {}) {
  const n = envelope.length;
  const periodAt = typeof periods === 'number' ? () => periods : (i) => periods[i];
  let meanPeriod = 0;
  for (let i = 0; i < n; i++) meanPeriod += periodAt(i);
  meanPeriod /= n || 1;
  const local = beatLocalScore(envelope, meanPeriod);
  let maxLocal = 0;
  for (let i = 0; i < n; i++) if (local[i] > maxLocal) maxLocal = local[i];
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  let firstBeat = true;
  for (let i = 0; i < n; i++) {
    const p = periodAt(i);
    const lo = i - Math.round(2 * p), hi = i - Math.round(p / 2);
    let best = -Infinity, arg = -1;
    for (let loc = lo; loc <= hi; loc++) {
      const d = Math.log((i - loc) / p);
      const v = (loc >= 0 ? cum[loc] : 0) - tightness * d * d;
      if (v > best) { best = v; arg = loc; }
    }
    cum[i] = local[i] + (arg === -1 && best === -Infinity ? 0 : best);
    if (firstBeat && local[i] < 0.01 * maxLocal) back[i] = -1;
    else {
      back[i] = arg >= 0 ? arg : -1;
      firstBeat = false;
    }
  }
  // Last beat: the final local maximum of the cumulative score above half its median peak.
  const peaks = [];
  for (let i = 0; i < n; i++) {
    const l = i > 0 ? cum[i - 1] : -Infinity, r = i + 1 < n ? cum[i + 1] : -Infinity;
    if (cum[i] > l && cum[i] >= r) peaks.push(i);
  }
  if (!peaks.length) return new Float64Array(0);
  const sorted = peaks.map((i) => cum[i]).sort((a, b) => a - b);
  const medScore = sorted[sorted.length >> 1];
  let last = peaks[peaks.length - 1];
  for (let k = peaks.length - 1; k >= 0; k--) if (2 * cum[peaks[k]] > medScore) { last = peaks[k]; break; }
  const beats = [];
  for (let b = last; b >= 0; b = back[b]) beats.push(b);
  beats.reverse();
  let lo = 0, hi = beats.length;
  if (trim && beats.length) {
    // Hann(5)-smoothed beat strengths; drop weak beats at the edges.
    const w = [0, 0.5, 1, 0.5, 0];
    const sm = beats.map((_, i) => {
      let s = 0;
      for (let k = -2; k <= 2; k++) if (i + k >= 0 && i + k < beats.length) s += w[k + 2] * local[beats[i + k]];
      return s;
    });
    const threshold = 0.5 * Math.sqrt(sm.reduce((a, v) => a + v * v, 0) / sm.length);
    while (lo < hi && local[beats[lo]] <= threshold) lo++;
    while (hi > lo && local[beats[hi - 1]] <= threshold) hi--;
  }
  const out = new Float64Array(hi - lo);
  for (let k = lo; k < hi; k++) {
    // Sub-frame refinement on the local score.
    const b = beats[k];
    let off = 0;
    if (b > 0 && b + 1 < n) {
      const a = local[b - 1], c = local[b], d = local[b + 1];
      const den = a - 2 * c + d;
      if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (a - d)) / den));
    }
    out[k - lo] = b + off;
  }
  // Beats with no onset under them (silence, a held pad) are placed by the DP
  // anywhere its integer-frame steps allow. Space each such run evenly
  // between the supported beats on either side.
  const strengths = Array.from(out, (f) => local[Math.round(f)]).sort((a, b) => a - b);
  const weak = 0.1 * (strengths[strengths.length >> 1] || 0);
  let prev = -1;
  for (let k = 0; k < out.length; k++) {
    if (local[Math.round(out[k])] < weak) continue;
    if (prev >= 0 && k - prev > 1) {
      const a = out[prev], b = out[k], steps = k - prev;
      for (let j = 1; j < steps; j++) out[prev + j] = a + ((b - a) * j) / steps;
    }
    prev = k;
  }
  return out;
}

/** Least-squares tempo of a beat sequence (assumes consecutive beats). */
export function beatsBpm(beatTimes) {
  const n = beatTimes.length;
  if (n < 2) return NaN;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += beatTimes[i]; sxx += i * i; sxy += i * beatTimes[i]; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return 60 / slope;
}

/**
 * Downbeat phase (0..3) for 4/4: bar starts are where the spectrum changes
 * most (chord and bass changes), measured between consecutive beat spans.
 * `features` is a frame-major Float32/Uint8 matrix with `dims` columns.
 */
export function downbeatPhase(beatFrames, features, dims, beatsPerBar = 4) {
  const nb = beatFrames.length;
  if (nb < 2 * beatsPerBar) return 0;
  const means = [];
  for (let b = 0; b + 1 < nb; b++) {
    const lo = Math.round(beatFrames[b]), hi = Math.max(lo + 1, Math.round(beatFrames[b + 1]));
    const m = new Float64Array(dims);
    for (let f = lo; f < hi; f++) for (let d = 0; d < dims; d++) m[d] += features[f * dims + d] || 0;
    for (let d = 0; d < dims; d++) m[d] /= hi - lo;
    means.push(m);
  }
  const score = new Float64Array(beatsPerBar), count = new Float64Array(beatsPerBar);
  for (let b = 1; b < means.length; b++) {
    let diff = 0;
    for (let d = 0; d < dims; d++) diff += Math.abs(means[b][d] - means[b - 1][d]);
    score[b % beatsPerBar] += diff;
    count[b % beatsPerBar]++;
  }
  let best = 0;
  for (let p = 1; p < beatsPerBar; p++) if (score[p] / count[p] > score[best] / count[best]) best = p;
  return best;
}
