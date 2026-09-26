import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTempo, trackBeats, beatsBpm, downbeatPhase, localPeriods } from '../src/audio/tempo.js';

const FR = 22050 / 512;

/** An onset envelope with pulses at the given times (a stand-in for flux). */
function pulses(times, seconds, accent = () => 1) {
  const env = new Float32Array(Math.ceil(seconds * FR));
  times.forEach((t, i) => {
    const f = t * FR, k = Math.floor(f), w = f - k;
    if (k + 1 < env.length) { env[k] += (1 - w) * accent(i); env[k + 1] += w * accent(i); }
  });
  return env;
}

const grid = (bpm, from, to) => {
  const out = [];
  for (let t = from; t < to; t += 60 / bpm) out.push(t);
  return out;
};

test('tempo estimate prefers the metrical level near 120 BPM', () => {
  for (const bpm of [96, 128, 140]) {
    const env = pulses(grid(bpm, 0.3, 60), 60);
    const est = estimateTempo(env, FR);
    assert.ok(Math.abs(est.bpm - bpm) / bpm < 0.02, `${bpm}: got ${est.bpm}`);
  }
  // Pulses at 64 BPM with eighth-note fills read as 128, not 64.
  const env = pulses(grid(128, 0.3, 60), 60, (i) => (i % 2 ? 0.6 : 1));
  assert.ok(Math.abs(estimateTempo(env, FR).bpm - 128) < 2.5);
});

test('DP beat tracker lands on the beats and gives BPM within ±1', () => {
  const truth = grid(128, 1, 59);
  // Off-beat noise at a third the strength must not pull the phase.
  const env = pulses([...truth, ...truth.map((t) => t + 60 / 256)].sort((a, b) => a - b), 60, (i) => (i % 2 ? 0.33 : 1));
  const est = estimateTempo(env, FR);
  const frames = trackBeats(env, est.period);
  const beats = Array.from(frames, (f) => f / FR);
  assert.ok(beats.length > truth.length * 0.9);
  for (const b of beats) {
    const err = Math.min(...truth.map((t) => Math.abs(t - b)));
    assert.ok(err < 0.02, `beat ${b.toFixed(3)} is ${err * 1000} ms off`);
  }
  assert.ok(Math.abs(beatsBpm(beats) - 128) < 1, `bpm ${beatsBpm(beats)}`);
});

test('beat tracker bridges a gap without drifting', () => {
  const truth = [...grid(120, 1, 20), ...grid(120, 1, 40).filter((t) => t >= 30)];
  const env = pulses(truth, 40);
  const frames = trackBeats(env, (60 * FR) / 120);
  const inGap = Array.from(frames, (f) => f / FR).filter((t) => t > 21 && t < 29);
  assert.ok(inGap.length >= 14, 'keeps beating through the gap');
  for (const b of inGap) {
    const err = Math.abs((b - 1) / 0.5 - Math.round((b - 1) / 0.5)) * 0.5;
    assert.ok(err < 0.02, `gap beat ${b.toFixed(3)} is ${Math.round(err * 1000)} ms off the grid`);
  }
});

test('local tempo follows a tempo change without octave jumps', () => {
  const times = [...grid(120, 0.5, 30)];
  const last = times[times.length - 1];
  for (let t = last + 60 / 132; t < 60; t += 60 / 132) times.push(t);
  const env = pulses(times, 60);
  const est = estimateTempo(env, FR);
  const periods = localPeriods(est.tempogram, est.bpm, FR, env.length);
  const bpmAt = (s) => (60 * FR) / periods[Math.round(s * FR)];
  assert.ok(Math.abs(bpmAt(12) - 120) < 2, `early ${bpmAt(12)}`);
  assert.ok(Math.abs(bpmAt(48) - 132) < 2, `late ${bpmAt(48)}`);
});

test('downbeat phase finds where the spectrum changes', () => {
  const beatsFr = Array.from({ length: 40 }, (_, i) => i * 20);
  const dims = 4, feat = new Float32Array(800 * dims);
  // A new "chord" every 4 beats starting at beat 2.
  for (let f = 0; f < 800; f++) {
    const bar = Math.floor((f / 20 - 2) / 4);
    feat[f * dims + (((bar % dims) + dims) % dims)] = 1;
  }
  assert.equal(downbeatPhase(beatsFr, feat, dims), 2);
});
