import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK } from '../src/audio/songmap.js';
import {
  ROWS, laneAt, clampShipX, inHitWindow, matchPoints, fallHold, scoringGroups, hasMatch,
} from '../src/game/rules.js';

test('35·n² per match', () => {
  for (const [n, points] of [[3, 315], [4, 560], [7, 1715], [14, 6860], [21, 15435]]) {
    assert.equal(matchPoints(n), points, `n = ${n}`);
  }
});

test('scoring groups: one group through the centre, outer columns alone without it', () => {
  const table = [
    // [left, centre, right] → groups
    [[0, 0, 0], []],
    [[0, 2, 0], []],
    [[0, 3, 0], [3]],
    [[1, 1, 1], [3]],
    [[2, 1, 0], [3]],
    [[7, 7, 7], [21]],
    [[3, 0, 5], [3, 5]],
    [[2, 0, 5], [5]],
    [[2, 0, 2], []],
    [[7, 0, 0], [7]],
  ];
  for (const [heights, groups] of table) {
    assert.deepEqual(scoringGroups(heights), groups, heights.join(','));
    assert.equal(hasMatch(heights), groups.length > 0, heights.join(','));
  }
});

test('a falling block holds the timer 0.25 s + 0.1 s per empty row', () => {
  for (const [height, hold] of [[0, 0.95], [3, 0.65], [6, 0.35]]) {
    assert.ok(Math.abs(fallHold(height) - hold) < 1e-12, `height ${height}`);
  }
  assert.equal(ROWS, 7);
});

test('hit windows: colour -20…+70 ms, grey -10…+18 ms', () => {
  const table = [
    // [type, dt (s), inside]
    [BLOCK.COLOUR, -0.021, false], [BLOCK.COLOUR, -0.02, true], [BLOCK.COLOUR, 0, true],
    [BLOCK.COLOUR, 0.07, true], [BLOCK.COLOUR, 0.071, false],
    [BLOCK.POWER, -0.02, true], [BLOCK.POWER, 0.07, true], [BLOCK.POWER, 0.071, false],
    [BLOCK.GREY, -0.011, false], [BLOCK.GREY, -0.01, true], [BLOCK.GREY, 0.018, true], [BLOCK.GREY, 0.019, false],
  ];
  for (const [type, dt, inside] of table) assert.equal(inHitWindow(type, dt), inside, `type ${type} at ${dt}`);
});

test('ship x snaps to the nearest lane; shoulders only with Casual', () => {
  const table = [
    // [x, shoulders, lane]
    [0, false, 0], [1.4, false, 0], [-1.6, false, -1], [2.9, false, 1], [4.5, false, 1],
    [3.7, true, 1], [-3.7, true, -1], [3.8, true, null], [-4.5, true, null],
  ];
  for (const [x, shoulders, lane] of table) assert.equal(laneAt(x, shoulders), lane, `x ${x} shoulders ${shoulders}`);
  assert.equal(clampShipX(9), 3);
  assert.equal(clampShipX(-9, true), -4.5);
});
