import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemoSong } from '../src/audio/demo.js';
import { analyzeAudio } from '../src/audio/analyze.js';
import { buildSongMap, BLOCK, LOOP, MODES, LAYOUT, NODE_RATE, LEAD_IN, makeGrid, gridPosition, gridTime } from '../src/audio/songmap.js';

const DEG = Math.PI / 180;

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
      const b = blocks[i];
      let lastSame = null;
      for (let j = i - 1; j >= 0 && b.t - blocks[j].t < LAYOUT.outerPairGap; j--) {
        const a = blocks[j], dt = b.t - a.t;
        if (b.lane === a.lane) assert.ok(dt >= LAYOUT.sameLaneGap, `same lane ${dt.toFixed(3)} s apart at ${b.t}`);
        if (kind(a) !== kind(b) && dt < LAYOUT.typeGap) assert.notEqual(a.lane, b.lane, `mixed types share a lane at ${b.t}`);
        if (!lastSame && kind(a) === kind(b)) lastSame = a;
      }
      if (lastSame && lastSame.lane !== 0) assert.notEqual(b.lane, -lastSame.lane, `outer-outer pair at ${b.t}`);
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

// --- structure features ------------------------------------------------------

/** Every big moment of a map (power-block loops and features), by start. */
const bigMoments = (map) => [...map.powerBlocks.map((pb) => pb.loop), ...map.features].sort((a, b) => a.start - b.start);
const nodeAt = (t) => Math.round((t + LEAD_IN) * NODE_RATE);

test('the demo gets twists and flips on its section lines, spaced, none in the intro', (t) => {
  const bar = (4 * 60) / demo.truth.bpm;
  for (const [mode, map] of Object.entries(maps)) {
    t.diagnostic(`${mode}: ${map.features.map((f) => `${Object.keys(LOOP)[f.type]} ${f.time.toFixed(2)}`).join(', ')}; ${map.sweeps.length} sweeps`);
    assert.ok(map.features.some((f) => f.type === LOOP.TWIST), `${mode}: a twist`);
    // The break is where the song falls: that is a flip.
    assert.ok(map.features.some((f) => f.type === LOOP.FLIP && Math.abs(f.time - demo.truth.sections.find((s) => s.name === 'break').start) < 0.1), `${mode}: a flip into the break`);
    for (const f of map.features) {
      assert.ok(f.start >= LAYOUT.featureNotBefore, `${mode}: nothing in the first 10 s (${f.start})`);
      assert.ok(Math.abs(f.time / bar - Math.round(f.time / bar)) * bar < 0.03, `${mode}: ${f.time} is on a bar line`);
    }
    const all = bigMoments(map);
    for (let i = 1; i < all.length; i++) assert.ok(all[i].start - all[i - 1].end >= LAYOUT.featureGap - 1e-9, `${mode}: ${all[i - 1].end} → ${all[i].start}`);
  }
  // Deterministic: the same analysis gives the same features and sweeps.
  const again = buildSongMap(features, { mode: 'mono', seed: 'demo' });
  assert.deepEqual(again.features, mono.features);
  assert.deepEqual(again.sweeps, mono.sweeps);
});

