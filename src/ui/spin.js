// Pure motion for the selection stage (tested in Node): the turntable's
// spin, with drag and fling that ease back to the slow spin, and the swap
// transition between two options.

/** One turn per 24 s. */
export const BASE_SPIN = (Math.PI * 2) / 24;

export class Turntable {
  constructor(base = BASE_SPIN) {
    this.base = base;
    this.angle = 0;
    this.vel = base;
    this.dragging = false;
    this.still = false; // calm visuals: no idle spin (drag still works)
    this._lastX = 0;
    this._lastT = 0;
  }

  grab(x, t) {
    this.dragging = true;
    this._lastX = x;
    this._lastT = t;
    this.vel = 0;
  }

  /** Pointer moved to x (px) at t (s): the table follows, 0.01 rad per px. */
  drag(x, t) {
    if (!this.dragging) return;
    const dx = x - this._lastX, dt = Math.max(1e-3, t - this._lastT);
    this.angle += dx * 0.01;
    // Fling velocity, smoothed over the last few moves.
    this.vel = this.vel * 0.6 + (dx * 0.01 / dt) * 0.4;
    this._lastX = x;
    this._lastT = t;
  }

  release() {
    this.dragging = false;
    this.vel = Math.max(-12, Math.min(12, this.vel));
  }

  /** Advance dt seconds: momentum decays toward the idle spin. */
  step(dt) {
    if (this.dragging) return this.angle;
    const target = this.still ? 0 : this.base;
    this.vel = target + (this.vel - target) * Math.exp(-dt * 1.6);
    this.angle += this.vel * dt;
    return this.angle;
  }
}

/**
 * The swap between two options over `duration` s, split in an out half and
 * an in half. Returns { out, in } phases in 0..1 (out runs first, in second)
 * for elapsed time t, and whether it is done.
 */
export function swapPhase(t, duration = 0.42) {
  const half = duration / 2;
  const out = Math.max(0, Math.min(1, t / half));
  const inn = Math.max(0, Math.min(1, (t - half) / half));
  return { out, in: inn, done: t >= duration };
}

/** easeOutBack, for the incoming object. */
export function easeOutBack(t, s = 1.4) {
  const u = t - 1;
  return 1 + u * u * ((s + 1) * u + s);
}

/** Next option index for a step, clamped (no wrap) unless wrap. */
export function stepOption(index, dir, count, wrap = true) {
  const n = index + dir;
  if (wrap) return ((n % count) + count) % count;
  return Math.max(0, Math.min(count - 1, n));
}
