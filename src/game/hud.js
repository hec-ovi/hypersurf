// DOM HUD: the 3×7 grid with its match timer, score (counting up),
// multiplier, song progress and short toasts; plus the results screen.
// Updates touch the DOM only when a shown value changes.

import { COLUMNS, ROWS, EVENT, REASON } from './rules.js';
import { gradientAt, linearToHex } from './palette.js';
import { makeSample } from './trackpath.js';

const fmt = new Intl.NumberFormat('en-US');
export const formatScore = (n) => fmt.format(Math.round(n));

export class Hud {
  constructor(root) {
    this.root = root;
    this.el = {
      progress: root.querySelector('[data-hud=progress]'),
      score: root.querySelector('[data-hud=score]'),
      mult: root.querySelector('[data-hud=mult]'),
      grid: root.querySelector('[data-hud=grid]'),
      timer: root.querySelector('[data-hud=timer]'),
      toast: root.querySelector('[data-hud=toast]'),
      title: root.querySelector('[data-hud=title]'),
    };
    this.cells = [];
    // Row 6 at the top: build rows top-down, columns left to right.
    for (let row = ROWS - 1; row >= 0; row--) {
      for (let col = 0; col < COLUMNS; col++) {
        const c = document.createElement('div');
        c.className = 'cell';
        this.el.grid.appendChild(c);
        this.cells[col * ROWS + row] = c;
      }
    }
    this.shown = new Int32Array(COLUMNS * ROWS).fill(-2);
    this.blockColours = [];
    this.scoreShown = 0;
    this.scoreText = '';
    this.multText = '';
    this.timerShown = -1;
    this.progressShown = -1;
    this.toastUntil = 0;
    this.overfill = new Uint8Array(COLUMNS);
  }

  /** Per-block CSS colours for the grid, from the SongMap (a live map's are made as blocks arrive). */
  load(map, path, title) {
    this.map = map;
    this.path = path;
    this.blockColours = new Array(map.blocks.count);
    for (let i = 0; i < map.blocks.count; i++) this._colour(i);
    this.el.title.textContent = title || '';
  }

  _colour(i) {
    let c = this.blockColours[i];
    if (!c) {
      const rgb = this._rgb || (this._rgb = [0, 0, 0]);
      gradientAt(this.path.sample(this.map.blocks.time[i], this._s || (this._s = makeSample())).intensity, rgb);
      c = this.blockColours[i] = linearToHex(rgb);
    }
    return c;
  }

  reset(mode) {
    this.root.dataset.mode = mode;
    this.shown.fill(-2);
    this.scoreShown = 0;
    this.scoreText = '';
    this.multText = '';
    this.timerShown = -1;
    this.progressShown = -1;
    this.el.toast.classList.remove('show');
    this.update(null, 0, 0);
  }

