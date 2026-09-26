import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemoSong } from '../src/audio/demo.js';
import { analyzeAudio } from '../src/audio/analyze.js';
import { buildSongMap, LEAD_IN } from '../src/audio/songmap.js';
import { LiveMap } from '../src/live/livemap.js';
import { TrackPath, makeSample } from '../src/game/trackpath.js';
import { Skyline, clearOfView, RING, PER_SLOT, NODES_PER_SLOT, CLEARANCE } from '../src/game/skyline.js';

// What the view does (src/game/view.js): draw distance and floating origin.
const DRAW = 650;
const REBASE = 500;
const TALLEST = 3.5; // a pillar's height grows up to ×3.5 with its band's level

const demo = generateDemoSong({ sampleRate: 22050 });
const features = analyzeAudio(demo.channels, demo.sampleRate);

/** Segment o → o + d against an axis-aligned box. */
function segmentHitsBox(ox, oy, oz, dx, dy, dz, lo, hi) {
  let t0 = 0, t1 = 1;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  for (let c = 0; c < 3; c++) {
    if (Math.abs(d[c]) < 1e-12) {
      if (o[c] < lo[c] || o[c] > hi[c]) return false;
      continue;
    }
    let a = (lo[c] - o[c]) / d[c], b = (hi[c] - o[c]) / d[c];
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Shown pillars that stand in front of the track: sight lines from a chase
 * camera at node k0 (7.5 m back, 4.6 m up) to the road's centre and both
 * rails, on the surface and 10 m above it, out to the draw distance,
 * against every shown pillar's box at its tallest, placed as the GPU gets
 * it (relative to the floating origin). An independent 3D check of the
 * corridor rule, which works on the ground plane.
 */
function occluders(sky, nd, k0, origin) {
  const f = [nd.fwd[k0 * 3], nd.fwd[k0 * 3 + 1], nd.fwd[k0 * 3 + 2]];
  const u = [nd.up[k0 * 3], nd.up[k0 * 3 + 1], nd.up[k0 * 3 + 2]];
  const cam = [0, 1, 2].map((c) => nd.pos[k0 * 3 + c] - f[c] * 7.5 + u[c] * 4.6);
  const targets = [];
  const lo = cam.slice(), hi = cam.slice();
  for (let b = k0 + 2; b < nd.count && nd.dist[b] - nd.dist[k0] <= DRAW; b += 4) {
    const F = [nd.fwd[b * 3], nd.fwd[b * 3 + 1], nd.fwd[b * 3 + 2]], U = [nd.up[b * 3], nd.up[b * 3 + 1], nd.up[b * 3 + 2]];
    const R = [F[1] * U[2] - F[2] * U[1], F[2] * U[0] - F[0] * U[2], F[0] * U[1] - F[1] * U[0]];
    for (const lat of [-4.5, 0, 4.5]) {
      for (const lift of [0.3, 10]) {
        const p = [0, 1, 2].map((c) => nd.pos[b * 3 + c] + R[c] * lat + U[c] * lift);
        targets.push(p);
        for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], p[c]); hi[c] = Math.max(hi[c], p[c]); }
      }
    }
  }
  const found = [];
  for (let i = 0; i < RING * PER_SLOT; i++) {
    const w = sky.size[i * 4];
    if (w === 0) continue;
    const x = sky.pos[i * 4] + origin.x, y = sky.pos[i * 4 + 1] + origin.y, z = sky.pos[i * 4 + 2] + origin.z;
    const blo = [x - w / 2, y - sky.size[i * 4 + 2], z - w / 2], bhi = [x + w / 2, y + sky.size[i * 4 + 1] * TALLEST, z + w / 2];
    if (bhi[0] < lo[0] || blo[0] > hi[0] || bhi[1] < lo[1] || blo[1] > hi[1] || bhi[2] < lo[2] || blo[2] > hi[2]) continue;
    for (const p of targets) {
      if (segmentHitsBox(cam[0], cam[1], cam[2], p[0] - cam[0], p[1] - cam[1], p[2] - cam[2], blo, bhi)) {
        found.push({ instance: i, slot: sky.slotOf[i % RING], node: k0 });
        break;
      }
    }
  }
  return found;
}

