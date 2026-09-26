import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hann, hzToMel, melToHz, melFilterbank, resample, percentile, smoothAttackRelease, downmix } from '../src/audio/dsp.js';
import { RealFFT } from '../src/audio/fft.js';

test('periodic Hann window matches the STFT convention', () => {
  const w = hann(8);
  assert.equal(w[0], 0);
  assert.ok(Math.abs(w[4] - 1) < 1e-7);
  assert.ok(Math.abs(w[2] - 0.5) < 1e-7);
});

test('Slaney mel scale round-trips and has its 1 kHz knee', () => {
  assert.ok(Math.abs(hzToMel(1000) - 15) < 1e-12);
  for (const f of [0, 50, 440, 1000, 3200, 11025]) assert.ok(Math.abs(melToHz(hzToMel(f)) - f) < 1e-6);
});

test('mel filterbank sums sensibly', () => {
  const sr = 22050, nFft = 2048;
  const binHz = sr / nFft;
  // Unnormalised triangles tile the spectrum: they sum to 1 between the first and last centre.
  const flat = melFilterbank({ sampleRate: sr, nFft, nMels: 128, norm: null });
  const sum = new Float64Array(nFft / 2 + 1);
  for (let b = 0; b < 128; b++) flat.weights[b].forEach((w, i) => { sum[flat.start[b] + i] += w; });
  const lo = Math.ceil(flat.centers[0] / binHz), hi = Math.floor(flat.centers[127] / binHz);
  for (let k = lo; k <= hi; k++) assert.ok(Math.abs(sum[k] - 1) < 1e-5, `bin ${k} sums to ${sum[k]}`);
  // Every band gets at least one bin, and centres rise monotonically.
  for (let b = 0; b < 128; b++) {
    assert.ok(flat.weights[b].length > 0, `band ${b} empty`);
    if (b) assert.ok(flat.centers[b] > flat.centers[b - 1]);
  }
  // Slaney norm gives each (well-sampled) triangle unit area in Hz.
  const slaney = melFilterbank({ sampleRate: sr, nFft, nMels: 128 });
  for (let b = 10; b < 127; b++) {
    const area = slaney.weights[b].reduce((a, w) => a + w, 0) * binHz;
    assert.ok(Math.abs(area - 1) < 0.1, `band ${b} area ${area}`);
  }
});

test('resampling 44.1 kHz to 22.05 kHz keeps in-band tones and removes aliases', () => {
  const from = 44100, to = 22050, n = 44100;
  const make = (f) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / from));
  const level = (x, f) => {
    const size = 8192, rf = new RealFFT(size), w = hann(size), buf = new Float32Array(size), p = new Float64Array(size / 2 + 1);
    const off = (x.length - size) >> 1;
    for (let i = 0; i < size; i++) buf[i] = x[off + i] * w[i];
    rf.power(buf, p);
    const k = Math.round((f * size) / to);
    return Math.sqrt(Math.max(p[k - 1], p[k], p[k + 1])) / (size / 4);
  };
  // A tone centred on an analysis bin (no scalloping loss): 372 · 22050 / 8192 Hz.
  const f1 = (372 * to) / 8192;
  const pass = resample(make(f1), from, to);
  assert.equal(pass.length, n / 2);
  assert.ok(Math.abs(level(pass, f1) - 1) < 0.01, `1 kHz passes (${level(pass, f1)})`);
  // 16 kHz would alias to 6.05 kHz without the anti-alias filter.
  const stop = resample(make(16000), from, to);
  assert.ok(level(stop, 22050 - 16000) < 1e-3, `alias suppressed (${level(stop, 6050)})`);
  // Non-integer ratios work too.
  const odd = resample(make(440), 48000, 22050);
  assert.equal(odd.length, Math.floor((n * 22050) / 48000));
});

test('percentile, downmix and attack/release smoothing behave', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([0, 10], 25), 2.5);
  assert.deepEqual(Array.from(downmix([Float32Array.of(1, 0), Float32Array.of(0, 1)])), [0.5, 0.5]);
  const step = new Float32Array(100).fill(1, 50);
  const y = smoothAttackRelease(step, 10, 0.1, 1);
  assert.ok(y[49] === 0 && y[51] > 0.8, 'fast attack');
  const down = smoothAttackRelease(Float32Array.from({ length: 100 }, (_, i) => (i < 50 ? 1 : 0)), 10, 0.1, 1);
  assert.ok(down[60] > 0.3, 'slow release');
});
