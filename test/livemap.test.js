import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveMap, LIVE, STATUS } from '../src/live/livemap.js';
import { BLOCK, LEAD_IN, LOOP } from '../src/audio/songmap.js';
import { TrackPath, makeSample } from '../src/game/trackpath.js';
import { DRAW_DISTANCE_M } from './live-fixtures.js';

const FPS = 60;

/**
 * Drive a LiveMap through a song played as a perfect grid: `beat(t)` gives
 * the tracker's grid at heard time t (null while it has none), `heard(t0,
 * t1, map)` reports the onsets heard in (t0, t1], `level(t)` the intensity.
 */
function drive(map, { until, grid, heard, level = () => 0.5, each }) {
  let prev = -LEAD_IN;
  for (let t = -LEAD_IN; t <= until; t += 1 / FPS) {
    if (heard) heard(prev, t, map);
    map.update(t, grid(t), level(t), t);
    if (each) each(t, map);
    prev = t;
  }
}

/** The tracker's view of a steady song: a grid through `first` at `bpm`. */
function steady(bpm, first = 0, { confidence = 1, hitRate = 1, from = 3 } = {}) {
  const T = 60 / bpm;
  const g = { anchor: NaN, period: T, confidence, hitRate };
  return (t) => {
    if (t < from) return null;
    g.anchor = first + Math.ceil((t - first) / T) * T;
    return g;
  };
}

/** Onsets on every beat (low band, strong) and between beats (high band, medium). */
function drums(bpm, first = 0, { offbeats = true } = {}) {
  const T = 60 / bpm;
  return (t0, t1, map) => {
    for (let k = Math.ceil((t0 - first) / (T / 2)); first + k * (T / 2) <= t1; k++) {
      const t = first + k * (T / 2);
      if (t <= t0 || t < 0) continue;
      if (k % 2 === 0) map.onset(t, 1, 0);
      else if (offbeats) map.onset(t, 0.6, 2);
    }
  };
}

const beatsOf = (bpm, first, n) => Array.from({ length: n }, (_, k) => first + (k * 60) / bpm);

test('nodes are committed two seconds ahead and a tail reaches the draw distance', () => {
  const map = new LiveMap({ mode: 'mono' });
  const s = makeSample();
  const path = new TrackPath(map.nodes);
  drive(map, {
    until: 30, grid: steady(128), heard: drums(128), level: (t) => (t < 15 ? 0.2 : 0.9),
    each: (t, m) => {
      assert.ok(m.nodes.t0 + (m.committed - 1) / 30 >= t + LIVE.horizon - 1 / 30 - 1e-9, `committed through ${t + 2}`);
      const d = path.sample(t, s).dist;
      assert.ok(m.nodes.dist[m.nodes.count - 1] - d >= DRAW_DISTANCE_M, `tail at ${t}`);
    },
  });
  const nd = map.nodes;
  for (let k = 1; k < nd.count; k++) assert.ok(nd.dist[k] > nd.dist[k - 1]);
  // Intensity (and so slope and colour) follows the music two seconds late.
  const at = (t) => nd.intensity[Math.round((t - nd.t0) * 30)];
  assert.ok(at(16.5) < 0.3 && at(17.5) > 0.8, `step lands at 17 s: ${at(16.5)} → ${at(17.5)}`);
  // Calm climbs, intense dives.
  assert.ok(nd.pitch[Math.round((12 - nd.t0) * 30)] > 0 && nd.pitch[Math.round((25 - nd.t0) * 30)] < 0);
});

