// Bars and phrases of a song heard live (docs/research.md §2.2), from the
// beats the live map has already heard. Pure; no allocation after
// construction, so it can run inside the frame loop.
//
// The live map pushes one record per beat span [beat n, beat n + 1) once
// it has been heard: the mean spectrum over the span (the skyline's 16
// levels, or none), the strongest onset on the beat and the strongest
// low-band (kick) onset on it, the summed strength of every onset in the
// span, and the live intensity.
//
//   downbeat  4/4 bars start where the spectrum changes most (chords and
//             bass move on the bar line) and where the kick is strongest.
//             The change at beat n compares the two beats from n with the
//             two before it: a chord held for the bar cancels out inside
//             it, and so does a kick-snare alternation. Both are averaged
//             per beat-of-bar over the last 16 bars, recent beats weighing
//             more. Confidence is how far the best beat-of-bar stands
//             above the runner-up.
//   phrases   at every bar line the change between the two bars after
//             and the two before (spectrum over its median, intensity,
//             onset energy); bar lines where that peaks count toward
//             their position in an 8-bar (and a 16-bar) cycle. Songs
//             change section on 8- and 16-bar lines, so the best position
//             is where the next section, and the next drop, will start.
//   builds    a bar that ends three bars of rising intensity and onset
//             energy (a riser, a snare roll): the song is heading into a
//             drop, which usually lands on the next phrase line.

export const BARS = Object.freeze({
  capacity: 256, // beats remembered (64 bars)
  dims: 16,
  downbeatBeats: 64, // beats the downbeat estimate looks back over
  decay: 0.97, // weight per beat of age in the downbeat estimate
  kickWeight: 0.2, // the kick's share of the downbeat evidence, next to spectral change
  switchMargin: 1.1, // another beat-of-bar must beat the current one by this factor to take over
  minBeats: 12, // beats before the downbeat is estimated at all
  phrasePeak: 1.8, // bar-line change (× its median) that counts as a section line
  phraseBars: 64,
  buildBars: 3, // a build rises over this many bars
  buildRise: 0.04, // intensity rise it needs, and
  buildEnergy: 0.1, // relative onset-energy rise
  buildScore: 0.8, // (rise / 0.15) + energy rise must reach this
});

const mod = (a, n) => ((a % n) + n) % n;

export class BarTracker {
  constructor() {
    const C = BARS.capacity, D = BARS.dims;
    this.spec = new Float32Array(C * D);
    this.hasSpec = new Uint8Array(C);
    this.accent = new Float32Array(C);
    this.kick = new Float32Array(C);
    this.energy = new Float32Array(C);
    this.level = new Float32Array(C);
    this.change = new Float32Array(C); // spectral change at beat n: beats n, n + 1 against n − 2, n − 1
    this.score4 = new Float64Array(4);
    this.weight4 = new Float64Array(4);
    this.score8 = new Float64Array(8);
    this.score16 = new Float64Array(16);
    const B = BARS.phraseBars;
    this.barSpec = new Float64Array(B * D);
    this.barLevel = new Float64Array(B);
    this.barEnergy = new Float64Array(B);
    this.barSpecOk = new Uint8Array(B);
    this.barDist = new Float64Array(B);
    this.barNovelty = new Float64Array(B);
    this.scratch = new Float64Array(B);
    this.reset();
  }

  reset() {
    this.first = 0; // first beat number held
    this.last = -1; // last beat number pushed (first − 1 when empty)
    this.count = 0;
    this.downbeat = 0; // beat numbers ≡ this (mod 4) start bars
    this.downbeatConfidence = 0;
    this.phrase = 0; // bar numbers ≡ this (mod 8) start phrases
    this.phrase16 = 0; // …and ≡ this (mod 16) the bigger ones
    this.phraseConfidence = 0;
    this.phraseLines = 0; // section lines seen
    this.buildScore = 0; // > 0: the bar just completed ended a build
    this.buildBar = NaN;
    this.lastBar = NaN; // last completed bar number
  }

  /** Ring slot of beat n. */
  _i(n) {
    return mod(n, BARS.capacity);
  }

  has(n) {
    return this.count > 0 && n >= this.first && n <= this.last;
  }

  /** Bar number of beat n (bars start on the downbeat). */
  barOf(n) {
    return Math.floor((n - this.downbeat) / 4);
  }

  isBarStart(n) {
    return mod(n - this.downbeat, 4) === 0;
  }

  /** First bar start at or after beat n. */
  nextBarStart(n) {
    return n + mod(this.downbeat - n, 4);
  }

  /** First phrase start (bar ≡ phrase mod 8) at or after beat n. */
  nextPhraseStart(n) {
    let b = this.nextBarStart(n);
    for (let k = 0; k < 8 && mod(this.barOf(b) - this.phrase, 8) !== 0; k++) b += 4;
    return b;
  }

