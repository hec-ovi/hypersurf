// Player input → ship x. Every device produces a target x in metres from
// the centre line; the ship follows it with a critically damped approach
// that crosses one lane (3 m) in about 60 ms and never overshoots.
//
//   keyboard / gamepad d-pad  hold to go to the outer lane, release for centre
//   gamepad stick             analog, full tilt = outer lane
//   mouse                     pointer lock: relative motion; otherwise the
//                             cursor maps absolutely across the canvas
//   touch                     drag maps absolutely across the canvas
//
// ShipMotion and the mapping helpers are pure (tested in Node); the
// InputController wires DOM events to them.

import { LANE_WIDTH, SHOULDER_X } from './rules.js';

/** Critically damped follower. omega 65 rad/s settles a 3 m move to 10% in ~60 ms. */
export class ShipMotion {
  constructor(omega = 65) {
    this.omega = omega;
    this.x = 0;
    this.v = 0;
  }

  reset(x = 0) {
    this.x = x;
    this.v = 0;
  }

  /** Exact solution over dt, so any step size is stable and deterministic. */
  step(dt, target) {
    const w = this.omega, e0 = this.x - target, v0 = this.v;
    const k = Math.exp(-w * dt), c = v0 + w * e0;
    this.x = target + (e0 + c * dt) * k;
    this.v = (v0 - w * c * dt) * k;
    return this.x;
  }
}

/** Hold-to-lane: which way the keys point, most recent press winning ties. */
export function heldDirection(left, right, lastPressed) {
  if (left && right) return lastPressed;
  return left ? -1 : right ? 1 : 0;
}

/** Absolute mapping of a pointer fraction (0 = left edge, 1 = right edge) to ship x. */
export function pointerToX(fraction, maxX, gain = 1.35) {
  const x = (fraction * 2 - 1) * maxX * gain;
  return x < -maxX ? -maxX : x > maxX ? maxX : x;
}

/** Stick value to target x, with a dead zone rescaled so small tilts stay precise. */
export function stickToX(value, maxX, dead = 0.2) {
  const a = Math.abs(value);
  if (a < dead) return 0;
  return Math.sign(value) * Math.min(1, (a - dead) / (1 - dead)) * maxX;
}

const LEFT_KEYS = new Set(['ArrowLeft', 'KeyA']);
const RIGHT_KEYS = new Set(['ArrowRight', 'KeyD']);

/**
 * DOM input. Call attach() once, setShoulders() per mode, and target() once
 * per frame. The most recently used device drives the ship.
 */
export class InputController {
  constructor(element) {
    this.element = element;
    this.shoulders = false;
    this.maxX = LANE_WIDTH;
    this.source = 'keys';
    this.left = false;
    this.right = false;
    this.lastPressed = 1;
    this.pointerX = 0;
    this.lockedX = 0;
    this.sensitivity = 1 / 160; // metres per pixel of locked mouse motion
    this.locked = false;
    this.gamepads = false;
    this.enabled = false;
    this.onPointerLockLost = null;
    this._handlers = null;
  }

  setShoulders(on) {
    this.shoulders = on;
    this.maxX = on ? SHOULDER_X : LANE_WIDTH;
  }

