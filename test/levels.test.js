import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemoSong } from '../src/audio/demo.js';
import { analyzeAudio } from '../src/audio/analyze.js';
import { detectOnsets } from '../src/audio/onsets.js';
import { buildSongMap, speedDrive, makeGrid, gridPosition, LOOP, MODES, LAYOUT, NODE_RATE, LEAD_IN } from '../src/audio/songmap.js';
import { LEVEL_PRESETS, levelPreset } from '../src/audio/levels.js';

// The level presets on the synthesised demo (the real songs never enter the tests).
const demo = generateDemoSong();
const features = analyzeAudio(demo.channels, demo.sampleRate);
const P = LEVEL_PRESETS.nyan;
const plain = buildSongMap(features, { mode: 'mono', seed: 'demo' });
const level = buildSongMap(features, { mode: 'mono', seed: 'demo', level: 'nyan' });
const grid = makeGrid(features.tempo.beats, features.tempo.bpm, features.duration);
const nodeAt = (map, t) => Math.round((t - map.nodes.t0) * NODE_RATE);

test('a map without a level is the plain map, and a level changes it', () => {
  const again = buildSongMap(features, { mode: 'mono', seed: 'demo', level: null });
  assert.equal(again.hash, plain.hash);
  assert.equal(plain.level, null);
  assert.equal(plain.start, 0);
  assert.equal(level.level, 'nyan');
  assert.notEqual(level.hash, plain.hash);
  assert.throws(() => levelPreset('nope'), /unknown level/);
});

test('level maps are deterministic', () => {
  const again = buildSongMap(features, { mode: 'mono', seed: 'demo', level: 'nyan' });
  assert.equal(again.hash, level.hash);
  assert.deepEqual(again.features.map((f) => [f.type, f.start]), level.features.map((f) => [f.type, f.start]));
  assert.deepEqual(again.nodes.speed, level.nodes.speed);
  const other = buildSongMap(features, { mode: 'mono', seed: 'another', level: 'nyan' });
  assert.notEqual(other.hash, level.hash);
  assert.deepEqual(other.blocks.time, level.blocks.time);
});

test('the preset re-picks onsets from the kept envelope: the defaults give the analysis back', () => {
  const spec = { envelope: features.envelope, bandFlux: features.bandFlux, frameRate: features.frameRate };
  assert.deepEqual(detectOnsets(spec).times, features.onsets.times);
  assert.ok(detectOnsets(spec, { delta: P.onsetDelta }).times.length >= features.onsets.times.length);
});

test('the music starts on a beat, and nothing comes before it', (t) => {
  t.diagnostic(`start ${level.start.toFixed(3)} s, first block ${level.blocks.time[0].toFixed(3)} s`);
  assert.ok(level.start > 0);
  const p = gridPosition(grid, level.start);
  assert.ok(Math.abs(p - Math.round(p)) < 1e-3, 'start is on the beat grid');
  const k = Math.round(level.start * features.intensity.rate);
  assert.ok(features.intensity.raw[k] >= P.intro.level - 0.25, 'the song is loud by then');
  assert.ok(level.blocks.time[0] >= level.start - LAYOUT.mergeWindow);
  for (const f of level.features) assert.ok(f.start >= level.start + P.features.notBefore - 1e-9);
});

test('level blocks follow more notes under a higher, mode-scaled cap', (t) => {
  t.diagnostic(`blocks: plain ${plain.blocks.count}, level ${level.blocks.count}`);
  assert.ok(level.blocks.count > plain.blocks.count * 0.9);
  for (const mode of Object.keys(MODES)) {
    const map = buildSongMap(features, { mode, seed: 'demo', level: 'nyan' });
    const limit = Math.floor(((P.maxRate * MODES[mode].maxRate) / MODES.mono.maxRate) * LAYOUT.capWindow);
    const times = Array.from(map.blocks.time);
    for (let i = 0, j = 0; i < times.length; i++) {
      while (j < times.length && times[j] < times[i] + LAYOUT.capWindow) j++;
      assert.ok(j - i <= limit, `${mode}: ${j - i} blocks in ${LAYOUT.capWindow} s`);
    }
  }
});

test('speed drive: dense passages rush, sparse ones slow, silent ends stay low', () => {
  const S = { density: 1, window: 2, smooth: 0.3, curve: 1, pitchRate: 20 };
  // 60 s: sparse (1/s) for 20 s, dense (8/s) for 20 s, sparse again.
  const times = [];
  for (let t = 0; t < 60; t += 1) times.push(t);
  for (let t = 20; t < 40; t += 0.125) times.push(t);
  times.sort((a, b) => a - b);
  const I = new Float32Array(600).fill(0.5);
  const count = (LEAD_IN + 60) * NODE_RATE;
  const d = speedDrive(times, I, 10, 60, 5, S, count);
  const at = (t) => d[Math.round((t + LEAD_IN) * NODE_RATE)];
  assert.ok(at(30) > 0.9, `dense ${at(30)}`);
  assert.ok(at(12) < 0.4 && at(50) < 0.4, `sparse ${at(12)} ${at(50)}`);
  assert.ok(at(-2) < 0.05, 'low before the music starts');
  for (const v of d) assert.ok(v >= 0 && v <= 1);
});

