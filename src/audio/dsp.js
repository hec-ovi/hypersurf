// Small DSP building blocks shared by the analysis stages: windows, the mel
// filterbank, resampling, downmixing and a few robust statistics.

/** Hann window. `periodic` matches scipy's fftbins=True (the STFT convention). */
export function hann(n, periodic = true) {
  const w = new Float32Array(n);
  const d = periodic ? n : n - 1;
  if (d <= 0) { w.fill(1); return w; }
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / d);
  return w;
}

// Slaney mel scale (librosa's default, htk=False): linear below 1 kHz, log above.
const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOG_STEP = Math.log(6.4) / 27;

export function hzToMel(hz) {
  return hz < MIN_LOG_HZ ? hz / F_SP : MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP;
}

export function melToHz(mel) {
  return mel < MIN_LOG_MEL ? F_SP * mel : MIN_LOG_HZ * Math.exp(LOG_STEP * (mel - MIN_LOG_MEL));
}

/**
 * Triangular mel filterbank over the bins of an nFft-point real FFT, stored
 * sparsely: band b covers bins start[b] .. start[b] + weights[b].length - 1.
 * norm 'slaney' scales each triangle to unit area in Hz (librosa default).
 */
export function melFilterbank({ sampleRate, nFft, nMels = 128, fMin = 0, fMax = sampleRate / 2, norm = 'slaney' }) {
  const bins = (nFft >> 1) + 1;
  const binHz = sampleRate / nFft;
  const melMin = hzToMel(fMin), melMax = hzToMel(fMax);
  const edges = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) edges[i] = melToHz(melMin + ((melMax - melMin) * i) / (nMels + 1));
  const start = new Int32Array(nMels);
  const weights = [];
  const centers = new Float64Array(nMels);
  for (let b = 0; b < nMels; b++) {
    const lo = edges[b], mid = edges[b + 1], hi = edges[b + 2];
    centers[b] = mid;
    const scale = norm === 'slaney' ? 2 / (hi - lo) : 1;
    let first = -1;
    const w = [];
    for (let k = 0; k < bins; k++) {
      const f = k * binHz;
      const v = Math.max(0, Math.min((f - lo) / (mid - lo), (hi - f) / (hi - mid)));
      if (v > 0) {
        if (first < 0) first = k;
        w.length = k - first + 1;
        w[k - first] = v * scale;
      } else if (first >= 0) break;
    }
    start[b] = first < 0 ? 0 : first;
    const arr = new Float32Array(w.length);
    for (let i = 0; i < w.length; i++) arr[i] = w[i] || 0;
    weights.push(arr);
  }
  return { nMels, nFft, sampleRate, start, weights, centers };
}

/** Apply a sparse mel filterbank to a power spectrum. */
export function applyFilterbank(fb, power, out) {
  for (let b = 0; b < fb.nMels; b++) {
    const w = fb.weights[b], s = fb.start[b];
    let acc = 0;
    for (let i = 0; i < w.length; i++) acc += w[i] * power[s + i];
    out[b] = acc;
  }
  return out;
}

/** Average the channels into one mono signal. */
export function downmix(channels) {
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const n = channels[0].length, out = new Float32Array(n), g = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] * g;
  return out;
}

function besselI0(x) {
  let sum = 1, term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 50; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/**
 * Band-limited resampling with a Kaiser-windowed sinc kernel read from a
 * finely sampled table. `zeros` is the number of zero crossings per side at
 * the output rate; `rolloff` places the cutoff just below the lower Nyquist.
 */
export function resample(input, fromRate, toRate, { zeros = 12, rolloff = 0.945, beta = 8.6 } = {}) {
  if (fromRate === toRate) return Float32Array.from(input);
  const ratio = toRate / fromRate;
  const outLen = Math.max(0, Math.floor(input.length * ratio));
  const out = new Float32Array(outLen);
  const fc = 0.5 * Math.min(1, ratio) * rolloff; // cycles per input sample
  const halfWidth = zeros / (2 * fc); // input samples
  const res = 256; // table points per input sample
  const tableLen = Math.ceil(halfWidth * res) + 2;
  const table = new Float32Array(tableLen);
  const i0b = besselI0(beta);
  for (let i = 0; i < tableLen; i++) {
    const t = i / res;
    const x = t / halfWidth;
    if (x >= 1) { table[i] = 0; continue; }
    const arg = 2 * Math.PI * fc * t;
    const sinc = t === 0 ? 1 : Math.sin(arg) / arg;
    table[i] = 2 * fc * sinc * (besselI0(beta * Math.sqrt(1 - x * x)) / i0b);
  }
  const step = fromRate / toRate;
  const n = input.length;
  for (let j = 0; j < outLen; j++) {
    const center = j * step;
    const lo = Math.max(0, Math.ceil(center - halfWidth));
    const hi = Math.min(n - 1, Math.floor(center + halfWidth));
    let acc = 0, norm = 0;
    for (let i = lo; i <= hi; i++) {
      const d = Math.abs(i - center) * res;
      const k = d | 0, f = d - k;
      const w = table[k] + (table[k + 1] - table[k]) * f;
      acc += w * input[i];
      norm += w;
    }
    // Normalise the DC gain; kernel sums differ slightly between phases and at the edges.
    out[j] = norm > 1e-9 ? acc / norm : 0;
  }
  return out;
}

/** p-th percentile (0..100) with linear interpolation; ignores NaN. */
export function percentile(values, p) {
  const a = Float64Array.from(values).filter((v) => !Number.isNaN(v)).sort();
  if (a.length === 0) return NaN;
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (a.length - 1);
  const i = Math.floor(pos), f = pos - i;
  return i + 1 < a.length ? a[i] + (a[i + 1] - a[i]) * f : a[i];
}

export function mean(a, from = 0, to = a.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i];
  return to > from ? s / (to - from) : 0;
}

export function std(a) {
  const m = mean(a);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2;
  return a.length ? Math.sqrt(s / a.length) : 0;
}

/**
 * Asymmetric one-pole smoother: rises with time constant `attack` and falls
 * with `release` (seconds), sampled at `rate` Hz.
 */
export function smoothAttackRelease(x, rate, attack, release, out = new Float32Array(x.length)) {
  const ka = 1 - Math.exp(-1 / (rate * attack));
  const kr = 1 - Math.exp(-1 / (rate * release));
  let y = x.length ? x[0] : 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    y += (v > y ? ka : kr) * (v - y);
    out[i] = y;
  }
  return out;
}

/** Linear interpolation into a uniformly sampled series (clamped at the ends). */
export function sampleSeries(series, rate, t) {
  const n = series.length;
  if (n === 0) return 0;
  const x = t * rate;
  if (x <= 0) return series[0];
  if (x >= n - 1) return series[n - 1];
  const i = x | 0, f = x - i;
  return series[i] + (series[i + 1] - series[i]) * f;
}
