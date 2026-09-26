// Radix-2 FFT. Tables are built once per size; transforms run in place and
// allocate nothing, so one instance can serve every frame of an analysis.

export function isPowerOfTwo(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/** Complex FFT of a power-of-two size (forward, e^{-i2πkn/N}, unscaled). */
export class FFT {
  constructor(size) {
    if (!isPowerOfTwo(size) || size < 2) throw new RangeError(`FFT size must be a power of two >= 2, got ${size}`);
    this.size = size;
    const bits = Math.round(Math.log2(size));
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1);
      this.rev[i] = r;
    }
    const half = size >> 1;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const a = (2 * Math.PI * k) / size;
      this.cos[k] = Math.cos(a);
      this.sin[k] = -Math.sin(a);
    }
  }

  /** In-place forward transform of (re, im). */
  forward(re, im) {
    const n = this.size, rev = this.rev, cos = this.cos, sin = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const wr = cos[k], wi = sin[k];
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

/**
 * FFT of a real signal of power-of-two size N via one complex FFT of size N/2.
 * Outputs bins 0..N/2 (N/2 + 1 values).
 */
export class RealFFT {
  constructor(size) {
    if (!isPowerOfTwo(size) || size < 4) throw new RangeError(`RealFFT size must be a power of two >= 4, got ${size}`);
    this.size = size;
    this.bins = (size >> 1) + 1;
    const m = size >> 1;
    this.fft = new FFT(m);
    this.re = new Float64Array(m);
    this.im = new Float64Array(m);
    this.wr = new Float64Array(m + 1);
    this.wi = new Float64Array(m + 1);
    for (let k = 0; k <= m; k++) {
      const a = (2 * Math.PI * k) / size;
      this.wr[k] = Math.cos(a);
      this.wi[k] = -Math.sin(a);
    }
  }

  /** Spectrum of `input` (length N) into outRe/outIm (length N/2 + 1). */
  forward(input, outRe, outIm) {
    const m = this.size >> 1, re = this.re, im = this.im;
    for (let k = 0; k < m; k++) {
      re[k] = input[2 * k];
      im[k] = input[2 * k + 1];
    }
    this.fft.forward(re, im);
    for (let k = 0; k <= m; k++) {
      const a = k === m ? 0 : k;
      const b = k === 0 ? 0 : m - k;
      const zr = re[a], zi = im[a];
      const cr = re[b], ci = -im[b]; // conj(Z[m-k])
      const er = 0.5 * (zr + cr), ei = 0.5 * (zi + ci);
      // (Z - conj)/2 divided by i
      const or = 0.5 * (zi - ci), oi = -0.5 * (zr - cr);
      const wr = this.wr[k], wi = this.wi[k];
      outRe[k] = er + or * wr - oi * wi;
      outIm[k] = ei + or * wi + oi * wr;
    }
  }

  /** Power spectrum |X[k]|² of `input` into `out` (length N/2 + 1). */
  power(input, out, scratchRe, scratchIm) {
    const bins = this.bins;
    const r = scratchRe || (this._pr ||= new Float64Array(bins));
    const i = scratchIm || (this._pi ||= new Float64Array(bins));
    this.forward(input, r, i);
    for (let k = 0; k < bins; k++) out[k] = r[k] * r[k] + i[k] * i[k];
  }
}
