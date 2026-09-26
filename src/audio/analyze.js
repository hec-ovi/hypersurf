// Whole-song analysis: decoded channels in, musical features out. Pure and
// synchronous so it runs the same in the worker and in Node tests.

import { downmix, resample } from './dsp.js';
import { spectralAnalysis, detectOnsets, ONSET_OFFSET } from './onsets.js';
import { estimateTempo, localPeriods, trackBeats, beatsBpm, downbeatPhase } from './tempo.js';
import { loudnessCurves, intensityCurve } from './loudness.js';

export const ANALYZER_VERSION = 1;
export const ANALYSIS_RATE = 22050;

// Share of the progress bar each stage takes (sums to 1).
const STAGES = { resample: 0.3, spectrum: 0.45, onsets: 0.05, tempo: 0.1, loudness: 0.1 };

/**
 * Analyse a decoded song.
 * @param {Float32Array[]} channels  one array per channel at `sampleRate`
 * @param {number} sampleRate
 * @param {{ onProgress?: (fraction: number, stage: string) => void }} [options]
 * @returns the feature set consumed by buildSongMap (all typed arrays, transferable)
 */
export function analyzeAudio(channels, sampleRate, { onProgress } = {}) {
  const timings = {};
  let done = 0;
  const progress = (stage, f) => onProgress && onProgress(Math.min(1, done + STAGES[stage] * f), stage);
  const stage = (name, fn) => {
    const t0 = now();
    progress(name, 0);
    const r = fn((f) => progress(name, f));
    timings[name] = now() - t0;
    done += STAGES[name];
    progress(name, 0);
    return r;
  };

  const duration = channels[0].length / sampleRate;
  const mono = stage('resample', () => resample(downmix(channels), sampleRate, ANALYSIS_RATE));
  const spec = stage('spectrum', (p) => spectralAnalysis(mono, ANALYSIS_RATE, {}, p));
  const onsets = stage('onsets', () => detectOnsets(spec));
  const tempo = stage('tempo', () => {
    const fr = spec.frameRate;
    // Beats follow the accents below 3.2 kHz (kick, snare body, bass, chords).
    // Hi-hats sit on off-beats in many styles and pull a full-band tracker
    // half a beat out of phase through breakdowns.
    const [low, mid] = spec.bandFlux;
    const beatEnv = new Float32Array(spec.nFrames);
    for (let i = 0; i < beatEnv.length; i++) beatEnv[i] = low[i] + mid[i];
    const est = estimateTempo(beatEnv, fr);
    let periods = est.period;
    // Follow a drifting or changing tempo only when it clearly departs from the global one.
    const local = localPeriods(est.tempogram, est.bpm, fr, spec.nFrames);
    let maxDev = 0;
    for (let i = 0; i < local.length; i++) maxDev = Math.max(maxDev, Math.abs(local[i] / est.period - 1));
    if (maxDev > 0.03) periods = local;
    let frames = trackBeats(beatEnv, periods);
    let bpm = beatsBpm(Array.from(frames, (f) => f / fr));
    // Second pass with the refined period keeps long quiet stretches on the grid.
    if (typeof periods === 'number' && Number.isFinite(bpm) && Math.abs(bpm / est.bpm - 1) < 0.05) {
      frames = trackBeats(beatEnv, (60 * fr) / bpm);
      bpm = beatsBpm(Array.from(frames, (f) => f / fr));
    }
    const beats = new Float64Array(frames.length);
    for (let i = 0; i < frames.length; i++) beats[i] = frames[i] / fr + ONSET_OFFSET;
    const phase = downbeatPhase(frames, spec.skyline, spec.skylineBands);
    return { bpm: Number.isFinite(bpm) ? bpm : est.bpm, tempogramBpm: est.bpm, beats, downbeatPhase: phase, variable: typeof periods !== 'number' };
  });
  const loud = stage('loudness', () => intensityCurve(loudnessCurves(channels, sampleRate)));
  onProgress && onProgress(1, 'done');

  return {
    version: ANALYZER_VERSION,
    duration,
    sampleRate,
    frameRate: spec.frameRate,
    onsets: { times: onsets.times, strength: onsets.strength, band: onsets.band },
    envelope: onsets.envelope,
    bandFlux: spec.bandFlux,
    bandPower: spec.bandPower,
    skyline: spec.skyline,
    skylineBands: spec.skylineBands,
    tempo,
    intensity: loud,
    timings,
  };
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Typed arrays inside a feature set, for postMessage transfer lists. */
export function transferables(obj, out = []) {
  if (ArrayBuffer.isView(obj)) {
    if (!out.includes(obj.buffer)) out.push(obj.buffer);
  } else if (Array.isArray(obj)) {
    for (const v of obj) transferables(v, out);
  } else if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) transferables(obj[k], out);
  }
  return out;
}