  /** Start listening. */
  attach() {
    if (this._handlers) return;
    const el = this.element;
    const h = {
      keydown: (e) => {
        if (!this.enabled) return;
        const dir = LEFT_KEYS.has(e.code) ? -1 : RIGHT_KEYS.has(e.code) ? 1 : 0;
        if (!dir) return;
        e.preventDefault();
        if (dir < 0) this.left = true; else this.right = true;
        // Auto-repeat re-asserts a key still held after a blur or pause cleared it,
        // but only a fresh press decides which of two held keys wins.
        if (!e.repeat) this.lastPressed = dir;
        this.source = 'keys';
      },
      keyup: (e) => {
        if (LEFT_KEYS.has(e.code)) this.left = false;
        else if (RIGHT_KEYS.has(e.code)) this.right = false;
      },
      blur: () => { this.left = this.right = false; },
      pointermove: (e) => {
        if (!this.enabled) return;
        if (this.locked) {
          this.lockedX = Math.max(-this.maxX, Math.min(this.maxX, this.lockedX + e.movementX * this.sensitivity * LANE_WIDTH));
          this.source = 'lock';
          return;
        }
        if (e.pointerType === 'mouse' && e.buttons === 0 && this.source === 'keys' && Math.abs(e.movementX) < 2) return;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0) this.pointerX = pointerToX((e.clientX - rect.left) / rect.width, this.maxX);
        this.source = e.pointerType === 'touch' ? 'touch' : 'mouse';
      },
      pointerdown: (e) => {
        if (!this.enabled) return;
        if (e.pointerType === 'touch') {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0) this.pointerX = pointerToX((e.clientX - rect.left) / rect.width, this.maxX);
          this.source = 'touch';
        } else if (e.pointerType === 'mouse' && !this.locked) this.requestLock();
      },
      pointerlockchange: () => {
        const was = this.locked;
        this.locked = document.pointerLockElement === el;
        if (this.locked) this.lockedX = this.targetNow();
        if (was && !this.locked && this.onPointerLockLost) this.onPointerLockLost();
      },
      gamepadconnected: () => { this.gamepads = true; },
    };
    window.addEventListener('keydown', h.keydown);
    window.addEventListener('keyup', h.keyup);
    window.addEventListener('blur', h.blur);
    el.addEventListener('pointermove', h.pointermove);
    el.addEventListener('pointerdown', h.pointerdown);
    document.addEventListener('pointerlockchange', h.pointerlockchange);
    window.addEventListener('gamepadconnected', h.gamepadconnected);
    this._handlers = h;
  }

  /** Ask for pointer lock; browsers refuse outside a user gesture, which is fine. */
  requestLock() {
    const el = this.element;
    if (!el.requestPointerLock || document.pointerLockElement === el) return;
    try {
      const p = el.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') p.catch(() => {
        // Some platforms reject the unadjusted option; retry plain, ignore refusals.
        try { const q = el.requestPointerLock(); if (q && q.catch) q.catch(() => {}); } catch { /* not allowed now */ }
      });
    } catch { /* not allowed now */ }
  }

  releaseLock() {
    if (document.pointerLockElement === this.element && document.exitPointerLock) document.exitPointerLock();
  }

  /** Reset per play: centre, nothing held. */
  reset() {
    this.left = this.right = false;
    this.pointerX = 0;
    this.lockedX = 0;
  }

  /** The target x right now; polls gamepads when any have been seen. */
  target() {
    if (this.gamepads) this._pollGamepads();
    return this.targetNow();
  }

  targetNow() {
    // A held direction key always drives the ship: mouse jitter under pointer
    // lock or an idle stick must not take it away while the key is still down.
    if (this.left || this.right) return heldDirection(this.left, this.right, this.lastPressed) * LANE_WIDTH;
    switch (this.source) {
      case 'lock': return this.lockedX;
      case 'mouse':
      case 'touch': return this.pointerX;
      case 'pad': return this._padX;
      default: return heldDirection(this.left, this.right, this.lastPressed) * LANE_WIDTH;
    }
  }

  _pollGamepads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : null;
    if (!pads) return;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || !p.connected) continue;
      const left = p.buttons[14] && p.buttons[14].pressed, right = p.buttons[15] && p.buttons[15].pressed;
      const stick = stickToX(p.axes[0] || 0, LANE_WIDTH);
      if (left || right) {
        this._padX = heldDirection(left, right, left ? -1 : 1) * LANE_WIDTH;
        this.source = 'pad';
      } else if (stick !== 0 || this.source === 'pad') {
        this._padX = stick;
        if (stick !== 0) this.source = 'pad';
      }
      return;
    }
  }
}
InputController.prototype._padX = 0;