test('blocks land on the beats, turn solid when beats are confirmed, and never move once solid', () => {
  const map = new LiveMap({ mode: 'mono' });
  const solidAt = new Map();
  drive(map, {
    until: 50, grid: steady(128, 0.1), heard: drums(128, 0.1),
    each: (t, m) => {
      const b = m.blocks;
      for (let i = 0; i < b.count; i++) {
        if (b.status[i] === STATUS.SOLID) {
          if (!solidAt.has(i)) solidAt.set(i, b.time[i]);
          else assert.equal(b.time[i], solidAt.get(i), 'solid blocks never move');
        }
        // Nothing within a second of the ship is a ghost.
        if (b.time[i] <= t + LIVE.solidBy) assert.notEqual(b.status[i], STATUS.GHOST);
      }
    },
  });
  const b = map.blocks;
  assert.ok(b.count > 100, `${b.count} blocks`);
  assert.equal(map.stats.withdrawn, 0);
  const T = 60 / 128;
  for (let i = 0; i < b.count; i++) {
    const pos = (b.time[i] - 0.1) / (T / 2);
    assert.ok(Math.abs(pos - Math.round(pos)) * (T / 2) < 0.005, `block ${i} at ${b.time[i]} is on the 8th grid`);
    if (i > 0) assert.ok(b.time[i] > b.time[i - 1]);
  }
  // Strong low beats sit mostly in the centre; the high off-beats mostly outside.
  let beatCentre = 0, beats = 0, offOuter = 0, offs = 0;
  for (let i = 0; i < b.count; i++) {
    if (b.type[i] !== BLOCK.COLOUR) continue;
    const onBeat = Math.round((b.time[i] - 0.1) / (T / 2)) % 2 === 0;
    if (onBeat) { beats++; if (b.lane[i] === 0) beatCentre++; } else { offs++; if (b.lane[i] !== 0) offOuter++; }
  }
  assert.ok(beats > 40 && offs > 40);
  assert.ok(beatCentre / beats > 0.4 && offOuter / offs > 0.6, `centre ${beatCentre}/${beats}, outer ${offOuter}/${offs}`);
  // Sixteen locked bars earn a power block; without phrases it waits four more bars, then takes a bar line ahead.
  const pbs = [];
  for (let i = 0; i < b.count; i++) if (b.type[i] === BLOCK.POWER) pbs.push(b.time[i]);
  assert.ok(pbs.length >= 1 && pbs[0] > 3 + (64 + LIVE.pbWait) * T + LIVE.loopLead && pbs[0] < 3 + (64 + LIVE.pbWait) * T + LIVE.loopLead + 4 * T, `power blocks at ${pbs}`);
});

test('ghosts that no beat confirms fade out and are withdrawn', () => {
  const map = new LiveMap({ mode: 'mono' });
  // Confident grid, but the onsets stop at 12 s.
  const onsets = drums(120);
  drive(map, { until: 20, grid: steady(120), heard: (a, b, m) => { if (b < 12) onsets(a, b, m); } });
  const b = map.blocks;
  // The last beat heard (11.5 s) confirmed the ghosts then out to ~13.55 s.
  let late = 0;
  for (let i = 0; i < b.count; i++) {
    if (b.time[i] > 13.6) {
      late++;
      assert.equal(b.status[i], STATUS.GONE, `block at ${b.time[i]}`);
    }
  }
  assert.ok(late > 0 && map.stats.withdrawn >= late);
  assert.equal(map.cancelled.count, map.stats.withdrawn);
  for (let k = 0; k < map.cancelled.count; k++) assert.equal(b.status[map.cancelled.list[k]], STATUS.GONE);
});

test('no blocks while the tracker is unsure', () => {
  for (const g of [steady(128, 0, { confidence: 0.4 }), steady(128, 0, { hitRate: 0.3 }), () => null]) {
    const map = new LiveMap({ mode: 'mono' });
    drive(map, { until: 15, grid: g, heard: drums(128) });
    assert.equal(map.blocks.count, 0);
  }
});

test('a phase jump glides at a quarter period per period; solid blocks stay put', () => {
  const map = new LiveMap({ mode: 'mono' });
  const T = 0.5;
  const before = steady(120, 0), after = steady(120, 0.1);
  let a0At20 = null, shifted = null;
  drive(map, {
    until: 22, grid: (t) => (t < 20 ? before(t) : after(t)), heard: drums(120),
    each: (t, m) => {
      if (a0At20 === null && t >= 20) a0At20 = m.timeAtBeat(Math.ceil(m.beatAt(t)));
      if (shifted === null && t >= 20.2) shifted = m.timeAtBeat(Math.round(m.beatAt(a0At20)));
    },
  });
  const moved = shifted - a0At20;
  assert.ok(moved > 0.02 && moved <= 0.25 * 0.2 + 1e-6, `moved ${moved} s in 0.2 s`);
  assert.ok(Math.abs(map.timeAtBeat(Math.round(map.beatAt(21.9))) - (Math.round(21.9 / T) * T + 0.1)) < 0.003, 'settled on the new phase');
});

