// Causal beat tracking for live audio (docs/research.md §2.2). Pure: fed
// audio in hops, it never looks ahead, and it allocates nothing per hop.
//
//   SpectralFlux  1024-sample frames every 512 samples, a log filterbank at
//                 12 bands per octave from 30 Hz to 17 kHz, log(1 + X), and
//                 the rectified difference against a 3-band max filter of
//                 the previous frame (SuperFlux); plus sub-band flux and 16
//                 skyline levels
//   BeatTracker   onset peaks (running-max normaliser), and a BTrack-style
//                 tempo and phase tracker, written from the paper (Stark,
//                 Davies and Plumbley, DAFx-09), not from its GPL code:
//                   - a cumulative beat score over [−2T, −T/2]
//                   - at each mid-beat the score is projected one period
//                     ahead to predict the next beat
//                   - at each beat the tempo is re-estimated: balanced
//                     autocorrelation → 4-harmonic comb filterbank weighted
//                     by a Rayleigh curve peaked at 120 BPM → 41-state tempo
//                     HMM from 80 to 160 BPM in 2 BPM steps
//                 Tempos outside 80–160 BPM fold into it (an octave up or
//                 down), which is the tracker's octave handling; the player
//                 can still switch the block grid ×2 or ÷2.
//
// Two numbers say how far to trust it: `confidence`, the tempo
// observation's peak-to-mean ratio (research §2.2), and `hitRate`, the
// running share of predicted beats an onset landed on within ±40 ms. The
// first is slow to notice a tempo change (the history still holds the old
// tempo); the second notices within a beat or two.
//
// Times are tracker seconds from the first sample pushed. The grid it
// publishes ({ anchor, period }) is refined by a least-squares fit through
// the onsets that confirmed recent beats, so extrapolating it two seconds
// ahead stays within a few milliseconds on a steady tempo.

import { RealFFT } from '../audio/fft.js';
import { hann } from '../audio/dsp.js';

export const TRACKER = Object.freeze({
  hop: 512,
  frame: 1024,
  bandsPerOctave: 12,
  fMin: 30,
  fMax: 17000,
  bandEdges: [200, 3200], // Hz: low < 200 <= mid < 3200 <= high
  skylineBands: 16,
  history: 512, // frames of onset function kept for the tempo estimate
  minBpm: 80,
  maxBpm: 160,
  bpmStep: 2,
  transitionSigma: 41 / 8, // tempo states
  rayleighSeconds: 0.5, // comb weighting peak (120 BPM)
  alpha: 0.9,
  tightness: 5,
  minTempoSeconds: 2, // history needed before the first tempo estimate
  preMax: 0.03,
  preAvg: 0.1,
  delta: 0.07,
  wait: 0.03,
  normDecay: 10, // seconds for the peak normaliser to fall by 1/e
  confirmWindow: 0.04, // an onset this close to a predicted beat confirms it
  fitBeats: 8, // confirmed beats in the grid fit
  suppressWindow: 0.03, // our own sounds: onset function held flat this close to them
});

// --- front end -----------------------------------------------------------------

/**
 * Triangular filters on log-spaced centres, SuperFlux style: centres at
 * `bandsPerOctave` per octave from fMin to fMax are snapped to FFT bins and
 * de-duplicated, so low bands narrower than a bin collapse to single bins.
 * Each filter sums to 1. Returns { count, start: Int32Array, len: Int32Array,
 * weights: Float32Array (flat), offset: Int32Array, centre: Float32Array (Hz) }.
 */
