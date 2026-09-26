// Visual juice with a photosensitivity guard. Pure; no DOM/GPU.
//
// Every bright, full-screen-ish change (beat pulses on the track, bloom
// bursts on hits, cash-ins and power blocks) asks one shared FlashLimiter
// first, so the whole game never flashes more than 3 times a second
// (WCAG 2.3.1). "Calm visuals" turns beat pulses off and scales bursts down.

/** Allows at most `max` flashes in any window of `window` seconds. */
export class FlashLimiter {
  constructor(max = 3, window = 1) {
    this.max = max;
    this.window = window;
    this.times = new Float64Array(max).fill(-Infinity);
    this.next = 0; // ring index of the oldest flash
    this.allowed = 0;
    this.denied = 0;
  }

  reset() {
    this.times.fill(-Infinity);
    this.next = 0;
  }

  /** Whether a flash may start at time `now` (seconds); records it if so. */
  tryFlash(now) {
    if (now - this.times[this.next] < this.window) {
      this.denied++;
      return false;
    }
    this.times[this.next] = now;
    this.next = (this.next + 1) % this.max;
    this.allowed++;
    return true;
  }
}

/**
 * Decaying envelopes for the renderer: beat pulse, bloom burst, FOV punch,
 * ship flash, desaturation. Each is a value that jumps up when triggered
 * and decays exponentially; update() runs once per frame.
 */
export class Juice {
  constructor(limiter = new FlashLimiter()) {
    this.limiter = limiter;
    this.calm = false;
    this.beat = 0; // track beat pulse 0..1
    this.bloom = 0; // extra bloom strength
    this.fov = 0; // extra degrees
    this.ship = 0; // ship emissive flash 0..1
    this.desaturate = 0; // 0..1
    this.kick = 0; // camera kick, metres
    this._lastBeat = -1;
  }

  reset() {
    this.beat = this.bloom = this.fov = this.ship = this.desaturate = this.kick = 0;
    this._lastBeat = -1;
    this.limiter.reset();
  }

  /** A beat at index `beatIndex` was heard at song time `now`. */
  onBeat(beatIndex, now, intensity) {
    if (beatIndex === this._lastBeat) return;
    this._lastBeat = beatIndex;
    if (this.calm) return;
    if (this.limiter.tryFlash(now)) this.beat = 0.3 + 0.7 * intensity;
  }

  /** Bloom burst (block hit +0.25, power +0.6), gated by the limiter. */
  burst(amount, now) {
    const a = this.calm ? amount * 0.3 : amount;
    if (this.limiter.tryFlash(now)) this.bloom = Math.min(1.2, this.bloom + a);
  }

  hit() {
    this.ship = 1;
    this.kick = 0.08;
  }

  power() {
    this.fov = 8;
  }

  grey() {
    this.desaturate = 1;
  }

  /** Decay everything over dt seconds (time constants from docs/research.md §4). */
  update(dt) {
    this.beat *= Math.exp(-dt / 0.12);
    this.bloom *= Math.exp(-dt / 0.15);
    this.fov *= Math.exp(-dt / 0.3);
    this.ship *= Math.exp(-dt / 0.08);
    this.desaturate *= Math.exp(-dt / 0.15);
    this.kick *= Math.exp(-dt / 0.1);
  }
}
