import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Turntable, swapPhase, easeOutBack, stepOption, BASE_SPIN } from '../src/ui/spin.js';
import { modeFacts, modeOptions, MODE_ORDER } from '../src/ui/modes.js';
import { profileBars } from '../src/ui/profile.js';
import { gaugeHtml } from '../src/ui/gauge.js';
import { RULES } from '../src/game/rules.js';

test('the turntable idles slowly, follows a drag and eases a fling back to the idle spin', () => {
  const t = new Turntable();
  t.step(1);
  assert.ok(Math.abs(t.angle - BASE_SPIN) < 1e-9, 'one second of idle spin');
  t.grab(100, 0);
  t.drag(160, 0.05);
  assert.ok(Math.abs(t.angle - (BASE_SPIN + 0.6)) < 1e-9, '0.01 rad per pixel');
  t.release();
  assert.ok(t.vel > 1, 'a fling keeps momentum');
  for (let i = 0; i < 600; i++) t.step(1 / 60);
  assert.ok(Math.abs(t.vel - BASE_SPIN) < 0.01, 'back to the idle spin');
  t.still = true;
  for (let i = 0; i < 600; i++) t.step(1 / 60);
  assert.ok(Math.abs(t.vel) < 0.01, 'calm visuals: it comes to rest');
});

test('a swap runs out, then in, and ends', () => {
  assert.deepEqual(swapPhase(0), { out: 0, in: 0, done: false });
  const mid = swapPhase(0.21);
  assert.equal(mid.out, 1);
  assert.equal(mid.in, 0);
  assert.equal(swapPhase(0.42).done, true);
  assert.equal(easeOutBack(0), 0);
  assert.ok(Math.abs(easeOutBack(1) - 1) < 1e-12);
  assert.ok(easeOutBack(0.7) > 1, 'overshoots before settling');
  assert.equal(stepOption(2, 1, 3), 0);
  assert.equal(stepOption(0, -1, 3), 2);
  assert.equal(stepOption(0, -1, 3, false), 0);
});

test('mode facts are the numbers the code plays by', () => {
  const mono = modeFacts('mono'), ninja = modeFacts('ninja'), casual = modeFacts('casual');
  assert.equal(mono.speedText, '×1.0');
  assert.equal(ninja.speedText, '×1.26');
  assert.equal(casual.speedText, '×0.8');
  assert.equal(ninja.speedFraction, 1);
  assert.equal(mono.densityText, '5.2');
  assert.equal(ninja.densityText, '7.8');
  assert.equal(casual.densityText, '2.3');
  assert.equal(casual.timer, `${RULES.casual.timer} s`);
  assert.equal(ninja.hazards, 'Spikes erase all');
  assert.equal(mono.hazards, 'Greys erase one');
  assert.equal(casual.shoulders, 'Safe');
  assert.equal(ninja.bonus, 'Stealth +25%');
  assert.equal(mono.bonus, 'Clean finish +10%');
  assert.deepEqual([casual, mono, ninja].map((f) => f.difficulty), [1, 2, 3]);
  const opts = modeOptions(() => '12,000');
  assert.deepEqual(opts.map((o) => o.id), MODE_ORDER);
  assert.equal(opts[1].rows.find((r) => r.label === 'Best').value, '12,000');
  for (const o of opts) assert.equal(typeof o.build, 'function');
});

test('the intensity profile averages each slice and stays in 0..1', () => {
  const bars = profileBars((t) => (t < 5 ? 0.2 : 2), 0, 10, 10, 4);
  assert.equal(bars.length, 10);
  assert.ok(Math.abs(bars[0] - 0.2) < 1e-6);
  assert.equal(bars[9], 1, 'clamped');
});

test('a ring gauge fills its arc to the fraction, clamped', () => {
  assert.match(gaugeHtml({ label: 'Speed', value: '×1.0', fraction: 0.5 }), /--v:50/);
  assert.match(gaugeHtml({ label: 'X', value: 1, fraction: 3 }), /--v:100/);
  assert.match(gaugeHtml({ label: 'X', value: 7, unit: '/s' }), /<small>\/s<\/small>/);
});
