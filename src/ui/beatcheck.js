// The beat check lane under the latency slider (docs/art-direction.md
// §7.4.1): while the latency row has focus, soft clicks play at 120 BPM
// through the normal output, and a diamond crosses the target line at each
// click's output time plus the latency setting. The player moves the
// slider until the click sounds as the diamond crosses.

const PERIOD = 0.5; // 120 BPM
const TARGET = 0.7; // target line at 70% of the lane
const AHEAD = 0.25; // schedule clicks this far ahead (s)

export class BeatCheck {
  /**
   * @param root   the .beatcheck element
   * @param audio  () => AudioContext or null
   * @param latencyMs () => the latency setting
   * @param calm   () => whether calm visuals is on (no flash)
   */
  constructor(root, { audio, latencyMs, calm }) {
    this.root = root;
    this.lane = root.querySelector('.lane');
    this.runner = root.querySelector('.runner');
    this.beat = root.querySelector('.beat');
    this.audio = audio;
    this.latencyMs = latencyMs;
    this.calm = calm;
    this.on = false;
    this.next = 0; // context time of the next click to schedule
    this.clicks = []; // context times scheduled
    this._frame = (now) => this.frame(now);
  }

  start() {
    if (this.on) return;
    this.on = true;
    this.root.classList.add('on');
    this.width = this.lane.clientWidth;
    this.t0 = performance.now();
    const ctx = this.audio();
    this.next = ctx ? ctx.currentTime + 0.15 : 0;
    this.clicks.length = 0;
    requestAnimationFrame(this._frame);
  }

  stop() {
    this.on = false;
    this.root.classList.remove('on');
  }

  /** performance.now() time at which context time t is heard. */
  _heard(ctx, t) {
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime) return ts.performanceTime + (t - ts.contextTime) * 1000;
    return performance.now() + (t - ctx.currentTime + (ctx.outputLatency || 0)) * 1000;
  }

  _click(ctx, at) {
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.frequency.value = 1320;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.18, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    osc.connect(g).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.06);
  }

  frame(now) {
    if (!this.on) return;
    requestAnimationFrame(this._frame);
    const ctx = this.audio();
    const lat = this.latencyMs();
    let phase;
    if (ctx && ctx.state === 'running') {
      while (this.next < ctx.currentTime + AHEAD) {
        if (this.next < ctx.currentTime) this.next = ctx.currentTime + 0.05;
        this._click(ctx, this.next);
        this.clicks.push(this.next);
        this.next += PERIOD;
      }
      while (this.clicks.length > 4) this.clicks.shift();
      // The diamond is at the target when a click is heard + latency.
      const ref = this.clicks[0];
      const crossMs = this._heard(ctx, ref) + lat;
      phase = ((now - crossMs) / 1000 / PERIOD) % 1;
      if (phase < 0) phase += 1;
      // Flash the beat diamond as each click is heard.
      let flash = false;
      for (const c of this.clicks) {
        const d = now - this._heard(ctx, c);
        if (d >= 0 && d < 90) flash = true;
      }
      this.beat.classList.toggle('flash', flash && !this.calm());
    } else {
      phase = (((now - this.t0) / 1000) / PERIOD) % 1;
    }
    // phase 0 = at the target; the diamond enters from the left.
    const f = (TARGET + phase) % 1;
    this.runner.style.setProperty('--x', `${(f * this.width).toFixed(1)}px`);
  }
}
