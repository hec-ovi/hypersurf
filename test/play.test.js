import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemoSong } from '../src/audio/demo.js';
import { analyzeAudio } from '../src/audio/analyze.js';
import { buildSongMap, BLOCK, MODES } from '../src/audio/songmap.js';
import { RulesEngine, EVENT } from '../src/game/rules.js';

const demo = generateDemoSong();
const features = analyzeAudio(demo.channels, demo.sampleRate);
const maps = Object.fromEntries(Object.keys(MODES).map((mode) => [mode, buildSongMap(features, { mode, seed: 'demo' })]));

const STEP = 1 / 240;

/**
 * A simple bot: steer for the next colour or power block and, if a grey or
 * spike is about to arrive in that lane first, move to the free lane beside it.
 */
function bot(blocks) {
  let i = 0;
  return (t) => {
    while (i < blocks.count && blocks.time[i] + 0.07 < t) i++;
    let target = 0, found = false;
    for (let k = i; k < blocks.count && blocks.time[k] < t + 0.5; k++) {
      if (blocks.type[k] !== BLOCK.GREY) { target = blocks.lane[k]; found = true; break; }
    }
    if (!found) return 0;
    for (let k = i; k < blocks.count && blocks.time[k] < t + 0.05; k++) {
      if (blocks.type[k] === BLOCK.GREY && blocks.lane[k] === target && blocks.time[k] + 0.02 >= t) {
        target = target === 0 ? 1 : 0;
        break;
      }
    }
    return target * 3;
  };
}

function playSong(map, ship) {
  const game = new RulesEngine(map.blocks, map.mode);
  const tally = { collected: 0, hits: 0, misses: 0 };
  const end = map.duration + 3;
  const t0 = performance.now();
  for (let k = 1; k * STEP <= end; k++) {
    const t = k * STEP;
    game.step(t, ship(t));
    for (let e = 0; e < game.eventCount; e++) {
      const ev = game.events[e];
      if (ev.type === EVENT.COLLECT) tally.collected += ev.value;
      else if (ev.type === EVENT.MISS) tally.misses++;
      else if (ev.type !== EVENT.MATCH && ev.block >= 0) tally.hits++;
    }
    game.clearEvents();
  }
  const ms = performance.now() - t0;
  const results = game.results();
  for (let e = 0; e < game.eventCount; e++) if (game.events[e].type === EVENT.COLLECT) tally.collected += game.events[e].value;
  return { game, results, tally, ms };
}

test('the demo plays through every mode with consistent bookkeeping', (t) => {
  for (const [mode, map] of Object.entries(maps)) {
    const { game, results, tally, ms } = playSong(map, bot(map.blocks));
    const s = results.stats;
    t.diagnostic(`${mode}: raw ${results.raw}, final ${results.final} (${results.bonuses.map((b) => `${b.id} +${b.points}`).join(', ') || 'no bonus'}); `
      + `colour ${s.colourHit}/${s.colour}, grey ${s.greyHit}/${s.grey}, power ${s.powerHit}/${s.power}, `
      + `matches ${s.matches}, biggest ${s.biggestMatch}, overfills ${s.overfills}; ${Math.round(240 * (map.duration + 3))} steps in ${ms.toFixed(1)} ms`);
    assert.equal(game.droppedEvents, 0);
    assert.equal(tally.hits + tally.misses, map.blocks.count, 'every block resolved once');
    assert.equal(s.colourHit + s.greyHit + s.powerHit, tally.hits);
    assert.equal(tally.collected, results.raw, 'collect events add up to the raw score');
    assert.equal(results.final, results.raw + results.bonuses.reduce((a, b) => a + b.points, 0));
    assert.ok(s.colourHit > 0.8 * s.colour, `${mode}: the bot takes most colours`);
    assert.ok(s.powerHit === s.power, `${mode}: the bot takes every power block`);
    assert.ok(results.raw > 0);
  }
});

test('the same song and route always give the same score', () => {
  const map = maps.mono;
  const a = playSong(map, bot(map.blocks)).results;
  const b = playSong(map, bot(map.blocks)).results;
  assert.deepEqual(a, b);
  // Steering matters: parking in the centre lane scores less.
  const idle = playSong(map, () => 0).results;
  assert.ok(idle.raw < a.raw, `idle ${idle.raw} vs bot ${a.raw}`);
});
