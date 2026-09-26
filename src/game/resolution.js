// Dynamic resolution governor. Pure; no DOM/GPU, so it is tested in Node.
//
// The display's frame interval is estimated as the fastest sustained
// frame-time average (it drifts up slowly so a refresh-rate change is
// followed). Anything slower than 50 Hz is taken as a slow GPU rather than
// a slow display, so the target never drops below 60 fps. The scale steps
// down by 0.1 when frames run 30% over the target and steps back up only
// after 8 s at full rate, so it does not oscillate. Stuck at the lowest
// scale and still slow for 5 s, it sets `lowerRequested` once, so the game
// can drop to the low quality tier.

export class ResolutionGovernor {
  constructor({ minScale = 0.6 } = {}) {
    this.minScale = minScale;
    this.scale = 1;
    this.frameMsEma = 1000 / 60;
    this.refreshMs = 0;
    this.lastChange = 0;
    this.slowSince = -1;
    this.lowerRequested = false;
    this.lowered = false;
  }

  /** The frame interval the governor aims for. */
  get targetMs() {
    return this.refreshMs > 0 && this.refreshMs <= 21 ? this.refreshMs : 1000 / 60;
  }

  /** Feed one frame interval. Returns true when the scale changed. */
  update(frameMs, nowMs) {
    if (!(frameMs > 0 && frameMs < 250)) return false; // tab switches, breakpoints
    this.frameMsEma += (frameMs - this.frameMsEma) * 0.05;
    this.refreshMs = Math.min((this.refreshMs || this.frameMsEma) + 0.002, this.frameMsEma);
    const target = this.targetMs;
    const slow = this.frameMsEma > target * 1.3 + 1;
    const atFloor = this.scale <= this.minScale + 1e-6;
    if (slow && atFloor && !this.lowered) {
      if (this.slowSince < 0) this.slowSince = nowMs;
      else if (nowMs - this.slowSince > 5000) this.lowerRequested = true;
    } else this.slowSince = -1;
    const since = nowMs - this.lastChange;
    if (since < 2000) return false;
    let next = this.scale;
    if (slow && !atFloor) next = Math.max(this.minScale, Math.round((this.scale - 0.1) * 10) / 10);
    else if (this.frameMsEma < target * 1.1 && this.scale < 1 && since > 8000) next = Math.min(1, Math.round((this.scale + 0.1) * 10) / 10);
    if (next === this.scale) return false;
    this.scale = next;
    this.lastChange = nowMs;
    return true;
  }

  /**
   * Pick a starting scale from a GPU-synced frame cost measured at scale 1
   * on the loading screen, so a weak GPU does not spend its first seconds
   * of play (the swoop-in) far over budget. Frame cost is taken as
   * proportional to pixel count (scale²), aiming at 80% of the target.
   * Returns whether even the floor would be too slow (a hint to start on
   * the low tier). The in-play governor still corrects either way.
   */
  calibrate(msAtFull) {
    if (!(msAtFull > 0 && Number.isFinite(msAtFull))) return false;
    const budget = this.targetMs * 0.8;
    let s = 1;
    while (s > this.minScale + 1e-6 && msAtFull * s * s > budget) s = Math.max(this.minScale, Math.round((s - 0.1) * 10) / 10);
    this.scale = s;
    return msAtFull * this.minScale * this.minScale > budget;
  }

  /** The game switched to the low tier: never ask again; start from full scale. */
  acknowledgeLower(minScale) {
    this.lowerRequested = false;
    this.lowered = true;
    this.minScale = minScale;
    this.scale = 1;
    this.slowSince = -1;
  }

  /** Forget the frame-time history after a pause or a state change. */
  reset(nowMs) {
    this.frameMsEma = this.refreshMs || 1000 / 60;
    this.lastChange = nowMs;
    this.slowSince = -1;
  }
}