test('×2 and ÷2 change the block grid', () => {
  const count = (octave) => {
    // Casual: beat slots only, at most 2.3 blocks/s, so 70 BPM doubled still fits.
    const map = new LiveMap({ mode: 'casual' });
    map.setOctave(octave);
    const q = 60 / 70 / 4;
    drive(map, { until: 30, grid: steady(70), heard: (a, b, m) => {
      // Onsets on every 16th so every slot is remembered as strong.
      for (let k = Math.ceil(a / q); k * q <= b; k++) if (k * q > a && k * q >= 0) m.onset(k * q, 1, 0);
    } });
    return map.blocks.count;
  };
  const one = count(0), dbl = count(1), half = count(-1);
  assert.ok(dbl > 1.6 * one, `×2: ${dbl} vs ${one}`);
  assert.ok(half < 0.65 * one, `÷2: ${half} vs ${one}`);
});

test('arrays grow past their initial capacity and keep their contents', () => {
  const map = new LiveMap({ mode: 'ninja', minutes: 0.2 });
  const cap = map.nodes.capacity;
  drive(map, { until: 45, grid: steady(128), heard: drums(128) });
  assert.ok(map.nodes.capacity > cap && map.blocks.count > 0);
  const path = new TrackPath(map.nodes), s = makeSample();
  let last = -Infinity;
  for (let t = -3; t < 45; t += 0.25) {
    const d = path.sample(t, s).dist;
    assert.ok(d > last);
    last = d;
  }
  // The skyline stores frames by song time.
  map.setSkylineRate(10);
  map.skylineFrame(2, new Uint8Array(16).fill(200));
  map.skylineFrame(900, new Uint8Array(16).fill(100));
  assert.equal(map.skyline.frames, 9001);
  assert.equal(map.skyline.data[20 * 16], 200);
  assert.equal(map.skyline.data[9000 * 16 + 5], 100);
});

test('the rules play a live map: blocks arrive as it grows, withdrawn ghosts never count', async () => {
  const { RulesEngine, EVENT, WITHDRAWN } = await import('../src/game/rules.js');
  const { createAutopilot } = await import('../src/game/autopilot.js');
  const map = new LiveMap({ mode: 'mono' });
  const rules = new RulesEngine(map.blocks, 'mono');
  const pilot = createAutopilot(map.blocks);
  const onsets = drums(128, 0.1);
  let seen = 0, hits = 0, misses = 0, collected = 0, sim = -LEAD_IN;
  // Onsets pause between 20 and 26 s: ghosts over the gap are withdrawn.
  drive(map, {
    until: 60, grid: steady(128, 0.1), heard: (a, b, m) => { if (b < 20 || a > 26) onsets(a, b, m); },
    each: (t, m) => {
      for (; seen < m.cancelled.count; seen++) rules.withdraw(m.cancelled.list[seen % m.cancelled.list.length]);
      while (sim + 1 / 240 <= t) {
        sim += 1 / 240;
        rules.step(sim, pilot(sim));
        for (let e = 0; e < rules.eventCount; e++) {
          const ev = rules.events[e];
          if (ev.type === EVENT.MISS) misses++;
          else if (ev.type === EVENT.COLLECT) collected += ev.value;
          else if (ev.type !== EVENT.MATCH && ev.block >= 0) {
            hits++;
            assert.equal(m.blocks.status[ev.block], STATUS.SOLID, 'only solid blocks are hit');
          }
        }
        rules.clearEvents();
      }
    },
  });
  map.dropGhosts();
  for (; seen < map.cancelled.count; seen++) rules.withdraw(map.cancelled.list[seen % map.cancelled.list.length]);
  const results = rules.results();
  let withdrawn = 0, played = 0;
  for (let i = 0; i < map.blocks.count; i++) {
    if (rules.state[i] === WITHDRAWN) withdrawn++;
    else if (map.blocks.time[i] < 59.9) played++;
  }
  assert.ok(withdrawn > 5, `${withdrawn} withdrawn`);
  assert.equal(withdrawn, map.stats.withdrawn);
  assert.equal(hits + misses, played, 'every played block resolved once');
  const s = results.stats;
  assert.equal(s.colour + s.grey + s.power, map.blocks.count - withdrawn, 'withdrawn blocks leave the tallies');
  assert.ok(s.colourHit > 0.8 * s.colour - 20, `bot took ${s.colourHit} of ${s.colour}`);
  assert.ok(collected > 0 && results.raw >= collected);
});

