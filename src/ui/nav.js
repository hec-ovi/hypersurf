// Menu navigation, pure: which control a direction key (or a gamepad
// d-pad) moves focus to, from the controls' screen rectangles. No DOM, so
// it is tested in Node; src/ui/focus.js feeds it real rectangles.
//
// A candidate must lie in the pressed direction (its centre past the
// current centre along that axis). Among those, the nearest wins, with
// sideways distance weighted more than forward distance so a straight
// line beats a diagonal: a menu stack moves up and down its column, a row
// of diamonds moves along the row.

/** Direction names to unit vectors in screen space (y grows downward). */
export const DIRS = Object.freeze({
  up: Object.freeze([0, -1]),
  down: Object.freeze([0, 1]),
  left: Object.freeze([-1, 0]),
  right: Object.freeze([1, 0]),
});

/** Keyboard codes (and gamepad buttons, see padAction) to navigation actions. */
export const KEY_ACTIONS = Object.freeze({
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
  Enter: 'ok', NumpadEnter: 'ok', Space: 'ok',
  Escape: 'back', Backspace: 'back',
  KeyQ: 'prevTab', KeyE: 'nextTab',
});

/** Standard-mapping gamepad button index to action. */
export const PAD_ACTIONS = Object.freeze({
  0: 'ok', 1: 'back', 4: 'prevTab', 5: 'nextTab', 9: 'back',
  12: 'up', 13: 'down', 14: 'left', 15: 'right',
});

/**
 * Index of the rectangle to move to from `from` in direction `dir`, or -1.
 * @param rects  [{ x, y, w, h }] in screen pixels (disabled ones already removed)
 * @param from   current index, or -1 for none (then the first rectangle wins)
 * @param dir    'up' | 'down' | 'left' | 'right'
 */
export function spatialNext(rects, from, dir) {
  if (!rects.length) return -1;
  if (from < 0 || from >= rects.length) return 0;
  const d = DIRS[dir];
  if (!d) return from;
  const a = rects[from];
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
  let best = -1, bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    if (i === from) continue;
    const r = rects[i];
    const bx = r.x + r.w / 2, by = r.y + r.h / 2;
    const dx = bx - ax, dy = by - ay;
    const forward = dx * d[0] + dy * d[1];
    if (forward <= 1) continue;
    // Sideways distance, measured to the nearest edge along the other
    // axis: controls that overlap it are "straight ahead" even when their
    // centres are not lined up (a wide button above a narrow one).
    const side = d[0] !== 0 ? gap(a.y, a.h, r.y, r.h) : gap(a.x, a.w, r.x, r.w);
    const score = forward + side * 3;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/** Distance between two intervals [p, p + a) and [q, q + b); 0 when they overlap. */
function gap(p, a, q, b) {
  if (q > p + a) return q - (p + a);
  if (p > q + b) return p - (q + b);
  return 0;
}

/** Next index in a list, stepping `step` and clamping (no wrap) unless wrap is set. */
export function stepIndex(index, step, count, wrap = false) {
  if (count <= 0) return -1;
  const n = index + step;
  if (wrap) return ((n % count) + count) % count;
  return Math.max(0, Math.min(count - 1, n));
}

/**
 * Edge-triggered gamepad reading: which actions were pressed since the
 * last poll, with auto-repeat for held directions (after `delay` ms, every
 * `rate` ms), and the left stick treated as a d-pad past `dead`.
 */
export class PadReader {
  constructor({ delay = 380, rate = 110, dead = 0.55 } = {}) {
    this.delay = delay;
    this.rate = rate;
    this.dead = dead;
    this.held = new Map(); // action → { since, next }
  }

  /**
   * @param pressed  Set-like of actions currently down (from buttons and stick)
   * @param now      ms
   * @param out      array to fill with actions to fire this poll
   */
  update(pressed, now, out) {
    out.length = 0;
    for (const action of pressed) {
      const h = this.held.get(action);
      if (!h) {
        this.held.set(action, { next: now + this.delay });
        out.push(action);
      } else if (isDirection(action) && now >= h.next) {
        h.next = now + this.rate;
        out.push(action);
      }
    }
    for (const action of this.held.keys()) if (!pressed.has(action)) this.held.delete(action);
    return out;
  }

  /** Actions currently down on one standard gamepad, into `into` (a Set). */
  read(pad, into) {
    into.clear();
    if (!pad || !pad.connected) return into;
    for (const [i, action] of Object.entries(PAD_ACTIONS)) {
      const b = pad.buttons[i];
      if (b && b.pressed) into.add(action);
    }
    const x = pad.axes[0] || 0, y = pad.axes[1] || 0;
    if (x < -this.dead) into.add('left');
    else if (x > this.dead) into.add('right');
    if (y < -this.dead) into.add('up');
    else if (y > this.dead) into.add('down');
    return into;
  }
}

const isDirection = (a) => a === 'up' || a === 'down' || a === 'left' || a === 'right';
