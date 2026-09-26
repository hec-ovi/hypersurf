// The built-in demo song: a seeded, deterministic 128 BPM track synthesised
// sample by sample in plain JavaScript. The same generator is the playable
// demo in the browser and the analysis fixture in Node, and it keeps its
// ground truth (note onsets, beats, sections, drops) for the tests.

import { mulberry32 } from './random.js';

export const DEMO_BPM = 128;
export const DEMO_SEED = 1;
const BEAT = 60 / DEMO_BPM;
const BAR = 4 * BEAT;
const SIXTEENTH = BEAT / 4;
const TAIL = 1.5; // seconds of decay after the last bar

/** Song form in bars: intro, build, drop, break (ending in a short roll), drop, outro. */
export const DEMO_FORM = [
  { name: 'intro', bars: 16 },
  { name: 'build', bars: 8 },
  { name: 'drop', bars: 16 },
  { name: 'break', bars: 16 },
  { name: 'drop', bars: 16 },
  { name: 'outro', bars: 8 },
];

// A minor: Am - F - C - G, one chord per bar.
const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const BASS = [33, 29, 36, 31];
const LEAD_SCALE = [69, 72, 74, 76, 79, 81, 84]; // A minor pentatonic, A4..C6

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** A two-bar lead motif on an eighth-note grid: [{ step, len, midi }]. */
function makeMotif(rand) {
  const notes = [];
  let idx = 2 + Math.floor(rand() * 3);
  for (let step = 0; step < 16; step++) {
    const onBeat = step % 2 === 0;
    if (step !== 0 && rand() > (onBeat ? 0.8 : 0.55)) continue;
    idx = Math.max(0, Math.min(LEAD_SCALE.length - 1, idx + Math.floor(rand() * 5) - 2));
    notes.push({ step, midi: LEAD_SCALE[idx] });
  }
  for (let i = 0; i < notes.length; i++) notes[i].len = ((i + 1 < notes.length ? notes[i + 1].step : 16) - notes[i].step) * (BEAT / 2);
  return notes;
}

