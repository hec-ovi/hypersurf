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

test('cash-in shockwaves share the limiter and dim instead of vanishing', () => {
  const j = new Juice();
  for (let k = 0; k < 3; k++) j.onBeat(k, k * 0.1, 1); // three flashes in 0.3 s
  j.cashIn(0.35, 21);
  assert.equal(j.shockTime, 0.35);
  assert.ok(j.shock > 0 && j.shock < 0.5, `limited shock ${j.shock}`);
  j.cashIn(1.5, 21);
  assert.ok(j.shock > 0.9, `full shock ${j.shock}`);
  const calm = new Juice();
  calm.calm = true;
  calm.cashIn(0, 3);
  assert.ok(calm.shock > 0 && calm.shock < 0.3);
});

test('impact envelopes are over within about 250 ms', () => {
  const j = new Juice();
  j.hit(0);
  j.power();
  j.grey();
  j.burst(0.6, 0);
  for (let k = 0; k < 15; k++) j.update(1 / 60);
  for (const key of ['ship', 'kick', 'debris', 'desaturate', 'bloom']) assert.ok(j[key] < 0.2 * (key === 'kick' ? 0.08 : 1), `${key} ${j[key]}`);
  assert.ok(j.lens < 0.5 && j.fov < 4, 'the power punch has faded well down');
});

test('hits flash the debris only when the limiter allows', () => {
  const j = new Juice();
  let flashes = 0;
  for (let k = 0; k < 20; k++) { // 20 hits in one second
    j.debris = 0;
    j.hit(k * 0.05);
    if (j.debris > 0.5) flashes++;
    assert.equal(j.ship, 1, 'the ship always flashes');
  }
  assert.equal(flashes, 3);
});

test('calm visuals keep power blocks free of lens punches', () => {
  const j = new Juice();
  j.calm = true;
  j.power();
  assert.equal(j.lens, 0);
  assert.ok(j.fov > 0 && j.fov <= 3, `calm fov punch ${j.fov}`);
  const full = new Juice();
  full.power();
  assert.equal(full.lens, 1);
  assert.equal(full.fov, 8);
});
