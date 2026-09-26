// Toasts (docs/art-direction.md §8.4): info (cyan, 6 s), warn (orange,
// 8 s) and error (red, until dismissed or acted on, with a focused
// recovery action and secondary links). Top centre, never over the mini
// player.

import { icon } from './icons.js';

const LIFE = { info: 6000, warn: 8000, error: 0 };
const ICON = { info: 'info', warn: 'warn', error: 'error' };

export class Toasts {
  constructor(root) {
    this.root = root;
  }

  /**
   * @param kind   'info' | 'warn' | 'error'
   * @param title  short uppercase title
   * @param body   one sentence
   * @param opts   { code, action: { label, run }, links: [{ label, run }], focus }
   * @returns a function that dismisses it
   */
  show(kind, title, body = '', { code = '', action = null, links = [], focus = kind === 'error' } = {}) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.innerHTML = `${icon(ICON[kind] || 'info')}<p class="t-title"></p><button class="t-close" type="button" aria-label="Dismiss">${icon('close')}</button>`;
    el.querySelector('.t-title').textContent = title;
    if (body) {
      const p = document.createElement('p');
      p.className = 't-body';
      p.textContent = body;
      el.appendChild(p);
    }
    if (code) {
      const c = document.createElement('p');
      c.className = 't-code';
      c.textContent = code;
      el.appendChild(c);
    }
    const close = () => {
      if (!el.isConnected || el.classList.contains('out')) return;
      el.classList.add('out');
      setTimeout(() => el.remove(), 180);
    };
    el.querySelector('.t-close').addEventListener('click', close);
    let first = null;
    if (action || links.length) {
      const acts = document.createElement('div');
      acts.className = 't-acts';
      if (action) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'act';
        b.innerHTML = '<i class="mk"></i>';
        b.append(action.label);
        b.addEventListener('click', () => { close(); action.run(); });
        acts.appendChild(b);
        first = b;
      }
      for (const l of links) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 't-link';
        b.textContent = l.label;
        b.addEventListener('click', () => { close(); l.run(); });
        acts.appendChild(b);
      }
      el.appendChild(acts);
    }
    const life = LIFE[kind] || 0;
    if (life) {
      const bar = document.createElement('i');
      bar.className = 'life';
      bar.style.setProperty('--life', `${life}ms`);
      el.appendChild(bar);
      setTimeout(close, life);
    }
    // Replace an older toast with the same title rather than stacking copies.
    for (const t of this.root.querySelectorAll('.toast')) if (t.querySelector('.t-title').textContent === title) t.remove();
    this.root.prepend(el);
    while (this.root.children.length > 3) this.root.lastElementChild.remove();
    if (focus && first) first.focus({ preventScroll: true });
    return close;
  }

  clear(kind = null) {
    for (const t of this.root.querySelectorAll('.toast')) if (!kind || t.classList.contains(kind)) t.remove();
  }
}