// --- bars, phrases and loops ----------------------------------------------------

const SONG_T = 60 / 128, SONG_BAR = 4 * SONG_T;

/**
 * A song heard live at 128 BPM, bar lines from 0 s: intro (bars 0-7),
 * verse (8-15), a build (16-23: a snare roll from quarters to sixteenths,
 * rising intensity, the kick out for its last two bars) and, from bar 24
 * (45 s), a drop, or with drop: false the song just thins out. Onsets go
 * to the map; so do skyline frames (a chord per bar, kick/snare colour).
 */
function liveSong({ drop = true } = {}) {
  const section = (bar) => (bar < 8 ? 0 : bar < 16 ? 1 : bar < 24 ? 2 : 3);
  const level = (t) => {
    const bar = Math.floor(t / SONG_BAR), s = section(Math.max(0, bar));
    if (s === 0) return 0.35;
    if (s === 1) return 0.55;
    if (s === 2) return 0.55 + 0.05 * (bar - 16 + (t % SONG_BAR) / SONG_BAR);
    return drop ? 0.95 : 0.3;
  };
  const sixteenth = SONG_T / 4, rate = 50;
  const levels = new Uint8Array(16);
  const heard = (t0, t1, map) => {
    map.setSkylineRate(rate);
    for (let k = Math.max(0, Math.ceil(t0 / sixteenth)); k * sixteenth <= t1; k++) {
      const t = k * sixteenth;
      if (t <= t0) continue;
      const bar = Math.floor(k / 16), s = section(bar), beat = k % 4 === 0, inBar = (k >> 2) % 4;
      const kick = beat && (s < 2 || (s === 2 && bar < 22) || (s === 3 && drop));
      let strongest = 0, band = 0;
      if (kick) { strongest = s === 3 ? 1 : 0.8; band = 0; }
      if (s === 2) {
        const step = bar < 20 ? 4 : bar < 22 ? 2 : 1;
        if (k % step === 0 && 0.45 + 0.06 * (bar - 16) > strongest) { strongest = 0.45 + 0.06 * (bar - 16); band = 1; }
      } else if (s >= 1 && beat && inBar % 2 === 1 && (s < 3 || drop) && 0.6 > strongest) { strongest = 0.6; band = 1; }
      if (k % 4 === 2 && strongest === 0) { strongest = 0.4; band = 2; }
      if (strongest > 0) map.onset(t, strongest, band);
    }
    for (let f = Math.max(0, Math.floor(t0 * rate) + 1); f / rate <= t1; f++) {
      const t = f / rate, bar = Math.floor(t / SONG_BAR), s = section(bar), sinceBeat = t % SONG_T;
      levels.fill(40 + 30 * s * (s === 3 && !drop ? 0 : 1));
      levels[2 + 3 * (bar % 4)] += 70;
      if (sinceBeat < 0.1) levels[Math.floor(t / SONG_T) % 2 === 0 ? 0 : 9] += 50;
      map.skylineFrame(t, levels);
    }
  };
  return { heard, level };
}

/** Record when each loop was scheduled, and what the map had drawn of it by then. */
function watchLoops() {
  const seen = new Map();
  return {
    seen,
    each: (t, m) => {
      for (const L of m.loops) {
        if (seen.has(L)) continue;
        seen.set(L, { at: t, committed: m.nodes.t0 + (m.committed - 1) / 30 });
      }
    },
  };
}