export function logFilterbank(sampleRate, nFft, { bandsPerOctave = 12, fMin = 30, fMax = 17000 } = {}) {
  const binHz = sampleRate / nFft, bins = (nFft >> 1) + 1;
  const top = Math.min(fMax, sampleRate / 2 - binHz);
  const idx = [];
  for (let f = fMin; f <= top * 1.000001; f *= Math.pow(2, 1 / bandsPerOctave)) {
    const k = Math.round(f / binHz);
    if (k >= 1 && k < bins && k !== idx[idx.length - 1]) idx.push(k);
  }
  const count = Math.max(0, idx.length - 2);
  const start = new Int32Array(count), len = new Int32Array(count), offset = new Int32Array(count), centre = new Float32Array(count);
  const flat = [];
  for (let i = 0; i < count; i++) {
    const a = idx[i], c = idx[i + 1], b = idx[i + 2];
    const w = [];
    for (let k = a; k < b; k++) w.push(k <= c ? (c === a ? 1 : (k - a) / (c - a)) : (b - k) / (b - c));
    // Drop the zero weight at a rising edge of more than one bin.
    let s0 = 0;
    while (s0 < w.length - 1 && w[s0] === 0) s0++;
    const kept = w.slice(s0);
    const sum = kept.reduce((x, y) => x + y, 0) || 1;
    start[i] = a + s0;
    len[i] = kept.length;
    offset[i] = flat.length;
    centre[i] = c * binHz;
    for (const v of kept) flat.push(v / sum);
  }
  return { count, start, len, offset, weights: Float32Array.from(flat), centre };
}

/**
 * Spectral flux of a live stream. push() one hop at a time; after each hop
 * `flux` holds the onset function value of the newest frame (the frame ends
 * with that hop), `bandFlux` its low/mid/high parts and `levels` 16 skyline
 * levels (0..255 over 60 dB below a slowly decaying peak).
 */
export class SpectralFlux {
  constructor(sampleRate, o = TRACKER) {
    this.sampleRate = sampleRate;
    this.hop = o.hop;
    this.size = o.frame;
    this.fft = new RealFFT(o.frame);
    this.window = hann(o.frame);
    this.samples = new Float32Array(o.frame);
    this.windowed = new Float32Array(o.frame);
    const bins = this.fft.bins;
    this.re = new Float64Array(bins);
    this.im = new Float64Array(bins);
    this.fb = logFilterbank(sampleRate, o.frame, o);
    const nb = this.fb.count;
    this.cur = new Float32Array(nb);
    this.prev = new Float32Array(nb);
    this.bandOf = new Uint8Array(nb);
    for (let b = 0; b < nb; b++) this.bandOf[b] = this.fb.centre[b] < o.bandEdges[0] ? 0 : this.fb.centre[b] < o.bandEdges[1] ? 1 : 2;
    this.bandCount = new Float32Array(3);
    for (let b = 0; b < nb; b++) this.bandCount[this.bandOf[b]]++;
    // Skyline groups: contiguous runs of filters, as even as the count allows.
    const groups = o.skylineBands;
    this.groupStart = new Int32Array(groups + 1);
    for (let g = 0; g <= groups; g++) this.groupStart[g] = Math.round((g * nb) / groups);
    this.linear = new Float32Array(nb);
    this.levels = new Uint8Array(groups);
    this.groupDb = new Float32Array(groups);
    this.peakDb = -60;
    this.peakFall = (o.hop / sampleRate) * 1.5; // dB per hop
    this.flux = 0;
    this.bandFlux = new Float32Array(3);
    this.energy = 0; // mean square of the newest hop
    this.frames = 0;
  }

  reset() {
    this.samples.fill(0);
    this.prev.fill(0);
    this.cur.fill(0);
    this.flux = 0;
    this.bandFlux.fill(0);
    this.levels.fill(0);
    this.peakDb = -60;
    this.frames = 0;
  }

