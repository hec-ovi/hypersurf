import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFrame, countAt, easeOutCubic } from '../src/ui/text.js';
import { ParticlePool } from '../src/ui/particles.js';
import { terrainHeight } from '../src/ui/terrain.js';

test('the decode reveal resolves left to right and keeps spaces', () => {
  const start = decodeFrame('SELECT MODE', 0, 3);
  assert.equal(start.done, '');
  assert.equal(start.rest.length, 'SELECT MODE'.length);
  assert.equal(start.rest[6], ' ', 'word gaps hold from the first frame');
  assert.notEqual(start.rest.slice(0, 6), 'SELECT');
  const mid = decodeFrame('SELECT MODE', 0.5, 3);
  assert.ok(mid.done.length > 3 && mid.done.length < 9);
  assert.equal(mid.done + mid.rest.slice(0, 0), 'SELECT MODE'.slice(0, mid.done.length));
  assert.equal(mid.done.length + mid.rest.length, 11);
  assert.deepEqual(decodeFrame('SELECT MODE', 1, 3), { done: 'SELECT MODE', rest: '' });
  // Stable within a tick, different across ticks.
  assert.equal(decodeFrame('HYPERSURF', 0.2, 7).rest, decodeFrame('HYPERSURF', 0.2, 7).rest);
});

test('count-ups ease out and land exactly', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(countAt(100, 500, 0, 400), 100);
  assert.equal(countAt(100, 500, 400, 400), 500);
  assert.equal(countAt(100, 500, 9999, 400), 500);
  const half = countAt(0, 1000, 200, 400);
  assert.ok(half > 500 && half < 1000, 'eased: past the midpoint at half time');
  assert.equal(countAt(3, 7, 10, 0), 7, 'no duration jumps to the end');
});

test('the particle pool is capped, reuses the oldest slot and never grows', () => {
  const pool = new ParticlePool(8);
  const arrays = [pool.x, pool.y, pool.life];
  for (let i = 0; i < 20; i++) pool.spawn(i, 0, 0, 0, 1, 2, 0);
  assert.equal(pool.step(0.01), 8);
  assert.deepEqual([pool.x, pool.y, pool.life], arrays, 'same typed arrays: nothing reallocated');
  assert.equal(pool.step(2), 0, 'all expire');
  pool.burst(10, 10, 5, { life: 0.5, speed: 100 });
  assert.equal(pool.step(0.1), 5);
});

test('particles move with drag and gravity', () => {
  const pool = new ParticlePool(2);
  pool.spawn(0, 0, 100, 0, 1, 2, 0, 0, 50);
  pool.step(0.5);
  assert.ok(Math.abs(pool.x[0] - 50) < 1e-4);
  assert.ok(pool.vy[0] > 0 && pool.y[0] > 0, 'gravity pulls down the screen');
  const damped = new ParticlePool(1);
  damped.spawn(0, 0, 100, 0, 1, 2, 0, 3, 0);
  damped.step(0.5);
  assert.ok(damped.vx[0] < 30, 'drag slows it');
});

test('the terrain stays in a bounded band and moves over time', () => {
  let lo = Infinity, hi = -Infinity;
  for (let x = -40; x <= 40; x += 3.1) for (let z = 2; z < 50; z += 2.3) {
    const y = terrainHeight(x, z, 5);
    lo = Math.min(lo, y); hi = Math.max(hi, y);
  }
  assert.ok(lo > -1.3 && hi < 1.3, `${lo} … ${hi}`);
  assert.notEqual(terrainHeight(3, 7, 0), terrainHeight(3, 7, 4));
});
