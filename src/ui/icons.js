// The icon set (docs/art-direction.md §10): 24px grid, 1.5px stroke,
// square caps, mitre joins, currentColor; no fills except diamonds. No
// brand logos. Elements with data-icon="name" get the SVG at boot.

const P = {
  fullscreen: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  speaker: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
  wave: '<path d="M3 9c3-3 6 3 9 0s6 3 9 0M3 15c3-3 6 3 9 0s6 3 9 0"/>',
  code: '<path d="M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15"/>',
  trophy: '<path d="M7.5 4h9v5.5a4.5 4.5 0 0 1-9 0z"/><path d="M7.5 6H4v1.5A3.5 3.5 0 0 0 7.5 11M16.5 6H20v1.5a3.5 3.5 0 0 1-3.5 3.5M12 14v3.5M8 20h8M9.5 17.5h5"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  link: '<path d="M10 14 14 10"/><path d="M11 6.5 13 4.5a4 4 0 0 1 5.7 5.7l-2 2M13 17.5l-2 2a4 4 0 0 1-5.7-5.7l2-2"/>',
  file: '<path d="M3 12h2.5M6.5 8v8M9.5 5v14M12.5 9v6M15.5 6.5v11M18.5 10v4M21 12h-1"/>',
  chevL: '<path d="M14.5 5 7.5 12l7 7"/>',
  chevR: '<path d="M9.5 5l7 7-7 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v6M12 7.5v1.5"/>',
  warn: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v5M12 16.5V18"/>',
  error: '<path d="M8 3.5h8L20.5 8v8L16 20.5H8L3.5 16V8z"/><path d="M12 8v5.5M12 15.5V17"/>',
  check: '<path d="M5 12.5 10 17.5 19.5 7"/>',
  restart: '<path d="M5 12a7 7 0 1 0 2.2-5.1"/><path d="M4.5 3.5v4.5H9"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M4 4l16 16M9.8 5.8A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.9 3.7M6.3 7.4A16 16 0 0 0 2.5 12S6 18.5 12 18.5c1.4 0 2.7-.3 3.8-.8"/>',
  grip: '<path d="M8 7h.01M8 12h.01M8 17h.01M16 7h.01M16 12h.01M16 17h.01" stroke-width="2.6"/>',
  video: '<path d="M3.5 6h13v12h-13z"/><path d="m16.5 10 4-2.5v9l-4-2.5"/>',
  // Mode glyphs: a 3×7 grid for Mono, a four-point star for Ninja, a wide ring with shoulder lanes for Casual.
  mono: '<path d="M7 3.5h10v17H7zM10.3 3.5v17M13.7 3.5v17M7 8.4h10M7 13.3h10"/><path d="M12 15.6l1.5 1.5-1.5 1.5-1.5-1.5z" fill="currentColor"/>',
  ninja: '<path d="M12 2.5 14 10l7.5 2L14 14l-2 7.5L10 14l-7.5-2L10 10z"/><circle cx="12" cy="12" r="1.6"/>',
  casual: '<ellipse cx="12" cy="12" rx="8" ry="4.5"/><path d="M2 12c0 3.8 4.5 7 10 7s10-3.2 10-7M2 12c0-3.8 4.5-7 10-7s10 3.2 10 7" opacity=".45"/>',
  ship: '<path d="M12 3 20 18l-8-3-8 3z"/><path d="M12 15v5.5"/>',
  // Vehicle glyphs (Dart uses ship): a swallow-tailed board for Wave, a cat on a pastry with its rainbow for Nyan.
  board: '<path d="M12 2.5c3 3 4.2 7.5 4.2 11.5v6.5L12 18l-4.2 2.5V14C7.8 10 9 5.5 12 2.5z"/><path d="M12 6.5v8"/>',
  cat: '<path d="M8.5 8.5h8v7h-8z"/><path d="M16.5 15.5h4.5V11l-1-2.5-1.5 2h-1l-1-2"/><path d="M2.5 10h4M2.5 12.5h4M2.5 15h4"/>',
  diamond: '<path d="M12 4 20 12 12 20 4 12z"/>',
  // Level glyphs (Nyan uses cat): the hypersurf mark, two nested peaks.
  mark: '<path d="M3 19.5 12 5l9 14.5"/><path d="M7.5 19.5 12 12.5l4.5 7"/>',
};

/** An SVG string for an icon. */
export function icon(name, cls = '') {
  const body = P[name];
  if (!body) return '';
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Fill every [data-icon] element under root. */
export function mountIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.firstElementChild && el.firstElementChild.tagName === 'svg') continue;
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
  }
}

export const ICONS = Object.freeze(Object.keys(P));
