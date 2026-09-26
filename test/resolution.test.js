import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResolutionGovernor } from '../src/game/resolution.js';

/** Feed `seconds` of frames at `ms` each, starting at `t0` ms; returns the end time. */
function run(g, ms, seconds, t0 = 0) {
  let t = t0;
  for (let i = 0; i < (seconds * 1000) / ms; i++) { t += ms; g.update(ms, t); }
  return t;
}

test('a 60 Hz display at full rate keeps full resolution', () => {
  const g = new ResolutionGovernor();
  run(g, 1000 / 60, 30);
  assert.equal(g.scale, 1);
  assert.equal(g.lowerRequested, false);
});

test('a GPU stuck at 30 fps steps down to the floor, then asks for the low tier', () => {
  const g = new ResolutionGovernor({ minScale: 0.6 });
  let t = run(g, 33.3, 3);
  assert.ok(g.scale < 1, 'scaled down');
  assert.ok(g.targetMs < 18, '30 fps is a slow GPU, not a 30 Hz display');
  t = run(g, 33.3, 20, t);
  assert.equal(g.scale, 0.6);
  assert.equal(g.lowerRequested, true);
  g.acknowledgeLower(0.5);
  run(g, 33.3, 30, t);
  assert.equal(g.lowerRequested, false, 'asks only once');
  assert.equal(g.scale, 0.5);
});

test('a 144 Hz display aims for 6.9 ms and recovers after load drops', () => {
  const g = new ResolutionGovernor();
  let t = run(g, 1000 / 144, 5);
  assert.ok(Math.abs(g.targetMs - 1000 / 144) < 0.2);
  t = run(g, 12, 6, t); // heavy scene
  assert.ok(g.scale < 1);
  const low = g.scale;
  run(g, 1000 / 144, 30, t);
  assert.ok(g.scale > low, 'steps back up');
});

test('tab switches and breakpoints are ignored', () => {
  const g = new ResolutionGovernor();
  run(g, 1000 / 60, 3);
  const ema = g.frameMsEma;
  assert.equal(g.update(900, 4000), false);
  assert.equal(g.frameMsEma, ema);
});