/** A synthetic track that winds harder than any song's (heading ±35°), level, at 45 m/s. */
function windingTrack(seconds = 120) {
  const rate = 30, n = seconds * rate, speed = 45;
  const nodes = {
    count: n, rate, t0: 0, pos: new Float64Array(n * 3), dist: new Float64Array(n), fwd: new Float32Array(n * 3), up: new Float32Array(n * 3),
    speed: new Float32Array(n).fill(speed), intensity: new Float32Array(n).fill(0.5), color: new Float32Array(n * 3), loop: new Uint8Array(n),
  };
  let x = 0, z = 0;
  for (let k = 0; k < n; k++) {
    const t = k / rate, yaw = (35 * Math.PI / 180) * Math.sin((2 * Math.PI * t) / 24);
    const fx = Math.sin(yaw), fz = -Math.cos(yaw);
    if (k > 0) { x += (fx * speed) / rate; z += (fz * speed) / rate; }
    nodes.pos[k * 3] = x; nodes.pos[k * 3 + 2] = z;
    nodes.dist[k] = (k * speed) / rate;
    nodes.fwd[k * 3] = fx; nodes.fwd[k * 3 + 2] = fz;
    nodes.up[k * 3 + 1] = 1;
  }
  return nodes;
}

/** A frame-by-frame ride as the view drives the skyline, with its floating origin. */
function ride(nodes, { t0, t1, fps = 60, checkEvery = 0.5, step }) {
  const pos = new Float32Array(RING * PER_SLOT * 4), size = new Float32Array(RING * PER_SLOT * 4);
  const sky = new Skyline(pos, size);
  const path = new TrackPath(nodes);
  const s = makeSample();
  const origin = { x: 0, y: 0, z: 0 };
  sky.load(nodes, !!nodes.live);
  const bad = [];
  let shown = 0, slotsSeen = 0, rebases = 0, nextCheck = t0;
  for (let i = 0; t0 + i / fps <= t1; i++) {
    const t = t0 + i / fps;
    if (step) step(t);
    path.sample(t, s);
    let rebased = i === 0;
    const ox = s.px - origin.x, oy = s.py - origin.y, oz = s.pz - origin.z;
    if (rebased || ox * ox + oy * oy + oz * oz > REBASE * REBASE) {
      origin.x = s.px; origin.y = s.py; origin.z = s.pz;
      rebased = true;
      rebases++;
    }
    const k = Math.round(path.indexAt(t));
    sky.update(k, origin, rebased);
    if (t >= nextCheck) {
      nextCheck += checkEvery;
      for (const o of occluders(sky, nodes, k, origin)) bad.push({ t: +t.toFixed(2), ...o });
      for (let r = 0; r < RING; r++) {
        if (sky.slotOf[r] === -1) continue;
        slotsSeen++;
        for (let q = 0; q < PER_SLOT; q++) if (size[(q * RING + r) * 4] > 0) shown++;
      }
    }
  }
  return { bad, shown: shown / Math.max(1, slotsSeen * PER_SLOT), rebases };
}

test('corridor: a pillar inside a bend is refused, one outside it stands', () => {
  // A 1 km arc of radius 600 m bending left (centre at x = −600), at 50 m/s.
  const n = 600, R = 600;
  const nodes = { count: n, rate: 30, t0: 0, pos: new Float64Array(n * 3), dist: new Float64Array(n), fwd: new Float32Array(n * 3) };
  for (let k = 0; k < n; k++) {
    const s = (k * 50) / 30, a = s / R;
    nodes.pos[k * 3] = -R + R * Math.cos(a);
    nodes.pos[k * 3 + 2] = -R * Math.sin(a);
    nodes.dist[k] = s;
    nodes.fwd[k * 3] = -Math.sin(a);
    nodes.fwd[k * 3 + 2] = -Math.cos(a);
  }
  // Half-way through the first 600 m, 60 m to either side of the road
  // (the road there is at (−73.5, −287.6), the bend's centre to its left).
  const nx = -0.877, nz = 0.479; // toward the centre
  const inside = [-73.5 + nx * 60, -287.6 + nz * 60], outside = [-73.5 - nx * 60, -287.6 - nz * 60];
  // Inside: it keeps its distance from the road, but the start's view of
  // the road 600 m on passes 13 m from it.
  assert.equal(clearOfView(nodes, inside[0], inside[1], 3, 180), false);
  // Outside a bend nothing lies between the camera and the road.
  assert.equal(clearOfView(nodes, outside[0], outside[1], 3, 180), true);
  // Too close to the road itself.
  assert.equal(clearOfView(nodes, CLEARANCE - 5, 0, 3, 0), false);
  // Behind every camera that is still to come, the inside of the bend is free.
  assert.equal(clearOfView(nodes, inside[0], inside[1], 3, 180, 400), true);
});

