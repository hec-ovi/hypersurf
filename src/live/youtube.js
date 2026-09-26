// YouTube helpers. For now only the link parser the menu needs; the player
// wrapper (IFrame API, state gating, error messages, time PLL) comes with
// the live mode.

const ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The 11-character video ID from a pasted link or bare ID, or null.
 * Accepts watch, youtu.be, embed, shorts, live and music links.
 */
export function parseVideoId(input) {
  const text = String(input || '').trim();
  if (ID.test(text)) return text;
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let candidate = null;
  if (host === 'youtu.be') candidate = url.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch') candidate = url.searchParams.get('v');
    else if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) candidate = parts[1];
  }
  return candidate && ID.test(candidate) ? candidate : null;
}
