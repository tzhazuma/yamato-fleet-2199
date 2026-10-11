/**
 * tests/math.test.mjs — SPEC §7.7 / task-5 Deliverable 1.
 * Pure-logic coverage for src/core/math.js (no three, no DOM).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp, clamp01, lerp, smoothstep, sign, damp, wrapAngle, angleDelta,
  moveToward, degToRad, radToDeg, dist, distSq, interceptTime,
  formatDistance, formatTime, TAU,
} from '../src/core/math.js';

/* -------------------------------------------------------------------------- */
/* interceptTime                                                               */
/* -------------------------------------------------------------------------- */

test('interceptTime: target directly ahead, moving away slower than the round', () => {
  // Target 1000 m dead ahead (bow is -Z), receding at 100 m/s; shell at 900 m/s.
  const t = interceptTime({ x: 0, y: 0, z: -1000 }, { x: 0, y: 0, z: -100 }, 900);
  assert.ok(t !== null, 'expected a solution');
  assert.ok(Math.abs(t - 1.25) < 1e-9, `expected 1.25 s, got ${t}`);
});

test('interceptTime: stationary target at exactly projectile range gives 1 s', () => {
  const t = interceptTime({ x: 0, y: 0, z: -900 }, { x: 0, y: 0, z: 0 }, 900);
  assert.ok(Math.abs(t - 1) < 1e-9, `expected 1 s, got ${t}`);
});

test('interceptTime: target outrunning the projectile has no solution', () => {
  // Receding at 1000 m/s from a 900 m/s shell — the shell never catches up.
  assert.equal(interceptTime({ x: 0, y: 0, z: -1000 }, { x: 0, y: 0, z: -1000 }, 900), null);
});

test('interceptTime: degenerate quadratic (|a|~0, |b|~0) returns null, never NaN', () => {
  // Relative velocity exactly equals projectile speed, offset perpendicular to it.
  const t = interceptTime({ x: 1000, y: 0, z: 0 }, { x: 0, y: 0, z: -900 }, 900);
  assert.equal(t, null);
});

test('interceptTime: closing target yields a shorter time than a receding one', () => {
  const closing = interceptTime({ x: 0, y: 0, z: -1000 }, { x: 0, y: 0, z: 100 }, 900);
  const receding = interceptTime({ x: 0, y: 0, z: -1000 }, { x: 0, y: 0, z: -100 }, 900);
  assert.ok(closing < receding, `${closing} should be < ${receding}`);
});

test('interceptTime: the returned time is always the earliest POSITIVE root', () => {
  const cases = [
    [{ x: 0, y: 0, z: -500 }, { x: 0, y: 0, z: -50 }, 900],
    [{ x: 0, y: 0, z: -5000 }, { x: 0, y: 0, z: 400 }, 900],
    [{ x: 300, y: 120, z: -1500 }, { x: -20, y: 5, z: 60 }, 1200],
    [{ x: -2000, y: 0, z: 0 }, { x: 150, y: 0, z: 0 }, 800],
  ];
  for (const [p, v, s] of cases) {
    const t = interceptTime(p, v, s);
    assert.ok(t !== null && t > 0, `expected positive t for ${JSON.stringify(p)}`);
    // Verify the root actually satisfies |relPos + relVel*t| == s*t.
    const rx = p.x + v.x * t, ry = p.y + v.y * t, rz = p.z + v.z * t;
    const range = Math.hypot(rx, ry, rz);
    assert.ok(Math.abs(range - s * t) < 1e-6 * Math.max(1, range),
      `t=${t} does not satisfy the intercept equation (range ${range} vs ${s * t})`);
  }
});

test('interceptTime: zero relative velocity, target behind at 10 km is solvable', () => {
  const t = interceptTime({ x: 0, y: 0, z: 10000 }, { x: 0, y: 0, z: 0 }, 4000);
  assert.ok(Math.abs(t - 2.5) < 1e-9, `expected 2.5 s, got ${t}`);
});

/* -------------------------------------------------------------------------- */
/* wrapAngle                                                                   */
/* -------------------------------------------------------------------------- */

test('wrapAngle: values inside (-PI, PI] are unchanged', () => {
  for (const a of [0, 0.5, -0.5, 3.0, -3.0, Math.PI / 2, -Math.PI / 2]) {
    assert.ok(Math.abs(wrapAngle(a) - a) < 1e-12, `${a} -> ${wrapAngle(a)}`);
  }
});

test('wrapAngle: always returns a value in [-PI, PI] congruent to the input mod TAU', () => {
  const inputs = [TAU + 0.5, -TAU - 0.5, 100, -100, 7.0, -7.0, 1e6, -1e6, Math.PI * 3, -Math.PI * 3];
  for (const a of inputs) {
    const w = wrapAngle(a);
    assert.ok(w >= -Math.PI - 1e-9 && w <= Math.PI + 1e-9, `wrapAngle(${a}) = ${w} out of range`);
    const k = Math.round((a - w) / TAU);
    assert.ok(Math.abs(a - w - k * TAU) < 1e-6 * Math.max(1, Math.abs(a)),
      `wrapAngle(${a}) = ${w} is not congruent mod TAU`);
  }
});

