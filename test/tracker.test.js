import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeatTracker, SpectralFlux, logFilterbank } from '../src/live/tracker.js';
import { generateDemoSong } from '../src/audio/demo.js';
import { SR, beatGrid, clickTrack, drumLoop, padOnly, whiteNoise, mono, feed, nearest, gridBeatNear } from './live-fixtures.js';

const H = 2; // seconds ahead the live map places blocks

/**
 * Run a stream through a tracker; every 0.25 s after `from`, record the
 * error of the grid's beat nearest to 2 s ahead against the truth.
 */
function track(signal, truth, { from = 0, until = Infinity } = {}) {
  const tr = new BeatTracker(SR);
  const out = { tracker: tr, lockedAt: Infinity, errors: [], samples: [] };
  let next = 0;
  feed(tr, signal, (t, now) => {
    if (now < next) return;
    next = now + 0.25;
    out.samples.push({ now, bpm: t.bpm, confidence: t.confidence, hitRate: t.hitRate });
    if (now >= from && now <= until && Number.isFinite(t.grid.anchor)) {
      const target = now + H;
      if (target < truth[truth.length - 1]) out.errors.push({ now, err: nearest(truth, gridBeatNear(t.grid, target)) });
    }
  });
  return out;
}

const maxAbs = (errs) => errs.reduce((m, e) => Math.max(m, Math.abs(e.err)), 0);

test('the log filterbank covers 30 Hz to 17 kHz at up to 12 bands per octave', () => {
  const fb = logFilterbank(44100, 1024);
  assert.ok(fb.count > 60 && fb.count < 110, `${fb.count} bands`);
  for (let b = 0; b < fb.count; b++) {
    let sum = 0;
    for (let j = 0; j < fb.len[b]; j++) sum += fb.weights[fb.offset[b] + j];
    assert.ok(Math.abs(sum - 1) < 1e-5, `band ${b} sums to ${sum}`);
    if (b > 0) assert.ok(fb.centre[b] > fb.centre[b - 1]);
  }
  assert.ok(fb.centre[0] < 100 && fb.centre[fb.count - 1] > 15000);
  // A 1 kHz tone lights the bands around 1 kHz and nothing far from it.
  const sf = new SpectralFlux(44100);
  const hop = new Float32Array(512);
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < 512; i++) hop[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * (k * 512 + i)) / 44100);
    sf.push(hop);
  }
  let peak = 0;
  for (let b = 0; b < fb.count; b++) if (sf.prev[b] > sf.prev[peak]) peak = b;
  assert.ok(Math.abs(sf.fb.centre[peak] - 1000) < 60, `peak band at ${sf.fb.centre[peak]} Hz`);
});

test('onsets land on the clicks, and our own sounds are ignored', () => {
  const clicks = beatGrid(100, 0.3, 12);
  const tr = new BeatTracker(SR);
  feed(tr, clickTrack(clicks, 12));
  assert.equal(tr.onsetCount, clicks.length);
  for (let i = 0; i < tr.onsetCount; i++) assert.ok(Math.abs(nearest(clicks, tr.onsetTime[i])) < 0.012);
  // The same clicks announced as ours (hit sounds, calibration) raise no onsets.
  const quiet = new BeatTracker(SR);
  const ours = clicks.slice(0, 16);
  for (const t of ours) quiet.suppress(t);
  feed(quiet, clickTrack(ours, 12));
  assert.equal(quiet.onsetCount, 0);
});

test('locks to a drum loop within a few seconds and predicts 2 s ahead within ±40 ms', () => {
  const beats = beatGrid(128, 0.25, 40);
  const tr = new BeatTracker(SR);
  const signal = drumLoop(beats, 40);
  let mid = null;
  feed(tr, signal.subarray(0, 20 * SR), (t, now) => {
    if (!mid && now >= 19.5) mid = { ...t.grid };
  });
  // The very next beat (predicted half a beat ahead) is tighter still.
  assert.ok(Math.abs(nearest(beats, mid.anchor)) < 0.02, `next beat off by ${nearest(beats, mid.anchor)}`);
  assert.ok(Math.abs(60 / mid.period - 128) < 0.5, `grid tempo ${60 / mid.period}`);
  assert.ok(tr.hitRate > 0.9);
  const r = track(signal, beats, { from: 5 });
  const lock = r.samples.find((s) => s.confidence > 0.6 && Math.abs(s.bpm - 128) < 1.5);
  assert.ok(lock && lock.now <= 5, `locked at ${lock && lock.now} s`);
  assert.ok(r.errors.length > 100);
  assert.ok(maxAbs(r.errors) <= 0.04, `worst 2 s-ahead error ${(maxAbs(r.errors) * 1000).toFixed(1)} ms`);
});

