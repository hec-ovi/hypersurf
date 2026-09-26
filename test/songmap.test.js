import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemoSong } from '../src/audio/demo.js';
import { analyzeAudio } from '../src/audio/analyze.js';
import { buildSongMap, BLOCK, LOOP, MODES, LAYOUT, NODE_RATE, LEAD_IN, makeGrid, gridPosition, gridTime } from '../src/audio/songmap.js';

const demo = generateDemoSong();
const features = analyzeAudio(demo.channels, demo.sampleRate);
const maps = Object.fromEntries(Object.keys(MODES).map((mode) => [mode, buildSongMap(features, { mode, seed: 'demo' })]));
const mono = maps.mono;

const blocksOf = (map) => Array.from({ length: map.blocks.count }, (_, i) => ({
  t: map.blocks.time[i], lane: map.blocks.lane[i], type: map.blocks.type[i], strength: map.blocks.strength[i],
  span: map.blocks.spanEnd[i] - map.blocks.time[i], filler: map.blocks.filler[i], band: map.blocks.band[i],
}));

test('demo power blocks sit within ±0.5 s of both drops', (t) => {
  for (const [mode, map] of Object.entries(maps)) {
    t.diagnostic(`${mode}: ${map.powerBlocks.map((p) => `${p.time.toFixed(3)} (rank ${p.rank})`).join(', ')}`);
    for (const drop of demo.truth.drops) {
      assert.ok(map.powerBlocks.some((pb) => Math.abs(pb.time - drop) <= 0.5), `${mode}: no PB near the drop at ${drop}`);
    }
    // The big one (rank 1) is at a drop too.
    const big = map.powerBlocks.find((pb) => pb.rank === 1);
    assert.ok(demo.truth.drops.some((d) => Math.abs(big.time - d) <= 0.5));
  }
});

test('songmap is deterministic: same input, identical hash', (t) => {
  const again = buildSongMap(features, { mode: 'mono', seed: 'demo' });
  assert.equal(again.hash, mono.hash);
  // The whole pipeline, from a fresh render of the demo, reproduces it too.
  const fresh = generateDemoSong();
  const map = buildSongMap(analyzeAudio(fresh.channels, fresh.sampleRate), { mode: 'mono', seed: 'demo' });
  t.diagnostic(`mono hash ${map.hash}`);
  assert.equal(map.hash, mono.hash);
  assert.deepEqual(map.blocks.lane, mono.blocks.lane);
  // A different seed changes lanes, not timing.
  const other = buildSongMap(features, { mode: 'mono', seed: 'another-song-id' });
  assert.notEqual(other.hash, mono.hash);
  assert.deepEqual(other.blocks.time, mono.blocks.time);
  assert.notDeepEqual(other.blocks.lane, mono.blocks.lane);
});

test('blocks come from onsets, snapped to the quarter-beat grid', () => {
  const grid = makeGrid(features.tempo.beats, features.tempo.bpm, features.duration);
  const blocks = blocksOf(mono).filter((b) => b.type !== BLOCK.POWER && !b.filler);
  assert.ok(blocks.length <= features.onsets.times.length, 'never more blocks than onsets');
  let onGrid = 0;
  for (const b of blocks) {
    const p = gridPosition(grid, b.t);
    if (Math.abs(gridTime(grid, Math.round(p * 4) / 4) - b.t) < 1e-6) onGrid++;
    // Each block is within the snap window of a detected onset.
    const near = features.onsets.times.some((o) => Math.abs(o - b.t) <= LAYOUT.snapWindow + 1e-3);
    assert.ok(near, `block at ${b.t} has no onset`);
  }
  assert.ok(onGrid / blocks.length > 0.95, `${onGrid}/${blocks.length} on the grid`);
});

test('density caps hold per mode and each easier mode cuts density by at least 20%', (t) => {
  const counts = {};
  for (const [mode, map] of Object.entries(maps)) {
    const times = Array.from(map.blocks.time);
    const limit = Math.floor(MODES[mode].maxRate * LAYOUT.capWindow);
    let worst = 0;
    for (let i = 0; i < times.length; i++) {
      let j = i;
      while (j < times.length && times[j] < times[i] + LAYOUT.capWindow) j++;
      worst = Math.max(worst, j - i);
    }
    assert.ok(worst <= limit, `${mode}: ${worst} blocks in ${LAYOUT.capWindow} s (limit ${limit})`);
    counts[mode] = times.length;
  }
  t.diagnostic(`blocks: casual ${counts.casual}, mono ${counts.mono}, ninja ${counts.ninja}`);
  assert.ok(counts.mono <= 0.8 * counts.ninja);
  assert.ok(counts.casual <= 0.8 * counts.mono);
});