/** The event list and ground truth for the demo (no audio yet). */
export function demoScore(seed = DEMO_SEED) {
  const rand = mulberry32(seed);
  const events = [];
  const add = (instr, t, vel = 1, midi = 0, dur = 0) => events.push({ instr, t, vel, midi, dur });
  const motifA = makeMotif(rand), motifB = makeMotif(rand);
  const sections = [];
  let bar = 0;
  for (const sec of DEMO_FORM) {
    const start = bar * BAR;
    sections.push({ name: sec.name, start, end: start + sec.bars * BAR });
    for (let sb = 0; sb < sec.bars; sb++, bar++) {
      const t0 = bar * BAR;
      const chord = CHORDS[bar % 4];
      const root = BASS[bar % 4];
      const beat = (b) => t0 + b * BEAT;
      const hatVel = () => 0.8 + 0.2 * rand();
      const roll = (startBar, bars) => {
        // Snare roll: quarters, then eighths, then sixteenths, rising in level.
        const k = sb - startBar;
        const div = k < bars / 2 ? 1 : k < (3 * bars) / 4 ? 2 : 4;
        for (let i = 0; i < 4 * div; i++) add('snare', t0 + (i * BEAT) / div, 0.45 + 0.5 * ((k + i / (4 * div)) / bars));
      };
      switch (sec.name) {
        case 'intro':
          add('pad', t0, 0.6, 0, BAR);
          for (let b = 0; b < 4; b++) {
            add('kick', beat(b), sb < 8 ? 0.4 : 0.5);
            add('hat', beat(b + 0.5), 0.5 * hatVel());
          }
          if (sb >= 8) {
            add('clap', beat(1), 0.45); add('clap', beat(3), 0.45);
            for (let b = 0; b < 4; b++) add('bass', beat(b + 0.5), 0.4, root, BEAT * 0.45);
          }
          break;
        case 'build':
          if (sb === 0) add('riser', t0, 1, 0, sec.bars * BAR);
          add('pad', t0, 0.8, 0, BAR);
          for (let b = 0; b < 4; b++) add('kick', beat(b), 0.5 + 0.04 * sb);
          for (let b = 0; b < 4; b++) add('hat', beat(b + 0.5), 0.6 * hatVel());
          roll(0, sec.bars);
          break;
        case 'drop': {
          if (sb % 8 === 0) add('crash', t0, 1);
          add('pad', t0, 0.45, 0, BAR);
          for (let b = 0; b < 4; b++) {
            add('kick', beat(b), 1);
            add('bass', beat(b + 0.5), 1, root, BEAT * 0.45);
          }
          add('clap', beat(1), 0.9); add('clap', beat(3), 0.9);
          for (let s = 0; s < 16; s++) {
            if (s % 4 === 2) add('ohat', t0 + s * SIXTEENTH, 0.7);
            else if (s % 4 !== 0) add('hat', t0 + s * SIXTEENTH, 0.8 * hatVel());
          }
          // Two-bar motif; the second drop alternates it with a variation.
          const second = sections.filter((s) => s.name === 'drop').length === 2;
          const motif = second && (sb >> 1) % 2 === 1 ? motifB : motifA;
          if (sb % 2 === 0) for (const n of motif) add('lead', t0 + n.step * (BEAT / 2), 0.9, n.midi, n.len);
          break;
        }
        case 'break':
          add('pad', t0, 1, 0, BAR);
          if (sb < 12) {
            for (let e = 0; e < 8; e++) add('pluck', t0 + e * (BEAT / 2), e % 2 ? 0.5 : 0.8, chord[[0, 1, 2, 1][e % 4]] + 12 + (e >= 4 ? 12 : 0), BEAT / 2);
            if (sb >= 4) for (let b = 0; b < 4; b++) add('hat', beat(b + 0.5), 0.35 * hatVel());
          } else {
            if (sb === 12) add('riser', t0, 1, 0, 4 * BAR);
            for (let b = 0; b < 4; b++) add('kick', beat(b), 0.5 + 0.08 * (sb - 12));
            roll(12, 4);
          }
          break;
        case 'outro':
          add('pad', t0, 0.8 - 0.08 * sb, 0, BAR);
          if (sb < 6) for (let b = 0; b < 4; b++) {
            add('kick', beat(b), 0.5 - 0.05 * sb);
            add('hat', beat(b + 0.5), 0.45 * hatVel());
          }
          break;
      }
    }
  }
  events.sort((a, b) => a.t - b.t || (a.instr < b.instr ? -1 : 1));
  const duration = bar * BAR + TAIL;
  // Ground truth: every note start except the riser (a slow fade-in, not an onset).
  const onsets = [];
  for (const e of events) {
    if (e.instr === 'riser') continue;
    const t = Math.round(e.t * 1e6) / 1e6;
    if (!onsets.length || t - onsets[onsets.length - 1] > 1e-4) onsets.push(t);
  }
  const beats = [];
  for (let k = 0; k < bar * 4; k++) beats.push(k * BEAT);
  const drops = sections.filter((s) => s.name === 'drop').map((s) => s.start);
  return { seed, bpm: DEMO_BPM, duration, events, truth: { bpm: DEMO_BPM, onsets, beats, sections, drops, bars: bar } };
}

// --- instruments -----------------------------------------------------------

const onePoleCoef = (fc, sr) => 1 - Math.exp((-2 * Math.PI * fc) / sr);

function writeStereo(L, R, i, v, pan) {
  // pan -1..1, constant power
  const a = (pan + 1) * 0.25 * Math.PI;
  L[i] += v * Math.cos(a);
  R[i] += v * Math.sin(a);
}

function kick(out, sr, e, rand) {
  const [L, R] = out, i0 = Math.round(e.t * sr), n = Math.min(Math.floor(0.42 * sr), L.length - i0);
  let phase = 0, pitchEnv = 1, amp = 1;
  const pitchDecay = Math.exp(-1 / (0.03 * sr)), ampDecay = Math.exp(-1 / (0.2 * sr));
  for (let i = 0; i < n; i++) {
    phase += (2 * Math.PI * (46 + 130 * pitchEnv)) / sr;
    pitchEnv *= pitchDecay;
    amp *= ampDecay;
    let s = Math.sin(phase) * amp;
    if (i < sr * 0.003) s += (rand() * 2 - 1) * 0.5 * (1 - i / (sr * 0.003));
    const fade = n - i < 64 ? (n - i) / 64 : 1;
    const v = 0.9 * e.vel * s * fade;
    L[i0 + i] += v; R[i0 + i] += v;
  }
}

