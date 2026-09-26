import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveSession, LiveClock, SESSION } from '../src/live/session.js';
import { LiveMap, STATUS } from '../src/live/livemap.js';
import { synthClick } from '../src/live/calibrate.js';
import { BLOCK } from '../src/audio/songmap.js';
import { generateDemoSong } from '../src/audio/demo.js';
import { SR, mono, nearest } from './live-fixtures.js';

/** Just enough AudioContext for the session's calibration to schedule clicks. */
function fakeContext() {
  const ctx = {
    sampleRate: SR, currentTime: 0, scheduled: [], gains: [], destination: {},
    createBuffer: (ch, n) => ({ copyToChannel() {}, length: n }),
    createGain: () => {
      const g = { gain: { value: 1 }, connect() {}, disconnect() {} };
      ctx.gains.push(g.gain);
      return g;
    },
    createBufferSource: () => ({ connect() {}, start: (t) => ctx.scheduled.push(t) }),
  };
  return ctx;
}

/** A SongClock stand-in: song time = heard context time − start − offset. */
const songClock = (start, offset = 0) => ({ songStart: start, offset, read: () => 0 });

test('the live path plays the demo: a steady tempo, blocks on its beats, a power block', () => {
  const demo = generateDemoSong({ sampleRate: SR });
  const audio = mono(demo.channels);
  const ctx = fakeContext();
  const session = new LiveSession(ctx, null);
  session.latency = 0.025;
  // Song time 0 was heard at context time 10; hops arrive 25 ms after they play.
  const clock = new LiveClock(songClock(10));
  const map = new LiveMap({ mode: 'mono', seed: 'live:demo', duration: demo.duration });
  session.begin(map, clock);
  const hop = 512, arrive = 10 + 0.025;
  for (let i = 0; i + hop <= audio.length; i += hop) {
    session.feed(Math.round((arrive + i / SR) * SR), audio.subarray(i, i + hop));
    const now = (i + hop) / SR - 0.012; // the frame loop runs a little behind the newest hop
    if ((i / hop) % 2 === 0) session.update(now);
  }
  const s = session.stats;
  assert.ok(Math.abs(s.tempo - 128) < 1, `tempo ${s.tempo}`);
  const b = map.blocks;
  let solid = 0, onBeat = 0, power = 0;
  for (let i = 0; i < b.count; i++) {
    if (b.status[i] !== STATUS.SOLID) continue;
    solid++;
    if (b.type[i] === BLOCK.POWER) power++;
    // Blocks sit on the demo's 8th-note grid (beats and off-beats), within 40 ms.
    const eighths = demo.truth.beats.flatMap((t) => [t, t + 60 / 128 / 2]);
    if (Math.abs(nearest(eighths, b.time[i])) <= 0.04) onBeat++;
  }
  assert.ok(solid > 150, `${solid} solid blocks`);
  assert.ok(onBeat / solid > 0.95, `${onBeat} of ${solid} on the grid`);
  assert.ok(power >= 1, 'sixteen locked bars earn a power block');
  // Intensity reached the drops and the skyline was written by song time.
  assert.ok(map.nodes.intensity[Math.round((60 + 3) * 30)] > 0.75);
  assert.ok(map.skyline.frames > 140 * session.tracker.frameRate);
});

/** Feed `seconds` of a capture whose first sample reaches us at context time `start`, in hops. */
function feedCapture(session, signal, start) {
  for (let i = 0; i + 512 <= signal.length; i += 512) session.feed(Math.round(start * SR) + i, signal.subarray(i, i + 512));
}

/** A capture from `start` on: `bed` (or silence) with the scheduled clicks `delay` seconds late, at `gain`. */
function clickCapture(scheduled, start, seconds, delay, { gain = 0.5, bed = null } = {}) {
  const out = new Float32Array(Math.round(seconds * SR)), click = synthClick(SR);
  if (bed) out.set(bed.subarray(0, out.length));
  for (const t of scheduled) {
    const i0 = Math.round((t + delay - start) * SR);
    for (let i = 0; i < click.length && i0 + i < out.length; i++) if (i0 + i >= 0) out[i0 + i] += click[i] * gain;
  }
  return out;
}

/** Let the session's promises and timers run until `done()` or ~1 s passes. */
async function until(done) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

test('calibration waits for the capture to flow, then measures the delay of the clicks it played', async () => {
  const ctx = fakeContext();
  ctx.currentTime = 20;
  const session = new LiveSession(ctx, null);
  const pending = session.calibrate();
  await until(() => false);
  assert.equal(ctx.scheduled.length, 0, 'no clicks before the capture delivers');
  // 0.4 s of a quiet capture: it flows, and the clicks play.
  feedCapture(session, new Float32Array(Math.round(0.4 * SR)), 19.6);
  await until(() => ctx.scheduled.length === 8);
  assert.equal(ctx.scheduled.length, 8);
  feedCapture(session, clickCapture(ctx.scheduled, 20, 4.5, 0.047), 20);
  const r = await pending;
  assert.ok(r && r.found >= 7, 'clicks heard');
  assert.ok(Math.abs(r.lag - 0.047) < 0.001, `lag ${r.lag}`);
  // The latency includes the onset front end's framing (a few ms).
  assert.ok(r.latency > 0.047 && r.latency < 0.057, `latency ${r.latency}`);
  assert.equal(session.latency, r.latency);
  assert.equal(session.calibrations, 1);
});