  /** @param rules RulesEngine (or null); progress 0..1; dt seconds */
  update(rules, progress, dt) {
    const e = this.el;
    const cells = rules ? rules.cells : null;
    for (let k = 0; k < COLUMNS * ROWS; k++) {
      const v = cells ? cells[k] : -1;
      if (v === this.shown[k]) continue;
      const c = this.cells[k];
      if (v >= 0) {
        c.style.setProperty('--c', this._colour(v));
        c.classList.add('on');
        if (this.shown[k] < 0) { c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop'); }
      } else c.classList.remove('on', 'pop');
      this.shown[k] = v;
    }
    // Overfill warning: a full column pulses (orange-red, 2 Hz, small area).
    for (let col = 0; col < COLUMNS; col++) {
      const full = rules && rules.heights[col] === ROWS ? 1 : 0;
      if (full !== this.overfill[col]) {
        this.overfill[col] = full;
        e.grid.classList.toggle(`full${col}`, !!full);
      }
    }
    const target = rules ? rules.score : 0;
    this.scoreShown += (target - this.scoreShown) * Math.min(1, dt * 10);
    if (Math.abs(target - this.scoreShown) < 1) this.scoreShown = target;
    const st = formatScore(this.scoreShown);
    if (st !== this.scoreText) { e.score.textContent = st; this.scoreText = st; }
    const m = rules && rules.multiplier > 1 ? `×${rules.multiplier}` : '';
    if (m !== this.multText) { e.mult.textContent = m; e.mult.classList.toggle('show', !!m); this.multText = m; }
    const tf = rules ? Math.round(rules.timerFraction * 100) : 0;
    if (tf !== this.timerShown) { e.timer.style.transform = `scaleX(${tf / 100})`; this.timerShown = tf; }
    const pr = Math.round(Math.min(1, Math.max(0, progress)) * 1000);
    if (pr !== this.progressShown) { e.progress.style.transform = `scaleX(${pr / 1000})`; this.progressShown = pr; }
  }

  /** Restart a one-shot CSS animation class on a cell, with a delay. */
  _flash(k, cls, delayMs) {
    const c = this.cells[k];
    c.style.setProperty('--d', `${delayMs}ms`);
    c.classList.remove('burst', 'crack');
    void c.offsetWidth;
    c.classList.add(cls);
  }

  /** React to one rules event. The grid shown is still the one before it. */
  event(ev) {
    switch (ev.type) {
      case EVENT.GREY:
        if (ev.value > 0) {
          // The grey took the top block of its column: that cell cracks.
          const col = ev.lane + 1;
          for (let row = ROWS - 1; row >= 0; row--) {
            if (this.shown[col * ROWS + row] >= 0) { this._flash(col * ROWS + row, 'crack', 0); break; }
          }
        }
        break;
      case EVENT.COLLECT:
        // Cash-in: every collected cell bursts, bottom row first, 20 ms apart.
        if (ev.value > 0) {
          for (let k = 0; k < COLUMNS * ROWS; k++) if (this.shown[k] >= 0) this._flash(k, 'burst', (k % ROWS) * 20);
        }
        if (ev.value > 0) this.toast(`+${formatScore(ev.value)}${ev.reason === REASON.OVERFILL ? ' overfill' : ev.reason === REASON.PB_OVERFILL ? ' PB overfill' : ''}`, ev.mult > 1 ? 'big' : '');
        break;
      case EVENT.POWER:
        this.toast(ev.mult > 1 ? `Power ×${ev.mult}` : 'Grid doubled', 'power');
        break;
      case EVENT.SPIKE:
        if (ev.count > 0) this.toast('Wiped', 'bad');
        break;
      default:
        break;
    }
  }

  toast(text, kind = '') {
    const t = this.el.toast;
    t.textContent = text;
    t.className = `toast show ${kind}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 900);
  }
}

/** Fill the results panel. */
export function showResults(root, { results, best, title, modeLabel }) {
  const q = (sel) => root.querySelector(sel);
  q('[data-res=title]').textContent = title;
  q('[data-res=mode]').textContent = modeLabel;
  q('[data-res=raw]').textContent = formatScore(results.raw);
  const list = q('[data-res=bonuses]');
  list.replaceChildren();
  if (results.bonuses.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No bonus';
    list.appendChild(li);
  }
  for (const b of results.bonuses) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `${b.label} +${b.percent}%`;
    const pts = document.createElement('span');
    pts.textContent = `+${formatScore(b.points)}`;
    li.append(name, pts);
    list.appendChild(li);
  }
  q('[data-res=final]').textContent = formatScore(results.final);
  const s = results.stats;
  q('[data-res=stats]').textContent =
    `Blocks ${s.colourHit}/${s.colour} · ${results.mode === 'ninja' ? 'Spikes hit' : 'Greys'} ${s.greyHit}/${s.grey} · Power ${s.powerHit}/${s.power} · Biggest match ${s.biggestMatch}`;
  const bestEl = q('[data-res=best]');
  if (best.isNew) {
    bestEl.textContent = best.previous ? `New best! Previous ${formatScore(best.previous.final)}` : 'New best!';
    bestEl.classList.add('new');
  } else {
    bestEl.textContent = `Best ${formatScore(best.best.final)}`;
    bestEl.classList.remove('new');
  }
}