test('a build predicts a loop on the next phrase line, drawn on the horizon first; the drop releases its power block', () => {
  const map = new LiveMap({ mode: 'mono' });
  const song = liveSong();
  const w = watchLoops();
  let drawnEarly = false;
  drive(map, {
    until: 62, grid: steady(128, 0, { from: 12 }), heard: song.heard, level: song.level,
    each: (t, m) => {
      w.each(t, m);
      // Two seconds before the loop starts it is already on the provisional tail.
      const L = m.loops.find((x) => x.predicted);
      if (L && t > L.start - 2.05 && t < L.start - 1.95) {
        const k = Math.round((L.time - m.nodes.t0) * 30);
        drawnEarly = k >= m.committed && k < m.nodes.count && m.nodes.loop[k] === L.type;
      }
    },
  });
  const L = map.loops.find((x) => x.predicted);
  assert.ok(L, `a predicted loop (${map.loops.map((x) => x.time.toFixed(2))})`);
  assert.ok([LOOP.CORKSCREW, LOOP.DOUBLE].includes(L.type));
  assert.ok(Math.abs(L.time - 24 * SONG_BAR) < 0.02, `on the drop's phrase line: ${L.time}`);
  const when = w.seen.get(L);
  assert.ok(L.time - when.at >= LIVE.loopLead - 1e-9, `scheduled ${L.time - when.at} s ahead`);
  assert.ok(L.start > when.committed, 'past the committed track');
  assert.ok(drawnEarly, 'foreshadowed on the tail');
  // The committed loop is the file's shape: a full roll, a continuous path, an orthonormal frame.
  const nd = map.nodes, end = Math.round((L.end - nd.t0) * 30) - 1;
  assert.ok(Math.abs(nd.roll[end] - (L.type === LOOP.DOUBLE ? 4 : 2) * Math.PI) < 0.05);
  for (let k = Math.round((L.start - nd.t0) * 30) - 5; k <= end + 5; k++) {
    const step = Math.hypot(nd.pos[k * 3] - nd.pos[k * 3 - 3], nd.pos[k * 3 + 1] - nd.pos[k * 3 - 2], nd.pos[k * 3 + 2] - nd.pos[k * 3 - 1]);
    assert.ok(step < 4, `step ${step} at ${k}`);
    const dot = nd.up[k * 3] * nd.fwd[k * 3] + nd.up[k * 3 + 1] * nd.fwd[k * 3 + 1] + nd.up[k * 3 + 2] * nd.fwd[k * 3 + 2];
    assert.ok(Math.abs(dot) < 1e-5 && Math.abs(Math.hypot(nd.up[k * 3], nd.up[k * 3 + 1], nd.up[k * 3 + 2]) - 1) < 1e-5);
  }
  // The drop came: its power block, one bar after it, is solid.
  assert.ok(L.checked && L.dropOk && map.stats.drops === 1);
  const b = map.blocks;
  let pb = -1;
  for (let i = 0; i < b.count; i++) if (b.type[i] === BLOCK.POWER && Math.abs(b.time[i] - 25 * SONG_BAR) < 0.02) pb = i;
  assert.ok(pb >= 0, 'a power block on the first downbeat after the drop');
  assert.equal(b.status[pb], STATUS.SOLID);
  assert.equal(b.pbRank[pb], L.type === LOOP.DOUBLE ? 1 : 2);
  // Blocks stay on the beats through the loop.
  let inLoop = 0;
  for (let i = 0; i < b.count; i++) {
    if (b.time[i] < L.start || b.time[i] > L.end || b.status[i] !== STATUS.SOLID) continue;
    inLoop++;
    assert.ok(Math.abs(b.time[i] / (SONG_T / 2) - Math.round(b.time[i] / (SONG_T / 2))) * (SONG_T / 2) < 0.01);
  }
  assert.ok(inLoop >= 4, `${inLoop} blocks in the loop`);
});

test('a predicted drop that never comes: the loop still plays, its power block is withdrawn', () => {
  const map = new LiveMap({ mode: 'mono' });
  const song = liveSong({ drop: false });
  drive(map, { until: 52, grid: steady(128, 0, { from: 12 }), heard: song.heard, level: song.level });
  const L = map.loops.find((x) => x.predicted);
  assert.ok(L && Math.abs(L.time - 24 * SONG_BAR) < 0.02, 'the loop was scheduled');
  assert.ok(map.nodes.loop[Math.round((L.time - map.nodes.t0) * 30)] === L.type, 'and is in the track');
  assert.ok(L.checked && !L.dropOk && map.stats.falseDrops === 1);
  const b = map.blocks;
  for (let i = 0; i < b.count; i++) {
    if (b.type[i] !== BLOCK.POWER) continue;
    assert.ok(Math.abs(b.time[i] - 25 * SONG_BAR) < 0.02, `only the held one: ${b.time[i]}`);
    assert.equal(b.status[i], STATUS.GONE, 'withdrawn, never awarded');
  }
});

