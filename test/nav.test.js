import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spatialNext, stepIndex, PadReader } from '../src/ui/nav.js';

// A menu like the real one: a right-aligned stack whose buttons widen as
// they go down, and a row of diamonds at the bottom left.
const stack = [
  { x: 1300, y: 200, w: 620, h: 64 },
  { x: 1278, y: 286, w: 642, h: 64 },
  { x: 1256, y: 372, w: 664, h: 64 },
  { x: 1234, y: 458, w: 686, h: 64 },
];
const diamonds = [
  { x: 56, y: 980, w: 58, h: 58 },
  { x: 136, y: 980, w: 58, h: 58 },
  { x: 216, y: 980, w: 58, h: 58 },
];
const menu = [...stack, ...diamonds];

test('up and down walk the stack in order', () => {
  assert.equal(spatialNext(menu, 0, 'down'), 1);
  assert.equal(spatialNext(menu, 1, 'down'), 2);
  assert.equal(spatialNext(menu, 2, 'up'), 1);
  assert.equal(spatialNext(menu, 0, 'up'), -1, 'nothing above the top button');
});

test('left and right walk a row and never jump to the far column when a row exists', () => {
  assert.equal(spatialNext(menu, 4, 'right'), 5);
  assert.equal(spatialNext(menu, 5, 'right'), 6);
  assert.equal(spatialNext(menu, 5, 'left'), 4);
  // From the last diamond, right goes to the stack (the only thing there).
  assert.equal(spatialNext(menu, 6, 'right'), 3);
});

test('down from the bottom button reaches the diamond row', () => {
  assert.ok([4, 5, 6].includes(spatialNext(menu, 3, 'down')));
});

test('with no current focus the first control wins', () => {
  assert.equal(spatialNext(menu, -1, 'down'), 0);
  assert.equal(spatialNext([], 0, 'down'), -1);
});

test('stepIndex clamps or wraps', () => {
  assert.equal(stepIndex(0, -1, 3), 0);
  assert.equal(stepIndex(2, 1, 3), 2);
  assert.equal(stepIndex(2, 1, 3, true), 0);
  assert.equal(stepIndex(0, -1, 3, true), 2);
});

test('the gamepad reader fires once per press and repeats held directions', () => {
  const pad = new PadReader({ delay: 300, rate: 100 });
  const out = [];
  assert.deepEqual(pad.update(new Set(['down']), 0, out), ['down']);
  assert.deepEqual(pad.update(new Set(['down']), 200, out), []);
  assert.deepEqual(pad.update(new Set(['down']), 310, out), ['down']);
  assert.deepEqual(pad.update(new Set(['down']), 360, out), []);
  assert.deepEqual(pad.update(new Set(['down']), 420, out), ['down']);
  // A held button (not a direction) never repeats.
  assert.deepEqual(pad.update(new Set(['ok']), 500, out), ['ok']);
  assert.deepEqual(pad.update(new Set(['ok']), 2000, out), []);
  assert.deepEqual(pad.update(new Set(), 2100, out), []);
  assert.deepEqual(pad.update(new Set(['ok']), 2200, out), ['ok']);
});

test('the stick reads as a d-pad past the dead zone', () => {
  const pad = new PadReader({ dead: 0.5 });
  const into = new Set();
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false }));
  pad.read({ connected: true, buttons, axes: [0.9, -0.2] }, into);
  assert.deepEqual([...into], ['right']);
  buttons[0].pressed = true;
  pad.read({ connected: true, buttons, axes: [0, 0.8] }, into);
  assert.deepEqual([...into].sort(), ['down', 'ok']);
});
