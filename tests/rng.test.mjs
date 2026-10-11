/**
 * tests/rng.test.mjs — SPEC §7.7 / task-5 Deliverable 1.
 * Determinism and stream independence for src/core/rng.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Rng, mulberry32, hashSeed } from '../src/core/rng.js';

test('same seed produces an identical sequence', () => {
  const a = new Rng(1234);
  const b = new Rng(1234);
  for (let i = 0; i < 500; i++) {
    assert.equal(a.next(), b.next(), `diverged at draw ${i}`);
  }
});

test('different seeds produce different sequences', () => {
  const a = new Rng(1);
  const b = new Rng(2);
  let same = 0;
  for (let i = 0; i < 100; i++) if (a.next() === b.next()) same++;
  assert.ok(same < 5, `expected near-zero collisions, got ${same}`);
});

test('a string seed hashes to the uint32 from hashSeed', () => {
  const r = new Rng('yamato');
  assert.equal(r.seed, hashSeed('yamato'));
  const r2 = new Rng('yamato');
  assert.equal(r2.next(), new Rng(hashSeed('yamato')).next());
});

test('the default seed is stable (0x5eed)', () => {
  assert.equal(new Rng().seed, 0x5eed);
  assert.equal(new Rng(0x5eed).next(), new Rng().next());
});

test('next() stays in [0,1)', () => {
  const r = new Rng(99);
  for (let i = 0; i < 20000; i++) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test('mulberry32 is reproducible and in [0,1)', () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

test('range(min,max) respects both bounds and reaches near both ends', () => {
  const r = new Rng('range');
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 20000; i++) {
    const v = r.range(-3, 7);
    assert.ok(v >= -3 && v < 7, `out of range: ${v}`);
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  assert.ok(lo < -2.5, `never sampled the low end (min ${lo})`);
  assert.ok(hi > 6.5, `never sampled the high end (max ${hi})`);
});

test('int(min,max) is inclusive of both ends and never fractional', () => {
  const r = new Rng('int');
  const seen = new Set();
  for (let i = 0; i < 20000; i++) {
    const v = r.int(1, 6);
    assert.ok(Number.isInteger(v), `non-integer ${v}`);
    assert.ok(v >= 1 && v <= 6, `out of range: ${v}`);
    seen.add(v);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
});

test('int(min,max) with a single value always returns that value', () => {
  const r = new Rng('single');
  for (let i = 0; i < 50; i++) assert.equal(r.int(4, 4), 4);
});

test('jitter(a) is symmetric within [-a, a]', () => {
  const r = new Rng('jitter');
  let min = Infinity, max = -Infinity, sum = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const v = r.jitter(0.5);
    assert.ok(v >= -0.5 && v <= 0.5, `out of range: ${v}`);
    min = Math.min(min, v); max = Math.max(max, v); sum += v;
  }
  assert.ok(min < -0.49 && max > 0.49, `did not span the interval (${min}..${max})`);
  assert.ok(Math.abs(sum / n) < 0.02, `mean ${sum / n} is not ~0`);
});

test('chance(0) is never true, chance(1) is always true', () => {
  const r = new Rng('chance');
  for (let i = 0; i < 5000; i++) {
    assert.equal(r.chance(0), false);
    assert.equal(r.chance(1), true);
  }
});

test('chance(p) approximates p', () => {
  const r = new Rng('chance-p');
  let hits = 0;
  const n = 50000;
  for (let i = 0; i < n; i++) if (r.chance(0.25)) hits++;
  assert.ok(Math.abs(hits / n - 0.25) < 0.01, `observed ${hits / n}`);
});

test('pick returns an element of the array', () => {
  const r = new Rng('pick');
  const arr = ['a', 'b', 'c', 'd'];
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const v = r.pick(arr);
    assert.ok(arr.includes(v));
    seen.add(v);
  }
  assert.equal(seen.size, 4, 'every element should be reachable');
});

test('shuffle is a permutation and does not mutate its input', () => {
  const r = new Rng('shuffle');
  const src = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const snapshot = src.slice();
  const out = r.shuffle(src);
  assert.deepEqual(src, snapshot, 'input array was mutated');
  assert.notEqual(out, src, 'shuffle must return a copy');
  assert.deepEqual(out.slice().sort((a, b) => a - b), snapshot);
  // Deterministic for the same seed.
  assert.deepEqual(new Rng('shuffle').shuffle(snapshot), out);
});

test('gauss is zero-mean; actual spread is 1/sqrt(3), NOT the "~unit spread" its comment claims', () => {
  // VERIFIER NOTE (reported as a LOW doc/impl mismatch in docs/VERIFY.md):
  // (u1+u2+u3-1.5) has sd = sqrt(3/12) = 0.5, and the code scales it by
  // 1.1547 = 2/sqrt(3), giving sd = 0.5774 = 1/sqrt(3). A true unit-sd
  // normaliser would be 2.0. `gauss()` is currently unused by product code,
  // so this has no gameplay effect; the test pins the ACTUAL behaviour so a
  // future change is visible.
  const r = new Rng('gauss');
  let sum = 0, sum2 = 0;
  const n = 50000;
  for (let i = 0; i < n; i++) { const v = r.gauss(); sum += v; sum2 += v * v; }
  const mean = sum / n;
  const sd = Math.sqrt(sum2 / n - mean * mean);
  assert.ok(Math.abs(mean) < 0.02, `mean ${mean}`);
  assert.ok(Math.abs(sd - 1 / Math.sqrt(3)) < 0.02, `sd ${sd} (expected ~0.5774)`);
  assert.ok(Math.abs(sd - 1) > 0.3, `sd ${sd} — comment says "unit spread" but it is not`);
});

test('fork(tag) streams are independent and do not disturb the parent', () => {
  const parent = new Rng('parent');
  const a = parent.fork('a');
  const b = parent.fork('b');
  let same = 0;
  for (let i = 0; i < 200; i++) if (a.next() === b.next()) same++;
  assert.ok(same < 5, `forked streams are not independent (${same} collisions)`);

  // Forking must not advance the parent: the next draw is the same as a fresh
  // Rng with the parent's seed.
  const fresh = new Rng('parent');
  const forked = new Rng('parent');
  forked.fork('a'); forked.fork('b');
  assert.equal(forked.next(), fresh.next());
});

test('fork(tag) is deterministic for the same tag, and tag-sensitive', () => {
  const r1 = new Rng('seed-x').fork('engine');
  const r2 = new Rng('seed-x').fork('engine');
  const r3 = new Rng('seed-x').fork('wmgun');
  assert.equal(r1.next(), r2.next());
  assert.notEqual(r1.seed, r3.seed);
  assert.notEqual(r1.next(), r3.next());
});

test('hashSeed is stable and uint32', () => {
  assert.equal(hashSeed('yamato'), hashSeed('yamato'));
  assert.notEqual(hashSeed('yamato'), hashSeed('yamato '));
  for (const s of ['', 'a', 'YAMATO FLEET 2199', '波動砲']) {
    const h = hashSeed(s);
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, `${s} -> ${h}`);
  }
});
