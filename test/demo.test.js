import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoScore, renderDemo, DEMO_BPM } from '../src/audio/demo.js';
import { matchEvents } from '../src/audio/metrics.js';

test('demo score follows the planned form at 128 BPM', () => {
  const s = demoScore();
  assert.equal(s.bpm, DEMO_BPM);
  const names = s.truth.sections.map((x) => x.name);
  assert.deepEqual(names, ['intro', 'build', 'drop', 'break', 'drop', 'outro']);
  assert.ok(s.duration > 145 && s.duration < 155, `about 2:30 (${s.duration})`);
  assert.deepEqual(s.truth.drops, [45, 105]);
  assert.equal(s.truth.beats.length, 320);
  // Onsets are unique, sorted and all on the sixteenth grid.
  const six = 60 / DEMO_BPM / 4;
  s.truth.onsets.forEach((t, i) => {
    if (i) assert.ok(t > s.truth.onsets[i - 1]);
    assert.ok(Math.abs(t / six - Math.round(t / six)) < 1e-4);
  });
});

test('demo score and audio are deterministic for a seed', () => {
  const a = demoScore(3), b = demoScore(3), c = demoScore(4);
  assert.deepEqual(a.events, b.events);
  assert.notDeepEqual(a.events, c.events);
  // Render a short excerpt twice: identical samples.
  const cut = (s) => ({ ...s, duration: 4, events: s.events.filter((e) => e.t < 3) });
  const [l1] = renderDemo(cut(a), 22050);
  const [l2] = renderDemo(cut(b), 22050);
  assert.deepEqual(l1, l2);
  assert.ok(l1.some((v) => Math.abs(v) > 0.1), 'not silent');
  assert.ok(l1.every((v) => Math.abs(v) < 1), 'no clipping');
});

test('event matching counts one-to-one hits within tolerance', () => {
  const m = matchEvents([1, 2, 3], [1.02, 2.2, 2.98, 3.01], 0.05);
  assert.equal(m.matched, 2); // 1.02, and 3.01 as the closer of the two near 3
  assert.equal(m.recall, 2 / 3);
  assert.equal(m.precision, 2 / 4);
});