  /** Add one hop (length = hop) and analyse the frame ending with it. */
  push(hop) {
    const n = this.size, h = this.hop, s = this.samples;
    s.copyWithin(0, h);
    let e = 0;
    for (let i = 0; i < h; i++) {
      const v = hop[i];
      s[n - h + i] = v;
      e += v * v;
    }
    this.energy = e / h;
    const w = this.window, x = this.windowed;
    for (let i = 0; i < n; i++) x[i] = s[i] * w[i];
    this.fft.forward(x, this.re, this.im);
    const fb = this.fb, re = this.re, im = this.im, cur = this.cur, lin = this.linear;
    for (let b = 0; b < fb.count; b++) {
      let acc = 0;
      const k0 = fb.start[b], o = fb.offset[b];
      for (let j = 0; j < fb.len[b]; j++) {
        const k = k0 + j;
        acc += Math.sqrt(re[k] * re[k] + im[k] * im[k]) * fb.weights[o + j];
      }
      lin[b] = acc;
      cur[b] = Math.log1p(acc);
    }
    // Rectified flux against a 3-band max filter of the previous frame.
    const prev = this.prev, nb = fb.count, bf = this.bandFlux;
    bf[0] = bf[1] = bf[2] = 0;
    let total = 0;
    for (let b = 0; b < nb; b++) {
      let ref = prev[b];
      if (b > 0 && prev[b - 1] > ref) ref = prev[b - 1];
      if (b + 1 < nb && prev[b + 1] > ref) ref = prev[b + 1];
      const d = cur[b] - ref;
      if (d > 0) {
        total += d;
        bf[this.bandOf[b]] += d;
      }
    }
    this.flux = total;
    for (let g = 0; g < 3; g++) bf[g] = this.bandCount[g] ? bf[g] / this.bandCount[g] : 0;
    this.prev = cur;
    this.cur = prev;
    this._skyline();
    this.frames++;
    return total;
  }

  _skyline() {
    const gs = this.groupStart, lin = this.linear, lv = this.levels, gdb = this.groupDb, groups = lv.length;
    let top = -Infinity;
    for (let g = 0; g < groups; g++) {
      const a = gs[g], b = Math.min(lin.length, Math.max(a + 1, gs[g + 1]));
      let acc = 0;
      for (let k = a; k < b; k++) acc += lin[k];
      const db = 20 * Math.log10(Math.max(1e-6, acc / (b - a)));
      gdb[g] = db;
      if (db > top) top = db;
    }
    this.peakDb = Math.max(top, this.peakDb - this.peakFall);
    for (let g = 0; g < groups; g++) lv[g] = Math.max(0, Math.min(255, Math.round(((gdb[g] - this.peakDb + 60) / 60) * 255)));
  }
}

// --- tracker ---------------------------------------------------------------------

const RING = 64;

/**
 * The live beat tracker. push() audio in any chunk size; read `grid`,
 * `confidence` and `bpm`, and drain onsets and beats from their rings by
 * count (onsetCount / beatCount grow forever; entry i lives at i % 64).
 */
export class BeatTracker {
  constructor(sampleRate, options = {}) {
    const o = (this.o = { ...TRACKER, ...options });
    this.sampleRate = sampleRate;
    this.hop = o.hop;
    this.hopDur = o.hop / sampleRate;
    this.frameRate = sampleRate / o.hop;
    this.front = new SpectralFlux(sampleRate, o);
    this.inHop = new Float32Array(o.hop);
    this.inFill = 0;

    const N = (this.N = o.history);
    this.odf = new Float32Array(N);
    this.cs = new Float32Array(N);
    this.series = new Float32Array(N); // scratch: chronological onset function

    // Tempo states and their HMM transition matrix.
    const S = (this.S = Math.round((o.maxBpm - o.minBpm) / o.bpmStep) + 1);
    this.bpms = new Float32Array(S);
    for (let s = 0; s < S; s++) this.bpms[s] = o.minBpm + s * o.bpmStep;
    this.trans = new Float32Array(S * S);
    for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) this.trans[i * S + j] = Math.exp(-((i - j) ** 2) / (2 * o.transitionSigma ** 2));
    this.delta = new Float32Array(S);
    this.deltaNext = new Float32Array(S);
    this.obs = new Float32Array(S);

