// BS.1770 loudness and the per-song intensity curve that shapes the track.
//
// K-weighting uses libebur128's rate-independent biquad design (MIT), so
// 44.1 kHz and any other decode rate get correct filters, and 48 kHz
// reproduces the coefficients published in BS.1770.

const SHELF = { f0: 1681.974450955533, gainDb: 3.999843853973347, q: 0.7071752369554196 };
const HIGHPASS = { f0: 38.13547087602444, q: 0.5003270373238773 };

/** K-weighting filter pair for `sampleRate`: { pre: {b, a}, rlb: {b, a} }. */
export function kWeightingCoefficients(sampleRate) {
  let k = Math.tan((Math.PI * SHELF.f0) / sampleRate);
  const vh = Math.pow(10, SHELF.gainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  let a0 = 1 + k / SHELF.q + k * k;
  const pre = {
    b: [(vh + (vb * k) / SHELF.q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / SHELF.q + k * k) / a0],
    a: [1, (2 * (k * k - 1)) / a0, (1 - k / SHELF.q + k * k) / a0],
  };
  k = Math.tan((Math.PI * HIGHPASS.f0) / sampleRate);
  a0 = 1 + k / HIGHPASS.q + k * k;
  const rlb = {
    b: [1, -2, 1],
    a: [1, (2 * (k * k - 1)) / a0, (1 - k / HIGHPASS.q + k * k) / a0],
  };
  return { pre, rlb };
}

/** Run a normalised biquad (a[0] = 1) over `x`, direct form I, into `out`. */
export function biquad(x, { b, a }, out = new Float32Array(x.length)) {
  const b0 = b[0], b1 = b[1], b2 = b[2], a1 = a[1], a2 = a[2];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

export const LUFS_FLOOR = -70;

function toLufs(meanSquare) {
  return meanSquare > 0 ? Math.max(LUFS_FLOOR, -0.691 + 10 * Math.log10(meanSquare)) : LUFS_FLOOR;
}

/**
 * Momentary (400 ms) and short-term (3 s) loudness in LUFS at a 100 ms hop.
 * Channel energies are summed (weight 1 for L/R), not downmixed. Frame k is
 * centred on k · hop seconds; audio outside the song counts as silence.
 */
export function loudnessCurves(channels, sampleRate, { hop = 0.1, momentary = 0.4, shortTerm = 3 } = {}) {
  const n = channels[0].length;
  const hopSamples = Math.round(hop * sampleRate);
  const blocks = Math.ceil(n / hopSamples);
  const energy = new Float64Array(blocks);
  const { pre, rlb } = kWeightingCoefficients(sampleRate);
  const tmp = new Float32Array(n);
  for (const ch of channels) {
    biquad(ch, pre, tmp);
    biquad(tmp, rlb, tmp);
    for (let blk = 0; blk < blocks; blk++) {
      const end = Math.min(n, (blk + 1) * hopSamples);
      let s = 0;
      for (let i = blk * hopSamples; i < end; i++) s += tmp[i] * tmp[i];
      energy[blk] += s;
    }
  }
  // Prefix sums make every window an O(1) lookup.
  const prefix = new Float64Array(blocks + 1);
  for (let i = 0; i < blocks; i++) prefix[i + 1] = prefix[i] + energy[i];
  const windowed = (frame, len) => {
    const nb = Math.round(len / hop);
    const lo = frame - Math.floor(nb / 2), hi = lo + nb;
    const s = prefix[Math.min(blocks, Math.max(0, hi))] - prefix[Math.min(blocks, Math.max(0, lo))];
    return s / (nb * hopSamples);
  };
  const frames = blocks + 1;
  const M = new Float32Array(frames), ST = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    M[f] = toLufs(windowed(f, momentary));
    ST[f] = toLufs(windowed(f, shortTerm));
  }
  return { rate: 1 / hop, momentary: M, shortTerm: ST };
}

/**
 * Normalised intensity 0..1 from loudness curves: I_raw = 0.7·ST + 0.3·M
 * (LUFS), mapped from the 5th to the 95th percentile of non-silent frames,
 * clamped, then smoothed with a fast attack and slow release.
 * Returns { rate, lufs, raw, smooth, lo, hi }.
 */
export function intensityCurve({ rate, momentary, shortTerm }, { attack = 0.35, release = 1.2, loPct = 5, hiPct = 95 } = {}) {
  const n = momentary.length;
  const lufs = new Float32Array(n);
  const active = [];
  for (let i = 0; i < n; i++) {
    lufs[i] = Math.max(LUFS_FLOOR, 0.7 * shortTerm[i] + 0.3 * momentary[i]);
    if (lufs[i] > LUFS_FLOOR) active.push(lufs[i]);
  }
  active.sort((x, y) => x - y);
  const pick = (p) => {
    if (!active.length) return LUFS_FLOOR;
    const pos = (p / 100) * (active.length - 1), i = Math.floor(pos), f = pos - i;
    return i + 1 < active.length ? active[i] + (active[i + 1] - active[i]) * f : active[i];
  };
  const lo = pick(loPct), hi = pick(hiPct);
  const span = Math.max(1e-6, hi - lo);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = lufs[i] <= LUFS_FLOOR ? 0 : Math.min(1, Math.max(0, (lufs[i] - lo) / span));
  const smooth = new Float32Array(n);
  const ka = 1 - Math.exp(-1 / (rate * attack)), kr = 1 - Math.exp(-1 / (rate * release));
  let y = raw[0] || 0;
  for (let i = 0; i < n; i++) {
    y += (raw[i] > y ? ka : kr) * (raw[i] - y);
    smooth[i] = y;
  }
  return { rate, lufs, raw, smooth, lo, hi };
}

/** Integrated-style mean loudness over the whole signal (ungated), for tests and diagnostics. */
export function meanLoudness(channels, sampleRate) {
  const { pre, rlb } = kWeightingCoefficients(sampleRate);
  let sum = 0;
  for (const ch of channels) {
    const y = biquad(biquad(ch, pre), rlb);
    let s = 0;
    for (let i = 0; i < y.length; i++) s += y[i] * y[i];
    sum += s / y.length;
  }
  return toLufs(sum);
}
