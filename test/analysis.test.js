// Analysis quality gates on the synthesized demo song (see docs/research.md §2.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemoSong } from '../src/audio/demo.js';
import { analyzeAudio } from '../src/audio/analyze.js';
import { matchEvents, median } from '../src/audio/metrics.js';

const demo = generateDemoSong();
const progress = [];
const features = analyzeAudio(demo.channels, demo.sampleRate, { onProgress: (f, stage) => progress.push([f, stage]) });

test('demo onsets: F-measure >= 0.9 at ±50 ms', (t) => {
  const m = matchEvents(demo.truth.onsets, features.onsets.times, 0.05);
  t.diagnostic(`F ${m.f.toFixed(3)}  P ${m.precision.toFixed(3)}  R ${m.recall.toFixed(3)}  median error ${(median(m.errors) * 1000).toFixed(1)} ms`);
  assert.ok(m.f >= 0.9, `F = ${m.f}`);
  // The timing correction keeps detections centred on the true onsets.
  assert.ok(Math.abs(median(m.errors)) < 0.01, `median error ${median(m.errors)}`);
});

test('demo tempo: BPM within ±1 of 128', (t) => {
  t.diagnostic(`bpm ${features.tempo.bpm.toFixed(3)} (tempogram ${features.tempo.tempogramBpm.toFixed(2)})`);
  assert.ok(Math.abs(features.tempo.bpm - 128) <= 1, `bpm ${features.tempo.bpm}`);
  assert.equal(features.tempo.variable, false);
});

test('demo beats: within ±30 ms of the true grid', (t) => {
  const beats = features.tempo.beats;
  const m = matchEvents(demo.truth.beats, beats, 0.03);
  const worst = Math.max(...m.errors.map(Math.abs));
  t.diagnostic(`${beats.length} beats  P ${m.precision.toFixed(3)}  R ${m.recall.toFixed(3)}  worst ${(worst * 1000).toFixed(1)} ms`);
  // Every detected beat is a true beat (no half-beat phase slips)...
  assert.equal(m.precision, 1, `precision ${m.precision}`);
  // ...and the grid covers the song apart from edge beats the tracker trims.
  assert.ok(m.recall >= 0.95, `recall ${m.recall}`);
  // Bars line up: the downbeat phase points at true bar starts.
  const first = Math.round(beats[0] / (60 / 128));
  assert.equal((first + features.tempo.downbeatPhase) % 4, 0, 'downbeat phase');
});

test('demo intensity is calm in the break and high in the drops', () => {
  const I = features.intensity;
  const at = (s) => I.smooth[Math.round(s * I.rate)];
  assert.ok(at(60) > 0.9 && at(120) > 0.9, 'drops near 1');
  assert.ok(at(90) < 0.1, 'break near 0');
  assert.ok(at(10) < at(40) && at(40) < at(60), 'rises through intro and build');
});

test('analysis reports monotonic progress ending at 1', () => {
  assert.ok(progress.length > 10);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i][0] >= progress[i - 1][0] - 1e-9, `progress went back at ${i}`);
  assert.deepEqual(progress[progress.length - 1], [1, 'done']);
});