    // Autocorrelation by FFT (Wiener-Khinchin) over the history.
    let size = 1;
    while (size < 2 * N) size <<= 1;
    this.acfSize = size;
    this.acfFft = new RealFFT(size);
    this.acfIn = new Float32Array(size);
    this.acfEven = new Float32Array(size);
    this.acfRe = new Float64Array(size / 2 + 1);
    this.acfIm = new Float64Array(size / 2 + 1);
    this.acf = new Float32Array(N);
    this.maxLag = Math.ceil((60 / o.minBpm) * this.frameRate) + 2;
    this.comb = new Float32Array(this.maxLag + 1);
    const beta = o.rayleighSeconds * this.frameRate;
    this.rayleigh = new Float32Array(this.maxLag + 1);
    for (let l = 1; l <= this.maxLag; l++) this.rayleigh[l] = (l / (beta * beta)) * Math.exp(-(l * l) / (2 * beta * beta));

    // Cumulative-score window, rebuilt when the period changes.
    this.w1 = new Float32Array(2 * this.maxLag + 2);
    this.future = new Float32Array(this.maxLag + 2);

    // Onset peak picking (normalised onset function, a short ring).
    this.normRing = new Float32Array(32);
    this.preMax = Math.max(1, Math.round(o.preMax * this.frameRate));
    this.preAvg = Math.max(1, Math.round(o.preAvg * this.frameRate));
    this.waitFrames = Math.max(1, Math.round(o.wait * this.frameRate));
    this.normFall = Math.exp(-this.hopDur / o.normDecay);
    this.bandRing = new Float32Array(32 * 3);

    // Output rings.
    this.onsetTime = new Float64Array(RING);
    this.onsetStrength = new Float32Array(RING);
    this.onsetBand = new Uint8Array(RING);
    this.beatTime = new Float64Array(RING);
    this.beatOnset = new Float64Array(RING); // confirming onset time, NaN if none
    this.beatConfidence = new Float32Array(RING);

    // Our own sounds (hit effects, calibration clicks): suppression times.
    this.suppressTimes = new Float64Array(32).fill(-Infinity);
    this.suppressNext = 0;

