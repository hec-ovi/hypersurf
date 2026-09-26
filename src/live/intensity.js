// Live intensity (docs/research.md §2.2): the offline recipe run causally.
// BS.1770 K-weighting on the captured audio, momentary (400 ms) and
// short-term (3 s) loudness every 100 ms, I_raw = 0.7·ST + 0.3·M,
// normalised between the 5th and 95th percentile of the session so far,
// blended with a -32…-12 LUFS prior that keeps half its weight after a
// minute of sound (a live map cannot know the drop is still to come, so a
// quiet intro must not read as intense just because it is all it heard), and
// smoothed with a 0.5 s attack and a 2 s release. The live track writes it
// into nodes two seconds ahead, so slope and colour trail the music by
// about that much. Pure; allocates nothing per push.

import { kWeightingCoefficients, LUFS_FLOOR } from '../audio/loudness.js';

const BIN = 0.5; // dB per histogram bin
const BINS = Math.round(-LUFS_FLOOR / BIN);
const PRIOR = { lo: -32, hi: -12, frames: 600 }; // frames: 100 ms blocks of sound for half weight
const MIN_SPAN = 10; // dB

export class LiveIntensity {
  constructor(sampleRate, { hop = 0.1, momentary = 0.4, shortTerm = 3, attack = 0.5, release = 2 } = {}) {
    this.sampleRate = sampleRate;
    this.hop = hop;
    this.blockSamples = Math.round(hop * sampleRate);
    const { pre, rlb } = kWeightingCoefficients(sampleRate);
    this.pre = pre;
    this.rlb = rlb;
    this.mBlocks = Math.round(momentary / hop);
    this.sBlocks = Math.round(shortTerm / hop);
    this.energy = new Float64Array(this.sBlocks);
    this.hist = new Uint32Array(BINS);
    this.up = 1 - Math.exp(-hop / attack);
    this.down = 1 - Math.exp(-hop / release);
    this.reset();
  }

  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.u1 = this.u2 = this.v1 = this.v2 = 0;
    this.acc = 0;
    this.fill = 0;
    this.blocks = 0;
    this.energy.fill(0);
    this.hist.fill(0);
    this.heard = 0;
    this.value = 0; // smoothed intensity 0..1
    this.raw = 0; // unsmoothed, normalised
    this.lufs = LUFS_FLOOR;
    this.lo = PRIOR.lo;
    this.hi = PRIOR.hi;
  }

  /** Feed mono samples (any length). */
  push(samples) {
    const [b0, b1, b2] = this.pre.b, [, a1, a2] = this.pre.a;
    const [c0, c1, c2] = this.rlb.b, [, d1, d2] = this.rlb.a;
    let x1 = this.x1, x2 = this.x2, y1 = this.y1, y2 = this.y2, u1 = this.u1, u2 = this.u2, v1 = this.v1, v2 = this.v2;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      const v = c0 * y + c1 * u1 + c2 * u2 - d1 * v1 - d2 * v2;
      u2 = u1; u1 = y; v2 = v1; v1 = v;
      this.acc += v * v;
      if (++this.fill === this.blockSamples) this._block();
    }
    this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2;
    this.u1 = u1; this.u2 = u2; this.v1 = v1; this.v2 = v2;
  }

  _block() {
    const E = this.energy, n = E.length;
    E[this.blocks % n] = this.acc / this.blockSamples;
    this.acc = 0;
    this.fill = 0;
    this.blocks++;
    const M = toLufs(meanOf(E, this.blocks, this.mBlocks));
    const ST = toLufs(meanOf(E, this.blocks, this.sBlocks));
    const lufs = Math.max(LUFS_FLOOR, 0.7 * ST + 0.3 * M);
    this.lufs = lufs;
    if (lufs > LUFS_FLOOR + 1) {
      this.hist[Math.min(BINS - 1, Math.max(0, Math.floor((lufs - LUFS_FLOOR) / BIN)))]++;
      this.heard++;
    }
    this._range();
    const lo = this.lo, hi = this.hi;
    this.raw = lufs <= LUFS_FLOOR + 1 ? 0 : Math.max(0, Math.min(1, (lufs - lo) / (hi - lo)));
    this.value += (this.raw - this.value) * (this.raw > this.value ? this.up : this.down);
  }

  /** The loudness range mapped onto 0..1 (lo, hi in LUFS): session percentiles, blended with the prior early on. */
  _range() {
    const w = this.heard / (this.heard + PRIOR.frames);
    let lo = PRIOR.lo, hi = PRIOR.hi;
    if (this.heard > 0) {
      lo = (1 - w) * PRIOR.lo + w * this._percentile(0.05);
      hi = (1 - w) * PRIOR.hi + w * this._percentile(0.95);
    }
    this.lo = lo;
    this.hi = hi - lo < MIN_SPAN ? lo + MIN_SPAN : hi;
  }

  _percentile(p) {
    const target = p * this.heard;
    let c = 0;
    for (let b = 0; b < BINS; b++) {
      c += this.hist[b];
      if (c >= target) return LUFS_FLOOR + (b + 0.5) * BIN;
    }
    return 0;
  }
}

function meanOf(E, count, k) {
  const n = E.length, m = Math.min(k, count);
  let s = 0;
  for (let j = 1; j <= m; j++) s += E[(count - j) % n];
  return m > 0 ? s / k : 0; // missing history counts as silence
}

function toLufs(ms) {
  return ms > 0 ? Math.max(LUFS_FLOOR, -0.691 + 10 * Math.log10(ms)) : LUFS_FLOOR;
}
