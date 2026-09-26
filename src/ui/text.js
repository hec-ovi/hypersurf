// Text effects (docs/art-direction.md §5.1): the decode reveal on titles
// and the eased count-up on numbers. The frame functions are pure (tested
// in Node); decode() and CountUp drive them against the DOM.

const GLYPHS = '▮▯◆◇01/\\<>';

export const easeOutCubic = (t) => 1 - (1 - t) ** 3;

/** Small integer hash, so the scrambled glyphs are stable for a given frame. */
function hash(a, b) {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * One frame of the decode reveal of `text` at progress p (0..1): the first
 * round(p · n) characters are resolved, the rest show a glyph that changes
 * every `tick`. Spaces stay spaces, so word shapes hold from the start.
 * @returns {{ done: string, rest: string }} resolved head and scrambled tail
 */
export function decodeFrame(text, p, tick = 0) {
  const n = text.length;
  const k = p >= 1 ? n : Math.max(0, Math.min(n, Math.floor(p * (n + 1))));
  let rest = '';
  for (let i = k; i < n; i++) {
    const c = text[i];
    rest += c === ' ' ? ' ' : GLYPHS[hash(i, tick) % GLYPHS.length];
  }
  return { done: text.slice(0, k), rest };
}

/** The value a count-up shows at time t (ms) of `duration`, from `from` to `to`. */
export function countAt(from, to, t, duration) {
  if (!(duration > 0) || t >= duration) return to;
  if (t <= 0) return from;
  return from + (to - from) * easeOutCubic(t / duration);
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
let calmFlag = false;
/** Calm visuals switch every text effect to its end state. */
export function setCalm(on) { calmFlag = !!on; }
export const motionOff = () => calmFlag || reduced();

const running = new WeakMap();

/**
 * Reveal `text` in `el` with the decode effect. The final text is set on
 * an aria-label first, so assistive tech reads the words, not the glyphs.
 */
export function decode(el, text = el.dataset.text || el.textContent, duration = 420) {
  if (!el) return;
  el.dataset.text = text;
  const prev = running.get(el);
  if (prev) cancelAnimationFrame(prev);
  if (motionOff() || typeof requestAnimationFrame !== 'function') {
    el.textContent = text;
    return;
  }
  el.setAttribute('aria-label', text);
  // The final text, invisible, holds the element's size; the animated
  // text is laid over it, so nothing around it reflows.
  const ghost = document.createElement('span');
  ghost.className = 'decode-ghost';
  ghost.textContent = text;
  const over = document.createElement('span');
  over.className = 'decode-over';
  const head = document.createElement('span');
  const tail = document.createElement('span');
  tail.className = 'scramble';
  over.append(head, tail);
  ghost.setAttribute('aria-hidden', 'true');
  over.setAttribute('aria-hidden', 'true');
  el.replaceChildren(ghost, over);
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / duration);
    const f = decodeFrame(text, p, Math.floor((now - start) / 45));
    head.textContent = f.done;
    tail.textContent = f.rest;
    if (p < 1) running.set(el, requestAnimationFrame(step));
    else {
      running.delete(el);
      el.textContent = text;
      el.removeAttribute('aria-label');
    }
  };
  running.set(el, requestAnimationFrame(step));
}

/** Decode every [data-decode] element inside root. */
export function decodeAll(root) {
  for (const el of root.querySelectorAll('[data-decode]')) decode(el, el.dataset.text || el.textContent);
}

/**
 * A number that eases toward its target: call to(value) when it changes
 * and frame(nowMs) once per frame; the element's text is written only when
 * the formatted value changes.
 */
export class CountUp {
  constructor(el, format, duration = 400) {
    this.el = el;
    this.format = format;
    this.duration = duration;
    this.from = 0;
    this.target = 0;
    this.value = 0;
    this.start = 0;
    this.text = '';
  }

  /** Jump straight to v (no easing). */
  set(v) {
    this.from = this.target = this.value = v;
    this.start = -Infinity;
    this._write();
  }

  to(v, now = performance.now()) {
    if (v === this.target) return;
    if (motionOff()) { this.set(v); return; }
    this.from = this.value;
    this.target = v;
    this.start = now;
  }

  /** @returns whether it is still counting */
  frame(now) {
    if (this.value === this.target) return false;
    this.value = countAt(this.from, this.target, now - this.start, this.duration);
    this._write();
    return this.value !== this.target;
  }

  _write() {
    const t = this.format(this.value);
    if (t !== this.text) {
      this.text = t;
      this.el.textContent = t;
    }
  }
}
