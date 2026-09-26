// Onset detection: SuperFlux-style spectral flux on a 128-band mel dB
// spectrogram (librosa's onset_strength with a 3-bin max filter), plus the
// sub-band envelopes the SongMap uses for lanes, spans and the skyline.

import { RealFFT } from './fft.js';
import { hann, melFilterbank, applyFilterbank } from './dsp.js';

export const SPECTRAL_DEFAULTS = Object.freeze({
  nFft: 2048,
  hop: 512,
  nMels: 128,
  lag: 1,
  maxSize: 3,
  topDb: 80,
  bandEdges: [200, 3200], // Hz: low < 200 <= mid < 3200 <= high
  skylineBands: 16,
});

export const BAND = Object.freeze({ LOW: 0, MID: 1, HIGH: 2 });

/**
 * STFT → mel dB → flux. Frame t is centred on t · hop / sampleRate seconds
 * (the signal is zero-padded by nFft/2 at both ends).
 *
 * Returns {
 *   frameRate, nFrames, hop, sampleRate,
 *   envelope: Float32Array   mean rectified flux (unnormalised),
 *   bandFlux: Float32Array[3] rectified flux per sub-band,
 *   bandPower: Float32Array[3] linear mel power per sub-band,
 *   skyline: Uint8Array      nFrames × 16 band levels (0..255 over 60 dB),
 * }
 */
export function spectralAnalysis(signal, sampleRate, options = {}, onProgress) {
  const o = { ...SPECTRAL_DEFAULTS, ...options };
  const { nFft, hop, nMels, lag, maxSize, topDb } = o;
  const nFrames = 1 + Math.floor(signal.length / hop);
  const window = hann(nFft);
  const fft = new RealFFT(nFft);
  const fb = melFilterbank({ sampleRate, nFft, nMels });
  const frame = new Float32Array(nFft);
  const power = new Float64Array(nFft / 2 + 1);
  const mel = new Float32Array(nFrames * nMels);
  const melRow = new Float32Array(nMels);
  const pad = nFft >> 1;
  let maxPower = 0;

  for (let t = 0; t < nFrames; t++) {
    const start = t * hop - pad;
    if (start >= 0 && start + nFft <= signal.length) {
      for (let i = 0; i < nFft; i++) frame[i] = signal[start + i] * window[i];
    } else {
      for (let i = 0; i < nFft; i++) {
        const j = start + i;
        frame[i] = j >= 0 && j < signal.length ? signal[j] * window[i] : 0;
      }
    }
    fft.power(frame, power);
    applyFilterbank(fb, power, melRow);
    const base = t * nMels;
    for (let b = 0; b < nMels; b++) {
      const v = melRow[b];
      mel[base + b] = v;
      if (v > maxPower) maxPower = v;
    }
    if (onProgress && (t & 255) === 0) onProgress(t / nFrames);
  }

  // Band groups by mel centre frequency.
  const bandOf = new Uint8Array(nMels);
  const bandCount = [0, 0, 0];
  for (let b = 0; b < nMels; b++) {
    const c = fb.centers[b];
    bandOf[b] = c < o.bandEdges[0] ? 0 : c < o.bandEdges[1] ? 1 : 2;
    bandCount[bandOf[b]]++;
  }
  const bandPower = [new Float32Array(nFrames), new Float32Array(nFrames), new Float32Array(nFrames)];
  const groups = o.skylineBands, perGroup = nMels / groups;
  const skyline = new Uint8Array(nFrames * groups);
  const refDb = 10 * Math.log10(Math.max(1e-10, maxPower));
  for (let t = 0; t < nFrames; t++) {
    const base = t * nMels;
    for (let b = 0; b < nMels; b++) bandPower[bandOf[b]][t] += mel[base + b];
    for (let g = 0; g < groups; g++) {
      let s = 0;
      for (let k = 0; k < perGroup; k++) s += mel[base + g * perGroup + k];
      const db = 10 * Math.log10(Math.max(1e-10, s / perGroup)) - refDb;
      skyline[t * groups + g] = Math.max(0, Math.min(255, Math.round(((db + 60) / 60) * 255)));
    }
  }

  // power_to_db with ref 1 and top_db clipping against the song's maximum.
  const floorDb = refDb - topDb;
  for (let i = 0; i < mel.length; i++) {
    const db = 10 * Math.log10(Math.max(1e-10, mel[i]));
    mel[i] = db < floorDb ? floorDb : db;
  }

  // Flux against a frequency-max-filtered reference `lag` frames back.
  const envelope = new Float32Array(nFrames);
  const bandFlux = [new Float32Array(nFrames), new Float32Array(nFrames), new Float32Array(nFrames)];
  const half = maxSize >> 1;
  for (let t = lag; t < nFrames; t++) {
    const cur = t * nMels, prev = (t - lag) * nMels;
    let total = 0;
    const acc = [0, 0, 0];
    for (let b = 0; b < nMels; b++) {
      let ref = -Infinity;
      for (let k = Math.max(0, b - half); k <= Math.min(nMels - 1, b + half); k++) if (mel[prev + k] > ref) ref = mel[prev + k];
      const d = mel[cur + b] - ref;
      if (d > 0) {
        total += d;
        acc[bandOf[b]] += d;
      }
    }
    envelope[t] = total / nMels;
    for (let g = 0; g < 3; g++) bandFlux[g][t] = bandCount[g] ? acc[g] / bandCount[g] : 0;
  }
  if (onProgress) onProgress(1);
  return { sampleRate, hop, nFft, frameRate: sampleRate / hop, nFrames, envelope, bandFlux, bandPower, skyline, skylineBands: groups };
}

