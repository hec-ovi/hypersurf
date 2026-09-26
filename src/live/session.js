// A live session: one MediaStream (the shared tab, or ?live=demo's own
// output) listened to for one run. It owns the audio graph (stream →
// hop-collecting worklet → a muted gain), runs the click calibration, and
// turns every hop into song time for the tracker, the intensity meter and
// the live map.
//
// Time. A hop's first sample reaches the worklet at context time c; it was
// heard at c − latency (the calibrated capture delay). The run's clock
// maps heard context time to song time (LiveClock: a SongClock minus an
// offset that grows while the source is held). The tracker keeps its own
// sample-counted time, so the session keeps the song time of the
// tracker's zero, nudging it to follow the clock and restarting the
// tracker when the two part (a seek).

import { BeatTracker } from './tracker.js';
import { LiveIntensity } from './intensity.js';
import { ClickListener, DriftWatch, clickTimes, synthClick } from './calibrate.js';

export const SESSION = Object.freeze({
  defaultLatency: 0.03, // seconds, when calibration hears nothing
  clickLead: 0.3, // first click this long after the calibration starts
  listenAfter: 0.45, // keep listening this long after the last click
  clickGain: 0.5,
  recalibrateGain: 0.2, // mid-song clicks, under the music
  recalibrateEvery: 30, // seconds at least between mid-song calibrations
  resync: 0.1, // song-time disagreement that restarts the tracker
});

const loaded = new WeakSet();

/**
 * Song time of the run: a SongClock (heard context time minus its start
 * and the user's latency offset) minus an offset that grows while the run
 * is held, so song time stops while the video pauses or buffers.
 */
export class LiveClock {
  constructor(clock) {
    this.clock = clock;
    this.K = 0;
    this.held = false;
    this.frozen = 0;
  }

  /** Song time t now, running. */
  start(t) {
    this.K = this.clock.read() - t;
    this.held = false;
  }

  hold() {
    if (this.held) return;
    this.frozen = this.time();
    this.held = true;
  }

  run() {
    if (!this.held) return;
    this.held = false;
    this.K = this.clock.read() - this.frozen;
  }

  get running() {
    return !this.held;
  }

  time() {
    return this.held ? this.frozen : this.clock.read() - this.K;
  }

  /** Song time of heard context time h. */
  songOfHeard(h) {
    return h - this.clock.songStart - this.clock.offset - this.K;
  }
}

export class LiveSession {
  /**
   * @param context  the game's AudioContext
   * @param stream   audio MediaStream to listen to
   * @param clickBus where calibration clicks play: the speakers for a
   *                 shared tab (the capture hears them), or the bus that
   *                 feeds ?live=demo's stream
   */
  constructor(context, stream, { clickBus = null } = {}) {
    this.context = context;
    this.stream = stream;
    this.clickBus = clickBus;
    this.sampleRate = context.sampleRate;
    this.latency = SESSION.defaultLatency;
    this.calibration = null; // last result: { latency, found, spread } or null
    this.calibrations = 0;
    this.map = null;
    this.clock = null;
    this.tracker = new BeatTracker(this.sampleRate);
    this.intensity = new LiveIntensity(this.sampleRate);
    this.drift = new DriftWatch();
    this.listening = null; // calibration in progress: { listener, clicks, end, resolve }
    this.lastCalibration = -Infinity;
    this.grid = { anchor: NaN, period: 0.5, confidence: 0, hitRate: 0 };
    this._reset();
  }

  _reset() {
    this.tracker.reset();
    this.fed = 0; // samples fed to the tracker since its reset
    this.songAtZero = 0;
    this.ctxAtZero = 0;
    this.onsetsSeen = 0;
    this.beatsSeen = 0;
    this.drift.reset();
  }

