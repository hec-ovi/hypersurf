import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantize, scaleFreq, hitDegree, synthPluck, synthChord, synthThud } from '../src/audio/sfx.js';
import { makeGrid } from '../src/audio/songmap.js';

const beats = Float64Array.from({ length: 64 }, (_, i) => i * 0.5); // 120 BPM
const grid = makeGrid(beats, 120, 32);

test('hits quantise to the next sixteenth of the beat grid', () => {
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(close(quantize(grid, 10.03), 10.125), 'to the next 1/16 (125 ms at 120 BPM)');
  assert.ok(close(quantize(grid, 10.14), 10.25));
  assert.ok(close(quantize(grid, 10.005), 10.005), 'just after a grid point plays at once');
  assert.ok(close(quantize(grid, 10.005, 10.02), 10.125), 'never before the schedulable time');
  assert.ok(close(quantize(grid, 10.2, 10.6), 10.625), 'skips grid points already past');
  // Every result is on the grid unless snapped.
  for (let t = 1; t < 20; t += 0.0371) {
    const q = quantize(grid, t, t);
    const onGrid = Math.abs(q * 8 - Math.round(q * 8)) < 1e-6;
    assert.ok(q >= t && (onGrid || q === t) && q - t <= 0.125 + 1e-9, `${t} → ${q}`);
  }
});

test('hit pitch climbs with column and height, on a pentatonic scale', () => {
  assert.equal(scaleFreq(0), 220);
  assert.ok(Math.abs(scaleFreq(5) - 440) < 1e-9, 'five degrees is an octave');
  assert.ok(hitDegree(2, 1) > hitDegree(0, 1));
  assert.ok(hitDegree(0, 3) > hitDegree(0, 1));
  let last = 0;
  for (let d = 0; d < 12; d++) { assert.ok(scaleFreq(d) > last); last = scaleFreq(d); }
});

test('synthesised effects are bounded, finite and decay to silence', () => {
  const sr = 44100;
  for (const [name, buf] of [['pluck', synthPluck(440, sr)], ['chord', synthChord([220, 261.6, 329.6], sr)], ['thud', synthThud(sr)]]) {
    let peak = 0, tail = 0;
    for (let i = 0; i < buf.length; i++) {
      assert.ok(Number.isFinite(buf[i]), name);
      peak = Math.max(peak, Math.abs(buf[i]));
      if (i > buf.length * 0.9) tail = Math.max(tail, Math.abs(buf[i]));
    }
    assert.ok(peak > 0.5 && peak <= 0.9, `${name} peak ${peak}`);
    assert.ok(tail < 0.08, `${name} tail ${tail}`);
  }
  // The pluck's fundamental: count zero crossings over its first 50 ms.
  const p = synthPluck(440, sr);
  let crossings = 0;
  for (let i = 1; i < sr * 0.05; i++) if ((p[i - 1] < 0) !== (p[i] < 0)) crossings++;
  assert.ok(Math.abs(crossings / 2 / 0.05 - 440) < 60, `${crossings / 2 / 0.05} Hz`);
  // Deterministic.
  assert.deepEqual(synthThud(sr), synthThud(sr));
});
