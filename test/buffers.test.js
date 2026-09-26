import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markRange } from '../src/game/buffers.js';

test('markRange reuses one range object per attribute', () => {
  // The shape three's BufferAttribute exposes.
  const attr = { itemSize: 16, updateRanges: [], needsUpdate: false };
  markRange(attr, 10);
  const range = attr.updateRanges[0];
  assert.deepEqual(range, { start: 0, count: 160 });
  attr.updateRanges.length = 0; // what the renderer does after uploading
  markRange(attr, 3);
  assert.equal(attr.updateRanges.length, 1);
  assert.equal(attr.updateRanges[0], range, 'same object');
  assert.equal(range.count, 48);
  markRange(attr, 4); // marked twice before an upload: still one range
  assert.equal(attr.updateRanges.length, 1);
});
