import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTENSITY_STOPS, hexToLinear, linearToHex, linearToOklab, oklabToLinear, gradientAt, chroma } from '../src/game/palette.js';

test('OKLab round-trips and puts white at L = 1', () => {
  const [L, a, b] = linearToOklab([1, 1, 1]);
  assert.ok(Math.abs(L - 1) < 1e-4 && Math.abs(a) < 1e-4 && Math.abs(b) < 1e-4);
  for (const [, hex] of INTENSITY_STOPS) assert.equal(linearToHex(oklabToLinear(linearToOklab(hexToLinear(hex)))), hex);
});

test('gradient hits every stop and stays in gamut', () => {
  // The 256-entry LUT lands between entries at most stops; allow its step.
  for (const [t, hex] of INTENSITY_STOPS) {
    const want = hexToLinear(hex), got = gradientAt(t);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(got[c] - want[c]) < 0.01, `${hex} channel ${c}: ${got[c]} vs ${want[c]}`);
  }
  for (let t = 0; t <= 1; t += 0.01) for (const c of gradientAt(t)) assert.ok(c >= 0 && c <= 1.001);
  // Clamped outside 0..1.
  assert.deepEqual(gradientAt(-1), gradientAt(0));
});

test('chroma flags greyscale palettes', () => {
  assert.ok(chroma('#808080') < 0.05);
  assert.ok(chroma('#FF1F4B') > 0.05);
});
