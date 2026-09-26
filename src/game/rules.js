// Gameplay rules for Mono and its variants (Ninja, Casual). Pure: no DOM,
// no GPU, no clock of its own. The game loop feeds it song time and ship x
// at a fixed step; it resolves block hits, runs the match timer and keeps
// the score. Rules follow docs/research.md §1.2.
//
// The grid is 3 columns × 7 rows with gravity, and Mono has a single block
// colour, so the grid is fully described by its column heights: with the
// centre column filled every block touches every other one, and with it
// empty the outer columns are separate groups.

import { BLOCK } from '../audio/songmap.js';

export const COLUMNS = 3;
export const ROWS = 7;

/** Lane centres are at x = 3·lane; dividers at ±1.5, shoulders at ±4.5. */
export const LANE_WIDTH = 3;
export const SHOULDER_X = 4.5;
/** Past this |x| a ship on a shoulder touches nothing. */
export const SHOULDER_EDGE = (LANE_WIDTH + SHOULDER_X) / 2;

/**
 * Hit windows in seconds around the block's time: a block can be taken from
 * `early` before it to `late` after it. Colours (and power blocks) are
 * forgiving, greys tight, in AS2's ~4:1 ratio.
 */
export const HIT_WINDOW = Object.freeze({
  colour: Object.freeze({ early: 0.02, late: 0.07 }),
  grey: Object.freeze({ early: 0.01, late: 0.018 }),
});

export const SCORE = Object.freeze({
  /** Points per match: base · n². */
  base: 35,
  /** Power block with a live match. */
  pbMultiplier: 1.5,
  bigPbMultiplier: 2,
  /** An overfill this soon after a power block pays only a fraction. */
  pbOverfillWindow: 1,
  pbOverfillFactor: 0.25,
  /** A falling block holds the timer for fallBase + fallPerRow · empty rows. */
  fallBase: 0.25,
  fallPerRow: 0.1,
});

/** Lane under ship x: -1, 0, 1, or null on a shoulder. */
export function laneAt(x, shoulders = false) {
  if (shoulders && Math.abs(x) > SHOULDER_EDGE) return null;
  return x < -LANE_WIDTH / 2 ? -1 : x > LANE_WIDTH / 2 ? 1 : 0;
}

/** Clamp ship x to the drivable width. */
export function clampShipX(x, shoulders = false) {
  const m = shoulders ? SHOULDER_X : LANE_WIDTH;
  return x < -m ? -m : x > m ? m : x;
}

export function hitWindow(type) {
  return type === BLOCK.GREY ? HIT_WINDOW.grey : HIT_WINDOW.colour;
}

/** Whether a block of this type can be hit dt seconds after its time (dt < 0: early). */
export function inHitWindow(type, dt) {
  const w = hitWindow(type);
  return dt >= -w.early && dt <= w.late;
}

/** Points for one connected match of n blocks. */
export const matchPoints = (n) => SCORE.base * n * n;

/** Timer hold for a block falling into a column that holds `height` blocks. */
export const fallHold = (height) => SCORE.fallBase + SCORE.fallPerRow * (ROWS - height);

/**
 * Sizes of the groups that would score, from column heights [left, centre, right].
 * With the centre filled everything is one group; with it empty each outer
 * column is its own group and scores only with more than two blocks.
 */
export function scoringGroups(heights) {
  const [l, c, r] = heights;
  if (c > 0) return l + c + r >= 3 ? [l + c + r] : [];
  const out = [];
  if (l > 2) out.push(l);
  if (r > 2) out.push(r);
  return out;
}

/** Whether the grid holds a match (≥ 3 connected blocks). */
export function hasMatch(heights) {
  const [l, c, r] = heights;
  return c > 0 ? l + c + r >= 3 : l > 2 || r > 2;
}
