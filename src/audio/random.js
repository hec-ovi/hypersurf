// Seeded randomness and hashing. Everything that looks random in a SongMap
// comes from here, so the same seed always builds the same track.

/** mulberry32: a small, fast 32-bit PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a of a string, used to turn an analysis ID into a seed. */
export function seedFromString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Incremental 64-bit-ish hash (two independent 32-bit lanes) over numbers.
 * Values are quantised by the caller; this only has to be stable and fast.
 */
export class Hasher {
  constructor() {
    this.h1 = 0xdeadbeef;
    this.h2 = 0x41c6ce57;
  }

  int(v) {
    const x = v | 0;
    this.h1 = Math.imul(this.h1 ^ x, 2654435761);
    this.h2 = Math.imul(this.h2 ^ x, 1597334677);
    return this;
  }

  /** Hash a number quantised to `step` (e.g. 1e-3). */
  num(v, step = 1e-4) {
    const q = Math.round(v / step);
    // Split so values beyond 32 bits still contribute.
    this.int(q % 4294967296);
    this.int(Math.floor(q / 4294967296));
    return this;
  }

  array(arr, step) {
    this.int(arr.length);
    for (let i = 0; i < arr.length; i++) this.num(arr[i], step);
    return this;
  }

  digest() {
    let h1 = this.h1, h2 = this.h2;
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }
}
