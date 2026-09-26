// The live dock's DOM: the YouTube player's host element, a status line,
// Start and Back, the blocks-per-beat buttons and the timing control. It
// only shows and reports; the game decides. Kept apart from the HUD so the UI can be
// redesigned without touching the live logic.

export class LiveDock {
  constructor(root) {
    this.root = root;
    this.player = root.querySelector('[data-live=player]');
    this.statusEl = root.querySelector('[data-live=status]');
    this.startBtn = root.querySelector('#live-start');
    this.backBtn = root.querySelector('#live-back');
    this.octaveBtns = Array.from(root.querySelectorAll('[data-octave]'));
    this.nudgeBtns = Array.from(root.querySelectorAll('[data-nudge]'));
    this.latencyOut = root.querySelector('[data-live=latency]');
  }

  /** Show or hide the dock; the page lays the game out beside it while shown. */
  show(on) {
    this.root.hidden = !on;
    if (on) document.body.dataset.live = 'youtube';
    else delete document.body.dataset.live;
  }

  /** tone: 'ok' (all set), 'hint' (quiet advice) or '' (needs attention). */
  status(text, tone = '') {
    this.statusEl.textContent = text || '';
    this.statusEl.classList.toggle('ok', tone === 'ok');
    this.statusEl.classList.toggle('hint', tone === 'hint');
  }

  /** The capture delay the timing control shows (seconds). */
  latency(seconds) {
    this.latencyOut.textContent = `${Math.round(seconds * 1000)} ms`;
  }

  canStart(on, label = 'Start') {
    this.startBtn.disabled = !on;
    this.startBtn.textContent = label;
  }

  octave(value) {
    for (const b of this.octaveBtns) b.setAttribute('aria-pressed', String(Number(b.dataset.octave) === value));
  }

  wire({ start, back, octave, nudge }) {
    this.startBtn.addEventListener('click', start);
    this.backBtn.addEventListener('click', back);
    for (const b of this.octaveBtns) b.addEventListener('click', () => octave(Number(b.dataset.octave)));
    for (const b of this.nudgeBtns) b.addEventListener('click', () => nudge(Number(b.dataset.nudge)));
  }
}