test('level speed swings over the preset range with block density, downhill when dense', (t) => {
  const nd = level.nodes, times = Array.from(level.blocks.time);
  const k0 = nodeAt(level, level.start + 2), k1 = nodeAt(level, features.duration - 5);
  let lo = Infinity, hi = -Infinity;
  const xs = [], ys = [], pitch = [];
  for (let k = k0; k < k1; k += 15) {
    const tt = nd.t0 + k / NODE_RATE;
    lo = Math.min(lo, nd.speed[k]);
    hi = Math.max(hi, nd.speed[k]);
    xs.push(times.filter((b) => Math.abs(b - tt) <= P.speed.window / 2).length);
    ys.push(nd.speed[k]);
    pitch.push(nd.pitch[k]);
  }
  const corr = (a, b) => {
    const ma = a.reduce((x, y) => x + y) / a.length, mb = b.reduce((x, y) => x + y) / b.length;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return sab / Math.sqrt(saa * sbb);
  };
  const r = corr(xs, ys), rp = corr(ys, pitch);
  t.diagnostic(`speed ${lo.toFixed(1)}..${hi.toFixed(1)} m/s, density correlation ${r.toFixed(2)}, speed/pitch ${rp.toFixed(2)}`);
  assert.ok(hi >= P.speed.max * 0.97, 'reaches the top speed');
  assert.ok(hi >= MODES.ninja.speedMax * 1.3, 'well beyond Ninja');
  assert.ok(hi - lo >= 0.5 * (P.speed.max - P.speed.min), 'swings strongly');
  assert.ok(r > 0.5, 'follows the density');
  assert.ok(rp < -0.5, 'fast stretches point downhill');
});

test('level moments come every few seconds on bar lines, of every kind, never overlapping', (t) => {
  const f = level.features;
  const shapes = [...f, ...level.powerBlocks.map((pb) => pb.loop)].sort((a, b) => a.start - b.start);
  const kinds = new Set(shapes.map((x) => x.type));
  const starts = shapes.map((x) => x.start);
  const gaps = starts.slice(1).map((s, i) => s - starts[i]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  t.diagnostic(`${shapes.length} moments, every ${mean.toFixed(2)} s (${Math.min(...gaps).toFixed(2)}..${Math.max(...gaps).toFixed(2)}), kinds ${[...kinds].join(',')}`);
  assert.ok(mean >= 4 && mean <= 6.5, `mean spacing ${mean}`);
  // The longest stretch without a moment: the gap, the search window and a bar.
  const idle = Math.max(...shapes.slice(1).map((x, i) => x.start - shapes[i].end));
  assert.ok(idle <= P.features.gap + P.features.window + 4 * grid.period, `idle stretch ${idle}`);
  for (const type of [LOOP.PLAIN, LOOP.CORKSCREW, LOOP.DOUBLE, LOOP.TWIST, LOOP.FLIP]) assert.ok(kinds.has(type), `has type ${type}`);
  for (let i = 1; i < shapes.length; i++) assert.ok(shapes[i].start >= shapes[i - 1].end + P.features.gap - 1e-9, 'moments keep their gap');
  const first = grid.offset + features.tempo.downbeatPhase;
  for (const x of f) {
    const p = (gridPosition(grid, x.time) - first) / 4;
    assert.ok(Math.abs(p - Math.round(p)) < 1e-3, `moment at ${x.time} is on a bar line`);
  }
  // The plain demo keeps its calmer pace.
  assert.ok(plain.features.length < f.length / 2);
});

test('the rainbow palette cycles along the track', () => {
  const nd = level.nodes;
  const k = nodeAt(level, 40);
  const d = nd.dist[k];
  let j = k;
  while (nd.dist[j] < d + P.rainbowLength) j++;
  let h = k;
  while (nd.dist[h] < d + P.rainbowLength / 2) h++;
  const c = (i) => [nd.color[i * 3], nd.color[i * 3 + 1], nd.color[i * 3 + 2]];
  const diff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  assert.ok(diff(c(k), c(j)) < 0.08, 'one rainbow length on, the colour comes round again');
  assert.ok(diff(c(k), c(h)) > 0.3, 'half way round it is another colour');
});

test('the levels screen reads its numbers from the modes and the presets', async () => {
  const { levelFacts, levelOptions, LEVELS, LEVEL_ORDER } = await import('../src/ui/levels.js');
  assert.deepEqual(LEVEL_ORDER, ['demo', 'nyan']);
  assert.equal(LEVELS.demo.preset, null, 'the demo level is the plain demo');
  const demoF = levelFacts('demo'), nyanF = levelFacts('nyan');
  assert.equal(demoF.speed, 1);
  assert.equal(nyanF.speed, P.speed.max / MODES.mono.speedMax);
  assert.ok(nyanF.speed >= 1.6 && nyanF.speed <= 1.8, `×${nyanF.speed}`);
  assert.equal(nyanF.speedFraction, 1);
  assert.equal(nyanF.density, P.maxRate);
  assert.ok(nyanF.moments > demoF.moments * 1.5);
  assert.equal(nyanF.vehicle, 'Nyan');
  const opts = levelOptions(null, () => '—', (id) => (id === 'nyan' ? 'Your copy · needed' : 'Built in'));
  for (const o of opts) {
    assert.equal(o.gauges.length, 3);
    assert.ok(o.gauges.every((g) => g.fraction > 0 && g.fraction <= 1));
    assert.equal(typeof o.build, 'function');
  }
  assert.equal(opts[1].rows.find((r) => r.label === 'Source').value, 'Your copy · needed');
});

test('the song store resolves quietly without browser storage', async () => {
  const { SongStore } = await import('../src/ui/songstore.js');
  const store = new SongStore(null);
  assert.equal(await store.get('nyan'), null);
  assert.equal(await store.put('nyan', { name: 'x.mp3', size: 1 }), false);
  assert.equal(await store.remove('nyan'), false);
});
