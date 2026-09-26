// The loading screen (docs/art-direction.md §7.5): a 72-segment progress
// ring, the real analysis stages with measured times, a stats strip and a
// tip. Stage keys are the analyzer's progress stages plus the app's own.

const SEGMENTS = 72;
export const STAGES = [
  ['synth', 'Synthesise'], ['decode', 'Decode'], ['resample', 'Resample'], ['spectrum', 'Spectrum'],
  ['onsets', 'Onsets'], ['tempo', 'Tempo'], ['loudness', 'Loudness'], ['build', 'Build track'], ['shaders', 'Warm up shaders'],
];
const LIVE_STAGES = [['share', 'Share tab'], ['calibrate', 'Calibrate'], ['build', 'Build track'], ['shaders', 'Warm up shaders']];
const TIPS = [
  'Hit sounds follow the beat grid, so they stay in time even when you are late.',
  'Fill a column to seven and the whole grid cashes in at once: an overfill.',
  'A power block during a pending match multiplies it. Without one, it copies your grid.',
  'Blocks arriving early or late? Settings › Audio latency lines them up with your speakers.',
  'Intense parts of the song run downhill and fast; calm parts climb.',
];

export class Loading {
  constructor(root) {
    this.root = root;
    const q = (s) => root.querySelector(`[data-load=${s}]`);
    this.el = { segs: q('segs'), pct: q('pct'), verb: q('verb'), title: q('title'), meta: q('meta'), stages: q('stages'), stats: q('stats'), tip: q('tip') };
    const ns = 'http://www.w3.org/2000/svg';
    const r = 150, c = 180;
    this.segs = [];
    for (let i = 0; i < SEGMENTS; i++) {
      // 3px arcs with 2px gaps, drawn as short strokes on a 300px circle.
      const a0 = (i / SEGMENTS) * Math.PI * 2 - Math.PI / 2;
      const a1 = a0 + (Math.PI * 2 / SEGMENTS) * 0.6;
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', `M${c + r * Math.cos(a0)} ${c + r * Math.sin(a0)} A${r} ${r} 0 0 1 ${c + r * Math.cos(a1)} ${c + r * Math.sin(a1)}`);
      p.setAttribute('class', 'seg');
      this.el.segs.appendChild(p);
      this.segs.push(p);
    }
    this.lit = 0;
    this.tipIndex = Math.floor(Math.random() * TIPS.length);
  }

  /** Start a load: title, meta line, which stages apply. */
  begin(title, meta, { demo = false, live = false, file = false } = {}) {
    this.el.title.textContent = title;
    this.el.meta.textContent = meta || '';
    this.el.stats.textContent = '';
    this.el.verb.textContent = live ? 'Listening' : 'Analysing';
    const list = live ? LIVE_STAGES : STAGES.filter(([k]) => (k !== 'synth' || demo) && (k !== 'decode' || file));
    this.el.stages.replaceChildren(...list.map(([key, label]) => {
      const li = document.createElement('li');
      li.dataset.key = key;
      li.append(label);
      const s = document.createElement('span');
      li.appendChild(s);
      return li;
    }));
    this.current = null;
    this.since = performance.now();
    this.tipIndex = (this.tipIndex + 1) % TIPS.length;
    this.el.tip.textContent = TIPS[this.tipIndex];
    this.progress(0);
  }

  /** Mark `key` as the running stage (earlier ones done, with their measured time). */
  stage(key) {
    if (key === this.current) return;
    const now = performance.now();
    const items = Array.from(this.el.stages.children);
    const at = items.findIndex((li) => li.dataset.key === key);
    if (at < 0) return;
    items.forEach((li, i) => {
      if (i < at && !li.classList.contains('done')) {
        li.classList.remove('now');
        li.classList.add('done');
        if (li.dataset.key === this.current) li.lastChild.textContent = `${((now - this.since) / 1000).toFixed(1)} S`;
      }
      if (i === at) li.classList.add('now');
    });
    this.current = key;
    this.since = now;
  }

  /** Finish every stage (the load is over). */
  done() {
    const now = performance.now();
    for (const li of this.el.stages.children) {
      if (li.classList.contains('now')) li.lastChild.textContent = `${((now - this.since) / 1000).toFixed(1)} S`;
      li.classList.remove('now');
      li.classList.add('done');
    }
    this.progress(1);
  }

  progress(f) {
    const p = Math.max(0, Math.min(1, f));
    const n = Math.round(p * SEGMENTS);
    if (n !== this.lit) {
      for (let i = 0; i < SEGMENTS; i++) this.segs[i].classList.toggle('on', i < n);
      this.lit = n;
    }
    this.el.pct.textContent = String(Math.round(p * 100));
  }

  stats(text) {
    this.el.stats.textContent = text;
  }
}
