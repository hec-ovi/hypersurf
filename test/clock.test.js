import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SongClock } from '../src/audio/clock.js';

/** A fake AudioContext whose output timestamp we control. */
function fakeContext() {
  return {
    state: 'running',
    currentTime: 0,
    outputLatency: 0.04,
    ts: { contextTime: 0, performanceTime: 0 },
    getOutputTimestamp() { return { ...this.ts }; },
  };
}

test('heard time comes from the output timestamp, not currentTime', () => {
  const ctx = fakeContext();
  let now = 1100;
  const clock = new SongClock(ctx, { now: () => now });
  clock.start(9);
  ctx.currentTime = 12; // ahead of what is heard; must be ignored
  ctx.ts = { contextTime: 10, performanceTime: 1000 };
  assert.ok(Math.abs(clock.read() - 1.1) < 1e-9);
  // A user offset delays the heard time.
  clock.offset = 0.05;
  assert.ok(Math.abs(clock.raw(now) - 1.05) < 1e-9);
});

test('falls back to currentTime - outputLatency before the first rendered block', () => {
  const ctx = fakeContext();
  ctx.currentTime = 5;
  const clock = new SongClock(ctx, { now: () => 0 });
  clock.start(4);
  assert.ok(Math.abs(clock.read() - 0.96) < 1e-9);
});

test('smooths render-quantum jitter and never runs backwards', () => {
  const ctx = fakeContext();
  let now = 0;
  const clock = new SongClock(ctx, { now: () => now });
  clock.start(0);
  let prev = -Infinity, maxErr = 0, maxRawErr = 0;
  for (let frame = 0; frame < 600; frame++) {
    now = frame * (1000 / 60);
    const truth = now / 1000;
    // The timestamp updates once per 128-frame quantum at 48 kHz.
    const quantum = 128 / 48000;
    const ctxTime = Math.floor(truth / quantum) * quantum;
    ctx.ts = { contextTime: ctxTime, performanceTime: now - (frame % 3) * 2 };
    const t = clock.read();
    assert.ok(t >= prev, `went back at frame ${frame}`);
    prev = t;
    if (frame > 60) {
      maxErr = Math.max(maxErr, Math.abs(t - truth));
      maxRawErr = Math.max(maxRawErr, Math.abs(clock.raw(now) - truth));
    }
  }
  assert.ok(maxErr < maxRawErr, `smoothed ${maxErr} vs raw ${maxRawErr}`);
  assert.ok(maxErr < 0.004);
});

test('snaps on a large jump and holds while the context is suspended', () => {
  const ctx = fakeContext();
  let now = 0;
  const clock = new SongClock(ctx, { now: () => now });
  clock.start(0);
  ctx.ts = { contextTime: 1, performanceTime: 0 };
  clock.read();
  now = 16;
  ctx.ts = { contextTime: 3, performanceTime: 16 }; // 2 s jump
  assert.ok(Math.abs(clock.read() - 3) < 1e-9);
  ctx.state = 'suspended';
  now = 1000; // wall time passes, audio does not
  ctx.ts = { contextTime: 3, performanceTime: 16 };
  const frozen = clock.read();
  assert.ok(frozen < 3.01, `advanced to ${frozen} while suspended`);
  // An explicit restart may go back in time.
  clock.start(2.5);
  ctx.state = 'running';
  assert.ok(clock.read() < 1.5);
});

test('a resumed context whose timestamp has no performance time does not jump the clock', () => {
  // Chrome, right after resume(): the current contextTime with performanceTime 0.
  const ctx = fakeContext();
  let now = 61641;
  const clock = new SongClock(ctx, { now: () => now });
  clock.start(30);
  ctx.currentTime = 51.296;
  ctx.ts = { contextTime: 51.296, performanceTime: 0 };
  const t = clock.read();
  assert.ok(Math.abs(t - (51.296 - 0.04 - 30)) < 1e-9, `read ${t}`);
  // A timestamp the device stopped updating long ago is not extrapolated either.
  ctx.ts = { contextTime: 51.3, performanceTime: now - 5000 };
  assert.ok(clock.raw(now) < 21.5);
});
