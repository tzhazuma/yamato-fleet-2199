/**
 * src/core/math.js — small numeric helpers used across the sim.
 *
 * Deliberately free of `three` imports so Node tests can exercise the maths
 * directly (SPEC §2). Anything needing Vector3/Quaternion lives in the
 * three-aware modules instead.
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function invLerp(a, b, v) { return a === b ? 0 : (v - a) / (b - a); }
export function smoothstep(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
export function sign(v) { return v < 0 ? -1 : v > 0 ? 1 : 0; }

/** Frame-rate independent exponential approach. `rate` = "snappiness". */
export function damp(current, target, rate, dt) {
  return target + (current - target) * Math.exp(-rate * dt);
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed delta from a to b. */
export function angleDelta(a, b) { return wrapAngle(b - a); }

/** Move `a` toward `b` by at most `maxStep`. */
export function moveToward(a, b, maxStep) {
  const d = b - a;
  if (Math.abs(d) <= maxStep) return b;
  return a + Math.sign(d) * maxStep;
}

export function degToRad(d) { return d * DEG; }
export function radToDeg(r) { return r / DEG; }

/** Distance between two {x,y,z} objects. */
export function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function distSq(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Ballistic lead/intercept solution for a target moving at constant velocity.
 * Returns time-to-intercept (seconds), or null when no positive solution
 * exists (target outrunning the projectile).
 *
 * Pure scalar maths: caller supplies relative position and velocity.
 */
export function interceptTime(relPos, relVel, projectileSpeed) {
  const a = relVel.x * relVel.x + relVel.y * relVel.y + relVel.z * relVel.z
          - projectileSpeed * projectileSpeed;
  const b = 2 * (relPos.x * relVel.x + relPos.y * relVel.y + relPos.z * relVel.z);
  const c = relPos.x * relPos.x + relPos.y * relPos.y + relPos.z * relPos.z;

  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) < 1e-6) return null;
    const t = -c / b;
    return t > 0 ? t : null;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b + sq) / (2 * a);
  const t2 = (-b - sq) / (2 * a);
  const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
  if (lo > 0) return lo;
  if (hi > 0) return hi;
  return null;
}

/**
 * Shortest distance between two line SEGMENTS, in 3D.
 *
 * Used for swept projectile-vs-hull collision: a shell travels a segment
 * between frames and a ship is a capsule (a segment plus a radius), so a
 * sphere test against the ship's centre would miss everything except a small
 * ball amidships — on a 638 m hull that is most of the ship.
 *
 * Implemented with plain scalars so it allocates nothing: this runs
 * projectiles x ships times per frame. Based on Ericson, *Real-Time Collision
 * Detection*, §5.1.9 (closest points of two segments).
 *
 * @param {{x,y,z}} p1 segment A start
 * @param {{x,y,z}} q1 segment A end
 * @param {{x,y,z}} p2 segment B start
 * @param {{x,y,z}} q2 segment B end
 * @returns {number} distance between the closest points
 */
export function segmentSegmentDistance(p1, q1, p2, q2) {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;

  const a = d1x * d1x + d1y * d1y + d1z * d1z;   // squared length of A
  const e = d2x * d2x + d2y * d2y + d2z * d2z;   // squared length of B
  const f = d2x * rx + d2y * ry + d2z * rz;
  const EPS = 1e-9;

  let s = 0, t = 0;

  if (a <= EPS && e <= EPS) {
    // Both segments are points.
    return Math.sqrt(rx * rx + ry * ry + rz * rz);
  }

  if (a <= EPS) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > EPS ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }

  const c1x = p1.x + d1x * s, c1y = p1.y + d1y * s, c1z = p1.z + d1z * s;
  const c2x = p2.x + d2x * t, c2y = p2.y + d2y * t, c2z = p2.z + d2z * t;
  const ex = c1x - c2x, ey = c1y - c2y, ez = c1z - c2z;
  return Math.sqrt(ex * ex + ey * ey + ez * ez);
}

/** Apply a spread cone as a small random angular offset (radians, per axis). */
export function spreadOffset(rng, spread) {
  return { x: rng.jitter(spread), y: rng.jitter(spread) };
}

/** Exponential moving average helper for HUD readouts. */
export function ema(prev, next, alpha) { return prev + (next - prev) * alpha; }

/** Format metres as km/m for HUD display. */
export function formatDistance(m) {
  if (!Number.isFinite(m)) return '---';
  if (Math.abs(m) >= 10000) return `${(m / 1000).toFixed(1)}km`;
  if (Math.abs(m) >= 1000) return `${(m / 1000).toFixed(2)}km`;
  return `${Math.round(m)}m`;
}

/** Format seconds as m:ss. */
export function formatTime(s) {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