test('tracks the demo song wherever a kick marks the beat', () => {
  const demo = generateDemoSong({ sampleRate: SR });
  const beats = demo.truth.beats;
  // The break (75–105 s) has no kick: 8th-note plucks with hats on the
  // off-beats, where the strongest pulse really is the off-beat, and the
  // tracker may ride it half a beat over (every prediction still lands on
  // an onset). The kick stops for good at 146 s.
  const kick = (t) => (t >= 8 && t < 75) || (t >= 106 && t < 145);
  const r = track(mono(demo.channels), beats);
  const checked = r.errors.filter((e) => kick(e.now) && kick(e.now + H));
  const confident = checked.filter((e) => r.samples.find((s) => s.now === e.now).confidence > 0.6);
  assert.ok(confident.length > 0.95 * checked.length, `${confident.length} of ${checked.length} confident`);
  assert.ok(maxAbs(confident) <= 0.04, `worst ${(maxAbs(confident) * 1000).toFixed(1)} ms`);
  const late = r.samples.filter((s) => s.now > 10 && s.confidence > 0.6);
  for (const s of late) assert.ok(Math.abs(s.bpm - 128) < 1.5, `${s.now}: ${s.bpm} BPM`);
});

test('follows a tempo change from 120 to 140 BPM', () => {
  const beats = [...beatGrid(120, 0.3, 15), ...beatGrid(140, 15, 40)];
  const r = track(drumLoop(beats, 40), beats, { from: 21 });
  const settled = r.samples.filter((s) => s.now >= 21);
  for (const s of settled) assert.ok(Math.abs(s.bpm - 140) < 1.5, `${s.now}: ${s.bpm} BPM`);
  assert.ok(maxAbs(r.errors) <= 0.04, `worst ${(maxAbs(r.errors) * 1000).toFixed(1)} ms`);
  // During the change the confirmation rate drops, so the live map stops trusting the grid.
  const during = r.samples.filter((s) => s.now > 15.5 && s.now < 19);
  assert.ok(during.some((s) => s.hitRate < 0.5));
});

test('folds other octaves into 80–160 BPM and keeps predicting the beats', () => {
  // 200 BPM clicks: tracked at 100 BPM, every predicted beat on a click.
  const fast = beatGrid(200, 0.3, 25);
  let r = track(clickTrack(fast, 25), fast, { from: 6 });
  assert.ok(Math.abs(r.samples.at(-1).bpm - 100) < 1, `${r.samples.at(-1).bpm}`);
  assert.ok(maxAbs(r.errors) <= 0.04);
  // Kicks at 128 BPM accented every other beat (a 64 BPM feel): 128, not 64.
  const beats = beatGrid(128, 0.3, 25);
  r = track(drumLoop(beats, 25, { snare: false, hats: false, accent: (i) => (i % 2 ? 0.35 : 1) }), beats, { from: 6 });
  assert.ok(Math.abs(r.samples.at(-1).bpm - 128) < 1.5);
  assert.ok(maxAbs(r.errors) <= 0.04);
  // 70 BPM clicks: doubled to 140, so predictions fall on a click or exactly halfway.
  const slow = beatGrid(70, 0.3, 25);
  r = track(clickTrack(slow, 25), slow, { from: 6 });
  assert.ok(Math.abs(r.samples.at(-1).bpm - 140) < 1.5);
  const half = 30 / 70;
  for (const e of r.errors) assert.ok(Math.abs(e.err) <= 0.04 || Math.abs(Math.abs(e.err) - half) <= 0.04, `${e.err}`);
});

test('confidence is high on a beat and low on noise, pads and silence', () => {
  const beats = beatGrid(120, 0.3, 20);
  const high = track(clickTrack(beats, 20), beats);
  assert.ok(high.samples.filter((s) => s.now > 5).every((s) => s.confidence > 0.8));
  for (const [name, signal] of [['noise', whiteNoise(20)], ['pad', padOnly(20)], ['silence', new Float32Array(20 * SR)]]) {
    const r = track(signal, [0]);
    const worst = Math.max(...r.samples.filter((s) => s.now > 3).map((s) => s.confidence));
    assert.ok(worst < 0.4, `${name}: confidence reached ${worst.toFixed(2)}`);
  }
});

test('reset forgets the stream', () => {
  const beats = beatGrid(128, 0.3, 10);
  const tr = new BeatTracker(SR);
  feed(tr, drumLoop(beats, 10));
  assert.ok(tr.confidence > 0.6 && tr.onsetCount > 0);
  tr.reset();
  assert.equal(tr.onsetCount, 0);
  assert.equal(tr.confidence, 0);
  assert.ok(Number.isNaN(tr.grid.anchor));
  assert.equal(tr.time, 0);
});
