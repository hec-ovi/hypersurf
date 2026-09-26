// The live dock's DOM: the YouTube player's host element, a status line,
// Start and Back, and the blocks-per-beat buttons. It only shows and
// reports; the game decides. Kept apart from the HUD so the UI can be
// redesigned without touching the live logic.

export class LiveDock {
  constructor(root) {
    this.root = root;
    this.player = root.querySelector('[data-live=player]');
    this.statusEl = root.querySelector('[data-live=status]');
    this.startBtn = root.querySelector('#live-start');
    this.backBtn = root.querySelector('#live-back');
    this.octaveBtns = Array.from(root.querySelectorAll('[data-octave]'));
  }

  /** Show or hide the dock; the page lays the game out beside it while shown. */
  show(on) {
    this.root.hidden = !on;
    if (on) document.body.dataset.live = 'youtube';
    else delete document.body.dataset.live;
  }

  status(text, ok = false) {
    this.statusEl.textContent = text || '';
    this.statusEl.classList.toggle('ok', ok);
  }

  canStart(on, label = 'Start') {
    this.startBtn.disabled = !on;
    this.startBtn.textContent = label;
  }

  octave(value) {
    for (const b of this.octaveBtns) b.setAttribute('aria-pressed', String(Number(b.dataset.octave) === value));
  }

  wire({ start, back, octave }) {
    this.startBtn.addEventListener('click', start);
    this.backBtn.addEventListener('click', back);
    for (const b of this.octaveBtns) b.addEventListener('click', () => octave(Number(b.dataset.octave)));
  }
}
