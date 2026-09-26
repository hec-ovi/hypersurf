// Song playback for files and the demo: the decoded AudioBuffer plays
// through an AudioBufferSourceNode (never an <audio> element), so analysis
// and playback share one timeline, and the SongClock reads what the
// listener hears from getOutputTimestamp. Game logic runs on that clock.

import { SongClock } from './clock.js';

export class SongPlayer {
  /** @param {AudioContext} context */
  constructor(context) {
    this.context = context;
    this.gain = context.createGain();
    this.gain.connect(context.destination);
    this.clock = new SongClock(context);
    this.source = null;
    this.startAt = 0;
  }

  /** Latency calibration in seconds (positive when audio is heard late). */
  set offset(seconds) {
    this.clock.offset = seconds;
  }

  /**
   * Play `buffer` so that song time 0 is heard `leadIn` seconds from now.
   * Song time runs from -leadIn during the lead-in.
   */
  play(buffer, leadIn = 3) {
    this.stop();
    const ctx = this.context;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);
    this.startAt = ctx.currentTime + leadIn;
    src.start(this.startAt);
    this.clock.start(this.startAt);
    this.source = src;
  }

  stop() {
    if (!this.source) return;
    try {
      this.source.stop();
    } catch { /* never started */ }
    this.source.disconnect();
    this.source = null;
  }

  /** Smoothed, monotonic song time in seconds. */
  time() {
    return this.clock.read();
  }

  pause() {
    return this.context.state === 'running' ? this.context.suspend() : Promise.resolve();
  }

  resume() {
    return this.context.state === 'suspended' ? this.context.resume() : Promise.resolve();
  }
}

/** Copy an AudioBuffer's channels (the copies are transferred to the worker). */
export function copyChannels(buffer) {
  const out = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c).slice());
  return out;
}

/** An AudioBuffer from Float32Array channels. */
export function toAudioBuffer(context, channels, sampleRate) {
  const buf = context.createBuffer(channels.length, channels[0].length, sampleRate);
  for (let c = 0; c < channels.length; c++) buf.copyToChannel(channels[c], c);
  return buf;
}
