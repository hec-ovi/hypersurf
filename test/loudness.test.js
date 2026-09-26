import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kWeightingCoefficients, loudnessCurves, intensityCurve, meanLoudness } from '../src/audio/loudness.js';

// ITU-R BS.1770-4, tables 1 and 2 (48 kHz).
const PUBLISHED_48K = {
  pre: { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1, -1.69065929318241, 0.73248077421585] },
  rlb: { b: [1, -2, 1], a: [1, -1.99004745483398, 0.99007225036621] },
};

test('K-weighting coefficients match the published 48 kHz values', () => {
  const c = kWeightingCoefficients(48000);
  for (const stage of ['pre', 'rlb']) {
    for (const k of ['b', 'a']) {
      PUBLISHED_48K[stage][k].forEach((v, i) => {
        assert.ok(Math.abs(c[stage][k][i] - v) < 1e-7, `${stage}.${k}[${i}] = ${c[stage][k][i]}, published ${v}`);
      });
    }
  }
});

function gainAt(c, f, fs) {
  // |H(e^jw)| of a biquad.
  const w = (2 * Math.PI * f) / fs;
  const ev = (p) => {
    const re = p[0] + p[1] * Math.cos(w) + p[2] * Math.cos(2 * w);
    const im = -(p[1] * Math.sin(w) + p[2] * Math.sin(2 * w));
    return Math.hypot(re, im);
  };
  return ev(c.b) / ev(c.a);
}

test('K-weighting is rate independent (44.1 kHz response equals 48 kHz)', () => {
  const c48 = kWeightingCoefficients(48000), c44 = kWeightingCoefficients(44100);
  for (const f of [20, 40, 100, 1000, 2000, 5000, 10000]) {
    const g48 = gainAt(c48.pre, f, 48000) * gainAt(c48.rlb, f, 48000);
    const g44 = gainAt(c44.pre, f, 44100) * gainAt(c44.rlb, f, 44100);
    assert.ok(Math.abs(20 * Math.log10(g44 / g48)) < 0.05, `${f} Hz differs`);
  }
  // Shelf adds about +4 dB at high frequencies.
  const hi = 20 * Math.log10(gainAt(c44.pre, 10000, 44100));
  assert.ok(hi > 3.5 && hi < 4.2, `shelf gain ${hi}`);
});

test('a 997 Hz sine at -20 dBFS per channel reads about -20 LUFS stereo sum', () => {
  // BS.1770 calibration: 0 dBFS 1 kHz sine in one channel reads -3.01 LUFS.
  const fs = 48000, n = fs * 2, amp = Math.pow(10, -20 / 20);
  const x = Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 997 * i) / fs));
  const mono = meanLoudness([x], fs);
  assert.ok(Math.abs(mono - -23.01) < 0.1, `mono ${mono}`);
  const stereo = meanLoudness([x, x], fs);
  assert.ok(Math.abs(stereo - -20.0) < 0.1, `stereo ${stereo}`);
});

test('momentary/short-term curves and intensity follow a quiet-loud-quiet signal', () => {
  const fs = 44100, secs = 30, n = fs * secs;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const amp = t >= 10 && t < 20 ? 0.5 : 0.05;
    x[i] = amp * Math.sin(2 * Math.PI * 440 * t);
  }
  const curves = loudnessCurves([x, x], fs);
  assert.equal(curves.rate, 10);
  const M = curves.momentary, ST = curves.shortTerm;
  assert.ok(M[150] - M[50] > 18 && M[150] - M[50] < 22, 'momentary sees the 20 dB step');
  // Momentary reacts within ~0.2 s; short-term takes longer.
  assert.ok(M[103] > M[150] - 1, 'momentary settled 0.3 s after the step');
  assert.ok(ST[103] < M[103] - 1.5, 'short-term (centred 3 s window) still blends the quiet part');
  const I = intensityCurve(curves);
  assert.ok(I.raw[150] > 0.95 && I.raw[50] < 0.05, 'raw intensity normalised to 0..1');
  // Attack is faster than release.
  const rise = I.smooth[110], fall = I.smooth[210];
  assert.ok(rise > 0.8, `attack ${rise}`);
  assert.ok(fall > 0.3, `release ${fall}`);
  // Silence stays at the -70 LUFS floor and zero intensity.
  const silent = loudnessCurves([new Float32Array(fs * 2)], fs);
  assert.ok(silent.momentary.every((v) => v === -70));
});