test('twists roll a full turn, flips hold the track upside down, sweeps bank and loops do not', () => {
  const n = mono.nodes;
  const upY = (k) => n.up[k * 3 + 1];
  for (const f of mono.features) {
    const a = nodeAt(f.start), b = nodeAt(f.end) - 1;
    assert.ok(Math.abs(n.roll[a]) < 0.02, `level on entry at ${f.start}`);
    assert.ok(Math.abs(Math.abs(n.roll[b]) - 2 * Math.PI) < 0.05, `a full turn by ${f.end}: ${n.roll[b]}`);
    if (f.type === LOOP.TWIST) assert.ok(upY(nodeAt(f.time)) < -0.5, 'upside down halfway through a twist');
    if (f.type === LOOP.FLIP) {
      for (let k = Math.ceil((f.inEnd + LEAD_IN) * NODE_RATE); k <= Math.floor((f.outStart + LEAD_IN) * NODE_RATE); k++) {
        assert.ok(Math.abs(Math.abs(n.roll[k]) - Math.PI) < 1e-3, 'held at half a turn');
        assert.ok(upY(k) < -0.8, `upside down at ${k}`);
        assert.equal(n.loop[k], LOOP.NONE, 'the upside-down stretch is not marked as a loop');
      }
      assert.equal(n.loop[nodeAt((f.start + f.inEnd) / 2)], LOOP.FLIP, 'the half-twists are');
    }
  }
  // Sweeps lean into the curve, within the cap; big moments carry no bank at all.
  let maxBank = 0;
  const inBig = (t) => bigMoments(mono).some((m) => t >= m.start - 0.2 && t <= m.end + 0.2);
  for (let k = 0; k < n.count; k++) {
    const t = n.t0 + k / n.rate;
    if (inBig(t)) continue;
    const cap = LAYOUT.bankMax * DEG * (0.35 + 0.65 * n.intensity[k]) + 1e-6;
    assert.ok(Math.abs(n.roll[k]) <= Math.max(cap, LAYOUT.bankMax * DEG), `bank at ${t}`);
    maxBank = Math.max(maxBank, Math.abs(n.roll[k]));
  }
  assert.ok(maxBank > 15 * DEG, `sweeps bank (max ${(maxBank / DEG).toFixed(1)}°)`);
  for (const w of mono.sweeps) {
    assert.ok(w.start >= LAYOUT.featureNotBefore && w.end - w.start >= LAYOUT.sweepMin);
    assert.ok(!bigMoments(mono).some((m) => w.start < m.end + LAYOUT.sweepClear - 1e-9 && w.end > m.start - LAYOUT.sweepClear + 1e-9), 'sweeps keep clear of big moments');
  }
});

/** Flat-spectrum features whose raw intensity steps through `levels` ([from, level]). */
function steppedFeatures(levels, duration) {
  const onsets = [];
  for (let t = 0; t < duration; t += 0.5) onsets.push({ t, s: 0.5, band: 0 });
  const f = syntheticFeatures({ duration, onsets });
  const n = f.intensity.raw.length;
  for (let k = 0; k < n; k++) {
    let v = levels[0][1];
    for (const [from, level] of levels) if (k / 10 >= from) v = level;
    f.intensity.raw[k] = v;
    f.intensity.smooth[k] = v;
  }
  return f;
}

test('section changes: a fall is a flip, a rise without a power block a twist; power-block loops stay as they were', () => {
  const f = steppedFeatures([[0, 0.3], [30, 0.8], [60, 0.2], [90, 0.8], [120, 0.3], [150, 0.9]], 190);
  // Casual keeps two power blocks: the biggest rises (90 and 150 s), so the smaller one at 30 s is a twist.
  const map = buildSongMap(f, { mode: 'casual', seed: 'steps' });
  const half = LAYOUT.loopLength / 2;
  const pbs = map.powerBlocks.map((pb) => [pb.time, pb.rank, pb.loop.type, pb.loop.start, pb.loop.end]);
  assert.deepEqual(pbs, [[90, 1, LOOP.DOUBLE, 90 - half, 90 + half], [150, 2, LOOP.PLAIN, 150 - half, 150 + half]]);
  assert.deepEqual(map.features.map((x) => [x.type, x.time]), [[LOOP.TWIST, 30], [LOOP.FLIP, 60], [LOOP.FLIP, 120]]);
  const flip = map.features[1];
  assert.equal(flip.end - flip.start, 4 * 2 + Math.min(2.2, Math.max(1.4, 2)), 'a half-twist, four bars upside down, a half-twist');
  // Mono has power blocks for every rise, so only the falls are features.
  const mono3 = buildSongMap(f, { mode: 'mono', seed: 'steps' });
  assert.deepEqual(mono3.powerBlocks.map((pb) => pb.time), [30, 90, 150]);
  assert.deepEqual(mono3.features.map((x) => [x.type, x.time]), [[LOOP.FLIP, 60], [LOOP.FLIP, 120]]);
  // A song that never changes gets no features, only sweeps (after the intro).
  const flat = buildSongMap(steppedFeatures([[0, 0.5]], 120), { seed: 'flat' });
  assert.equal(flat.features.length, 0);
  assert.ok(flat.sweeps.length > 0 && flat.sweeps.every((w) => w.start >= LAYOUT.featureNotBefore));
});
