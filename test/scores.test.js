import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BestScores, bestKey, sha256Hex } from '../src/game/scores.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('best scores are kept per song and mode, and only improve', () => {
  const store = memoryStorage();
  const best = new BestScores(store);
  assert.equal(best.get('demo', 'mono'), null);
  let r = best.submit('demo', 'mono', { final: 1000, raw: 900 }, 'h1');
  assert.ok(r.isNew && r.previous === null && r.best.final === 1000);
  r = best.submit('demo', 'mono', { final: 800, raw: 800 });
  assert.ok(!r.isNew && r.best.final === 1000);
  r = best.submit('demo', 'mono', { final: 1200, raw: 1100 });
  assert.ok(r.isNew && r.previous.final === 1000);
  assert.equal(best.get('demo', 'ninja'), null);
  assert.ok(store.m.has(bestKey('demo', 'mono')));
});

test('best scores survive broken storage', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const best = new BestScores(broken);
  assert.equal(best.get('demo', 'mono'), null);
  assert.equal(best.submit('demo', 'mono', { final: 5, raw: 5 }).isNew, true);
  assert.equal(new BestScores(null).get('x', 'mono'), null);
  const junk = memoryStorage();
  junk.setItem(bestKey('demo', 'mono'), '{not json');
  assert.equal(new BestScores(junk).get('demo', 'mono'), null);
});

test('sha256 of file bytes', async () => {
  const hex = await sha256Hex(new TextEncoder().encode('abc').buffer);
  assert.equal(hex, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
