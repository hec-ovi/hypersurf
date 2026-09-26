import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisHandler } from '../src/audio/worker.js';
import { Analyzer } from '../src/audio/analyzer.js';

function tone(seconds, sampleRate) {
  const n = seconds * sampleRate, x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate, beat = t % 0.5;
    x[i] = Math.exp(-beat * 30) * Math.sin(2 * Math.PI * 80 * beat) * 0.8 + 0.05 * Math.sin(2 * Math.PI * 440 * t);
  }
  return x;
}

test('worker handler: demo request streams progress then a transferable result', () => {
  const handle = createAnalysisHandler();
  const replies = [];
  handle({ type: 'demo', id: 7, sampleRate: 22050, mode: 'mono' }, (msg, transfer) => replies.push({ msg, transfer }));
  const progress = replies.filter((r) => r.msg.type === 'progress').map((r) => r.msg.fraction);
  assert.ok(progress.length > 5);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1]);
  const { msg, transfer } = replies[replies.length - 1];
  assert.equal(msg.type, 'result');
  assert.equal(msg.id, 7);
  assert.equal(msg.songMap.mode, 'mono');
  assert.equal(msg.channels.length, 2);
  assert.equal(msg.sampleRate, 22050);
  assert.deepEqual(msg.truth.drops, [45, 105]);
  // Everything big goes by transfer: the channels and the SongMap arrays.
  assert.ok(transfer.includes(msg.channels[0].buffer));
  assert.ok(transfer.includes(msg.songMap.nodes.pos.buffer));
  assert.ok(transfer.includes(msg.songMap.blocks.time.buffer));
  // Another mode rebuilds from the kept analysis.
  const again = [];
  handle({ type: 'build', id: 8, mode: 'casual', seed: 'demo' }, (m) => again.push(m));
  assert.equal(again.length, 1);
  assert.equal(again[0].songMap.mode, 'casual');
  assert.ok(again[0].songMap.blocks.count < msg.songMap.blocks.count);
});

test('worker handler: analyse request and errors', () => {
  const handle = createAnalysisHandler();
  const out = [];
  const post = (m) => out.push(m);
  handle({ type: 'build', id: 1, mode: 'mono' }, post);
  assert.deepEqual(out.pop(), { type: 'error', id: 1, message: 'nothing analysed yet' });
  handle({ type: 'nope', id: 2 }, post);
  assert.equal(out.pop().type, 'error');
  const x = tone(30, 22050);
  handle({ type: 'analyze', id: 3, channels: [x], sampleRate: 22050, mode: 'mono', seed: 'tone' }, post);
  const result = out.pop();
  assert.equal(result.type, 'result');
  assert.ok(Math.abs(result.songMap.bpm - 120) < 1, `bpm ${result.songMap.bpm}`);
  assert.ok(result.timings.spectrum > 0);
});

class LoopbackWorker {
  constructor() {
    this.handle = createAnalysisHandler();
    this.terminated = false;
  }
  postMessage(msg) {
    setTimeout(() => this.handle(msg, (reply) => this.onmessage({ data: reply })), 0);
  }
  terminate() { this.terminated = true; }
}

test('analyzer client resolves results, reports progress and rejects errors', async () => {
  const analyzer = new Analyzer(new LoopbackWorker());
  const seen = [];
  const res = await analyzer.analyze([tone(20, 22050)], 22050, { mode: 'ninja', seed: 's', onProgress: (f, stage) => seen.push([f, stage]) });
  assert.equal(res.songMap.mode, 'ninja');
  assert.ok(seen.length > 3 && seen[seen.length - 1][0] === 1);
  const rebuilt = await analyzer.build({ mode: 'casual', seed: 's' });
  assert.equal(rebuilt.songMap.mode, 'casual');
  const fresh = new Analyzer(new LoopbackWorker());
  await assert.rejects(fresh.build({ mode: 'mono' }), /nothing analysed/);
  const pending = fresh.analyze([tone(5, 22050)], 22050);
  fresh.terminate();
  await assert.rejects(pending, /terminated/);
});
