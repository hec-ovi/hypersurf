// GPU buffer upload helpers that allocate nothing per frame.
//
// BufferAttribute.addUpdateRange pushes a fresh { start, count } object on
// every call, and the renderer clears the list after each upload, so
// marking a range every frame allocates every frame. markRange keeps one
// range object per attribute and pushes that same object again.

/** Upload only [0, count) items' worth of `attr` on the next render. */
export function markRange(attr, count) {
  let range = attr.userRange;
  if (!range) range = attr.userRange = { start: 0, count: 0 };
  range.count = count * attr.itemSize;
  attr.updateRanges.length = 0;
  attr.updateRanges.push(range);
  attr.needsUpdate = true;
}
