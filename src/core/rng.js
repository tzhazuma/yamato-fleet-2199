/**
 * src/core/rng.js — deterministic, seedable PRNG + noise helpers.
 * Pure logic: safe to import from Node tests.
 */

/** mulberry32 — small, fast, good enough for gameplay jitter. */
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

/** Hash a string to a uint32 seed. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  constructor(seed = 0x5eed) {
    this.seed = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
    this._next = mulberry32(this.seed);
  }
  /** [0,1) */
  next() { return this._next(); }
  /** [min,max) */
  range(min, max) { return min + (max - min) * this._next(); }
  /** integer in [min,max] */
  int(min, max) { return Math.floor(this.range(min, max + 1)); }
  /** symmetric jitter in [-a, a] */
  jitter(a) { return (this._next() * 2 - 1) * a; }
  /** true with probability p */
  chance(p) { return this._next() < p; }
  pick(arr) { return arr[Math.floor(this._next() * arr.length)]; }
  /** Fisher-Yates on a copy */
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  /**
   * Gaussian-ish via the sum of 3 uniforms. Mean 0.
   * NOTE: the actual standard deviation is 1/sqrt(3) ~= 0.577, not 1 — the
   * 1.1547 factor (= 2/sqrt(3)) normalises the *half-width* of the support to
   * 1, not the variance. Callers that want unit variance should scale by
   * sqrt(3). Asserted by tests/rng.test.mjs.
   */
  gauss() { return (this._next() + this._next() + this._next() - 1.5) * 1.1547; }
  /** Deterministic child stream, so subsystems don't share a sequence. */
  fork(tag) { return new Rng((this.seed ^ hashSeed(String(tag))) >>> 0); }
}

export default Rng;
