// Song clock: the song time the player is hearing right now.
//
// heard = ts.contextTime + (now − ts.performanceTime) / 1000 − songStart
// with ts = context.getOutputTimestamp(). contextTime already is the frame
// the output device is playing, so outputLatency is NOT subtracted again;
// it is only used as a fallback while the timestamp has no performanceTime
// (before the first rendered block, and right after a resume, when Chrome
// reports the current contextTime with a performanceTime of 0) or an old
// one (more than half a second: the device has not reported since).
// The raw value jitters by a render quantum, so it is tracked by a
// first-order loop at wall-clock rate, snapped on large jumps, and never
// allowed to run backwards between explicit starts or seeks.

export class SongClock {
  /**
   * @param {AudioContext} context
   * @param {{ now?: () => number, gain?: number, snap?: number }} [options]
   *   now: milliseconds (performance.now by default); gain: correction per
   *   read; snap: error in seconds beyond which the clock jumps to the raw value.
   */
  constructor(context, { now = () => performance.now(), gain = 0.1, snap = 0.1 } = {}) {
    this.context = context;
    this.now = now;
    this.gain = gain;
    this.snap = snap;
    this.songStart = 0; // context time at which song time 0 is heard
    this.offset = 0; // user latency calibration, seconds (positive = hear later)
    this.estimate = 0;
    this.lastMs = 0;
    this.lastOut = -Infinity;
    this.started = false;
  }

  /** Song time 0 plays at context time `contextTime` (as passed to source.start). */
  start(contextTime) {
    this.songStart = contextTime;
    this.started = false;
    this.lastOut = -Infinity;
  }

  /** Raw heard time, unsmoothed. */
  raw(nowMs = this.now()) {
    const ctx = this.context;
    const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    // A suspended context's timestamp is stale; do not extrapolate it by wall time.
    const running = ctx.state === undefined || ctx.state === 'running';
    let heard;
    const fresh = ts && ts.performanceTime > 0 && (!running || nowMs - ts.performanceTime < 500);
    if (fresh) heard = ts.contextTime + (running ? (nowMs - ts.performanceTime) / 1000 : 0);
    else heard = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    return heard - this.songStart - this.offset;
  }

  /** Smoothed, monotonic song time in seconds. */
  read() {
    const nowMs = this.now();
    const raw = this.raw(nowMs);
    if (!this.started) {
      this.estimate = raw;
      this.started = true;
    } else {
      const running = this.context.state === undefined || this.context.state === 'running';
      const predicted = this.estimate + (running ? (nowMs - this.lastMs) / 1000 : 0);
      const err = raw - predicted;
      this.estimate = Math.abs(err) > this.snap ? raw : predicted + this.gain * err;
    }
    this.lastMs = nowMs;
    if (this.estimate > this.lastOut) this.lastOut = this.estimate;
    return this.lastOut;
  }
}
