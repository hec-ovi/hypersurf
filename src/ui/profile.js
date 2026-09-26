// The song's intensity profile (docs/art-direction.md §9.2): 60 bars drawn
// once to two canvases, dim (unplayed) and lit (played). During play only
// transforms move: a clip box slides over the lit copy, and the playhead.
// profileBars() is pure (tested in Node).

import { makeSample } from '../game/trackpath.js';

export const BARS = 60;

/**
 * Mean intensity (0..1) in each of `bars` equal slices of [t0, t1], from a
 * sampler intensityAt(t). Several samples per slice so short spikes count.
 */
export function profileBars(intensityAt, t0, t1, bars = BARS, perBar = 6, out = new Float32Array(bars)) {
  const span = (t1 - t0) / bars;
  for (let b = 0; b < bars; b++) {
    let sum = 0;
    for (let k = 0; k < perBar; k++) sum += intensityAt(t0 + span * (b + (k + 0.5) / perBar));
    const v = sum / perBar;
    out[b] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

export class Profile {
  constructor(root) {
    this.root = root;
    this.dim = root.querySelector('canvas.dim');
    this.lit = root.querySelector('canvas.lit');
    this.clip = root.querySelector('.lit-clip');
    this.head = root.querySelector('.head');
    this.bars = new Float32Array(BARS);
    this.marks = [];
    this.px = -1;
    this.w = 0;
    this._s = makeSample();
  }

  /** Measure (one-shot) and size the canvases to the element. */
  _size() {
    const w = this.root.clientWidth, h = this.root.clientHeight;
    if (!w || !h) return false;
    const dpr = Math.min(2, devicePixelRatio || 1);
    for (const c of [this.dim, this.lit]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    return true;
  }

  /** A whole song: bars over [0, duration], section marks at `marks` (seconds). */
  song(path, duration, marks = []) {
    const s = this._s;
    profileBars((t) => path.sample(t, s).intensity, 0, duration, BARS, 6, this.bars);
    this.marks = marks.map((t) => t / duration);
    this.draw();
  }

  /** A live run: the past `window` seconds up to now (the future is unknown). */
  rolling(path, now, window = 30) {
    const s = this._s, t0 = now - window;
    profileBars((t) => (t < 0 ? 0 : path.sample(t, s).intensity), t0, now, BARS, 3, this.bars);
    this.marks = [];
    this.draw();
  }

  draw() {
    if (!this._size()) { this.w = 0; return; }
    this._paint(this.dim, 'rgba(120,225,218,.22)', 'rgba(157,192,189,.9)');
    this._paint(this.lit, 'rgba(63,224,208,.9)', 'rgba(157,192,189,.9)');
    this.px = -1;
  }

  _paint(canvas, bar, mark) {
    const ctx = canvas.getContext('2d');
    const { w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const step = w / BARS, bw = Math.max(1.5, step * 4 / 7);
    const top = 8, base = h - 5; // room for marks above and ticks below
    ctx.fillStyle = bar;
    for (let b = 0; b < BARS; b++) {
      const bh = Math.max(3, this.bars[b] * (base - top));
      ctx.fillRect(b * step + (step - bw) / 2, base - bh, bw, bh);
    }
    ctx.fillStyle = 'rgba(120,225,218,.3)';
    ctx.fillRect(0, base + 1, w, 1);
    for (let k = 0; k <= 10; k++) ctx.fillRect(Math.min(w - 1, Math.round((k / 10) * w)), base + 1, 1, 4);
    ctx.fillStyle = mark;
    for (const m of this.marks) ctx.fillRect(Math.round(m * w), 0, 1, 7);
  }

  /** Move the played clip and the playhead to fraction p (only when it moves ≥ 1px). */
  set(p) {
    if (!this.w) {
      // Drawn while hidden (no size yet): draw now that it shows.
      this.draw();
      if (!this.w) return;
    }
    const x = Math.round(Math.max(0, Math.min(1, p)) * this.w);
    if (x === this.px) return;
    this.px = x;
    const hide = this.w - x;
    this.clip.style.transform = `translateX(${-hide}px)`;
    this.lit.style.transform = `translateX(${hide}px)`;
    this.head.style.transform = `translateX(${x}px)`;
  }
}