function noiseHit(out, sr, e, rand, { hp, lp = 0, decay, length, gain, pan = 0, tone = 0, toneDecay = 0.04 }) {
  const [L, R] = out, i0 = Math.round(e.t * sr), n = Math.min(Math.floor(length * sr), L.length - i0);
  const ah = onePoleCoef(hp, sr), al = lp ? onePoleCoef(lp, sr) : 1;
  let lp1 = 0, lp2 = 0, y = 0, amp = 1, tamp = 1, phase = 0;
  const d = Math.exp(-1 / (decay * sr)), td = Math.exp(-1 / (toneDecay * sr));
  for (let i = 0; i < n; i++) {
    const x = rand() * 2 - 1;
    lp1 += ah * (x - lp1);
    const h1 = x - lp1;
    lp2 += ah * (h1 - lp2);
    const h2 = h1 - lp2; // two-pole high-pass
    y += al * (h2 - y);
    amp *= d;
    let s = y * amp;
    if (tone) { phase += (2 * Math.PI * tone) / sr; tamp *= td; s += 0.35 * Math.sin(phase) * tamp; }
    const fade = n - i < 64 ? (n - i) / 64 : 1;
    writeStereo(L, R, i0 + i, gain * e.vel * s * fade, pan);
  }
}

function riser(out, sr, e, rand) {
  const [L, R] = out, i0 = Math.round(e.t * sr), n = Math.min(Math.floor(e.dur * sr), L.length - i0);
  let lp1 = 0, lp2 = 0, a = 0;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    if ((i & 31) === 0) a = onePoleCoef(300 * Math.pow(30, p), sr);
    const x = rand() * 2 - 1;
    lp1 += a * (x - lp1);
    lp2 += a * (lp1 - lp2);
    const v = 0.3 * p * p * p * lp2;
    writeStereo(L, R, i0 + i, v, Math.sin(p * 40) * 0.5);
  }
}

function saw(phase) { return 2 * (phase - Math.floor(phase + 0.5)); }

function bass(out, sr, e) {
  const [L, R] = out, i0 = Math.round(e.t * sr), n = Math.min(Math.floor((e.dur + 0.02) * sr), L.length - i0);
  const f = midiHz(e.midi);
  let ph1 = 0, ph2 = 0.3, y1 = 0, y2 = 0, a = 0, fenv = 1;
  const fd = Math.exp(-1 / (0.07 * sr));
  const rel = Math.floor(0.02 * sr), att = Math.floor(0.002 * sr);
  for (let i = 0; i < n; i++) {
    ph1 += f / sr; ph2 += (f * 1.005) / sr;
    if ((i & 15) === 0) a = onePoleCoef(220 + 1400 * fenv, sr);
    fenv *= fd;
    const x = 0.5 * saw(ph1) + 0.5 * saw(ph2) + 0.6 * Math.sin(2 * Math.PI * ph1 * 0.5);
    y1 += a * (x - y1); y2 += a * (y1 - y2);
    const env = Math.min(1, i / att) * Math.min(1, (n - i) / rel);
    const v = 0.34 * e.vel * y2 * env;
    L[i0 + i] += v; R[i0 + i] += v;
  }
}

function lead(out, sr, e, { gain = 0.2, pan = -0.25, decay = 0.35, bright = 2600, fdecay = 0.1 } = {}) {
  const [L, R] = out, i0 = Math.round(e.t * sr), n = Math.min(Math.floor((e.dur + 0.03) * sr), L.length - i0);
  const f = midiHz(e.midi);
  let ph1 = 0, ph2 = 0.5, y1 = 0, y2 = 0, a = 0, fenv = 1, amp = 1;
  const fd = Math.exp(-1 / (fdecay * sr)), ad = Math.exp(-1 / (decay * sr));
  const att = Math.floor(0.002 * sr), rel = Math.floor(0.03 * sr);
  for (let i = 0; i < n; i++) {
    ph1 += f / sr; ph2 += (f * 1.0046) / sr;
    if ((i & 15) === 0) a = onePoleCoef(700 + bright * fenv, sr);
    fenv *= fd; amp *= ad;
    const sq = ph1 - Math.floor(ph1) < 0.5 ? 1 : -1;
    const x = 0.45 * saw(ph1) + 0.35 * saw(ph2) + 0.25 * sq;
    y1 += a * (x - y1); y2 += a * (y1 - y2);
    const env = Math.min(1, i / att) * Math.min(1, (n - i) / rel) * amp;
    writeStereo(L, R, i0 + i, gain * e.vel * y2 * env, pan);
  }
}