  /** Whether beat n starts a 16-bar phrase. */
  isBigLine(n) {
    return this.isBarStart(n) && mod(this.barOf(n) - this.phrase16, 16) === 0;
  }

  kickAt(n) {
    return this.has(n) ? this.kick[this._i(n)] : 0;
  }

  levelAt(n) {
    return this.has(n) ? this.level[this._i(n)] : NaN;
  }

  /**
   * The record of beat n's span. Beats must arrive in order; a gap (or a
   * restart) forgets everything before it.
   * @param spec    16 levels (mean over the span) or null
   * @param accent  strongest onset on the beat (0..1), kick the strongest low-band one
   * @param energy  summed onset strength over the span
   * @param level   live intensity 0..1
   * @returns whether beat n completed a bar
   */
  push(n, spec, accent, kick, energy, level) {
    if (this.count > 0 && n !== this.last + 1) this.reset();
    if (this.count === 0) this.first = n;
    const C = BARS.capacity, D = BARS.dims, i = this._i(n);
    if (this.count === C) this.first++;
    else this.count++;
    this.last = n;
    const o = i * D;
    if (spec) for (let d = 0; d < D; d++) this.spec[o + d] = spec[d];
    this.hasSpec[i] = spec ? 1 : 0;
    this.accent[i] = accent;
    this.kick[i] = kick;
    this.energy[i] = energy;
    this.level[i] = level;
    // Beat n completes the change at beat n − 1.
    if (this.has(n - 3)) {
      const a = this._i(n - 3), b = this._i(n - 2), c0 = this._i(n - 1);
      let c = 0;
      if (spec && this.hasSpec[a] && this.hasSpec[b] && this.hasSpec[c0]) {
        const pa = a * D, pb = b * D, pc = c0 * D;
        for (let d = 0; d < D; d++) c += Math.abs(this.spec[pc + d] + this.spec[o + d] - this.spec[pa + d] - this.spec[pb + d]) / 2;
      }
      this.change[c0] = c;
    }
    this.change[i] = 0;
    this._downbeat();
    this.buildScore = 0;
    if (this.downbeatConfidence > 0 && mod(n + 1 - this.downbeat, 4) === 0) {
      this.lastBar = this.barOf(n);
      this._phrases();
      this._build();
      return true;
    }
    return false;
  }

  /** Beat-of-bar with the most spectral change and kick, recent beats weighing more. */
  _downbeat() {
    const n = this.last - 1, lo = Math.max(this.first + 2, n - BARS.downbeatBeats + 1);
    if (n - lo + 1 < BARS.minBeats) { this.downbeatConfidence = 0; return; }
    let meanC = 0, meanK = 0, cnt = 0;
    for (let m = lo; m <= n; m++) { const i = this._i(m); meanC += this.change[i]; meanK += this.kick[i]; cnt++; }
    meanC /= cnt; meanK /= cnt;
    const S = this.score4, W = this.weight4;
    S.fill(0); W.fill(0);
    let w = 1;
    for (let m = n; m >= lo; m--, w *= BARS.decay) {
      const i = this._i(m), q = mod(m, 4);
      const c = meanC > 1e-9 ? this.change[i] / meanC : 0, k = meanK > 1e-9 ? this.kick[i] / meanK : 0;
      S[q] += w * (c + BARS.kickWeight * k);
      W[q] += w;
    }
    let best = 0;
    for (let q = 0; q < 4; q++) S[q] = W[q] > 0 ? S[q] / W[q] : 0;
    for (let q = 1; q < 4; q++) if (S[q] > S[best]) best = q;
    // Hysteresis: a near tie never moves the bar lines.
    if (best !== this.downbeat && (this.downbeatConfidence === 0 || S[best] > BARS.switchMargin * S[this.downbeat])) {
      // The bar lines moved: phrase evidence counted on the old ones is void.
      this.downbeat = best;
      this.phraseConfidence = 0;
      this.phraseLines = 0;
    }
    const cur = this.downbeat;
    let second = 0;
    for (let q = 0; q < 4; q++) if (q !== cur && S[q] > second) second = S[q];
    this.downbeatConfidence = S[cur] > 1e-9 ? Math.max(0, 1 - second / S[cur]) : 0;
  }

