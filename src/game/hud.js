// DOM HUD (docs/art-direction.md §9): the song cluster with its intensity
// profile, the score with BEST progress and the power chip, the 3×7 grid
// in its housing with lane diamonds and the match ring, and the event feed.
// Updates touch the DOM only when a shown value changes, and animate only
// transform and opacity. Also fills the results screen.

import { COLUMNS, ROWS, EVENT, REASON, matchPoints, scoringGroups } from './rules.js';
import { gradientAt, linearToHex } from './palette.js';
import { makeSample } from './trackpath.js';
import { Profile } from '../ui/profile.js';
import { CountUp, countAt, motionOff } from '../ui/text.js';
import { FX_COLOURS } from '../ui/particles.js';
import { gaugeHtml } from '../ui/gauge.js';

const fmt = new Intl.NumberFormat('en-US');
export const formatScore = (n) => fmt.format(Math.round(n));

/** m:ss for a time in seconds (negative clamps to 0). */
export function clock(t) {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Blocks and points of the match that would cash in now (0, 0 when none). */
export function pendingMatch(heights, mult = 1) {
  const groups = scoringGroups(heights);
  let blocks = 0, points = 0;
  for (const n of groups) { blocks += n; points += matchPoints(n); }
  return { blocks, points: Math.round(points * mult) };
}

const FEED_MAX = 3;
const FEED_HOLD = 1600;
const MODE_NAME = { mono: 'Mono', ninja: 'Ninja', casual: 'Casual' };

export class Hud {
  /** @param fx optional FxLayer for sparks */
  constructor(root, fx = null) {
    this.root = root;
    this.fx = fx;
    const q = (s) => root.querySelector(`[data-hud=${s}]`);
    this.el = {
      score: q('score'), mult: q('mult'), grid: q('grid'), timer: q('timer'), count: q('count'), pending: q('pending'),
      title: q('title'), mode: q('mode'), elapsed: q('elapsed'), remain: q('remain'), feed: q('feed'), lanes: q('lanes'),
      bestRow: q('bestrow'), bestLabel: q('bestlabel'), bestFill: q('bestfill'), housing: q('housing'),
      live: q('live'), liveText: q('livetext'), waiting: q('waiting'),
    };
    this.gridWrap = root.querySelector('.hud-grid');
    this.ping = this.el.mult.querySelector('.ping');
    this.laneDots = Array.from(this.el.lanes.children);
    this.profile = new Profile(q('profile'));
    this.cells = [];
    // Row 6 at the top: build rows top-down, columns left to right.
    for (let row = ROWS - 1; row >= 0; row--) {
      for (let col = 0; col < COLUMNS; col++) {
        const c = document.createElement('div');
        c.className = 'cell';
        c.innerHTML = '<i class="glow"></i><i class="tile"></i><i class="pend"></i><i class="crackline"></i>';
        this.el.grid.appendChild(c);
        this.cells[col * ROWS + row] = c;
      }
    }
    this.shown = new Int32Array(COLUMNS * ROWS).fill(-2);
    this.overfill = new Uint8Array(COLUMNS);
    this.blockColours = [];
    this.scoreCount = new CountUp(this.el.score, formatScore, 400);
    this.best = 0;
    this.feed = [];
    this.reset('mono');
  }

  /** Per-block CSS colours and the profile, from the SongMap (a live map's colours are made as blocks arrive). */
  load(map, path, title, { live = false } = {}) {
    this.map = map;
    this.path = path;
    this.live = live;
    this.blockColours = new Array(map.blocks.count);
    for (let i = 0; i < map.blocks.count; i++) this._colour(i);
    this.el.title.textContent = title || '';
    this.duration = map.duration;
    if (!live) this.profile.song(path, map.duration, map.powerBlocks ? map.powerBlocks.map((pb) => pb.time) : []);
    else this.profile.rolling(path, 0);
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

  /** @param best the stored best final score for this song and mode (0 for none) */
  reset(mode, best = 0) {
    this.root.dataset.mode = mode;
    this.el.mode.textContent = MODE_NAME[mode] || mode;
    this.shown.fill(-2);
    this.overfill.fill(0);
    for (let c = 0; c < COLUMNS; c++) { this.gridWrap.classList.remove(`full${c}`); this.el.grid.classList.remove(`full${c}`); }
    this.scoreCount.set(0);
    this.multText = null;
    this.timerShown = -1;
    this.countShown = -2;
    this.pendingShown = -1;
    this.pendingOn = false;
    this.el.grid.classList.remove('pending');
    this.lane = -9;
    this.elapsedText = '';
    this.remainText = '';
    this.best = best;
    this.bestShown = -1;
    this.beat = false;
    this.el.bestRow.hidden = !(best > 0);
    this.el.bestRow.classList.remove('beat');
    if (best > 0) this.el.bestLabel.textContent = `Best ${formatScore(best)}`;
    for (const f of this.feed) f.el.remove();
    this.feed.length = 0;
    this.rollNext = 0;
    this.lastScore = 0;
    this.liveTextShown = '';
    this.liveStatus(null);
    this.update(null, 0, 0, 0);
  }

  /** Live runs: the readout chip, and the quiet state before audio arrives. */
  liveStatus(s) {
    if (!s) { this.el.live.hidden = true; this.el.waiting.hidden = true; this.root.classList.remove('waiting-audio'); return; }
    const waiting = !s.heard;
    this.el.waiting.hidden = !waiting;
    this.root.classList.toggle('waiting-audio', waiting);
    this.el.live.hidden = waiting;
    const text = s.tempo ? `${Math.round(s.tempo)} BPM · LOCK ${Math.round((s.confidence || 0) * 100)}% · ${s.latencyMs >= 0 ? '+' : ''}${s.latencyMs} MS` : `Listening · ${s.latencyMs >= 0 ? '+' : ''}${s.latencyMs} MS`;
    if (text !== this.liveTextShown) { this.el.liveText.textContent = text; this.liveTextShown = text; }
    this.el.live.classList.toggle('locked', !!s.locked);
  }

  /**
   * @param rules RulesEngine (or null); t song time (s); dt seconds; lane
   *   the ship's lane (-1, 0, 1, or null on a shoulder)
   */
  update(rules, t, dt, lane = 0) {
    const e = this.el;
    const now = performance.now();
    const cells = rules ? rules.cells : null;
    for (let k = 0; k < COLUMNS * ROWS; k++) {
      const v = cells ? cells[k] : -1;
      if (v === this.shown[k]) continue;
      const c = this.cells[k];
      if (v >= 0) {
        c.style.setProperty('--c', this._colour(v));
        c.classList.remove('burst', 'crack');
        c.classList.add('on');
        if (this.shown[k] < 0) { c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop'); }
      } else c.classList.remove('on', 'pop');
      this.shown[k] = v;
    }
    // Overfill warning: the full column's rails pulse (orange-red, 2 Hz, small area).
    for (let col = 0; col < COLUMNS; col++) {
      const full = rules && rules.heights[col] === ROWS ? 1 : 0;
      if (full !== this.overfill[col]) {
        this.overfill[col] = full;
        e.grid.classList.toggle(`full${col}`, !!full);
        this.gridWrap.classList.toggle(`full${col}`, !!full);
      }
    }
    // Score, counting up; a big jump leaves a faint trail of motes.
    const score = rules ? rules.score : 0;
    if (score !== this.scoreCount.target) {
      if (score - this.lastScore >= 1000 && this.fx && !motionOff()) this._trail();
      this.scoreCount.to(score, now);
      this.lastScore = score;
    }
    this.scoreCount.frame(now);
    // Best progress.
    if (this.best > 0) {
      const f = Math.min(1, this.scoreCount.value / this.best);
      const q = Math.round(f * 140);
      if (q !== this.bestShown) { e.bestFill.style.transform = `scaleX(${q / 140})`; this.bestShown = q; }
      if (!this.beat && score > this.best) {
        this.beat = true;
        e.bestRow.classList.add('beat');
        e.bestLabel.textContent = '◆ New best';
      }
    }
    // Power multiplier chip.
    const mult = rules ? rules.multiplier : 1;
    const m = mult > 1 ? `×${mult}` : '';
    if (m !== this.multText) {
      const was = this.multText;
      this.multText = m;
      if (m) e.mult.firstElementChild.textContent = m;
      e.mult.classList.toggle('show', !!m);
      if (m && !was && !motionOff()) { this.ping.classList.remove('go'); void this.ping.offsetWidth; this.ping.classList.add('go'); }
    }
    // Match ring: timer arc, pending block count and points.
    const tf = rules ? Math.round(rules.timerFraction * 100) : 0;
    if (tf !== this.timerShown) { e.timer.style.strokeDasharray = `${tf} 100`; this.timerShown = tf; }
    const pend = rules && rules.timerActive ? pendingMatch(rules.heights, mult) : null;
    const count = pend ? pend.blocks : -1;
    if (count !== this.countShown) {
      e.count.textContent = count > 0 ? String(count) : '—';
      e.count.classList.toggle('none', count <= 0);
      this.countShown = count;
    }
    const pts = pend ? pend.points : 0;
    if (pts !== this.pendingShown) { e.pending.textContent = pts ? `+${formatScore(pts)}` : ''; this.pendingShown = pts; }
    const on = !!pend;
    if (on !== this.pendingOn) { e.grid.classList.toggle('pending', on); this.pendingOn = on; }
    // Lane diamonds.
    if (lane !== this.lane) {
      for (let i = 0; i < 3; i++) this.laneDots[i].classList.toggle('on', lane === i - 1);
      e.lanes.classList.toggle('shoulder', lane === null);
      this.lane = lane;
    }
    // Times and the profile playhead.
    const el = this.live ? `${clock(t)} · LIVE` : clock(t);
    if (el !== this.elapsedText) { e.elapsed.textContent = el; this.elapsedText = el; }
    const rem = this.live || !this.duration ? '' : `−${clock(this.duration - t)}`;
    if (rem !== this.remainText) { e.remain.textContent = rem; this.remainText = rem; }
    if (this.live) {
      if (now >= this.rollNext && this.path) { this.rollNext = now + 500; this.profile.rolling(this.path, Math.max(0, t)); }
      this.profile.set(1);
    } else this.profile.set(this.duration ? t / this.duration : 0);
    // Event feed lifetimes.
    for (let i = this.feed.length - 1; i >= 0; i--) {
      const f = this.feed[i];
      if (!f.gone && now > f.until) { f.gone = true; f.el.classList.add('gone'); }
      if (now > f.until + 320) { f.el.remove(); this.feed.splice(i, 1); }
    }
  }

  /** Restart a one-shot CSS animation class on a cell, with a delay. */
  _flash(k, cls, delayMs) {
    const c = this.cells[k];
    c.style.setProperty('--d', `${delayMs}ms`);
    c.classList.remove('burst', 'crack', 'pop');
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
      case EVENT.COLLECT: {
        if (!(ev.value > 0)) break;
        // Cash-in: collected tiles burst bottom-up, 20 ms apart, and throw sparks.
        for (let k = 0; k < COLUMNS * ROWS; k++) {
          if (this.shown[k] < 0) continue;
          this._flash(k, 'burst', (k % ROWS) * 20);
          if (this.fx && !motionOff()) this._sparkCell(k);
        }
        const over = ev.reason === REASON.OVERFILL || ev.reason === REASON.PB_OVERFILL;
        const label = ev.reason === REASON.PB_OVERFILL ? 'PB overfill' : over ? 'Overfill' : 'Match';
        this.callout(over ? 'over' : '', label, `${ev.count} blocks${ev.mult > 1 ? ` · ×${ev.mult}` : ''}`, `+${formatScore(ev.value)}`);
        break;
      }
      case EVENT.POWER:
        this.callout('power', 'Power', ev.mult > 1 ? 'Match multiplied' : 'Grid doubled', ev.mult > 1 ? `×${ev.mult}` : '×2');
        break;
      case EVENT.SPIKE:
        if (ev.count > 0) {
          const h = this.el.housing;
          h.classList.remove('wiped');
          void h.offsetWidth;
          h.classList.add('wiped');
          this.callout('wiped', 'Wiped', `${ev.count} blocks lost`, '0');
        }
        break;
      default:
        break;
    }
  }

  /** A chip in the event feed: newest on top, at most three, older ones fading. */
  callout(kind, label, sub, value) {
    const el = document.createElement('div');
    el.className = `ev in ${kind}`;
    el.innerHTML = '<span class="lab"><b></b><span></span></span><span class="v"></span>';
    el.querySelector('b').textContent = label;
    el.querySelector('.lab span').textContent = sub;
    el.querySelector('.v').textContent = value;
    this.el.feed.prepend(el);
    this.feed.unshift({ el, until: performance.now() + FEED_HOLD, gone: false });
    while (this.feed.length > FEED_MAX + 1) this.feed.pop().el.remove();
    for (let i = 0; i < this.feed.length; i++) {
      const f = this.feed[i];
      f.el.style.transform = i ? `translateY(${i * 48}px)` : '';
      if (!f.gone) f.el.style.opacity = i === 0 ? '' : i === 1 ? '.6' : i === 2 ? '.35' : '0';
    }
    if (this.fx && !motionOff()) {
      const colour = kind === 'power' ? FX_COLOURS.lime : kind === 'over' ? FX_COLOURS.overfill : kind === 'wiped' ? FX_COLOURS.red : FX_COLOURS.cyan;
      const r = this.el.feed.getBoundingClientRect();
      this.fx.burst(r.right - 240, r.top + 20, 14, { colour, speed: 180, angle: Math.PI, spread: 1.6, life: 0.5, size: 2.2, jitter: 20 });
    }
  }

  _sparkCell(k) {
    const r = this.cells[k].getBoundingClientRect();
    const colour = this.fx.colourFor(this.blockColours[this.shown[k]] || '#3fe0d0');
    this.fx.burst(r.left + r.width / 2, r.top + r.height / 2, 10, { colour, speed: 160, angle: -Math.PI / 2, spread: 2.4, life: 0.55, size: 2.4, gravity: -60, jitter: r.width });
  }

  _trail() {
    const r = this.el.score.getBoundingClientRect();
    for (let i = 0; i < 6; i++) {
      this.fx.spawn(r.left + r.width * (0.2 + 0.1 * i), r.top + r.height * 0.6, -30 - 12 * i, -40 - 10 * i, 0.7, 2, FX_COLOURS.cyanHi, 1.2, 0);
    }
  }
}

// --- results -----------------------------------------------------------------------

/**
 * Fill the results panel; with `animate`, the numbers count up (raw, then
 * each bonus, then the final) and the best badge fades in after.
 */
export function showResults(root, { results, best, title, modeLabel, animate = true }) {
  const q = (sel) => root.querySelector(sel);
  q('[data-res=title]').textContent = title;
  q('[data-res=mode]').textContent = `Results · ${modeLabel}`;
  const list = q('[data-res=bonuses]');
  list.replaceChildren();
  const rows = [];
  if (results.bonuses.length === 0) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'No bonus';
    list.appendChild(li);
  }
  for (const b of results.bonuses) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `${b.label} +${b.percent}%`;
    const pts = document.createElement('b');
    pts.className = 'num';
    li.append(name, pts);
    list.appendChild(li);
    rows.push({ el: pts, to: b.points, prefix: '+' });
  }
  const s = results.stats;
  const ninja = results.mode === 'ninja';
  const pct = (n, d) => Math.round((n / d) * 100);
  const ring = (label, n, d) => gaugeHtml({ label, value: d ? pct(n, d) : '—', unit: d ? '%' : '', fraction: d ? n / d : 0, sub: `${formatScore(n)} <small>/ ${formatScore(d)}</small>` });
  q('[data-res=gauges]').innerHTML = [
    ring('Blocks', s.colourHit, s.colour),
    ring(ninja ? 'Spikes dodged' : 'Greys dodged', s.grey - s.greyHit, s.grey),
    ring('Power', s.powerHit, s.power),
    gaugeHtml({ label: 'Biggest match', value: s.biggestMatch, fraction: s.biggestMatch / (COLUMNS * ROWS), sub: `${s.biggestMatch} <small>/ ${COLUMNS * ROWS}</small>` }),
  ].join('');
  const bestEl = q('[data-res=best]');
  bestEl.replaceChildren();
  if (best.isNew) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '◆ New local best';
    bestEl.append(badge);
    if (best.previous) {
      const prev = document.createElement('span');
      prev.className = 'micro';
      prev.textContent = `Previous ${formatScore(best.previous.final)}`;
      bestEl.append(prev);
    }
  } else {
    const b = document.createElement('span');
    b.className = 'micro';
    b.textContent = `Best ${formatScore(best.best.final)}`;
    bestEl.append(b);
  }
  const raw = q('[data-res=raw]'), fin = q('[data-res=final]');
  // Count-up schedule: raw 600 ms, each bonus 300 ms (150 ms apart), final 700 ms.
  const plan = [{ el: raw, to: results.raw, at: 0, dur: 600 }];
  let at = 600;
  for (const r of rows) { plan.push({ ...r, at, dur: 300 }); at += 150; }
  plan.push({ el: fin, to: results.final, at: at + 150, dur: 700 });
  const end = at + 150 + 700;
  const write = (p, v) => { p.el.textContent = `${p.prefix || ''}${formatScore(v)}`; };
  if (!animate || motionOff()) {
    for (const p of plan) write(p, p.to);
    return null;
  }
  for (const p of plan) write(p, 0);
  bestEl.style.opacity = '0';
  const start = performance.now();
  let raf = 0;
  const tick = (now) => {
    const t = now - start;
    for (const p of plan) write(p, countAt(0, p.to, t - p.at, p.dur));
    if (t < end) raf = requestAnimationFrame(tick);
    else {
      bestEl.style.opacity = '';
      const badge = bestEl.querySelector('.badge');
      if (badge) badge.classList.add('in');
    }
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
