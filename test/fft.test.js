import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FFT, RealFFT } from '../src/audio/fft.js';
import { mulberry32 } from '../src/audio/random.js';

function dft(re, im) {
  const n = re.length, outRe = new Float64Array(n), outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      sr += re[t] * Math.cos(a) - im[t] * Math.sin(a);
      si += re[t] * Math.sin(a) + im[t] * Math.cos(a);
    }
    outRe[k] = sr; outIm[k] = si;
  }
  return [outRe, outIm];
}

test('complex FFT matches a naive DFT', () => {
  const rand = mulberry32(7);
  for (const n of [2, 4, 8, 64, 256]) {
    const re = Float64Array.from({ length: n }, () => rand() * 2 - 1);
    const im = Float64Array.from({ length: n }, () => rand() * 2 - 1);
    const [er, ei] = dft(re, im);
    const fft = new FFT(n);
    fft.forward(re, im);
    for (let k = 0; k < n; k++) {
      assert.ok(Math.abs(re[k] - er[k]) < 1e-9 * n, `n=${n} re[${k}]`);
      assert.ok(Math.abs(im[k] - ei[k]) < 1e-9 * n, `n=${n} im[${k}]`);
    }
  }
});

test('real FFT matches a naive DFT on bins 0..N/2', () => {
  const rand = mulberry32(11);
  for (const n of [4, 16, 512, 2048]) {
    const x = Float64Array.from({ length: n }, () => rand() * 2 - 1);
    const [er, ei] = dft(x, new Float64Array(n));
    const rf = new RealFFT(n);
    const re = new Float64Array(n / 2 + 1), im = new Float64Array(n / 2 + 1);
    rf.forward(x, re, im);
    for (let k = 0; k <= n / 2; k++) {
      assert.ok(Math.abs(re[k] - er[k]) < 1e-9 * n, `n=${n} re[${k}] ${re[k]} vs ${er[k]}`);
      assert.ok(Math.abs(im[k] - ei[k]) < 1e-9 * n, `n=${n} im[${k}]`);
    }
    const pw = new Float64Array(n / 2 + 1);
    rf.power(x, pw);
    for (let k = 0; k <= n / 2; k++) assert.ok(Math.abs(pw[k] - (er[k] ** 2 + ei[k] ** 2)) < 1e-6 * n * n);
  }
});

test('FFT rejects sizes that are not powers of two', () => {
  assert.throws(() => new FFT(12), RangeError);
  assert.throws(() => new RealFFT(2), RangeError);
});