  /** Section lines from the bars held, and the phrase position they agree on. */
  _phrases() {
    const D = BARS.dims, B = BARS.phraseBars;
    const jHi = this.lastBar, jLo = Math.max(Math.ceil((this.first - this.downbeat) / 4), jHi - B + 1);
    const nb = jHi - jLo + 1;
    if (nb < 5) return;
    for (let b = 0; b < nb; b++) {
      const s = this.downbeat + 4 * (jLo + b);
      let lv = 0, en = 0, ok = 1;
      for (let d = 0; d < D; d++) this.barSpec[b * D + d] = 0;
      for (let m = s; m < s + 4; m++) {
        const i = this._i(m);
        lv += this.level[i];
        en += this.energy[i];
        if (!this.hasSpec[i]) { ok = 0; continue; }
        for (let d = 0; d < D; d++) this.barSpec[b * D + d] += this.spec[i * D + d] / 4;
      }
      this.barLevel[b] = lv / 4;
      this.barEnergy[b] = en;
      this.barSpecOk[b] = ok;
    }
    // Change at the start of bar b: bars b, b + 1 against b − 2, b − 1.
    let nd = 0;
    for (let b = 2; b + 1 < nb; b++) {
      let dist = 0;
      if (this.barSpecOk[b - 2] && this.barSpecOk[b - 1] && this.barSpecOk[b] && this.barSpecOk[b + 1]) {
        for (let d = 0; d < D; d++) {
          const after = this.barSpec[b * D + d] + this.barSpec[(b + 1) * D + d];
          const before = this.barSpec[(b - 2) * D + d] + this.barSpec[(b - 1) * D + d];
          dist += Math.abs(after - before) / 2;
        }
      }
      this.barDist[b] = dist;
      this.scratch[nd++] = dist;
    }
    // Median by insertion sort (no allocation).
    const sc = this.scratch;
    for (let a = 1; a < nd; a++) { const v = sc[a]; let k = a - 1; while (k >= 0 && sc[k] > v) { sc[k + 1] = sc[k]; k--; } sc[k + 1] = v; }
    const med = nd ? sc[nd >> 1] : 0;
    for (let b = 2; b + 1 < nb; b++) {
      const lvA = (this.barLevel[b] + this.barLevel[b + 1]) / 2, lvB = (this.barLevel[b - 2] + this.barLevel[b - 1]) / 2;
      const enA = this.barEnergy[b] + this.barEnergy[b + 1], enB = this.barEnergy[b - 2] + this.barEnergy[b - 1];
      const enRel = Math.abs(enA - enB) / Math.max(1e-6, enA, enB);
      this.barNovelty[b] = (med > 1e-9 ? this.barDist[b] / med : 0) + 4 * Math.abs(lvA - lvB) + enRel;
    }
    this.score8.fill(0);
    this.score16.fill(0);
    let lines = 0;
    for (let b = 2; b + 1 < nb; b++) {
      const v = this.barNovelty[b];
      if (v < BARS.phrasePeak) continue;
      // Only where all four bars were heard in full (not the warm-up of a new lock).
      if (!(this.barSpecOk[b - 2] && this.barSpecOk[b - 1] && this.barSpecOk[b] && this.barSpecOk[b + 1]) && med > 1e-9) continue;
      if ((b > 2 && this.barNovelty[b - 1] > v) || (b + 2 < nb && this.barNovelty[b + 1] >= v)) continue;
      const j = jLo + b;
      this.score8[mod(j, 8)] += v;
      this.score16[mod(j, 16)] += v;
      lines++;
    }
    this.phraseLines = lines;
    if (!lines) { this.phraseConfidence = 0; return; }
    let best = 0;
    for (let p = 1; p < 8; p++) if (this.score8[p] > this.score8[best]) best = p;
    let second = 0;
    for (let p = 0; p < 8; p++) if (p !== best && this.score8[p] > second) second = this.score8[p];
    this.phrase = best;
    this.phrase16 = this.score16[best + 8] > this.score16[best] ? best + 8 : best;
    this.phraseConfidence = 1 - second / this.score8[best];
  }

  /** Did the bar just completed end a build? */
  _build() {
    const R = BARS.buildBars, j = this.lastBar;
    const s0 = this.downbeat + 4 * (j - R);
    if (!this.has(s0)) return;
    let lvNow = 0, lvThen = 0, enNow = 0, enThen = 0, lvPrev = 0;
    for (let m = 0; m < 4; m++) {
      const now = this._i(s0 + 4 * R + m), then = this._i(s0 + m), prev = this._i(s0 + 4 * (R - 1) + m);
      lvNow += this.level[now] / 4; lvThen += this.level[then] / 4; lvPrev += this.level[prev] / 4;
      enNow += this.energy[now]; enThen += this.energy[then];
    }
    const rise = lvNow - lvThen, energy = enNow / Math.max(1e-6, enThen) - 1;
    if (rise < BARS.buildRise || energy < BARS.buildEnergy || lvNow < lvPrev - 0.03) return;
    const score = rise / 0.15 + energy;
    if (score < BARS.buildScore) return;
    this.buildScore = score;
    this.buildBar = j;
  }
}