test('skyline never stands in front of the track across whole demo runs', () => {
  for (const mode of ['mono', 'ninja', 'casual']) {
    const map = buildSongMap(features, { mode, seed: 'demo' });
    const nd = map.nodes;
    const t1 = nd.t0 + (nd.count - 2) / nd.rate;
    const r = ride(nd, { t0: -LEAD_IN, t1 });
    assert.ok(r.rebases > 5, `${mode}: the ride re-bases (${r.rebases})`);
    assert.deepEqual(r.bad.slice(0, 5), [], `${mode}: ${r.bad.length} pillars in the view corridor`);
    // The skyline stays a skyline: most pillars stand.
    assert.ok(r.shown > 0.7, `${mode}: ${(r.shown * 100).toFixed(0)}% of pillars shown`);
  }
});

test('skyline keeps out of the inside of hard bends', () => {
  const nodes = windingTrack();
  const r = ride(nodes, { t0: 0, t1: 110 });
  assert.deepEqual(r.bad.slice(0, 5), [], `${r.bad.length} pillars in the view corridor`);
  assert.ok(r.shown > 0.5, `${(r.shown * 100).toFixed(0)}% of pillars shown`);
});

test('skyline stays out of a growing live track, across tail rewrites and re-bases', () => {
  const map = new LiveMap({ mode: 'mono', seed: 'live:test' });
  // Intensity swings rewrite the provisional tail: slow climbs, fast drops.
  const level = (t) => (t < 20 ? 0.2 : t < 45 ? 0.95 : t < 60 ? 0.1 : t < 80 ? 0.8 : 0.3);
  const g = { anchor: NaN, period: 60 / 128, confidence: 1, hitRate: 1 };
  const grid = (t) => { g.anchor = Math.ceil(t / g.period) * g.period; return t < 3 ? null : g; };
  const r = ride(map.nodes, { t0: -LEAD_IN, t1: 100, step: (t) => map.update(t, grid(t), level(t), t) });
  assert.ok(r.rebases > 5);
  assert.deepEqual(r.bad.slice(0, 5), [], `${r.bad.length} pillars in the view corridor`);
  assert.ok(r.shown > 0.7, `${(r.shown * 100).toFixed(0)}% of pillars shown`);
});

test('ring entries that leave the window are hidden, not carried along by a re-base', () => {
  const map = buildSongMap(features, { mode: 'mono', seed: 'demo' });
  const nd = map.nodes;
  const pos = new Float32Array(RING * PER_SLOT * 4), size = new Float32Array(RING * PER_SLOT * 4);
  const sky = new Skyline(pos, size);
  sky.load(nd);
  const origin = { x: 0, y: 0, z: 0 };
  // Near the end of the song the window is shorter than the ring.
  const last = Math.floor((nd.count - 1) / NODES_PER_SLOT);
  const k = (last - 40) * NODES_PER_SLOT;
  sky.update(k - 200 * NODES_PER_SLOT, origin, true);
  origin.x = nd.pos[k * 3]; origin.y = nd.pos[k * 3 + 1]; origin.z = nd.pos[k * 3 + 2];
  sky.update(k, origin, true);
  const j0 = Math.floor(k / NODES_PER_SLOT) - 2;
  for (let r = 0; r < RING; r++) {
    const j = sky.slotOf[r];
    const inWindow = j >= j0 && j <= last;
    assert.ok(j === -1 || inWindow, `ring entry ${r} holds slot ${j}`);
    if (j === -1) for (let q = 0; q < PER_SLOT; q++) assert.equal(size[(q * RING + r) * 4], 0);
  }
});
