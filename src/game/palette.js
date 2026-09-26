// Colour: the intensity gradient (sampled in OKLab so hues blend evenly)
// and the fixed scene colours from docs/research.md §4. Pure; no DOM/GPU.

export const PALETTE = Object.freeze({
  background: '#05060A',
  fog: '#0B0E1F',
  horizon: '#1A1450',
  trackSurface: '#0A0C14',
  hazardBody: '#15171D',
  hazardRim: '#E8ECF5',
  overfill: '#FF5A2A',
});

/** Calm → intense. */
export const INTENSITY_STOPS = Object.freeze([
  [0.0, '#3A2CFF'],
  [0.25, '#0FA3FF'],
  [0.5, '#19E0A0'],
  [0.7, '#FFD23A'],
  [0.85, '#FF7A1A'],
  [1.0, '#FF1F4B'],
]);

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** '#RRGGBB' → linear RGB [0..1]³. */
export function hexToLinear(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [srgbToLinear(((v >> 16) & 255) / 255), srgbToLinear(((v >> 8) & 255) / 255), srgbToLinear((v & 255) / 255)];
}

export function linearToHex([r, g, b]) {
  const to = (c) => Math.round(Math.min(1, Math.max(0, linearToSrgb(c))) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

/** Linear sRGB → OKLab (Björn Ottosson). */
export function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** A size×3 linear-RGB lookup table of the gradient, interpolated in OKLab. */
export function gradientLut(stops = INTENSITY_STOPS, size = 256) {
  const labs = stops.map(([t, hex]) => [t, linearToOklab(hexToLinear(hex))]);
  const lut = new Float32Array(size * 3);
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    let k = 0;
    while (k < labs.length - 2 && t > labs[k + 1][0]) k++;
    const [t0, a] = labs[k], [t1, b] = labs[k + 1];
    const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
    const rgb = oklabToLinear([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
    // OKLab blends between saturated stops can leave the sRGB gamut slightly; clip.
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.min(1, Math.max(0, rgb[c]));
  }
  return lut;
}

const DEFAULT_LUT = gradientLut();

/** Gradient colour at t ∈ [0, 1] into `out` (linear RGB). */
export function gradientAt(t, out = [0, 0, 0], lut = DEFAULT_LUT) {
  const size = lut.length / 3;
  const x = Math.min(1, Math.max(0, t)) * (size - 1);
  const i = Math.min(size - 2, x | 0), f = x - i;
  for (let c = 0; c < 3; c++) out[c] = lut[i * 3 + c] + (lut[i * 3 + 3 + c] - lut[i * 3 + c]) * f;
  return out;
}

/** The rainbow a special level paints its track with, red round to red again. */
export const RAINBOW_STOPS = Object.freeze([
  [0, '#FF1F4B'],
  [1 / 6, '#FF8A1A'],
  [2 / 6, '#FFD23A'],
  [3 / 6, '#19E0A0'],
  [4 / 6, '#0FA3FF'],
  [5 / 6, '#8A3CFF'],
  [1, '#FF1F4B'],
]);

const RAINBOW_LUT = gradientLut(RAINBOW_STOPS);

/** Rainbow colour at u, wrapping every 1 (linear RGB into `out`). */
export function rainbowAt(u, out = [0, 0, 0]) {
  return gradientAt(u - Math.floor(u), out, RAINBOW_LUT);
}

/** OKLab chroma; album-art palettes below 0.05 read as grey and are rejected. */
export function chroma(hex) {
  const [, a, b] = linearToOklab(hexToLinear(hex));
  return Math.hypot(a, b);
}