test('no loops while the tracker, the bar lines or the phrases are unsure', () => {
  const song = liveSong();
  // The tracker is unsure: nothing at all.
  const unsure = new LiveMap({ mode: 'mono' });
  drive(unsure, { until: 60, grid: steady(128, 0, { confidence: 0.4 }), heard: song.heard, level: song.level });
  assert.equal(unsure.loops.length, 0);
  // Sure of the beat, but every beat is the same (no spectrum, no sections): no predicted loop,
  // and the locked power block's plain loop falls on the tracker's own bar line.
  const flat = new LiveMap({ mode: 'mono' });
  drive(flat, { until: 60, grid: steady(128), heard: drums(128, 0, { offbeats: false }), level: () => 0.6 });
  assert.equal(flat.stats.predicted, 0);
  assert.ok(flat.bars.downbeatConfidence < LIVE.downbeatConfidence);
  assert.ok(flat.loops.length >= 1 && flat.loops.every((L) => L.type === LOOP.PLAIN && !L.predicted));
});

test('sixteen locked bars give a plain loop with the power block, on a phrase line; loops keep 12 s apart', () => {
  const map = new LiveMap({ mode: 'mono' });
  const song = liveSong();
  const w = watchLoops();
  drive(map, { until: 75, grid: steady(128, 0, { from: 3 }), heard: song.heard, level: song.level, each: w.each });
  assert.ok(map.loops.length >= 2, `${map.loops.length} loops`);
  for (let i = 1; i < map.loops.length; i++) assert.ok(map.loops[i].time - map.loops[i - 1].time >= LIVE.loopSpacing - 1e-9);
  for (const L of map.loops) {
    assert.ok(L.time - w.seen.get(L).at >= LIVE.loopLead - 1e-9, 'ahead of the horizon');
    // Section lines are every 8 bars from 0 s.
    const bars = L.time / SONG_BAR;
    assert.ok(Math.abs(bars - Math.round(bars)) < 0.02 && Math.round(bars) % 8 === 0, `${L.time} on a phrase line`);
  }
  // The first power block came from the lock, before the build: its loop sits on the drop's line,
  // and the build turned it into a corkscrew (the block stays earned).
  const first = map.loops[0];
  assert.ok(Math.abs(first.time - 24 * SONG_BAR) < 0.02 && first.type !== LOOP.PLAIN);
  const b = map.blocks;
  let pb = -1;
  for (let i = 0; i < b.count; i++) if (b.type[i] === BLOCK.POWER && Math.abs(b.time[i] - first.time) < 0.02) pb = i;
  assert.ok(pb >= 0 && b.status[pb] === STATUS.SOLID);
});

test('the live demo gets its loops on the song’s section lines', async () => {
  const { LiveSession, LiveClock } = await import('../src/live/session.js');
  const { generateDemoSong } = await import('../src/audio/demo.js');
  const { SR, mono } = await import('./live-fixtures.js');
  const demo = generateDemoSong({ sampleRate: SR });
  const audio = mono(demo.channels);
  const node = () => ({ gain: { value: 1 }, connect() {}, disconnect() {}, start() {} });
  const ctx = { sampleRate: SR, currentTime: 0, destination: {}, createBuffer: () => ({ copyToChannel() {} }), createGain: node, createBufferSource: node };
  const session = new LiveSession(ctx, null);
  session.latency = 0.025;
  const map = new LiveMap({ mode: 'mono', seed: 'live:demo', duration: demo.duration });
  session.begin(map, new LiveClock({ songStart: 10, offset: 0, read: () => 0 }));
  const w = watchLoops();
  for (let i = 0; i + 512 <= audio.length; i += 512) {
    session.feed(Math.round((10.025 + i / SR) * SR), audio.subarray(i, i + 512));
    const now = (i + 512) / SR - 0.012;
    if ((i / 512) % 2 === 0) { session.update(now); w.each(now, map); }
  }
  const lines = demo.truth.sections.map((s) => s.start);
  assert.ok(map.loops.length >= 3, `${map.loops.length} loops`);
  for (const L of map.loops) {
    assert.ok(lines.some((x) => Math.abs(L.time - x) < 0.3), `loop at ${L.time} on a section line`);
    assert.ok(L.time - w.seen.get(L).at >= LIVE.loopLead - 1e-9);
  }
  // The first drop was predicted from its build, and came.
  const drop = map.loops.find((L) => Math.abs(L.time - demo.truth.drops[0]) < 0.1);
  assert.ok(drop && drop.predicted && drop.type !== LOOP.PLAIN && drop.dropOk);
});
