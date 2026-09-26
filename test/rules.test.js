import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK, MODES } from '../src/audio/songmap.js';
import {
  ROWS, laneAt, clampShipX, inHitWindow, matchPoints, fallHold, scoringGroups, hasMatch,
  RulesEngine, makeBlocks, RULES, GREY_EFFECT, EVENT, REASON,
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

// --- engine -----------------------------------------------------------------

const C = BLOCK.COLOUR, G = BLOCK.GREY, P = BLOCK.POWER;
const block = (t, lane, type = C, extra = {}) => ({ t, lane, type, ...extra });
const centre = (...times) => times.map((t) => block(t, 0));

/** Ship route: [[fromTime, x], ...]; the last entry at or before t wins. */
const route = (...legs) => (t) => {
  let x = legs[0][1];
  for (const [from, lx] of legs) if (t >= from) x = lx;
  return x;
};

/** Play a block list at a fixed step and return the engine, every event and the results. */
function play(mode, list, { ship = () => 0, until, dt = 0.001, finishAt } = {}) {
  const blocks = makeBlocks(list);
  const game = new RulesEngine(blocks, mode);
  const end = until ?? (list.length ? Math.max(...list.map((b) => b.t)) + 4 : 4);
  const events = [];
  const stop = finishAt ?? end;
  for (let k = 1; ; k++) {
    const t = -0.5 + k * dt;
    if (t > stop + 1e-9) break;
    game.step(t, ship(t));
    for (let e = 0; e < game.eventCount; e++) events.push({ ...game.events[e] });
    game.clearEvents();
  }
  const results = game.results();
  for (let e = 0; e < game.eventCount; e++) events.push({ ...game.events[e] });
  return { game, events, results, collects: events.filter((e) => e.type === EVENT.COLLECT) };
}

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

test('match timer: 1.5 s (Casual 1.75 s) after the falling block lands', () => {
  // Hits land 20 ms early (the window opens then); the third block falls
  // past 5 empty rows, holding the timer 0.75 s, until 1.93 s.
  const table = [
    // [mode, blocks, collect time, points]
    ['mono', centre(1.0, 1.1, 1.2), 3.43, 315],
    ['ninja', centre(1.0, 1.1, 1.2), 3.43, 315],
    ['casual', centre(1.0, 1.1, 1.2), 3.68, 315],
    // A hit resets the timer: 2.98 + hold 0.65 + 1.5.
    ['mono', centre(1.0, 1.1, 1.2, 3.0), 5.13, 560],
    ['casual', centre(1.0, 1.1, 1.2, 3.0), 5.38, 560],
    // Two blocks are not a match: no timer, nothing scored.
    ['mono', centre(1.0, 1.1), null, 0],
  ];
  for (const [mode, list, when, points] of table) {
    const { collects, results } = play(mode, list);
    const name = `${mode} ${list.length} blocks`;
    assert.equal(results.raw, points, name);
    if (when === null) { assert.equal(collects.length, 0, name); continue; }
    assert.equal(collects.length, 1, name);
    near(collects[0].time, when, name);
    assert.equal(collects[0].reason, REASON.TIMER, name);
  }
});

test('greys: eraseone takes the top block and resets the timer (Mono, Casual)', () => {
  const table = [
    // [mode, blocks, ship, points, collect time]
    // Grey on an empty column at 3.0 (taken at 2.99): nothing erased, timer reset.
    ['mono', [...centre(1.0, 1.1, 1.2), block(3.0, 1, G)], route([-1, 0], [2.9, 3]), 315, 4.49],
    ['casual', [...centre(1.0, 1.1, 1.2), block(3.0, 1, G)], route([-1, 0], [2.9, 3]), 315, 4.74],
    // Dodged, the grey changes nothing.
    ['mono', [...centre(1.0, 1.1, 1.2), block(3.0, 1, G)], () => 0, 315, 3.43],
    // Four blocks, then a grey on their column: three are left to score.
    ['mono', [...centre(1.0, 1.1, 1.2, 1.3), block(1.5, 0, G)], () => 0, 315, 3.43],
    // Grey breaks the match: two left, no timer, nothing scored.
    ['mono', [...centre(1.0, 1.1, 1.2), block(1.5, 0, G)], () => 0, 0, null],
  ];
  for (const [mode, list, ship, points, when] of table) {
    const { collects, results, events, game } = play(mode, list, { ship });
    const name = `${mode} ${list.length} blocks, collect ${when}`;
    assert.equal(results.raw, points, name);
    if (when !== null) near(collects[0].time, when, name);
    else assert.equal(collects.length, 0, name);
    const greys = events.filter((e) => e.type === EVENT.GREY);
    assert.equal(greys.length, results.stats.greyHit, name);
    if (when === null) assert.deepEqual([...game.heights], [0, 2, 0], name);
  }
});

test('Ninja spikes wipe the whole grid (eraseall)', () => {
  const list = [...centre(1.0, 1.1, 1.2, 1.3), block(1.25, -1, C), block(1.6, 1, G)];
  const ship = route([-1, 0], [1.22, -3], [1.27, 0], [1.5, 3]);
  const { results, events, game, collects } = play('ninja', list, { ship });
  const spike = events.find((e) => e.type === EVENT.SPIKE);
  assert.ok(spike, 'spike hit');
  assert.equal(spike.count, 5, 'blocks lost');
  assert.deepEqual([...game.heights], [0, 0, 0]);
  assert.equal(collects.length, 0);
  assert.equal(results.raw, 0);
  // The same route in Mono only erases the top of the (empty) right column.
  const mono = play('mono', list, { ship });
  assert.equal(mono.results.raw, 35 * 25);
});

test('riding a chain span pauses the timer, even with its block dodged', () => {
  // Grey in the left lane at 2.0 with a 1 s span. The ship dodges the grey
  // and moves onto the span at 2.1: the timer ran 1.93 → 2.1 (0.17 s),
  // pauses to 3.0, then runs the remaining 1.33 s. (Routes switch half a
  // 1 ms step early so the ride starts exactly on a step boundary.)
  const list = [...centre(1.0, 1.1, 1.2), block(2.0, -1, G, { span: 1.0 })];
  const table = [
    // [mode, ship, collect time]
    ['mono', route([-1, 0], [2.1005, -3]), 4.33],
    ['mono', () => 0, 3.43],
    ['casual', route([-1, 0], [2.1005, -3]), 4.58],
    // On the shoulder the ship is off the span.
    ['casual', route([-1, 0], [2.1005, -4.5]), 3.68],
    // Riding only part of the span pauses only that part: 2.1 → 2.5.
    ['mono', route([-1, 0], [2.1005, -3], [2.5005, 0]), 3.83],
  ];
  for (const [mode, ship, when] of table) {
    const { collects, results } = play(mode, list, { ship });
    assert.equal(results.stats.greyHit, 0, `${mode} dodged the grey`);
    assert.equal(collects.length, 1);
    near(collects[0].time, when, `${mode} → ${when}`);
  }
});

test('overfill: an 8th block on a full column cashes in and seeds a new grid', () => {
  const eight = centre(...Array.from({ length: 8 }, (_, k) => 1.0 + 0.2 * k));
  const { collects, game, results } = play('mono', eight);
  assert.equal(collects.length, 1);
  assert.equal(collects[0].reason, REASON.OVERFILL);
  assert.equal(collects[0].value, 1715);
  near(collects[0].time, 2.38, 'at the 8th hit');
  assert.deepEqual([...game.heights], [0, 1, 0], 'the 8th block starts the new grid');
  assert.equal(results.stats.overfills, 1);
});

test('power blocks: ×1.5 (big ×2) on a live match, otherwise the grid is duplicated', () => {
  const table = [
    // [blocks, points, stat]
    [[...centre(1.0, 1.1, 1.2), block(1.5, 0, P, { rank: 2 })], 473, 'multiplied'], // 315 × 1.5 = 472.5
    [[...centre(1.0, 1.1, 1.2), block(1.5, 0, P, { rank: 1 })], 630, 'multiplied'],
    // Two PBs on one match: the bigger multiplier wins, they do not stack.
    [[...centre(1.0, 1.1, 1.2), block(1.4, 0, P, { rank: 2 }), block(1.6, 0, P, { rank: 1 })], 630, 'multiplied'],
    // Two blocks, no match: duplicated to four, which then scores.
    [[...centre(1.0, 1.1), block(1.5, 0, P, { rank: 1 })], 560, 'duplications'],
    // Two per outer column: both duplicated to four, scored separately.
    [[block(1.0, -1), block(1.1, -1), block(1.2, 1), block(1.3, 1), block(1.5, 0, P, { rank: 2 })], 1120, 'duplications'],
    // Empty grid: nothing to duplicate.
    [[block(1.5, 0, P, { rank: 1 }), ...centre(3.0, 3.1, 3.2)], 315, 'duplications'],
  ];
  for (const [list, points, stat] of table) {
    const ship = (t) => {
      const next = list.find((b) => b.t + 0.07 >= t) ?? list[list.length - 1];
      return next.lane * 3;
    };
    const { results } = play('mono', list, { ship });
    assert.equal(results.raw, points, `${list.length} blocks → ${points}`);
    assert.ok(results.stats[stat] > 0, stat);
    assert.equal(results.stats.powerHit, list.filter((b) => b.type === P).length);
  }
});

test('an overfill within 1 s of a power block pays a quarter', () => {
  // Left 2, right 2, PB duplicates to 4 + 4, three more left make 7, and
  // the next left block overfills: 35·7² + 35·4² = 2275.
  const make = (last) => [
    block(0.2, -1), block(0.4, -1), block(0.6, 1), block(0.8, 1), block(1.0, 0, P, { rank: 2 }),
    block(1.2, -1), block(1.4, -1), block(1.6, -1), block(last, -1),
  ];
  const ship = route([-1, -3], [0.5, 3], [0.9, 0], [1.1, -3]);
  const table = [
    // [last block, reason, points]
    [1.8, REASON.PB_OVERFILL, 569], // 2275 / 4 = 568.75, 0.8 s after the PB
    [2.1, REASON.OVERFILL, 2275], // 1.1 s after
  ];
  for (const [last, reason, points] of table) {
    const { collects } = play('mono', make(last), { ship });
    assert.equal(collects[0].reason, reason, `last block at ${last}`);
    assert.equal(collects[0].value, points, `last block at ${last}`);
  }
});

test('hit windows decide hits in the engine, whatever the step', () => {
  const table = [
    // [type, ship in the lane from dt to dt + 2 ms, hit]
    [C, -0.025, false], [C, -0.018, true], [C, 0.065, true], [C, 0.072, false],
    [P, -0.018, true], [P, 0.072, false],
    [G, -0.014, false], [G, -0.008, true], [G, 0.015, true], [G, 0.02, false],
  ];
  for (const [type, dt, hit] of table) {
    const ship = (t) => (t >= 1 + dt && t <= 1 + dt + 0.002 ? 3 : 0);
    const { results } = play('mono', [block(1, 1, type, { rank: 1 })], { ship });
    const taken = results.stats.colourHit + results.stats.greyHit + results.stats.powerHit;
    assert.equal(taken, hit ? 1 : 0, `type ${type} at ${dt}`);
  }
  // At a coarse 30 Hz step the ship still catches a 28 ms grey window.
  const coarse = play('mono', [block(1, 1, G)], { ship: () => 3, dt: 1 / 30 });
  assert.equal(coarse.results.stats.greyHit, 1);
});

test('Casual shoulders are safe; without shoulders x clamps into the outer lane', () => {
  const list = [block(1, 1), block(1.5, 1, G), block(2, -1), block(2.5, -1, G)];
  const table = [
    // [mode, |x|, taken]
    ['casual', 4.5, 0],
    ['casual', 3.5, 4],
    ['mono', 4.5, 4],
  ];
  for (const [mode, x, taken] of table) {
    const ship = (t) => (t < 1.75 ? x : -x);
    const { results } = play(mode, list, { ship });
    assert.equal(results.stats.colourHit + results.stats.greyHit, taken, `${mode} at ±${x}`);
  }
});

test('results: raw → bonuses (Clean Finish 10%, Ninja Stealth 25%) → final', () => {
  const three = centre(1.0, 1.1, 1.2);
  const table = [
    // [name, mode, blocks, ship, options, raw, bonuses, final]
    ['mono clean', 'mono', three, () => 0, {}, 315, [['clean', 32]], 347],
    ['casual clean', 'casual', three, () => 0, {}, 315, [['clean', 32]], 347],
    ['mono leftover block', 'mono', [...three, block(5, -1)], (t) => (t < 4 ? 0 : -3), {}, 315, [], 315],
    // A live match is scored at the finish, then the grid is empty.
    ['mono finish mid-timer', 'mono', three, () => 0, { finishAt: 2 }, 315, [['clean', 32]], 347],
    // Greys cost Mono nothing at the finish.
    ['mono grey taken', 'mono', [...three, block(5, 1, G)], (t) => (t < 4 ? 0 : 3), {}, 315, [['clean', 32]], 347],
    // Ninja: no Clean Finish; Stealth when no spike was hit.
    ['ninja stealth', 'ninja', [...three, block(5, 1, G)], () => 0, {}, 315, [['stealth', 79]], 394],
    ['ninja spike hit', 'ninja', [...three, block(5, 1, G)], (t) => (t < 4 ? 0 : 3), {}, 315, [], 315],
    ['ninja no spikes', 'ninja', three, () => 0, {}, 315, [], 315],
  ];
  for (const [name, mode, list, ship, opts, raw, bonuses, final] of table) {
    const { results, collects } = play(mode, list, { ship, ...opts });
    assert.equal(results.raw, raw, name);
    assert.deepEqual(results.bonuses.map((b) => [b.id, b.points]), bonuses, name);
    assert.equal(results.final, final, name);
    assert.equal(collects.reduce((a, e) => a + e.value, 0), raw, `${name}: collects add up`);
  }
  const { results } = play('mono', centre(1.0, 1.1, 1.2), { finishAt: 2 });
  assert.equal(results.bonuses[0].label, 'Clean Finish');
  assert.equal(results.bonuses[0].percent, 10);
});

test('modes are variants of one rule set', () => {
  const table = [
    // [mode, timer, grey effect, grey resets, shoulders, clean finish, stealth]
    ['mono', 1.5, GREY_EFFECT.ERASE_ONE, true, false, 0.1, 0],
    ['ninja', 1.5, GREY_EFFECT.ERASE_ALL, false, false, 0, 0.25],
    ['casual', 1.75, GREY_EFFECT.ERASE_ONE, true, true, 0.1, 0],
  ];
  for (const [mode, timer, grey, greyResets, shoulders, cleanFinish, stealth] of table) {
    assert.deepEqual({ ...RULES[mode] }, { timer, grey, greyResets, shoulders, cleanFinish, stealth }, mode);
  }
  // Generation side: Ninja is faster (×1.26), Casual slower with at most two power blocks.
  near(MODES.ninja.speedMax / MODES.mono.speedMax, 1.26, 'ninja speed');
  near(MODES.casual.speedMax / MODES.mono.speedMax, 0.8, 'casual speed');
  assert.ok(MODES.casual.maxPowerBlocks <= 2 && MODES.mono.maxPowerBlocks > 2);
  assert.throws(() => new RulesEngine(makeBlocks([]), 'wakeboard'));
});
