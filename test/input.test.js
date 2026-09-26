import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShipMotion, heldDirection, pointerToX, stickToX } from '../src/game/input.js';
import { laneAt } from '../src/game/rules.js';

test('the ship crosses one lane in about 60 ms without overshoot', () => {
  const ship = new ShipMotion();
  const dt = 1 / 240;
  let t = 0, crossed = null, settled = null, peak = 0;
  while (t < 0.3) {
    ship.step(dt, 3);
    t += dt;
    if (crossed === null && laneAt(ship.x) === 1) crossed = t;
    if (settled === null && ship.x > 2.7) settled = t;
    peak = Math.max(peak, ship.x);
  }
  assert.ok(crossed < 0.03, `enters the lane after ${crossed}s`);
  assert.ok(settled > 0.045 && settled < 0.075, `within 10% after ${settled}s`);
  assert.ok(peak <= 3 + 1e-9, `no overshoot (${peak})`);
});

test('ship motion does not depend on the step size', () => {
  const a = new ShipMotion(), b = new ShipMotion();
  for (let k = 0; k < 240; k++) a.step(1 / 240, k < 120 ? -3 : 3);
  for (let k = 0; k < 60; k++) b.step(1 / 60, k < 30 ? -3 : 3);
  assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.v - b.v) < 1e-6);
});

test('input mappings', () => {
  assert.equal(heldDirection(false, false, 1), 0);
  assert.equal(heldDirection(true, false, 1), -1);
  assert.equal(heldDirection(true, true, 1), 1);
  assert.equal(heldDirection(true, true, -1), -1);
  assert.equal(pointerToX(0.5, 3), 0);
  assert.equal(pointerToX(0, 3), -3);
  assert.equal(pointerToX(1, 4.5), 4.5);
  assert.ok(Math.abs(pointerToX(0.75, 3) - 2.025) < 1e-12);
  assert.equal(stickToX(0.1, 3), 0);
  assert.equal(stickToX(-1, 3), -3);
  assert.ok(Math.abs(stickToX(0.6, 3) - 1.5) < 1e-12);
});

test('a held key keeps driving the ship when the mouse or a pad moves', async () => {
  const { InputController } = await import('../src/game/input.js');
  const input = new InputController({});
  input.right = true;
  input.lastPressed = 1;
  for (const source of ['lock', 'mouse', 'touch', 'pad']) {
    input.source = source;
    input.lockedX = input.pointerX = -3;
    input._padX = -3;
    assert.equal(input.targetNow(), 3, `${source} must not override the held key`);
  }
  input.right = false;
  input.source = 'mouse';
  assert.equal(input.targetNow(), -3, 'the pointer drives again once no key is held');
});
