// A simple lane-following bot: steer for the next colour or power block
// and, if a grey or spike is about to arrive in that lane first, move to the
// free lane beside it. The play test uses it to drive whole songs through
// the rules, and ?debug=1 exposes it for hands-free checks in the browser.

import { BLOCK } from '../audio/songmap.js';
import { LANE_WIDTH } from './rules.js';
import { STATUS } from '../live/livemap.js';

/** Returns target(t) → ship x for a SongMap's blocks. Call with increasing t. */
export function createAutopilot(blocks) {
  let i = 0;
  // A live map's blocks grow and can be withdrawn; read status per block.
  const gone = (k) => blocks.status !== undefined && blocks.status[k] === STATUS.GONE;
  return (t) => {
    while (i < blocks.count && blocks.time[i] + 0.07 < t) i++;
    let target = 0, found = false;
    for (let k = i; k < blocks.count && blocks.time[k] < t + 0.5; k++) {
      if (blocks.type[k] !== BLOCK.GREY && !gone(k)) { target = blocks.lane[k]; found = true; break; }
    }
    if (!found) return 0;
    for (let k = i; k < blocks.count && blocks.time[k] < t + 0.05; k++) {
      if (blocks.type[k] === BLOCK.GREY && !gone(k) && blocks.lane[k] === target && blocks.time[k] + 0.02 >= t) {
        target = target === 0 ? 1 : 0;
        break;
      }
    }
    return target * LANE_WIDTH;
  };
}
