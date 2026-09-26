// Game sound effects (docs/research.md §3, Thumper-style audio juice):
//   hit     a short pluck, pitched by column and by how full the column is,
//           quantised to the next 1/16 of the song's beat grid
//   cash-in a chord stab that grows with the match
//   power   the chord an octave up, with the fifth doubled
//   grey    a muted thud, and the music dips 3 dB for 150 ms
//
// Sounds are synthesised once into AudioBuffers (pure functions below, so
// Node tests them) and played through one gain bus. Scheduling is in song
// time: song time s plays at context time songStart + s, the same mapping
// the music uses, so quantised hits land on the music's grid.
//
// Live mode has no fixed grid (setSong(null)): hits play at once, the
// music is never ducked (the video's sound is not ours to touch), and
// onPlay reports each sound's context time so the live tracker can keep
// the game's own sounds out of what it hears.

import { gridPosition, gridTime } from './songmap.js';

/** Minor pentatonic intervals in semitones; forgiving over most songs. */
const SCALE = [0, 3, 5, 7, 10];
const ROOT = 220; // A3

/** Frequency of scale degree d (0-based, climbs through octaves). */
export function scaleFreq(degree, root = ROOT) {
  const oct = Math.floor(degree / SCALE.length), i = degree - oct * SCALE.length;
  return root * Math.pow(2, oct + SCALE[i] / 12);
}

/** Hit pitch: columns sit two degrees apart, and each block already in the column lifts it one. */
export function hitDegree(column, height) {
  return column * 2 + Math.max(0, height - 1);
}

/**
 * The next 1/`division` beat-grid time at or after `t` (and at or after
 * `notBefore`, the earliest time audio can still be scheduled). Within
 * `snap` seconds after a grid point, the hit counts as on it and is
 * played right away (at `t`), so on-beat hits never wait a whole step.
 */
export function quantize(grid, t, notBefore = -Infinity, division = 4, snap = 0.012) {
  const pos = gridPosition(grid, t) * division;
  const prev = Math.floor(pos + 1e-9);
  const tPrev = gridTime(grid, prev / division);
  if (t - tPrev <= snap && t >= notBefore) return t;
  let q = Math.ceil(pos - 1e-9);
  let tq = gridTime(grid, q / division);
  while (tq < notBefore) tq = gridTime(grid, ++q / division);
  return tq;
}

/** Bright pluck: decaying harmonics with a soft attack. */
export function synthPluck(freq, sampleRate, seconds = 0.32) {
  const n = Math.round(seconds * sampleRate), out = new Float32Array(n);
  const attack = 0.002 * sampleRate;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (let k = 1; k <= 6; k++) v += Math.sin(2 * Math.PI * freq * k * t) * Math.exp(-t * (9 + 7 * k)) / k;
    out[i] = v * Math.min(1, i / attack);
  }
  return normalize(out, 0.8);
}

/** Chord stab: detuned voices with a slower decay and darker harmonics. */
export function synthChord(freqs, sampleRate, seconds = 0.8) {
  const n = Math.round(seconds * sampleRate), out = new Float32Array(n);
  const attack = 0.004 * sampleRate;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (let f = 0; f < freqs.length; f++) {
      for (let d = -1; d <= 1; d += 2) {
        const fr = freqs[f] * (1 + d * 0.003);
        for (let k = 1; k <= 5; k++) v += Math.sin(2 * Math.PI * fr * k * t) / Math.pow(k, 1.6);
      }
    }
    out[i] = v * Math.exp(-t / 0.22) * Math.min(1, i / attack);
  }
  return normalize(out, 0.7);
}

/** Muted thud: a falling sine with a short filtered noise tick. Seeded, so deterministic. */
export function synthThud(sampleRate, seconds = 0.35) {
  const n = Math.round(seconds * sampleRate), out = new Float32Array(n);
  let phase = 0, noise = 0, seed = 0x7a11;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f = 45 + 75 * Math.exp(-t / 0.05);
    phase += (2 * Math.PI * f) / sampleRate;
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    noise += ((seed / 4294967296) * 2 - 1 - noise) * 0.08; // one-pole lowpass
    out[i] = Math.sin(phase) * Math.exp(-t / 0.12) + noise * 2.5 * Math.exp(-t / 0.02);
  }
  return normalize(out, 0.85);
}

