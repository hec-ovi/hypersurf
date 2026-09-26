import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlashLimiter, Juice } from '../src/game/effects.js';

test('the flash limiter allows at most 3 flashes in any second', () => {
  const lim = new FlashLimiter();
  const granted = [];
  // Requests at 10 Hz for 5 s.
  for (let k = 0; k < 50; k++) if (lim.tryFlash(k * 0.1)) granted.push(k * 0.1);
  for (let i = 0; i + 3 < granted.length; i++) assert.ok(granted[i + 3] - granted[i] >= 1 - 1e-9);
  assert.ok(granted.length >= 14 && granted.length <= 16, `${granted.length} flashes in 5 s`);
  // A 128 BPM beat (2.13/s) always passes on its own.
  const beats = new FlashLimiter();
  for (let k = 0; k < 100; k++) assert.ok(beats.tryFlash(k * 60 / 128));
});

test('beat pulses and bursts share the limiter; calm visuals drop pulses', () => {
  const j = new Juice();
  let pulses = 0;
  for (let k = 0; k < 20; k++) {
    j.beat = 0;
    j.onBeat(k, k * 0.1, 1); // a 600 BPM beat stream
    if (j.beat > 0) pulses++;
  }
  assert.ok(pulses <= 6, `${pulses} pulses in 2 s`);
  const calm = new Juice();
  calm.calm = true;
  calm.onBeat(1, 0, 1);
  assert.equal(calm.beat, 0);
  calm.burst(0.6, 0);
  assert.ok(calm.bloom > 0 && calm.bloom < 0.6);
  calm.update(1);
  assert.ok(calm.bloom < 0.01);
});
