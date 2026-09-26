// Local best scores, per song and mode, in localStorage. The song key is
// the SHA-256 of the file bytes for files, 'yt:<videoId>' for YouTube and
// 'demo' for the demo. Storage can be missing or throw (private windows,
// blocked site data), so every access is guarded and the game plays on.

const PREFIX = 'hypersurf.best.';

export function bestKey(songKey, mode) {
  return `${PREFIX}${mode}.${songKey}`;
}

export class BestScores {
  /** @param {Storage | null} storage usually window.localStorage */
  constructor(storage) {
    this.storage = storage || null;
  }

  /** The stored best for this song and mode, or null. */
  get(songKey, mode) {
    try {
      const raw = this.storage && this.storage.getItem(bestKey(songKey, mode));
      if (!raw) return null;
      const v = JSON.parse(raw);
      return v && Number.isFinite(v.final) ? v : null;
    } catch {
      return null;
    }
  }

  /**
   * Record a finished run. Returns { previous, best, isNew }; `best` is the
   * run itself when it beats (or first sets) the record.
   */
  submit(songKey, mode, result, songMapHash = '') {
    const previous = this.get(songKey, mode);
    const isNew = !previous || result.final > previous.final;
    const entry = { final: result.final, raw: result.raw, hash: songMapHash, at: Date.now() };
    if (isNew) {
      try {
        if (this.storage) this.storage.setItem(bestKey(songKey, mode), JSON.stringify(entry));
      } catch { /* storage full or blocked: keep playing */ }
    }
    return { previous, best: isNew ? entry : previous, isNew };
  }
}

/** Lower-case hex SHA-256 of an ArrayBuffer (Web Crypto; works in Node 20+ too). */
export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/** localStorage if usable, else null. */
export function safeLocalStorage() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const k = `${PREFIX}probe`;
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}