function normalize(buf, peak) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
  if (m > 0) for (let i = 0; i < buf.length; i++) buf[i] *= peak / m;
  return buf;
}

/** Plays the effects on an AudioContext. `music` is the music bus gain to duck. */
export class Sfx {
  constructor(context, music = null) {
    this.context = context;
    this.music = music;
    this.bus = context.createGain();
    this.bus.gain.value = 0.32;
    this.bus.connect(context.destination);
    this.enabled = true;
    this.grid = null;
    this.songStart = 0;
    this._buffers = new Map();
    this._lastAt = -1;
    this._lastKey = -1;
    this.onPlay = null;
  }

  /** Use a song's beat grid (makeGrid) and the context time song time 0 plays at. */
  setSong(grid, songStart) {
    this.grid = grid;
    this.songStart = songStart;
    this._lastAt = -1;
  }

  _buffer(key, make) {
    let b = this._buffers.get(key);
    if (!b) {
      const data = make(this.context.sampleRate);
      b = this.context.createBuffer(1, data.length, this.context.sampleRate);
      b.copyToChannel(data, 0);
      this._buffers.set(key, b);
    }
    return b;
  }

  /** Build every buffer up front (loading screen), so no hit synthesises during play. */
  prepare() {
    for (let d = 0; d <= hitDegree(2, 7); d++) this._buffer(`p${d}`, (sr) => synthPluck(scaleFreq(d), sr));
    for (let s = 0; s < 3; s++) this._buffer(`c${s}`, (sr) => synthChord(chordFreqs(s), sr));
    this._buffer('pb', (sr) => synthChord([ROOT * 2, scaleFreq(3) * 2, ROOT * 4, scaleFreq(3) * 4], sr, 1.1));
    this._buffer('thud', (sr) => synthThud(sr));
  }

  /** Song time of the earliest schedulable moment. */
  _now() {
    return this.context.currentTime + 0.005 - this.songStart;
  }

  _play(buffer, songTime, gain = 1) {
    if (!this.enabled || this.context.state !== 'running') return;
    const src = this.context.createBufferSource();
    src.buffer = buffer;
    let out = this.bus;
    if (gain !== 1) {
      out = this.context.createGain();
      out.gain.value = gain;
      out.connect(this.bus);
    }
    src.connect(out);
    src.start(this.songStart + songTime);
    if (this.onPlay) this.onPlay(this.songStart + songTime);
  }

  /** When a sound in song time t plays: the next grid step, or right away without a grid. */
  _at(songTime) {
    return this.grid ? quantize(this.grid, songTime, this._now()) : this._now();
  }

  /** A colour block landed in `column` (0–2), which now holds `height` blocks. */
  hit(column, height, songTime) {
    const at = this._at(songTime);
    const d = hitDegree(column, height);
    if (at === this._lastAt && d === this._lastKey) return; // one voice per note per step
    this._lastAt = at;
    this._lastKey = d;
    this._play(this._buffer(`p${d}`, (sr) => synthPluck(scaleFreq(d), sr)), at, 0.9);
  }

  /** A match of `count` blocks cashed in. */
  cashIn(count, songTime) {
    const size = count >= 12 ? 2 : count >= 6 ? 1 : 0;
    this._play(this._buffer(`c${size}`, (sr) => synthChord(chordFreqs(size), sr)), this._at(songTime));
  }

  power(songTime) {
    this._play(this._buffer('pb', (sr) => synthChord([ROOT * 2, scaleFreq(3) * 2, ROOT * 4, scaleFreq(3) * 4], sr, 1.1)), this._at(songTime));
  }

  /** A grey (or spike) hit: a thud now, and the music dips 3 dB for 150 ms. */
  grey() {
    if (!this.enabled || this.context.state !== 'running') return;
    this._play(this._buffer('thud', (sr) => synthThud(sr)), this._now(), 1.2);
    if (this.music) {
      const g = this.music.gain, now = this.context.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0.708, now + 0.015);
      g.setValueAtTime(0.708, now + 0.15);
      g.linearRampToValueAtTime(1, now + 0.2);
    }
  }
}

/** Chord for a match size: a minor triad, then a seventh, then an octave on top. */
function chordFreqs(size) {
  const f = [scaleFreq(0), scaleFreq(1), scaleFreq(3)];
  if (size >= 1) f.push(scaleFreq(4));
  if (size >= 2) f.push(scaleFreq(5));
  return f;
}
