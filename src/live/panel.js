// The YouTube mini player (docs/art-direction.md §8.3): the player's host
// element in a small frame floating in a corner, never covered by
// anything. It can be dragged to any corner (it snaps to the nearest) and
// hidden. Hidden collapses the box to 1px with a clip, never display:none
// and never removed, so the IFrame player keeps playing.

export const CORNERS = ['br', 'bl', 'tr', 'tl'];

/** The corner nearest a point (px) in a w × h viewport. */
export function nearestCorner(x, y, w, h) {
  return `${y < h / 2 ? 't' : 'b'}${x < w / 2 ? 'l' : 'r'}`;
}

export class MiniPlayer {
  /**
   * @param root    #mini
   * @param onMove  called with the new corner after a drag
   * @param onHide  called when the hide button is pressed
   */
  constructor(root, { onMove = null, onHide = null } = {}) {
    this.root = root;
    this.player = root.querySelector('[data-live=player]');
    this.strip = root.querySelector('[data-mini=strip]');
    this.onMove = onMove;
    root.querySelector('[data-mini=hide]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (onHide) onHide();
    });
    this._wireDrag();
  }

  /** Show or hide the whole live layout (the player box, and body[data-live] for the HUD and screens). */
  show(on) {
    this.root.hidden = !on;
    if (on) document.body.dataset.live = 'youtube';
    else delete document.body.dataset.live;
  }

  /** 'mini' or 'hidden'. */
  setMode(mode) {
    document.body.dataset.video = mode === 'hidden' ? 'hidden' : 'mini';
  }

  setCorner(corner) {
    document.body.dataset.corner = CORNERS.includes(corner) ? corner : 'br';
  }

  _wireDrag() {
    let start = null;
    this.strip.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      this.strip.setPointerCapture(e.pointerId);
      const r = this.root.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      this.root.classList.add('dragging');
    });
    this.strip.addEventListener('pointermove', (e) => {
      if (!start) return;
      this.root.style.translate = `${e.clientX - start.x}px ${e.clientY - start.y}px`;
    });
    const end = (e) => {
      if (!start) return;
      const cx = start.cx + e.clientX - start.x, cy = start.cy + e.clientY - start.y;
      start = null;
      const corner = nearestCorner(cx, cy, innerWidth, innerHeight);
      // Keep the drop position for one frame, then ease into the corner.
      const r0 = this.root.getBoundingClientRect();
      this.setCorner(corner);
      this.root.style.translate = '';
      const r1 = this.root.getBoundingClientRect();
      this.root.style.translate = `${r0.left - r1.left}px ${r0.top - r1.top}px`;
      void this.root.offsetWidth;
      this.root.classList.remove('dragging');
      this.root.style.translate = '';
      if (this.onMove) this.onMove(corner);
    };
    this.strip.addEventListener('pointerup', end);
    this.strip.addEventListener('pointercancel', end);
  }
}
