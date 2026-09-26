import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveSession, LiveClock } from '../src/live/session.js';
import { LiveMap, STATUS } from '../src/live/livemap.js';
import { synthClick } from '../src/live/calibrate.js';
import { BLOCK } from '../src/audio/songmap.js';
import { generateDemoSong } from '../src/audio/demo.js';
import { SR, mono, nearest } from './live-fixtures.js';

/** Just enough AudioContext for the session's calibration to schedule clicks. */
function fakeContext() {
  const ctx = {
    sampleRate: SR, currentTime: 0, scheduled: [], destination: {},
    createBuffer: (ch, n) => ({ copyToChannel() {}, length: n }),
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
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

test('calibration measures the capture delay from the clicks it scheduled', async () => {
  const ctx = fakeContext();
  ctx.currentTime = 20;
  const session = new LiveSession(ctx, null);
  const pending = session.calibrate();
  assert.equal(ctx.scheduled.length, 8);
  // The capture: silence with each click arriving 47 ms after it played.
  const seconds = 4, start = 20, out = new Float32Array(seconds * SR), click = synthClick(SR);
  for (const t of ctx.scheduled) {
    const i0 = Math.round((t + 0.047 - start) * SR);
    for (let i = 0; i < click.length; i++) out[i0 + i] += click[i] * 0.5;
  }
  for (let i = 0; i + 512 <= out.length; i += 512) session.feed(Math.round(start * SR) + i, out.subarray(i, i + 512));
  const r = await pending;
  assert.ok(r && r.found >= 7, 'clicks heard');
  assert.ok(r.latency > 0.045 && r.latency < 0.057, `latency ${r.latency}`);
  assert.equal(session.latency, r.latency);
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