test('angleDelta: shortest signed delta', () => {
  assert.ok(Math.abs(angleDelta(0.1, 0.3) - 0.2) < 1e-12);
  // Crossing the +/-PI seam must take the short way round.
  const d = angleDelta(Math.PI - 0.1, -Math.PI + 0.1);
  assert.ok(Math.abs(d - 0.2) < 1e-9, `expected +0.2 across the seam, got ${d}`);
});

/* -------------------------------------------------------------------------- */
/* clamp / lerp / smoothstep / sign                                            */
/* -------------------------------------------------------------------------- */

test('clamp and clamp01', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
  assert.equal(clamp01(-3), 0);
  assert.equal(clamp01(3), 1);
  assert.equal(clamp01(0.25), 0.25);
});

test('lerp / smoothstep / sign', () => {
  assert.equal(lerp(0, 10, 0.5), 5);
  assert.equal(smoothstep(0), 0);
  assert.equal(smoothstep(1), 1);
  assert.equal(smoothstep(0.5), 0.5);
  assert.equal(smoothstep(-5), 0);
  assert.equal(smoothstep(5), 1);
  assert.equal(sign(-2), -1);
  assert.equal(sign(2), 1);
  assert.equal(sign(0), 0);
});

test('degToRad / radToDeg round-trip', () => {
  assert.ok(Math.abs(degToRad(180) - Math.PI) < 1e-12);
  assert.ok(Math.abs(radToDeg(Math.PI) - 180) < 1e-12);
  assert.ok(Math.abs(radToDeg(degToRad(37.5)) - 37.5) < 1e-12);
});

/* -------------------------------------------------------------------------- */
/* moveToward                                                                  */
/* -------------------------------------------------------------------------- */

test('moveToward: snaps to the target when within one step', () => {
  assert.equal(moveToward(0, 0.5, 1), 0.5);
  assert.equal(moveToward(10, 9.9, 1), 9.9);
  assert.equal(moveToward(3, 3, 0.1), 3);
});

test('moveToward: moves by exactly maxStep otherwise, in the right direction', () => {
  assert.equal(moveToward(0, 10, 2), 2);
  assert.equal(moveToward(0, -10, 2), -2);
  assert.equal(moveToward(5, 0, 1.5), 3.5);
  assert.equal(moveToward(5, 100, 0), 5, 'a zero step must not move');
});

/* -------------------------------------------------------------------------- */
/* damp                                                                        */
/* -------------------------------------------------------------------------- */

test('damp: converges monotonically toward the target and never overshoots', () => {
  let v = 0;
  const target = 1;
  let prevGap = Math.abs(target - v);
  for (let i = 0; i < 200; i++) {
    v = damp(v, target, 3, 1 / 60);
    const gap = Math.abs(target - v);
    assert.ok(gap <= prevGap + 1e-15, `gap grew at step ${i}: ${gap} > ${prevGap}`);
    assert.ok(v <= target + 1e-12, `overshot at step ${i}: ${v}`);
    prevGap = gap;
  }
  assert.ok(Math.abs(target - v) < 1e-3, `did not converge: ${v}`);
});

test('damp: dt = 0 is a no-op and rate = 0 never moves', () => {
  assert.ok(Math.abs(damp(0.3, 1, 5, 0) - 0.3) < 1e-12);
  assert.ok(Math.abs(damp(0.3, 1, 0, 1) - 0.3) < 1e-12);
});

test('damp: larger rate converges faster; symmetric for decreasing targets', () => {
  const slow = damp(0, 1, 1, 0.5);
  const fast = damp(0, 1, 8, 0.5);
  assert.ok(fast > slow, `${fast} should exceed ${slow}`);
  let v = 10;
  for (let i = 0; i < 300; i++) v = damp(v, 0, 3, 1 / 60);
  assert.ok(v >= 0 && v < 0.01, `decreasing damp went wrong: ${v}`);
});

/* -------------------------------------------------------------------------- */
/* dist / distSq / formatDistance / formatTime                                 */
/* -------------------------------------------------------------------------- */

test('dist / distSq', () => {
  assert.equal(dist({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }), 5);
  assert.equal(distSq({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }), 25);
  assert.equal(dist({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }), 0);
});

test('formatDistance: m below 1 km, 2 decimals to 10 km, 1 decimal above', () => {
  assert.equal(formatDistance(0), '0m');
  assert.equal(formatDistance(500), '500m');
  assert.equal(formatDistance(999), '999m');
  assert.equal(formatDistance(1000), '1.00km');
  assert.equal(formatDistance(1500), '1.50km');
  assert.equal(formatDistance(9999), '10.00km');
  assert.equal(formatDistance(10000), '10.0km');
  assert.equal(formatDistance(12345), '12.3km');
  assert.equal(formatDistance(-2500), '-2.50km');
  assert.equal(formatDistance(NaN), '---');
  assert.equal(formatDistance(Infinity), '---');
});

test('formatTime: m:ss with clamping', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(9.9), '0:09');
  assert.equal(formatTime(60), '1:00');
  assert.equal(formatTime(125), '2:05');
  assert.equal(formatTime(-5), '0:00');
});
