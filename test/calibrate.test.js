import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClickListener, DriftWatch, clickTimes, synthClick, CALIBRATION } from '../src/live/calibrate.js';
import { generateDemoSong } from '../src/audio/demo.js';
import { SR, mono } from './live-fixtures.js';

/** A capture: `bed` (or silence) with the click train mixed in `latency` seconds late. */
function capture(seconds, clicks, latency, { gain = 1, bed = null, keep = clicks.length } = {}) {
  const out = new Float32Array(Math.ceil(seconds * SR));
  if (bed) out.set(bed.subarray(0, out.length));
  const click = synthClick(SR);
  for (let c = 0; c < keep; c++) {
    const i0 = Math.round((clicks[c] + latency) * SR);
    for (let i = 0; i < click.length && i0 + i < out.length; i++) out[i0 + i] += click[i] * gain;
  }
  return out;
}

/** Listen to a capture whose first sample plays at context time `start`. */
function listen(signal, start) {
  const l = new ClickListener(SR);
  for (let i = 0; i + 512 <= signal.length; i += 512) l.push(signal.subarray(i, i + 512), start + i / SR);
  return l;
}

test('the click train is eight irregular clicks', () => {
  const t = clickTimes(10);
  assert.equal(t.length, 8);
  assert.equal(t[0], 10);
  const gaps = new Set(CALIBRATION.gaps);
  assert.equal(gaps.size, CALIBRATION.gaps.length, 'no two gaps alike, so no beat can mimic the train');
  assert.ok(synthClick(SR).every((v) => Math.abs(v) <= 1));
});

test('calibration finds the capture latency in silence and under music', () => {
  const start = 50; // context time of the capture's first sample
  const clicks = clickTimes(start + 0.3);
  for (const latency of [0.012, 0.037, 0.09, 0.21]) {
    const r = listen(capture(4, Array.from(clicks, (c) => c - start), latency), start).measure(clicks);
    assert.ok(r, `${latency}: clicks not found`);
    assert.equal(r.found, 8);
    // Plus the front end's own framing delay (a few ms), which every live
    // onset carries too, so it cancels out of the correction.
    assert.ok(r.latency - latency > -0.002 && r.latency - latency < 0.01, `${latency}: measured ${r.latency}`);
  }
  // Mid-song: the demo's drop underneath, clicks 12 dB down.
  const demo = mono(generateDemoSong({ sampleRate: SR }).channels);
  const bed = demo.subarray(Math.round(50 * SR));
  const r = listen(capture(4, Array.from(clicks, (c) => c - start), 0.061, { gain: 0.25, bed }), start).measure(clicks);
  assert.ok(r && r.found >= CALIBRATION.minFound, 'clicks found under music');
  assert.ok(r.latency - 0.061 > -0.004 && r.latency - 0.061 < 0.012, `under music: measured ${r.latency}`);
});

test('calibration gives up when the clicks are not in the capture', () => {
  const start = 5, clicks = clickTimes(start + 0.3);
  const rel = Array.from(clicks, (c) => c - start);
  assert.equal(listen(capture(4, rel, 0.04, { keep: 3 }), start).measure(clicks), null);
  assert.equal(listen(new Float32Array(4 * SR), start).measure(clicks), null);
});

test('the drift watch flags a jump in capture delay on a steady beat, and only then', () => {
  const T = 60 / 128;
  let w = new DriftWatch();
  const jitter = (k) => 0.003 * Math.sin(k * 1.7);
  for (let k = 0; k < 200; k++) assert.equal(w.add(k, 10 + k * T + jitter(k)), 0, `steady beat ${k}`);
  // The delay grows by 30 ms at beat 100.
  w = new DriftWatch();
  let flagged = null;
  for (let k = 0; k < 140 && flagged === null; k++) {
    const d = w.add(k, 10 + k * T + jitter(k) + (k >= 100 ? 0.03 : 0));
    if (d !== 0) flagged = { k, d };
  }
  assert.ok(flagged, 'drift flagged');
  assert.ok(flagged.k >= 103 && flagged.k <= 108, `flagged at beat ${flagged.k}`);
  assert.ok(Math.abs(flagged.d - 0.03) < 0.006, `drift ${flagged.d}`);
  // A tempo change is not a drift.
  w = new DriftWatch();
  let t = 10;
  for (let k = 0; k < 200; k++) {
    t += k < 100 ? T : 60 / 140;
    assert.equal(w.add(k, t), 0, `tempo change, beat ${k}`);
  }
});
