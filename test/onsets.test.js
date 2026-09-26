import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spectralAnalysis, detectOnsets, pickPeaks, BAND } from '../src/audio/onsets.js';
import { matchEvents } from '../src/audio/metrics.js';
import { mulberry32 } from '../src/audio/random.js';

const SR = 22050;

function render(events, seconds) {
  const x = new Float32Array(SR * seconds);
  const rand = mulberry32(5);
  // A faint noise floor, as in any real recording; digital silence makes dB flux meaningless.
  for (let i = 0; i < x.length; i++) x[i] = 0.002 * (rand() * 2 - 1);
  for (const { t, kind } of events) {
    const i0 = Math.round(t * SR);
    let prev = 0;
    for (let i = 0; i < SR * 0.15 && i0 + i < x.length; i++) {
      const env = Math.exp(-i / (SR * 0.03));
      let s;
      if (kind === 'low') s = Math.sin((2 * Math.PI * 60 * i) / SR);
      else if (kind === 'high') {
        // Differenced noise: a hat-like, high-tilted burst.
        const n = rand() * 2 - 1;
        s = n - prev;
        prev = n;
      } else s = Math.sin((2 * Math.PI * 900 * i) / SR);
      x[i0 + i] += 0.5 * env * s;
    }
  }
  return x;
}

test('peak picking follows librosa semantics', () => {
  const x = Float32Array.from([0, 0.2, 1, 0.2, 0, 0, 0.5, 0.55, 0, 0, 0, 0.05, 0]);
  const peaks = pickPeaks(x, { preMax: 1, postMax: 1, preAvg: 2, postAvg: 3, delta: 0.07, wait: 1 });
  // 2 and 6 are peaks (the window looks back only); 7 falls inside `wait`;
  // 11 is below mean + delta.
  assert.deepEqual(peaks, [2, 6]);
  // `wait` suppresses a peak too close to the previous one.
  const twin = Float32Array.from([0, 1, 0, 1, 0, 0]);
  const opts = { preMax: 1, postMax: 1, preAvg: 1, postAvg: 1, delta: 0.1 };
  assert.deepEqual(pickPeaks(twin, { ...opts, wait: 2 }), [1]);
  assert.deepEqual(pickPeaks(twin, { ...opts, wait: 1 }), [1, 3]);
});

test('detects synthetic onsets within 50 ms and labels their band', () => {
  const kinds = ['low', 'mid', 'high'];
  const events = [];
  for (let k = 0; k < 24; k++) events.push({ t: 0.5 + k * 0.37, kind: kinds[k % 3] });
  const spec = spectralAnalysis(render(events, 10), SR);
  assert.equal(spec.nFrames, 1 + Math.floor((SR * 10) / 512));
  const on = detectOnsets(spec);
  const m = matchEvents(events.map((e) => e.t), on.times, 0.05);
  assert.equal(m.f, 1, `F = ${m.f}`);
  // Band labels are a heuristic; onsets split across two frames can blur them.
  const want = { low: BAND.LOW, mid: BAND.MID, high: BAND.HIGH };
  let right = 0;
  for (const e of events) {
    const i = on.times.findIndex((t) => Math.abs(t - e.t) < 0.05);
    if (on.band[i] === want[e.kind]) right++;
  }
  assert.ok(right >= 0.9 * events.length, `${right}/${events.length} bands right`);
  assert.ok(on.strength.every((s) => s > 0 && s <= 1));
});

test('silence produces no onsets and a flat skyline', () => {
  const spec = spectralAnalysis(new Float32Array(SR * 2), SR);
  assert.equal(detectOnsets(spec).times.length, 0);
  assert.ok(spec.skyline.every((v) => v === spec.skyline[0]));
});