test('greys: weakest 23% (Ninja 35%) plus the longest spans', () => {
  for (const [mode, map] of Object.entries(maps)) {
    const blocks = blocksOf(map).filter((b) => b.type !== BLOCK.POWER);
    const greys = blocks.filter((b) => b.type === BLOCK.GREY);
    const frac = greys.length / blocks.length;
    const want = MODES[mode].greyFraction;
    assert.ok(frac >= want - 0.01 && frac <= want + MODES[mode].spanGreyFraction + 0.01, `${mode}: ${frac}`);
    // Every colour block is at least as strong as the weakest-set greys.
    const weakGreys = greys.filter((b) => b.span <= 0);
    const maxWeakGrey = Math.max(...weakGreys.map((b) => b.strength));
    for (const b of blocks) if (b.type === BLOCK.COLOUR) assert.ok(b.strength >= maxWeakGrey);
  }
});

test('lanes obey the spacing rules and power blocks sit in the centre', () => {
  for (const map of Object.values(maps)) {
    const blocks = blocksOf(map);
    for (const b of blocks) assert.ok([-1, 0, 1].includes(b.lane));
    for (const b of blocks.filter((x) => x.type === BLOCK.POWER)) assert.equal(b.lane, 0);
    const kind = (b) => (b.type === BLOCK.GREY ? 1 : 0);
    for (let i = 1; i < blocks.length; i++) {
      const a = blocks[i - 1], b = blocks[i], dt = b.t - a.t;
      if (b.lane === a.lane) assert.ok(dt >= LAYOUT.sameLaneGap, `same lane ${dt.toFixed(3)} s apart at ${b.t}`);
      if (kind(a) !== kind(b) && dt < LAYOUT.typeGap) assert.notEqual(a.lane, b.lane, `mixed types share a lane at ${b.t}`);
      if (kind(a) === kind(b) && dt < LAYOUT.outerPairGap && a.lane !== 0) assert.notEqual(b.lane, -a.lane, `outer-outer pair at ${b.t}`);
    }
    // All three lanes get used.
    for (const lane of [-1, 0, 1]) assert.ok(blocks.filter((b) => b.lane === lane).length > blocks.length * 0.15);
  }
});

test('chain spans exist and stay within 2 s', () => {
  const spans = blocksOf(mono).filter((b) => b.span > 0);
  assert.ok(spans.length > 0);
  for (const b of spans) assert.ok(b.span >= LAYOUT.spanMin && b.span <= LAYOUT.spanMax);
});

test('track nodes: speed follows intensity, slope is rate limited, path is continuous', () => {
  const n = mono.nodes;
  assert.equal(n.rate, NODE_RATE);
  assert.equal(n.count, Math.ceil((LEAD_IN + features.duration + 3) * NODE_RATE) + 1);
  const k0 = LEAD_IN * NODE_RATE;
  assert.deepEqual([n.pos[k0 * 3], n.pos[k0 * 3 + 1], n.pos[k0 * 3 + 2], n.dist[k0]], [0, 0, 0, 0]);
  const at = (s) => Math.round((s + LEAD_IN) * NODE_RATE);
  assert.ok(n.speed[at(60)] > 65 && n.speed[at(90)] < 30, 'fast in the drop, slow in the break');
  assert.ok(n.pitch[at(60)] < -30 * (Math.PI / 180), 'downhill in the drop');
  assert.ok(n.pitch[at(90)] > 5 * (Math.PI / 180), 'uphill in the break');
  const maxStep = (LAYOUT.pitchRate / NODE_RATE) * (Math.PI / 180) + 1e-6;
  for (let k = 1; k < n.count; k++) {
    assert.ok(n.dist[k] > n.dist[k - 1], 'distance strictly increases');
    assert.ok(Math.abs(n.pitch[k] - n.pitch[k - 1]) <= maxStep, `pitch jumps at node ${k}`);
    assert.ok(n.speed[k] >= MODES.mono.speedMin - 1e-3 && n.speed[k] <= MODES.mono.speedMax + 1e-3);
    const step = Math.hypot(n.pos[k * 3] - n.pos[k * 3 - 3], n.pos[k * 3 + 1] - n.pos[k * 3 - 2], n.pos[k * 3 + 2] - n.pos[k * 3 - 1]);
    assert.ok(step < 5, `gap of ${step} m at node ${k}`);
    const upLen = Math.hypot(n.up[k * 3], n.up[k * 3 + 1], n.up[k * 3 + 2]);
    const dot = n.up[k * 3] * n.fwd[k * 3] + n.up[k * 3 + 1] * n.fwd[k * 3 + 1] + n.up[k * 3 + 2] * n.fwd[k * 3 + 2];
    assert.ok(Math.abs(upLen - 1) < 1e-4 && Math.abs(dot) < 1e-4, 'orthonormal frame');
  }
});

