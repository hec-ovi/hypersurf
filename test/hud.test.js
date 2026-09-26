import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingMatch, clock, formatScore } from '../src/game/hud.js';
import { nearestCorner } from '../src/live/panel.js';

test('the match ring shows the blocks and points that would cash in now', () => {
  assert.deepEqual(pendingMatch([0, 0, 0]), { blocks: 0, points: 0 });
  assert.deepEqual(pendingMatch([1, 1, 1]), { blocks: 3, points: 35 * 9 });
  assert.deepEqual(pendingMatch([3, 0, 4]), { blocks: 7, points: 35 * 9 + 35 * 16 });
  assert.deepEqual(pendingMatch([2, 0, 2]), { blocks: 0, points: 0 });
  assert.deepEqual(pendingMatch([1, 1, 1], 2), { blocks: 3, points: 35 * 9 * 2 });
});

test('times and scores read as a player expects', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(151.5), '2:31');
  assert.equal(clock(-3), '0:00');
  assert.equal(formatScore(53031.4), '53,031');
});

test('the mini player snaps to the nearest corner', () => {
  assert.equal(nearestCorner(100, 100, 1920, 1080), 'tl');
  assert.equal(nearestCorner(1800, 100, 1920, 1080), 'tr');
  assert.equal(nearestCorner(100, 1000, 1920, 1080), 'bl');
  assert.equal(nearestCorner(1800, 1000, 1920, 1080), 'br');
});