    this.grid = { anchor: NaN, period: 0.5, bpm: 120, confidence: 0 };
    this.reset();
  }

  reset() {
    this.front.reset();
    this.inFill = 0;
    this.n = -1;
    this.odf.fill(0);
    this.cs.fill(0);
    this.delta.fill(1 / this.S);
    this.normRing.fill(0);
    this.bandRing.fill(0);
    this.runMax = 1e-9;
    this.lastPeak = -Infinity;
    this.onsetCount = 0;
    this.beatCount = 0;
    this.resolved = 0; // beats whose confirmation window has closed
    this.hitRate = 0; // running share of beats an onset confirmed
    this.confidence = 0;
    this.bpm = 120;
    this._setPeriod((60 / 120) * this.frameRate);
    this.predictAt = Math.round(1.2 * this.frameRate);
    this.nextBeat = Infinity;
    this.lastBeat = NaN;
    this.suppressTimes.fill(-Infinity);
    const g = this.grid;
    g.anchor = NaN;
    g.period = 0.5;
    g.bpm = 120;
    g.confidence = 0;
  }

  /** Tracker time (s) of frame n: the middle of its newest hop. */
  frameTime(n) {
    return (n + 0.5) * this.hopDur;
  }

  /** Current tracker time: the newest analysed frame. */
  get time() {
    return this.n < 0 ? 0 : this.frameTime(this.n);
  }

  /** Hold the onset function flat within ±30 ms of tracker time t (our own sounds). */
  suppress(t) {
    this.suppressTimes[this.suppressNext] = t;
    this.suppressNext = (this.suppressNext + 1) % this.suppressTimes.length;
  }

  /** Feed mono samples, any length. */
  push(samples) {
    const h = this.hop, buf = this.inHop;
    let i = 0;
    while (i < samples.length) {
      const take = Math.min(h - this.inFill, samples.length - i);
      for (let k = 0; k < take; k++) buf[this.inFill + k] = samples[i + k];
      this.inFill += take;
      i += take;
      if (this.inFill === h) {
        this.inFill = 0;
        this._frame(this.front.push(buf));
      }
    }
  }

  _frame(value) {
    const n = ++this.n, N = this.N, t = this.frameTime(n);
    // Suppress our own sounds: the onset function may not rise near them.
    let odf = value;
    for (let k = 0; k < this.suppressTimes.length; k++) {
      if (Math.abs(t - this.suppressTimes[k]) <= this.o.suppressWindow) {
        const prev = n > 0 ? this.odf[(n - 1) % N] : 0;
        if (odf > prev) odf = prev;
        break;
      }
    }
    this.odf[n % N] = odf;

    // Cumulative beat score.
    const lo = this.w1Lo, hi = this.w1Hi, w1 = this.w1, cs = this.cs;
    let best = 0;
    for (let v = lo; v <= hi; v++) {
      const k = n - v;
      if (k < 0) break;
      const val = w1[v - lo] * cs[k % N];
      if (val > best) best = val;
    }
    cs[n % N] = (1 - this.o.alpha) * odf + this.o.alpha * best;

    this._pickOnset(n, odf);
    if (n >= this.predictAt) this._predict(n);
    if (n >= this.nextBeat) this._beat(n);
    this._resolveBeats(t);
  }

  _setPeriod(frames) {
    this.period = frames;
    const lo = Math.max(1, Math.round(frames / 2)), hi = Math.min(this.N - 1, Math.round(2 * frames));
    this.w1Lo = lo;
    this.w1Hi = hi;
    const eta = this.o.tightness;
    for (let v = lo; v <= hi; v++) {
      const x = eta * Math.log(v / frames);
      this.w1[v - lo] = Math.exp(-0.5 * x * x);
    }
  }

  /**
   * Onset peaks on the onset function over a running maximum (10 s decay):
   * the frame before the newest is a peak when it is the largest of the last
   * 30 ms and the next frame, and clears the 100 ms mean by delta.
   */
  _pickOnset(n, odf) {
    this.runMax = Math.max(odf, this.runMax * this.normFall, 1e-9);
    const R = this.normRing, L = R.length;
    R[n % L] = odf / this.runMax;
    const bands = this.front.bandFlux, B = this.bandRing;
    B[(n % L) * 3] = bands[0]; B[(n % L) * 3 + 1] = bands[1]; B[(n % L) * 3 + 2] = bands[2];
    const p = n - 1;
    if (p < 1) return;
    const x = R[p % L];
    if (x < R[n % L]) return;
    for (let k = 1; k <= this.preMax && p - k >= 0; k++) if (R[(p - k) % L] > x) return;
    let avg = 0, cnt = 0;
    for (let k = 0; k <= this.preAvg && p - k >= 0; k++) { avg += R[(p - k) % L]; cnt++; }
    if (x < avg / cnt + this.o.delta) return;
    if (p - this.lastPeak <= this.waitFrames) return;
    this.lastPeak = p;
    // Sub-frame position from a parabola through the peak and its neighbours.
    const a = R[(p - 1) % L], c = R[n % L];
    const den = a - 2 * x + c;
    const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    const i = this.onsetCount % RING;
    this.onsetTime[i] = this.frameTime(p + off);
    this.onsetStrength[i] = x;
    let band = 0, bestV = -1;
    for (let g = 0; g < 3; g++) {
      const v = Math.max(B[(p % L) * 3 + g], B[(n % L) * 3 + g]);
      if (v > bestV) { bestV = v; band = g; }
    }
    this.onsetBand[i] = band;
    this.onsetCount++;
  }

  /** At mid-beat: project the cumulative score one period ahead and pick the next beat. */
  _predict(n) {
    const N = this.N, cs = this.cs, fut = this.future, w1 = this.w1, lo = this.w1Lo, hi = this.w1Hi;
    const T = this.period, L = Math.min(fut.length - 1, Math.round(T));
    const alpha = this.o.alpha;
    let bestJ = 1, bestV = -1;
    const sigma = T / 2;
    for (let j = 1; j <= L; j++) {
      let best = 0;
      for (let v = lo; v <= hi; v++) {
        const k = n + j - v;
        if (k < 0) break;
        const val = w1[v - lo] * (k > n ? fut[k - n] : cs[k % N]);
        if (val > best) best = val;
      }
      fut[j] = alpha * best;
      const w2 = Math.exp(-((j - sigma) ** 2) / (2 * sigma * sigma));
      const score = fut[j] * w2;
      if (score > bestV) { bestV = score; bestJ = j; }
    }
    this.nextBeat = n + bestJ;
    this.predictAt = Infinity;
    // The next beat is known: publish the grid through it.
    this._publishGrid(this.frameTime(n + bestJ));
  }

  /** A beat frame arrived: record it, re-estimate the tempo, schedule the next prediction. */
  _beat(n) {
    const t = this.frameTime(this.nextBeat);
    this.lastBeat = this.nextBeat;
    if ((n + 1) * this.hopDur >= this.o.minTempoSeconds) this._tempo(n);
    const i = this.beatCount % RING;
    this.beatTime[i] = t;
    this.beatOnset[i] = NaN;
    this.beatConfidence[i] = this.confidence;
    this.beatCount++;
    this.nextBeat = Infinity;
    this.predictAt = this.lastBeat + Math.round(this.period / 2);
  }

  /** Beats whose ±40 ms window has closed get their confirming onset (or none). */
  _resolveBeats(now) {
    const win = this.o.confirmWindow;
    while (this.resolved < this.beatCount) {
      const i = this.resolved % RING, bt = this.beatTime[i];
      if (now < bt + win + 2 * this.hopDur) break;
      let bestT = NaN, bestD = win;
      for (let k = Math.max(0, this.onsetCount - RING); k < this.onsetCount; k++) {
        const ot = this.onsetTime[k % RING], d = Math.abs(ot - bt);
        if (d <= bestD) { bestD = d; bestT = ot; }
      }
      this.beatOnset[i] = bestT;
      this.hitRate += 0.25 * ((Number.isFinite(bestT) ? 1 : 0) - this.hitRate);
      this.resolved++;
    }
  }

  /**
   * The grid through the next beat `tNext`: a least-squares line through the
   * onsets that confirmed the last few beats when they agree with the HMM
   * tempo, otherwise the prediction itself at the HMM period.
   */
  _publishGrid(tNext) {
    const g = this.grid, T = this.period * this.hopDur;
    let anchor = tNext, period = T;
    const m = Math.min(this.o.fitBeats, this.resolved);
    let sk = 0, st = 0, skk = 0, skt = 0, c = 0;
    for (let j = 0; j < m; j++) {
      const idx = this.resolved - 1 - j, ot = this.beatOnset[idx % RING];
      if (!Number.isFinite(ot)) continue;
      // Beat index along the grid: whole periods back from the prediction.
      const k = Math.round((ot - tNext) / T);
      if (k >= 0) continue;
      sk += k; st += ot; skk += k * k; skt += k * ot; c++;
    }
    if (c >= 4) {
      const den = c * skk - sk * sk;
      if (den > 0) {
        const b = (c * skt - sk * st) / den, a = (st - b * sk) / c;
        if (Math.abs(b - T) / T < 0.03 && Math.abs(a - tNext) < 0.25 * T) { anchor = a; period = b; }
      }
    }
    g.anchor = anchor;
    g.period = period;
    g.bpm = 60 / period;
    g.confidence = this.confidence;
  }

  /** Tempo from the onset history: balanced ACF → comb filterbank → HMM. */
  _tempo(n) {
    const N = this.N, len = Math.min(n + 1, N), x = this.series;
    // Chronological copy with an adaptive threshold (local mean removed, rectified).
    for (let i = 0; i < len; i++) x[i] = this.odf[(n - len + 1 + i) % N];
    const half = 8;
    let energy = 0;
    for (let i = 0; i < len; i++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, i - half); k <= Math.min(len - 1, i + half); k++) { s += x[k]; c++; }
      this.acf[i] = Math.max(0, x[i] - s / c); // temporarily hold the thresholded series
      energy += this.acf[i];
    }
    if (energy < 1e-6) {
      this.confidence *= 0.5;
      return;
    }
    const size = this.acfSize, inp = this.acfIn, even = this.acfEven, re = this.acfRe, im = this.acfIm;
    inp.fill(0);
    for (let i = 0; i < len; i++) inp[i] = this.acf[i];
    this.acfFft.forward(inp, re, im);
    const bins = size / 2 + 1;
    for (let k = 0; k < bins; k++) even[k] = re[k] * re[k] + im[k] * im[k];
    for (let k = bins; k < size; k++) even[k] = even[size - k];
    this.acfFft.forward(even, re, im);
    // re[l] = size · Σ x[i] x[i + l]; balance by the overlap length.
    const acf = this.acf;
    for (let l = 0; l < len; l++) acf[l] = re[l] / (size * (len - l));

    // Comb filterbank: four harmonics of each lag, Rayleigh-weighted.
    const comb = this.comb, maxLag = this.maxLag;
    for (let tau = 1; tau <= maxLag; tau++) {
      let s = 0;
      for (let a = 1; a <= 4; a++) {
        for (let b = 1 - a; b <= a - 1; b++) {
          const l = a * tau + b;
          if (l > 0 && l < len) s += acf[l] / (2 * a - 1);
        }
      }
      comb[tau] = s * this.rayleigh[tau];
    }

    // Observation per tempo state: the comb at its lag plus at half its lag.
    const S = this.S, obs = this.obs;
    let peak = 0, mean = 0;
    for (let s = 0; s < S; s++) {
      const lag = (60 / this.bpms[s]) * this.frameRate;
      const v = Math.max(0, combAt(comb, lag)) + Math.max(0, combAt(comb, lag / 2));
      obs[s] = v;
      mean += v;
      if (v > peak) peak = v;
    }
    mean /= S;
    // Confidence: the observation's peak-to-mean ratio, normalised, and
    // halved while the tempo estimate is still moving between beats.
    const ratio = mean > 0 ? peak / mean : 0;
    let c = Math.max(0, Math.min(1, (ratio - 1.25) / (2.2 - 1.25)));

    // HMM (Viterbi-style max-product) step.
    const d = this.delta, dn = this.deltaNext, tr = this.trans;
    let sum = 0;
    for (let j = 0; j < S; j++) {
      let best = 0;
      for (let i = 0; i < S; i++) {
        const v = d[i] * tr[i * S + j];
        if (v > best) best = v;
      }
      dn[j] = best * (obs[j] / (peak || 1) + 1e-3);
      sum += dn[j];
    }
    let arg = 0;
    for (let j = 0; j < S; j++) {
      d[j] = sum > 0 ? dn[j] / sum : 1 / S;
      if (d[j] > d[arg]) arg = j;
    }
    // Refine between neighbouring states by the observation curve.
    let bpm = this.bpms[arg];
    if (arg > 0 && arg < S - 1) {
      const a = obs[arg - 1], b = obs[arg], cc = obs[arg + 1];
      const den = a - 2 * b + cc;
      if (den < 0) bpm += Math.max(-0.5, Math.min(0.5, (0.5 * (a - cc)) / den)) * this.o.bpmStep;
    }
    if (Math.abs(bpm - this.bpm) > 2.5) c *= 0.5;
    this.confidence = this.beatCount < 2 ? c : 0.5 * this.confidence + 0.5 * c;
    this.bpm = bpm;
    this._setPeriod((60 / bpm) * this.frameRate);
  }
}

/** Linear interpolation into the comb output at a fractional lag. */
function combAt(comb, lag) {
  const i = Math.floor(lag), f = lag - i;
  if (i < 1 || i + 1 >= comb.length) return 0;
  return comb[i] * (1 - f) + comb[i + 1] * f;
}
