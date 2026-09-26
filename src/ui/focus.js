// Menu focus (docs/art-direction.md §11): one screen at a time owns focus.
// Arrow keys, WASD and the gamepad move it spatially between [data-nav]
// controls (pure logic in nav.js); ←/→ on a selector row step its value;
// Enter/Space/A activate; Esc/B go back; Q/E/LB/RB switch tabs. Hover
// moves focus, as in a game menu. The gold look is plain :focus CSS.

import { spatialNext, KEY_ACTIONS, PadReader } from './nav.js';

const isText = (el) => el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'url' || el.type === 'search');
const isRange = (el) => el instanceof HTMLInputElement && el.type === 'range';

export class FocusManager {
  /**
   * @param handlers per screen id: { back(), tab(dir), step(el, dir) }; the
   *   screen root is found by id.
   */
  constructor() {
    this.root = null;
    this.handlers = {};
    this.last = new Map(); // screen id → last focused control
    this.pad = new PadReader();
    this.padDown = new Set();
    this.padOut = [];
    this.polling = false;
    this.enabled = true;
    this.onPad = null; // called with true/false as a gamepad (dis)connects
    this._poll = () => this.poll();
    addEventListener('gamepadconnected', () => { this._padChange(); this._startPoll(); });
    addEventListener('gamepaddisconnected', () => this._padChange());
    document.addEventListener('pointerover', (e) => {
      if (!this.root || !this.enabled) return;
      const el = e.target.closest && e.target.closest('[data-nav]');
      if (el && this.root.contains(el) && document.activeElement !== el && !isText(document.activeElement)) el.focus({ preventScroll: true });
    });
    document.addEventListener('focusin', (e) => {
      if (this.root && this.root.contains(e.target) && e.target.matches('[data-nav]')) this.last.set(this.root.id, e.target);
    });
  }

  register(id, handlers) {
    this.handlers[id] = handlers;
  }

  /** Give focus to a screen: its remembered control, else `initial`, else its [data-default], else the first. */
  show(root, initial = null) {
    this.root = root;
    if (!root) return;
    const remembered = this.last.get(root.id);
    const target = initial
      || (remembered && root.contains(remembered) && this._usable(remembered) ? remembered : null)
      || root.querySelector('[data-default]:not([disabled])')
      || this.controls()[0];
    if (target && this._usable(target)) target.focus({ preventScroll: true });
  }

  /** Focus a control on the current screen. */
  focus(el) {
    if (el && this._usable(el)) el.focus({ preventScroll: true });
  }

  controls() {
    if (!this.root) return [];
    return Array.from(this.root.querySelectorAll('[data-nav]')).filter((el) => this._usable(el));
  }

  _usable(el) {
    return !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.getClientRects().length > 0 && !el.closest('[hidden], [inert]');
  }

  /** Keyboard entry point; returns true when the key was handled. */
  key(e) {
    if (!this.root || !this.enabled) return false;
    const action = KEY_ACTIONS[e.code];
    if (!action) return false;
    const el = document.activeElement;
    if (isText(el)) {
      // Typing wins: only vertical moves, Escape and Enter (form submit) leave the field.
      if (e.code === 'ArrowUp' || e.code === 'ArrowDown') { this.act(action); e.preventDefault(); return true; }
      if (e.code === 'Escape') { this.act('back'); e.preventDefault(); return true; }
      return false;
    }
    if (isRange(el) && (action === 'left' || action === 'right')) return false; // native stepping
    if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (e.repeat) { e.preventDefault(); return true; }
    }
    this.act(action);
    e.preventDefault();
    return true;
  }

  /** Perform a navigation action on the current screen. */
  act(action) {
    const h = this.handlers[this.root.id] || {};
    let el = document.activeElement;
    if (!this.root.contains(el) || el === document.body) el = null;
    switch (action) {
      case 'up': case 'down': case 'left': case 'right': {
        if (el && (action === 'left' || action === 'right')) {
          const dir = action === 'left' ? -1 : 1;
          if (el.hasAttribute('data-step')) { el.dispatchEvent(new CustomEvent('step', { detail: { dir } })); return; }
          if (isRange(el)) { stepRange(el, dir); return; }
          if (h.side && h.side(dir, el)) return;
        }
        const list = this.controls();
        const rects = list.map((c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
        const from = el ? list.indexOf(el) : -1;
        const next = spatialNext(rects, from, action);
        if (next >= 0 && list[next] !== el) list[next].focus({ preventScroll: false });
        else if (!el && list[0]) list[0].focus();
        return;
      }
      case 'ok':
        if (!el) { this.show(this.root); return; }
        if (el.hasAttribute('data-step')) el.dispatchEvent(new CustomEvent('step', { detail: { dir: 1, wrap: true } }));
        else el.click();
        return;
      case 'back':
        if (h.back) h.back();
        return;
      case 'prevTab': case 'nextTab':
        if (h.tab) h.tab(action === 'prevTab' ? -1 : 1);
        else if (h.side) h.side(action === 'prevTab' ? -1 : 1, el);
        return;
      default:
    }
  }

  get gamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  _padChange() {
    if (this.onPad) this.onPad(!!this.gamepad);
  }

  _startPoll() {
    if (this.polling) return;
    this.polling = true;
    requestAnimationFrame(this._poll);
  }

  poll() {
    const pad = this.gamepad;
    if (!pad) { this.polling = false; return; }
    requestAnimationFrame(this._poll);
    if (!this.root || !this.enabled) { this.pad.update(this.padDown, performance.now(), this.padOut); return; }
    this.pad.read(pad, this.padDown);
    for (const a of this.pad.update(this.padDown, performance.now(), this.padOut)) this.act(a);
  }
}

function stepRange(el, dir) {
  const step = Number(el.step) || 1;
  const v = Math.max(Number(el.min), Math.min(Number(el.max), Number(el.value) + dir * step));
  if (String(v) === el.value) return;
  el.value = String(v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
