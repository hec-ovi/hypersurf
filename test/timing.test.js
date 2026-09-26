// Analysis cost gate: a 4-minute stereo song must analyse in a few seconds
// (docs/research.md targets ≤ 3 s on a 2022 laptop).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemoSong } from '../src/audio/demo.js';
import { analyzeAudio } from '../src/audio/analyze.js';
import { buildSongMap } from '../src/audio/songmap.js';

const BUDGET_MS = 4000;

function tile(channels, sampleRate, seconds) {
  const n = Math.round(seconds * sampleRate);
  return channels.map((ch) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += ch.length) out.set(ch.subarray(0, Math.min(ch.length, n - i)), i);
    return out;
  });
}

for (const sampleRate of [44100, 48000]) {
  test(`a 4-minute ${sampleRate / 1000} kHz stereo song analyses within ${BUDGET_MS / 1000} s`, (t) => {
    const demo = generateDemoSong({ sampleRate });
    const channels = tile(demo.channels, sampleRate, 240);
    const t0 = performance.now();
    const features = analyzeAudio(channels, sampleRate);
    const t1 = performance.now();
    const map = buildSongMap(features, { mode: 'mono', seed: 'timing' });
    const t2 = performance.now();
    const stages = Object.entries(features.timings).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ');
    t.diagnostic(`analysis ${Math.round(t1 - t0)} ms (${stages}), songmap ${Math.round(t2 - t1)} ms, total ${Math.round(t2 - t0)} ms`);
    assert.ok(map.blocks.count > 0);
    assert.ok(t2 - t0 < BUDGET_MS, `took ${Math.round(t2 - t0)} ms`);
  });
}