/**
 * librosa.util.peak_pick: x[n] is a peak when it is the maximum of
 * x[n-preMax .. n+postMax), at least mean(x[n-preAvg .. n+postAvg)) + delta,
 * and more than `wait` frames after the previous peak.
 */
export function pickPeaks(x, { preMax, postMax, preAvg, postAvg, delta, wait }) {
  const n = x.length, peaks = [];
  // Prefix sum for the moving average.
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - preMax), hi = Math.min(n, i + postMax);
    let mx = -Infinity;
    for (let k = lo; k < hi; k++) if (x[k] > mx) mx = x[k];
    if (x[i] !== mx) continue;
    const alo = Math.max(0, i - preAvg), ahi = Math.min(n, i + postAvg);
    const avg = (prefix[ahi] - prefix[alo]) / (ahi - alo);
    if (x[i] < avg + delta) continue;
    if (i - last <= wait) continue;
    peaks.push(i);
    last = i;
  }
  return peaks;
}

export const PEAK_DEFAULTS = Object.freeze({ preMax: 0.03, postMax: 0.0, preAvg: 0.1, postAvg: 0.1, wait: 0.03, delta: 0.07 });

/**
 * Onsets from a spectral analysis. Parameters are in seconds and converted
 * with librosa's rounding (floor, +1 frame on the post windows).
 * `offset` (seconds) is added to every reported time; see ONSET_OFFSET.
 *
 * Returns { times: Float64Array, strength: Float32Array (0..1),
 *           band: Uint8Array (BAND.*), frames: Int32Array, envelope (normalised) }.
 */
export function detectOnsets(spec, options = {}) {
  const o = { ...PEAK_DEFAULTS, offset: ONSET_OFFSET, ...options };
  const fr = spec.frameRate;
  const env = normalise(spec.envelope);
  const params = {
    preMax: Math.floor(o.preMax * fr),
    postMax: Math.floor(o.postMax * fr) + 1,
    preAvg: Math.floor(o.preAvg * fr),
    postAvg: Math.floor(o.postAvg * fr) + 1,
    wait: Math.floor(o.wait * fr),
    delta: o.delta,
  };
  const peaks = pickPeaks(env, params);
  // Per-band flux scaled by a high percentile so bands compete fairly.
  const scale = spec.bandFlux.map((f) => {
    const nz = Array.from(f).filter((v) => v > 0).sort((a, b) => a - b);
    return nz.length ? Math.max(1e-9, nz[Math.floor(nz.length * 0.98)]) : 1;
  });
  const times = new Float64Array(peaks.length);
  const strength = new Float32Array(peaks.length);
  const band = new Uint8Array(peaks.length);
  const frames = new Int32Array(peaks);
  for (let i = 0; i < peaks.length; i++) {
    const p = peaks[i];
    // Sub-frame position from a parabola through the peak and its neighbours.
    let offset = 0;
    if (p > 0 && p + 1 < env.length) {
      const a = env[p - 1], b = env[p], c = env[p + 1];
      const den = a - 2 * b + c;
      if (den < 0) offset = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
    }
    times[i] = Math.max(0, (p + offset) / fr + o.offset);
    strength[i] = env[p];
    let best = 0, bestV = -1;
    for (let g = 0; g < 3; g++) {
      const f = spec.bandFlux[g];
      const v = Math.max(f[p], p + 1 < f.length ? f[p + 1] : 0) / scale[g];
      if (v > bestV) { bestV = v; best = g; }
    }
    band[i] = best;
  }
  return { times, strength, band, frames, envelope: env };
}

/**
 * Timing correction for this front end (seconds). A centred 93 ms frame sees
 * an attack before its centre reaches it, so the flux peak lands about 10 ms
 * before the note starts; measured on the demo fixture (test/analysis.test.js
 * checks the median error stays near zero).
 */
export const ONSET_OFFSET = 0.01;

function normalise(x) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < x.length; i++) { if (x[i] < lo) lo = x[i]; if (x[i] > hi) hi = x[i]; }
  const out = new Float32Array(x.length);
  const span = hi - lo > 0 ? hi - lo : 1;
  for (let i = 0; i < x.length; i++) out[i] = (x[i] - lo) / span;
  return out;
}
