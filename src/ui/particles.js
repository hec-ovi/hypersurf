// UI particles (docs/art-direction.md §5.1): one pooled 2D canvas over the
// interface. ParticlePool is pure and allocation-free after construction
// (tested in Node); FxLayer draws it on #fx and runs its loop only while
// particles are alive.

/** Colour slots a particle can take (index into this list). */
export const FX_COLOURS = Object.freeze({
  cyan: 0, cyanHi: 1, gold: 2, lime: 3, overfill: 4, red: 5, white: 6,
});
const RGB = ['63,224,208', '143,247,238', '255,201,64', '198,240,74', '255,90,42', '255,90,74', '230,255,252'];
const EXTRA_BASE = 7; // custom colours (grid tiles) start here

export class ParticlePool {
  constructor(capacity = 480) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.life = new Float32Array(capacity); // seconds left; ≤ 0 is free
    this.max = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.colour = new Uint8Array(capacity);
    this.next = 0; // ring cursor: when full, the oldest slot is reused
    this.alive = 0;
    this.seed = 0x9e3779b9;
  }

  /** Deterministic, allocation-free random in [0, 1). */
  rand() {
    let s = (this.seed = (this.seed + 0x6d2b79f5) | 0);
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  }

  spawn(x, y, vx, vy, life, size, colour, drag = 2.2, gravity = 0) {
    const i = this._slot();
    this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.max[i] = life; this.size[i] = size;
    this.drag[i] = drag; this.gravity[i] = gravity; this.colour[i] = colour;
    return i;
  }

  _slot() {
    // Prefer a free slot near the cursor; otherwise take the cursor (the oldest).
    for (let k = 0; k < this.capacity; k++) {
      const i = (this.next + k) % this.capacity;
      if (this.life[i] <= 0) { this.next = (i + 1) % this.capacity; this.alive++; return i; }
    }
    const i = this.next;
    this.next = (i + 1) % this.capacity;
    return i;
  }

  /**
   * A radial burst of n sparks at (x, y). spread: angle range in radians
   * around `angle` (2π for all round); speed in px/s.
   */
  burst(x, y, n, { colour = 0, speed = 220, spread = Math.PI * 2, angle = 0, life = 0.45, size = 2, gravity = 0, drag = 3, jitter = 0 } = {}) {
    for (let k = 0; k < n; k++) {
      const a = angle + (this.rand() - 0.5) * spread;
      const v = speed * (0.35 + 0.65 * this.rand());
      const px = x + (this.rand() - 0.5) * jitter, py = y + (this.rand() - 0.5) * jitter;
      this.spawn(px, py, Math.cos(a) * v, Math.sin(a) * v, life * (0.6 + 0.4 * this.rand()), size * (0.6 + 0.8 * this.rand()), colour, drag, gravity);
    }
  }

  /** Advance dt seconds. Returns the number still alive. */
  step(dt) {
    let alive = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      const l = this.life[i] - dt;
      this.life[i] = l;
      if (l <= 0) continue;
      const k = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= k;
      this.vy[i] = this.vy[i] * k + this.gravity[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      alive++;
    }
    this.alive = alive;
    return alive;
  }

  clear() {
    this.life.fill(0);
    this.alive = 0;
  }
}

/**
 * The #fx canvas. burst()/spawn() go through the pool; the loop starts on
 * the first spawn and stops (after one clearing frame) when all are gone.
 */
export class FxLayer {
  constructor(canvas, capacity = 480) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pool = new ParticlePool(capacity);
    this.running = false;
    this.enabled = true;
    this.last = 0;
    this.colours = RGB.slice();
    this.styles = [];
    this._build();
    this._frame = (now) => this.frame(now);
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  _build() {
    this.styles = this.colours.map((c) => `rgb(${c})`);
  }

  /** Colour slot for a CSS hex colour (grid tiles), added once. */
  colourFor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return 0;
    const n = parseInt(m[1], 16);
    const rgb = `${n >> 16},${(n >> 8) & 255},${n & 255}`;
    let i = this.colours.indexOf(rgb, EXTRA_BASE);
    if (i < 0) {
      if (this.colours.length >= 64) return 0;
      i = this.colours.push(rgb) - 1;
      this.styles.push(`rgb(${rgb})`);
    }
    return i;
  }

  resize() {
    this.dpr = Math.min(1.5, devicePixelRatio || 1);
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  burst(x, y, n, opts) {
    if (!this.enabled) return;
    this.pool.burst(x, y, n, opts);
    this._wake();
  }

  /** Burst from the centre of an element's box. */
  burstFrom(el, n, opts) {
    if (!this.enabled || !el) return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    this.burst(r.left + r.width / 2, r.top + r.height / 2, n, { jitter: Math.min(r.width, 160), ...opts });
  }

  spawn(...args) {
    if (!this.enabled) return;
    this.pool.spawn(...args);
    this._wake();
  }

  _wake() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this._frame);
  }

  frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const alive = this.pool.step(dt);
    const { ctx, pool } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!alive) {
      this.running = false;
      return;
    }
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < pool.capacity; i++) {
      const l = pool.life[i];
      if (l <= 0) continue;
      const f = l / pool.max[i];
      ctx.globalAlpha = f < 0.5 ? f * 2 : 1;
      ctx.fillStyle = this.styles[pool.colour[i]];
      const s = pool.size[i] * (0.5 + 0.5 * f);
      ctx.fillRect(pool.x[i] - s / 2, pool.y[i] - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    requestAnimationFrame(this._frame);
  }

  clear() {
    this.pool.clear();
  }
}
