// Synthetic live streams for the tracker and live-map tests: click tracks
// and drum loops (the demo song's own instruments) at any tempo, mono.

import { renderDemo } from '../src/audio/demo.js';
import { mulberry32 } from '../src/audio/random.js';

export const SR = 44100;

/** Beat times at `bpm` from `from` (inclusive) to `to` (exclusive). */
export function beatGrid(bpm, from, to) {
  const out = [];
  for (let t = from; t < to - 1e-9; t += 60 / bpm) out.push(t);
  return out;
}

/** A 4 ms noise click at each time. */
export function clickTrack(times, seconds, gain = 0.8, seed = 7) {
  const m = new Float32Array(Math.ceil(seconds * SR));
  const rand = mulberry32(seed);
  for (const t of times) {
    const i0 = Math.round(t * SR);
    for (let i = 0; i < 0.004 * SR && i0 + i < m.length; i++) m[i0 + i] += (rand() * 2 - 1) * Math.exp(-i / (0.001 * SR)) * gain;
  }
  return m;
}

/**
 * A drum loop: a kick on every beat (`accent(i)` scales it), a snare on
 * every other beat and a hat between beats.
 */
export function drumLoop(beats, seconds, { hats = true, snare = true, accent = null } = {}) {
  const events = [];
  beats.forEach((t, i) => {
    events.push({ instr: 'kick', t, vel: accent ? accent(i) : 1 });
    if (snare && i % 2 === 1) events.push({ instr: 'snare', t, vel: 0.7 });
    if (hats && i + 1 < beats.length) events.push({ instr: 'hat', t: (t + beats[i + 1]) / 2, vel: 0.6 });
  });
  events.sort((a, b) => a.t - b.t);
  return mono(renderDemo({ seed: 3, duration: seconds, events }, SR));
}

/** A beatless pad: long chords with slow attacks. */
export function padOnly(seconds) {
  const events = [];
  for (let t = 0; t < seconds; t += 1.875) events.push({ instr: 'pad', t, vel: 1, dur: 1.875 });
  return mono(renderDemo({ seed: 2, duration: seconds, events }, SR));
}

export function whiteNoise(seconds, gain = 0.2, seed = 3) {
  const m = new Float32Array(Math.ceil(seconds * SR));
  const rand = mulberry32(seed);
  for (let i = 0; i < m.length; i++) m[i] = (rand() * 2 - 1) * gain;
  return m;
}

export function mono([L, R]) {
  const m = new Float32Array(L.length);
  for (let i = 0; i < m.length; i++) m[i] = 0.5 * (L[i] + R[i]);
  return m;
}

/**
 * Feed `signal` to `tracker` in hops of `hop` samples, calling
 * `each(tracker, time)` after every hop (time = end of the fed audio).
 */
export function feed(tracker, signal, each, hop = 512) {
  for (let i = 0; i + hop <= signal.length; i += hop) {
    tracker.push(signal.subarray(i, i + hop));
    if (each) each(tracker, (i + hop) / SR);
  }
}

/** Signed distance from t to the nearest time in a sorted list. */
export function nearest(list, t) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m] < t) lo = m + 1; else hi = m; }
  let best = Infinity;
  for (const k of [lo - 1, lo]) if (k >= 0 && k < list.length && Math.abs(t - list[k]) < Math.abs(best)) best = t - list[k];
  return best;
}

/** The grid's beat nearest to time t. */
export function gridBeatNear(grid, t) {
  return grid.anchor + Math.round((t - grid.anchor) / grid.period) * grid.period;
}
export const DRAW_DISTANCE_M = 650;