function pad(out, sr, e, chord) {
  const [L, R] = out, i0 = Math.round(e.t * sr), n = Math.min(Math.floor((e.dur + 0.15) * sr), L.length - i0);
  const att = Math.floor(0.03 * sr), rel = Math.floor(0.15 * sr);
  const a = onePoleCoef(1300, sr);
  const voices = chord.map((m, k) => ({ f: midiHz(m), pl: k * 0.13, pr: k * 0.29 + 0.5, yl1: 0, yl2: 0, yr1: 0, yr2: 0 }));
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / att) * Math.min(1, (n - i) / rel) * 0.055 * e.vel;
    let l = 0, r = 0;
    for (const v of voices) {
      v.pl += (v.f * 0.9965) / sr; v.pr += (v.f * 1.0035) / sr;
      v.yl1 += a * (saw(v.pl) - v.yl1); v.yl2 += a * (v.yl1 - v.yl2);
      v.yr1 += a * (saw(v.pr) - v.yr1); v.yr2 += a * (v.yr1 - v.yr2);
      l += v.yl2; r += v.yr2;
    }
    L[i0 + i] += l * env; R[i0 + i] += r * env;
  }
}

/** Render a score to stereo Float32Arrays at `sampleRate`. */
export function renderDemo(score, sampleRate = 44100) {
  const n = Math.ceil(score.duration * sampleRate);
  const L = new Float32Array(n), R = new Float32Array(n);
  const out = [L, R];
  const rand = mulberry32(score.seed ^ 0x9e3779b9);
  for (const e of score.events) {
    const bar = Math.floor(e.t / BAR + 1e-9);
    switch (e.instr) {
      case 'kick': kick(out, sampleRate, e, rand); break;
      case 'snare': noiseHit(out, sampleRate, e, rand, { hp: 900, lp: 7000, decay: 0.09, length: 0.25, gain: 0.5, tone: 190 }); break;
      case 'clap': noiseHit(out, sampleRate, e, rand, { hp: 1100, lp: 6000, decay: 0.045, length: 0.2, gain: 0.55, pan: 0.05, tone: 220, toneDecay: 0.02 }); break;
      case 'hat': noiseHit(out, sampleRate, e, rand, { hp: 5000, decay: 0.03, length: 0.1, gain: 0.85, pan: 0.3 }); break;
      case 'ohat': noiseHit(out, sampleRate, e, rand, { hp: 5500, decay: 0.07, length: 0.2, gain: 0.35, pan: 0.3 }); break;
      case 'crash': noiseHit(out, sampleRate, e, rand, { hp: 3500, decay: 0.9, length: 2.8, gain: 0.3, pan: -0.2 }); break;
      case 'riser': riser(out, sampleRate, e, rand); break;
      case 'bass': bass(out, sampleRate, e); break;
      case 'lead': lead(out, sampleRate, e); break;
      case 'pluck': lead(out, sampleRate, e, { gain: 0.16, pan: 0.2, decay: 0.18, bright: 3500, fdecay: 0.06 }); break;
      case 'pad': pad(out, sampleRate, e, CHORDS[bar % 4]); break;
      default: throw new Error(`unknown instrument ${e.instr}`);
    }
  }
  // Gentle master saturation keeps the peaks below full scale.
  for (let i = 0; i < n; i++) {
    L[i] = Math.tanh(L[i] * 0.9);
    R[i] = Math.tanh(R[i] * 0.9);
  }
  return out;
}

/** Score + audio + ground truth in one call. */
export function generateDemoSong({ seed = DEMO_SEED, sampleRate = 44100 } = {}) {
  const score = demoScore(seed);
  const channels = renderDemo(score, sampleRate);
  return { sampleRate, channels, duration: score.duration, bpm: score.bpm, truth: score.truth, events: score.events };
}