  /** Build the audio graph. */
  async open() {
    const ctx = this.context;
    if (!loaded.has(ctx)) {
      await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
      loaded.add(ctx);
    }
    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'hypersurf-hops', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { hop: this.tracker.hop } });
    this.mute = ctx.createGain();
    this.mute.gain.value = 0; // the worklet outputs silence; this only keeps it pulled
    this.source.connect(this.node);
    this.node.connect(this.mute);
    this.mute.connect(ctx.destination);
    this.node.port.onmessage = (e) => {
      const { frame, samples } = e.data;
      this.feed(frame, samples);
      this.node.port.postMessage(samples, [samples.buffer]);
    };
    return this;
  }

  close() {
    this.running = false;
    if (this.node) {
      this.node.port.onmessage = null;
      this.source.disconnect();
      this.node.disconnect();
      this.mute.disconnect();
    }
    this.node = this.source = this.mute = null;
    if (this.listening) this._finishCalibration(null);
  }

  /**
   * Play the click train and measure the capture latency. Resolves with
   * { latency, found, spread } (and adopts it) or null (keeps the last
   * latency). Mid-song the clicks are quieter and kept out of the tracker.
   */
  calibrate({ gain = SESSION.clickGain } = {}) {
    if (this.listening) return this.listening.promise;
    const ctx = this.context, clicks = clickTimes(ctx.currentTime + SESSION.clickLead);
    const click = synthClick(this.sampleRate);
    const clickBuffer = ctx.createBuffer(1, click.length, this.sampleRate);
    clickBuffer.copyToChannel(click, 0);
    const level = ctx.createGain();
    level.gain.value = gain;
    level.connect(this.clickBus || ctx.destination);
    for (const t of clicks) {
      const src = ctx.createBufferSource();
      src.buffer = clickBuffer;
      src.connect(level);
      src.start(t);
      this.suppress(t);
    }
    const listening = { listener: new ClickListener(this.sampleRate), clicks, end: clicks[clicks.length - 1] + SESSION.listenAfter, level };
    listening.promise = new Promise((resolve) => { listening.resolve = resolve; });
    // Never wait forever: a stream that stopped delivering ends it too.
    listening.timer = setTimeout(() => this._finishCalibration(listening.listener.measure(clicks)), (clicks[clicks.length - 1] - ctx.currentTime + 2) * 1000);
    this.listening = listening;
    this.calibrations++;
    return listening.promise;
  }

  _finishCalibration(result) {
    const l = this.listening;
    if (!l) return;
    this.listening = null;
    clearTimeout(l.timer);
    try { l.level.disconnect(); } catch { /* already */ }
    this.lastCalibration = this.context.currentTime;
    if (result) {
      // A later capture means every hop was heard earlier than we thought.
      this.songAtZero -= result.latency - this.latency;
      this.latency = result.latency;
    }
    this.calibration = result;
    l.resolve(result);
  }

  /** Start listening for a run: song time comes from `clock` (a LiveClock); results go to `map`. */
  begin(map, clock) {
    this.map = map;
    this.clock = clock;
    map.setSkylineRate(this.tracker.frameRate);
    this._reset();
    this.intensity.reset();
    this.running = true;
  }

  /** The song jumped (a seek): forget the rhythm heard so far. */
  resync() {
    this._reset();
  }

  /** Keep our own sound at context time t (a hit effect) out of the beat tracking. */
  suppress(t) {
    if (this.fed > 0) this.tracker.suppress(t + this.latency - this.ctxAtZero);
  }

  /** One hop of captured audio whose first sample reached us at context frame `frame`. */
  feed(frame, samples) {
    const c = frame / this.sampleRate;
    const l = this.listening;
    if (l) {
      l.listener.push(samples, c);
      if (c >= l.end) this._finishCalibration(l.listener.measure(l.clicks));
    }
    if (!this.running || !this.clock || !this.clock.running) return;
    const song = this.clock.songOfHeard(c - this.latency);
    if (this.fed === 0) this.songAtZero = song;
    else {
      const diff = song - (this.songAtZero + this.fed / this.sampleRate);
      if (Math.abs(diff) > SESSION.resync) {
        this._reset();
        this.songAtZero = song;
      } else this.songAtZero += 0.02 * diff;
    }
    this.ctxAtZero = c - this.fed / this.sampleRate;
    this.tracker.push(samples);
    this.intensity.push(samples);
    this.fed += samples.length;
    this._drain();
  }

  /** Pass what the tracker found on to the live map. */
  _drain() {
    const tr = this.tracker, map = this.map, z = this.songAtZero;
    for (; this.onsetsSeen < tr.onsetCount; this.onsetsSeen++) {
      const i = this.onsetsSeen % 64;
      map.onset(tr.onsetTime[i] + z, tr.onsetStrength[i], tr.onsetBand[i]);
    }
    if (tr.n >= 0) map.skylineFrame(tr.time + z, tr.front.levels);
    // Confirmed beats feed the drift watch; a step in the capture delay re-runs the clicks.
    for (; this.beatsSeen < tr.resolved; this.beatsSeen++) {
      const ot = tr.beatOnset[this.beatsSeen % 64];
      if (!Number.isFinite(ot)) continue;
      const d = this.drift.add(this.beatsSeen, ot);
      if (d !== 0 && !this.listening && this.context.currentTime - this.lastCalibration >= SESSION.recalibrateEvery) this.calibrate({ gain: SESSION.recalibrateGain });
    }
  }

  /** The tracker's grid in song time. */
  get songGrid() {
    const g = this.grid, tg = this.tracker.grid;
    g.anchor = tg.anchor + this.songAtZero;
    g.period = tg.period;
    g.confidence = this.tracker.confidence;
    g.hitRate = this.tracker.hitRate;
    return g;
  }

  /** Advance the live map to song time `now` (once per frame). */
  update(now) {
    if (!this.map) return;
    this.map.update(now, this.songGrid, this.intensity.value, this.tracker.time + this.songAtZero);
  }

  /** Numbers for the debug overlay and automated checks. */
  get stats() {
    const m = this.map;
    return {
      latencyMs: Math.round(this.latency * 1000),
      calibrated: this.calibration ? this.calibration.found : 0,
      calibrations: this.calibrations,
      tempo: m && m.bpm ? Math.round(m.bpm * 10) / 10 : Math.round(this.tracker.bpm * 10) / 10,
      confidence: Math.round(this.tracker.confidence * 100) / 100,
      hitRate: Math.round(this.tracker.hitRate * 100) / 100,
      intensity: Math.round(this.intensity.value * 100) / 100,
      locked: m ? m.gate : false,
      blocks: m ? m.blocks.count : 0,
      ghosts: m ? m.stats.ghosts : 0,
      withdrawn: m ? m.stats.withdrawn : 0,
      powerBlocks: m ? m.stats.powerBlocks : 0,
    };
  }
}
