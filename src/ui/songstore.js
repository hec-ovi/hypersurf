// Song files kept in this browser only (IndexedDB), for the special levels
// that ride the player's own copy of a song: picked once, one click after
// that. Nothing is uploaded or leaves the device. Every call resolves, to
// null or false, when the browser gives no storage (a private window,
// blocked site data), so the level still plays that visit.

const DB = 'hypersurf';
const STORE = 'songs';

/** An IDBRequest as a promise. */
const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export class SongStore {
  /** @param idb an IDBFactory (the browser's indexedDB by default) */
  constructor(idb = typeof indexedDB !== 'undefined' ? indexedDB : null) {
    this.idb = idb;
    this.db = null;
  }

  async _open() {
    if (this.db) return this.db;
    if (!this.idb) return null;
    try {
      const req = this.idb.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      this.db = await done(req);
      return this.db;
    } catch {
      return null;
    }
  }

  async _run(mode, fn) {
    const db = await this._open();
    if (!db) return null;
    try {
      return await done(fn(db.transaction(STORE, mode).objectStore(STORE)));
    } catch {
      return null;
    }
  }

  /** The stored song for `id` as { name, type, size, savedAt, blob }, or null. */
  async get(id) {
    const rec = await this._run('readonly', (s) => s.get(id));
    return rec && rec.blob ? rec : null;
  }

  /** Keep `file` for `id`, replacing any earlier one. Resolves true when stored. */
  async put(id, file) {
    const rec = { name: file.name || 'song', type: file.type || '', size: file.size, savedAt: Date.now(), blob: file };
    return (await this._run('readwrite', (s) => s.put(rec, id))) !== null;
  }

  /** Forget the song for `id`. Resolves true when it is gone. */
  async remove(id) {
    return (await this._run('readwrite', (s) => s.delete(id))) !== null;
  }
}

/** A stored record back as a File the game can play. */
export function storedFile(rec) {
  return new File([rec.blob], rec.name, { type: rec.type });
}
