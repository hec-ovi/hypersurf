import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemoSong } from '../src/audio/demo.js';
import { analyzeAudio } from '../src/audio/analyze.js';
import { buildSongMap, LOOP } from '../src/audio/songmap.js';
import { TrackPath, makeSample, catmullRom, planChunks, chunkAt, nodeBeats } from '../src/game/trackpath.js';

const demo = generateDemoSong({ sampleRate: 22050 });
const map = buildSongMap(analyzeAudio(demo.channels, demo.sampleRate), { mode: 'mono', seed: 'demo' });
const path = new TrackPath(map.nodes);

test('catmull-rom passes through its control points', () => {
  assert.equal(catmullRom(0, 1, 5, 2, 0), 1);
  assert.equal(catmullRom(0, 1, 5, 2, 1), 5);
  // A straight line stays straight.
  assert.ok(Math.abs(catmullRom(0, 1, 2, 3, 0.3) - 1.3) < 1e-12);
});

test('samples hit the nodes exactly at node times', () => {
  const s = makeSample();
  const nd = map.nodes;
  for (const k of [0, 1, 90, 500, nd.count - 2, nd.count - 1]) {
    path.sample(nd.t0 + k / nd.rate, s);
    assert.ok(Math.abs(s.px - nd.pos[k * 3]) < 1e-6 && Math.abs(s.py - nd.pos[k * 3 + 1]) < 1e-6 && Math.abs(s.pz - nd.pos[k * 3 + 2]) < 1e-6, `node ${k}`);
    assert.ok(Math.abs(s.dist - nd.dist[k]) < 1e-6);
  }
  // Song time 0 is the origin.
  path.sample(0, s);
  assert.ok(Math.hypot(s.px, s.py, s.pz) < 1e-6);
});

test('the frame is orthonormal and right-handed everywhere, loops included', () => {
  const s = makeSample();
  let loopSamples = 0;
  for (let t = path.t0; t <= path.tEnd; t += 0.0137) {
    path.sample(t, s);
    if (s.loop !== LOOP.NONE) loopSamples++;
    const len = (x, y, z) => Math.hypot(x, y, z);
    assert.ok(Math.abs(len(s.fx, s.fy, s.fz) - 1) < 1e-9);
    assert.ok(Math.abs(len(s.ux, s.uy, s.uz) - 1) < 1e-9);
    assert.ok(Math.abs(len(s.rx, s.ry, s.rz) - 1) < 1e-9);
    assert.ok(Math.abs(s.fx * s.ux + s.fy * s.uy + s.fz * s.uz) < 1e-9);
  }
  assert.ok(loopSamples > 100, 'the demo has loops to sample');
  // At the start the track runs down -z with +x to the right.
  path.sample(path.t0, s);
  assert.ok(s.rx > 0.9 && s.fz < -0.5);
});

test('positions move smoothly: no jumps between consecutive samples', () => {
  const a = makeSample(), b = makeSample();
  const dt = 1 / 240;
  let worst = 0;
  for (let t = path.t0; t + dt <= path.tEnd; t += dt) {
    path.sample(t, a);
    path.sample(t + dt, b);
    const step = Math.hypot(b.px - a.px, b.py - a.py, b.pz - a.pz);
    // Never faster than the top speed plus room for the corkscrew offsets.
    worst = Math.max(worst, step / dt / Math.max(a.speed, b.speed));
  }
  assert.ok(worst < 1.6, `worst step ratio ${worst}`);
});

test('distance and time invert each other, beyond both ends too', () => {
  for (const t of [-5, -3, -1.234, 0, 10.5, 77.7, map.duration, map.duration + 4.5]) {
    const d = path.distanceAt(t);
    assert.ok(Math.abs(path.timeAtDistance(d) - t) < 1e-6, `t=${t}`);
  }
  // Distance increases strictly with time.
  let last = -Infinity;
  for (let t = -3; t < map.duration + 3; t += 0.05) {
    const d = path.distanceAt(t);
    assert.ok(d > last);
    last = d;
  }
});

test('chunks tile the track without gaps and stay within their node budget', () => {
  const plan = planChunks(map.nodes, 50, 96);
  assert.equal(plan.starts[0], 0);
  assert.equal(plan.starts[plan.count], map.nodes.count - 1);
  for (let i = 0; i < plan.count; i++) {
    const a = plan.starts[i], b = plan.starts[i + 1];
    assert.ok(b > a && b - a <= 95, `chunk ${i}: ${a}..${b}`);
    const len = map.nodes.dist[b] - map.nodes.dist[a];
    if (i < plan.count - 1) assert.ok(len >= 50 || b - a === 95);
    assert.ok(len < 50 + 4, `chunk ${i} is ${len} m`);
  }
  // chunkAt finds the chunk holding a distance.
  for (const d of [-100, 0, 1234.5, 1e9]) {
    const c = chunkAt(plan, d);
    assert.ok(c >= 0 && c < plan.count);
    if (d > plan.dist[0] && d < plan.dist[plan.count - 1]) assert.ok(plan.dist[c] <= d && d < plan.dist[c + 1]);
  }
});

test('node beat positions count beats in song time', () => {
  const beats = nodeBeats(map);
  const period = 60 / map.bpm;
  for (let k = 1; k < beats.length; k++) assert.ok(beats[k] > beats[k - 1]);
  // Over 10 s the grid advances by about 10 / period beats.
  const k0 = Math.round(20 * 30 + 90), k1 = k0 + 300;
  assert.ok(Math.abs(beats[k1] - beats[k0] - 10 / period) < 0.2);
});