test('each power block gets a loop: the big one a double corkscrew, the weakest a plain loop', () => {
  const n = mono.nodes;
  const byRank = [...mono.powerBlocks].sort((a, b) => a.rank - b.rank);
  assert.equal(byRank[0].loop.type, LOOP.DOUBLE);
  if (byRank.length > 1) assert.equal(byRank[byRank.length - 1].loop.type, LOOP.PLAIN);
  for (const pb of byRank) {
    const { start, end } = pb.loop;
    assert.ok(end - start >= 2.5 && end - start <= 3);
    assert.ok(Math.abs((start + end) / 2 - pb.time) < 1e-9, 'centred on the power block');
    const k = Math.round((end + LEAD_IN) * NODE_RATE) - 1;
    if (pb.loop.type === LOOP.DOUBLE) assert.ok(Math.abs(n.roll[k] - 4 * Math.PI) < 0.01);
    if (pb.loop.type === LOOP.CORKSCREW) assert.ok(Math.abs(n.roll[k] - 2 * Math.PI) < 0.01);
  }
});

// --- synthetic features ------------------------------------------------------

function syntheticFeatures({ duration = 64, bpm = 120, onsets = [], silentFrom = Infinity } = {}) {
  const fr = 22050 / 512, frames = Math.ceil(duration * fr) + 1;
  const beats = Float64Array.from({ length: Math.floor((duration * bpm) / 60) }, (_, i) => (i * 60) / bpm);
  const n = Math.ceil(duration * 10) + 1;
  const lufs = Float32Array.from({ length: n }, (_, k) => (k / 10 >= silentFrom ? -70 : -20));
  const flat = (v) => [0, 1, 2].map(() => new Float32Array(frames).fill(v));
  return {
    duration, frameRate: fr,
    onsets: { times: Float64Array.from(onsets.map((o) => o.t)), strength: Float32Array.from(onsets.map((o) => o.s)), band: Uint8Array.from(onsets.map((o) => o.band)) },
    bandFlux: flat(0.1), bandPower: flat(1),
    skyline: new Uint8Array(frames * 16), skylineBands: 16,
    tempo: { bpm, beats, downbeatPhase: 0 },
    intensity: { rate: 10, lufs, raw: new Float32Array(n).fill(0.5), smooth: new Float32Array(n).fill(0.5) },
  };
}

test('repeated 8-beat patterns reuse their lanes, mirrored on alternate repeats', () => {
  // Beat positions (in beats) and bands of one two-bar phrase at 120 BPM.
  const phrase = [[0, 0], [1, 1], [1.5, 2], [2, 0], [3, 1], [4, 0], [4.5, 2], [5, 1], [6, 0], [7, 2]];
  const onsets = [];
  for (let rep = 0; rep < 8; rep++) {
    phrase.forEach(([beat, band], i) => onsets.push({ t: (rep * 8 + beat) * 0.5, s: 0.3 + 0.07 * i, band }));
  }
  const map = buildSongMap(syntheticFeatures({ onsets }), { seed: 'pattern' });
  const blocks = blocksOf(map).filter((b) => b.type !== BLOCK.POWER);
  const reps = Array.from({ length: 8 }, (_, r) => blocks.filter((b) => b.t >= r * 4 - 0.01 && b.t < r * 4 + 3.99).map((b) => b.lane));
  assert.ok(reps[0].some((l) => l !== 0), 'the phrase uses outer lanes');
  for (let r = 1; r < 8; r++) {
    const mirrored = r % 2 === 1;
    const expected = reps[0].map((l) => (mirrored && l ? -l : l));
    assert.deepEqual(reps[r], expected, `repeat ${r}`);
  }
});

test('quiet stretches get half-density beat blocks, but silence stays empty', () => {
  const onsets = [];
  for (let t = 0; t < 20; t += 0.5) onsets.push({ t, s: 0.5, band: 1 });
  for (let t = 30; t < 40; t += 0.5) onsets.push({ t, s: 0.5, band: 1 });
  for (let t = 50; t < 60; t += 0.5) onsets.push({ t, s: 0.5, band: 1 });
  const features = syntheticFeatures({ onsets, silentFrom: 40.5 });
  features.intensity.lufs.fill(-20, 50 * 10); // audible again from 50 s
  const map = buildSongMap(features, { seed: 'quiet' });
  const fillers = blocksOf(map).filter((b) => b.filler);
  const inGap = fillers.filter((b) => b.t > 20 && b.t < 30);
  assert.ok(inGap.length >= 8 && inGap.length <= 10, `${inGap.length} fillers at half density`);
  for (let i = 1; i < inGap.length; i++) assert.ok(Math.abs(inGap[i].t - inGap[i - 1].t - 1) < 1e-9, 'every other beat');
  assert.equal(fillers.filter((b) => b.t > 40.5 && b.t < 50).length, 0, 'none in silence');
});