test('calibration hears a slow, late-starting capture under a loud video', async () => {
  // Emulates a real tab capture: frames start flowing only after a while,
  // the delay is far above the old 0.35 s search range, a hop goes missing
  // and a loud master plays underneath.
  const ctx = fakeContext();
  ctx.currentTime = 30;
  const session = new LiveSession(ctx, null);
  const pending = session.calibrate();
  feedCapture(session, new Float32Array(Math.round(0.35 * SR)), 30.4); // flows only from 30.4
  ctx.currentTime = 30.75;
  await until(() => ctx.scheduled.length === 8);
  const demo = mono(generateDemoSong({ sampleRate: SR }).channels);
  const bed = demo.slice(Math.round(64 * SR), Math.round(70 * SR));
  let e = 0;
  for (const v of bed) e += v * v;
  const k = 0.25 / Math.sqrt(e / bed.length); // about −12 dBFS RMS
  for (let i = 0; i < bed.length; i++) bed[i] *= k;
  const start = 30.75, cap = clickCapture(ctx.scheduled, start, 5, 0.52, { gain: SESSION.clickGain, bed });
  for (let i = 0; i + 512 <= cap.length; i += 512) {
    if (i / 512 === 120) continue; // a dropped hop
    session.feed(Math.round(start * SR) + i, cap.subarray(i, i + 512));
  }
  const r = await pending;
  assert.ok(r, 'clicks heard');
  assert.ok(Math.abs(r.lag - 0.52) < 0.001, `lag ${r.lag}`);
  assert.equal(session.calibrations, 1);
});

test('calibration tries once more, louder, then keeps a sane delay the player can nudge', async () => {
  const ctx = fakeContext();
  ctx.currentTime = 10;
  const session = new LiveSession(ctx, null, { latency: 0.07 });
  const pending = session.calibrate();
  feedCapture(session, new Float32Array(Math.round(0.4 * SR)), 9.6);
  await until(() => ctx.scheduled.length === 8);
  // First train: nothing comes back (a muted tab).
  feedCapture(session, new Float32Array(Math.round(4.5 * SR)), 10);
  ctx.currentTime = 14.5;
  await until(() => ctx.scheduled.length === 16);
  assert.equal(ctx.scheduled.length, 16, 'a second train');
  assert.ok(ctx.gains[1].value > ctx.gains[0].value, 'louder');
  // Second train: heard.
  feedCapture(session, clickCapture(ctx.scheduled.slice(8), 14.5, 4.5, 0.12, { gain: 0.8 }), 14.5);
  const r = await pending;
  assert.ok(r && Math.abs(r.lag - 0.12) < 0.001, 'heard the second time');
  assert.equal(session.calibrations, 2);

  // Never heard: the delay stays where it was, and the player can move it.
  ctx.currentTime = 10;
  const quiet = new LiveSession(ctx, null, { latency: 0.07 });
  const none = quiet.calibrate();
  feedCapture(quiet, new Float32Array(Math.round(0.4 * SR)), 9.6);
  await until(() => ctx.scheduled.length === 24);
  feedCapture(quiet, new Float32Array(Math.round(4.5 * SR)), 10);
  ctx.currentTime = 14.5;
  await until(() => ctx.scheduled.length === 32);
  feedCapture(quiet, new Float32Array(Math.round(4.5 * SR)), 14.5);
  assert.equal(await none, null);
  assert.equal(quiet.latency, 0.07);
  assert.equal(quiet.calibrations, 2, 'one retry, no more');
  quiet.setLatency(quiet.latency + 2 * SESSION.nudge);
  assert.ok(Math.abs(quiet.latency - 0.08) < 1e-9);
  quiet.setLatency(-1);
  assert.equal(quiet.latency, 0, 'never negative');
});

test('calibration gives up quickly when the capture never delivers', async () => {
  const ctx = fakeContext();
  const session = new LiveSession(ctx, null, { flowTimeout: 0.05 });
  assert.equal(await session.calibrate(), null);
  assert.equal(ctx.scheduled.length, 0, 'no clicks into a dead capture');
  assert.equal(session.latency, SESSION.defaultLatency);
});

test('the live clock stops while held and maps heard time to song time', () => {
  let heard = 100;
  const clock = new LiveClock({ songStart: 0, offset: 0.01, read: () => heard - 0.01 });
  clock.start(-3);
  assert.ok(Math.abs(clock.time() + 3) < 1e-9);
  heard += 2;
  assert.ok(Math.abs(clock.time() + 1) < 1e-9);
  assert.ok(Math.abs(clock.songOfHeard(heard) - clock.time()) < 1e-9);
  clock.hold();
  heard += 5;
  assert.ok(Math.abs(clock.time() + 1) < 1e-9, 'held');
  clock.run();
  heard += 1;
  assert.ok(Math.abs(clock.time()) < 1e-9);
  assert.ok(Math.abs(clock.songOfHeard(heard) - clock.time()) < 1e-9);
});
