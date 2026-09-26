// The menu backdrop (docs/art-direction.md §6.1): a particle-wave terrain
// along the bottom and faint twinkling stars, on a 2D canvas (#sky) at
// 30 fps at most. The game renderer owns the GPU, so this is plain canvas.
// It runs only while a menu screen is up and the tab is visible; under
// calm visuals or reduced motion it draws one frame and stops.

const COLS = 90;
const ROWS = 64;
const STARS = 160;
const HORIZON = 0.58; // horizon height as a fraction of the screen
const Z_NEAR = 2.2;
const Z_FAR = 34;
const CAM_H = 2.4;
const WAVE = 0.15; // rad/s

/** Terrain height at world (x, z) and time t: two sine octaves and a slow swell. */
export function terrainHeight(x, z, t) {
  const p = t * WAVE;
  return 0.55 * Math.sin(x * 0.18 + z * 0.21 + p * 2.1)
    + 0.28 * Math.sin(x * 0.41 - z * 0.33 - p * 3.3 + 1.7)
    + 0.35 * Math.sin(x * 0.05 + z * 0.07 + p) * Math.cos(z * 0.045 - p * 0.6);
}

export class TerrainSky {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.on = false;
    this.still = false;
    this.last = 0;
    this.t = 0;
    // Jittered grid, fixed at construction (world units).
    const n = COLS * ROWS;
    this.jx = new Float32Array(n);
    this.jz = new Float32Array(n);
    this.sz = new Float32Array(n);
    let s = 12345;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < n; i++) {
      this.jx[i] = rnd() - 0.5;
      this.jz[i] = rnd() - 0.5;
      this.sz[i] = 1 + rnd() * 0.6;
    }
    this.star = new Float32Array(STARS * 4); // x, y (fractions), phase, rate
    for (let i = 0; i < STARS; i++) {
      this.star[i * 4] = rnd();
      this.star[i * 4 + 1] = rnd() * 0.55;
      this.star[i * 4 + 2] = rnd() * Math.PI * 2;
      this.star[i * 4 + 3] = (0.2 + rnd() * 0.4) * Math.PI * 2;
    }
    this.crest = new Float32Array(COLS * 3);
    this.rowStyle = [];
    this.rowStyleHi = [];
    for (let r = 0; r < ROWS; r++) {
      const f = r / (ROWS - 1); // 0 near → 1 far
      const a = 0.55 - 0.43 * f;
      this.rowStyle.push(`rgba(120,225,218,${a.toFixed(3)})`);
      this.rowStyleHi.push(`rgba(143,247,238,${Math.min(0.6, a + 0.15).toFixed(3)})`);
    }
    this._frame = (now) => this.frame(now);
    this.resize();
    addEventListener('resize', () => { this.resize(); if (this.on) this.draw(); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.on && !this.still) this._loop();
    });
  }

  resize() {
    this.dpr = Math.min(1.5, devicePixelRatio || 1);
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /** Show and animate (or draw once when still). */
  start(still = false) {
    this.still = still;
    if (this.on) {
      if (still) this.draw();
      return;
    }
    this.on = true;
    this.draw();
    if (!still) this._loop();
  }

  stop() {
    this.on = false;
  }

  _loop() {
    this.last = performance.now();
    requestAnimationFrame(this._frame);
  }

  frame(now) {
    if (!this.on || this.still || document.hidden) return;
    requestAnimationFrame(this._frame);
    if (now - this.last < 32) return; // 30 fps
    this.t += Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.draw();
  }

  draw() {
    const { ctx, w, h, t } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // Stars in the upper 55%.
    ctx.fillStyle = '#cffaf5';
    const st = this.star;
    for (let i = 0; i < STARS; i++) {
      const tw = 0.5 + 0.5 * Math.sin(st[i * 4 + 2] + t * st[i * 4 + 3]);
      ctx.globalAlpha = 0.15 + 0.35 * tw;
      ctx.fillRect(st[i * 4] * w, st[i * 4 + 1] * h, 1, 1);
    }
    ctx.globalAlpha = 1;
    // Terrain: rows far to near, perspective-projected.
    const hy = h * HORIZON;
    const f = (h - hy) * Z_NEAR / CAM_H * 1.45; // focal length: the nearest row sits near the bottom
    const scroll = t * 1.2;
    for (let r = ROWS - 1; r >= 0; r--) {
      const zr = Z_NEAR + (Z_FAR - Z_NEAR) * (r / (ROWS - 1)) ** 1.15;
      const span = (w / 2) * zr / f * 1.08;
      ctx.fillStyle = this.rowStyle[r];
      let nHi = 0;
      const crest = this.crest;
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c;
        const z = zr + this.jz[i] * 0.6;
        const x = ((c + 0.5) / COLS - 0.5) * 2 * span + this.jx[i] * span * 0.03;
        const y = terrainHeight(x, z + scroll, t);
        const sx = w / 2 + (x * f) / z;
        const sy = hy + ((CAM_H - y * 1.5) * f) / z * 0.62;
        if (sy < hy || sy > h) continue;
        const s = this.sz[i] * (r < 16 ? 1.25 : 1);
        if (y > 0.72) { crest[nHi * 3] = sx; crest[nHi * 3 + 1] = sy; crest[nHi * 3 + 2] = s; nHi++; continue; }
        ctx.fillRect(sx, sy, s, s);
      }
      // Ridge crests, slightly brighter, in one style change per row.
      if (nHi) {
        ctx.fillStyle = this.rowStyleHi[r];
        for (let k = 0; k < nHi; k++) ctx.fillRect(crest[k * 3], crest[k * 3 + 1], crest[k * 3 + 2], crest[k * 3 + 2]);
      }
    }
  }
}
