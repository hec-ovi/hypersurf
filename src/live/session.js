// A live session: one MediaStream (the shared tab, or ?live=demo's own
// output) listened to for one run. It owns the audio graph (stream →
// hop-collecting worklet → a muted gain), runs the click calibration, and
// turns every hop into song time for the tracker, the intensity meter and
// the live map.
//
// Calibration waits until the capture is delivering steadily (a shared
// tab's audio can take a moment to start flowing, and clicks played
// before that are lost), plays the click train, and tries once more
// louder if it was not heard. If that fails too, the delay stays at a
// typical value (or the one this browser measured before), and the
// player can nudge it.
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
import { ClickListener, DriftWatch, clickTimes, synthClick, trainSpan, CALIBRATION } from './calibrate.js';

export const SESSION = Object.freeze({
  // Seconds, when calibration hears nothing: a typical tab-capture delay
  // plus the onset front end's framing. The player can nudge it.
  defaultLatency: 0.06,
  nudge: 0.005, // seconds per step of the player's timing control
  flowing: 0.3, // seconds of steady capture before the clicks play
  flowTimeout: 3, // seconds to wait for the capture to start delivering
  clickLead: 0.25, // first click this long after the calibration starts
  clickGain: 0.6,
  retryGain: 1, // the second try, when the first was not heard
  recalibrateGain: 0.25, // mid-song clicks, under the music (no retry)
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
  constructor(context, stream, { clickBus = null, latency = SESSION.defaultLatency, flowTimeout = SESSION.flowTimeout } = {}) {
    this.context = context;
    this.stream = stream;
    this.clickBus = clickBus;
    this.sampleRate = context.sampleRate;
    this.latency = latency;
    this.calibration = null; // last result: { latency, lag, found, spread, psr } or null
    this.calibrations = 0; // click trains played
    this.pending = null; // calibration in progress (a promise)
    this.closed = false;
    this.flow = { since: -Infinity, last: -Infinity, waiters: [], timeout: flowTimeout };
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
    this.closed = true;
    if (this.node) {
      this.node.port.onmessage = null;
      this.source.disconnect();
      this.node.disconnect();
      this.mute.disconnect();
    }
    this.node = this.source = this.mute = null;
    if (this.listening) this._finishTrain(null);
    this._settleFlow(false);
  }

  /**
   * Measure the capture latency: wait for the capture to flow, play the
   * click train, and (unless `retry` is off) play it once more, louder,
   * if it was not heard. Resolves with { latency, lag, found, spread, psr }
   * (and adopts it) or null (keeps the current latency). Mid-song the
   * clicks are quieter and kept out of the tracker.
   */
  calibrate({ gain = SESSION.clickGain, retry = true } = {}) {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      let r = null;
      if (await this.whenFlowing()) {
        r = await this._train(gain);
        if (!r && retry && !this.closed) r = await this._train(Math.max(gain, SESSION.retryGain));
      }
      this.lastCalibration = this.context.currentTime;
      if (r) {
        this.setLatency(r.latency);
        this.calibration = r;
      }
      this.pending = null;
      return r;
    })();
    return this.pending;
  }

  /**
   * Resolves true once hops have arrived steadily for SESSION.flowing
   * seconds, or false after the flow timeout (or when the session closes).
   */
  whenFlowing() {
    const f = this.flow;
    if (f.last - f.since >= SESSION.flowing) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = { resolve, timer: 0 };
      w.timer = setTimeout(() => {
        f.waiters.splice(f.waiters.indexOf(w), 1);
        resolve(false);
      }, f.timeout * 1000);
      f.waiters.push(w);
    });
  }

  _settleFlow(ok) {
    const ws = this.flow.waiters;
    while (ws.length) {
      const w = ws.pop();
      clearTimeout(w.timer);
      w.resolve(ok);
    }
  }

  /** The capture latency in seconds, from calibration or the player's nudges. */
  setLatency(latency) {
    const v = Math.max(0, Math.min(CALIBRATION.maxLatency, latency));
    // A later capture means every hop was heard earlier than we thought.
    this.songAtZero -= v - this.latency;
    this.latency = v;
  }

  /** One click train: resolves with the measurement or null. */
  _train(gain) {
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
    const span = trainSpan();
    const listening = {
      listener: new ClickListener(this.sampleRate, SESSION.clickLead + span + 0.5), clicks, end: clicks[0] + span, level, measuring: false,
    };
    listening.promise = new Promise((resolve) => { listening.resolve = resolve; });
    // Never wait forever: a stream that stopped delivering ends it too.
    listening.timer = setTimeout(() => this._measure(listening), (clicks[0] + span - ctx.currentTime + 1.5) * 1000);
    this.listening = listening;
    this.calibrations++;
    return listening.promise;
  }

  /** The train is in (or the wait is over): measure it a slice at a time, off the audio path. */
  _measure(l) {
    if (l.measuring || this.listening !== l) return;
    l.measuring = true;
    clearTimeout(l.timer);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
    l.listener.measureAsync(l.clicks, pause).then((r) => this._finishTrain(r), () => this._finishTrain(null));
  }

  _finishTrain(result) {
    const l = this.listening;
    if (!l) return;
    this.listening = null;
    clearTimeout(l.timer);
    try { l.level.disconnect(); } catch { /* already */ }
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
    const f = this.flow, dur = samples.length / this.sampleRate;
    if (c - f.last > 0.1) f.since = c; // the first hop, or one after a gap
    f.last = c + dur;
    if (f.waiters.length && f.last - f.since >= SESSION.flowing) this._settleFlow(true);
    const l = this.listening;
    if (l && !l.measuring) {
      l.listener.push(samples, c);
      if (c >= l.end) this._measure(l);
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
      if (d !== 0 && !this.pending && this.context.currentTime - this.lastCalibration >= SESSION.recalibrateEvery) this.calibrate({ gain: SESSION.recalibrateGain, retry: false });
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
      psr: this.calibration ? Math.round(this.calibration.psr) : 0,
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
