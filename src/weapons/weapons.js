/**
 * src/weapons/weapons.js — weapon definitions and firing logic (SPEC §6.4).
 *
 * The WEAPONS table lives in src/core/config.js (single source of balance
 * truth, SPEC §6.2) and is re-exported here under the name SPEC §6.4 mandates.
 *
 * Firing rule: a weapon fires `mounts[weaponId] * turretFactor` mounts, each
 * throwing `salvo` projectiles, aimed at the intercept point of `ship.target`.
 * Mounts are taken from the model's hardpoints round-robin; if the model has no
 * matching hardpoints the shot still happens from a synthesised bow position,
 * so a placeholder mesh never disables the guns.
 */

import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { clamp } from '../core/math.js';

/** SPEC §6.4 export — the weapon table. */
export const WEAPONS = CONFIG.weapons;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();

/* -------------------------------------------------------------------------- */
/* Charge / cooldown bookkeeping                                              */
/* -------------------------------------------------------------------------- */

/** Effective number of mounts able to shoot right now. */
export function effectiveMounts(ship, weaponId, spec) {
  const declared = ship.stats?.mounts?.[weaponId] ?? 1;
  const kind = spec.subsystemKind;
  const factor = kind ? ship.turretFactor(kind) : 1;
  return Math.max(0, Math.round(declared * factor));
}

/** Can this weapon fire this instant? */
export function canFire(ship, weaponId, target) {
  const spec = WEAPONS[weaponId];
  const st = ship?.weaponState?.[weaponId];
  if (!spec || !st || !ship.alive) return false;
  if (st.cooldown > 0) return false;
  if (spec.subsystemKind && !ship.hasWorkingSubsystem(spec.subsystemKind)) return false;
  if (effectiveMounts(ship, weaponId, spec) <= 0) return false;
  if (spec.kind === 'wmgun' && st.chargeRatio < 0.999) return false;

  const tgt = target || ship.target;
  if (tgt && tgt.alive) {
    const d = ship.position.distanceTo(tgt.position);
    if (d > spec.range * 1.05) return false;
    if (spec.arcDeg < 180 && !ship.inFiringArc(tgt.position, spec.arcDeg)) return false;
  }
  return true;
}

/** True when the weapon's subsystem has been knocked out. */
export function isWeaponDisabled(ship, weaponId) {
  const spec = WEAPONS[weaponId];
  if (!spec || !spec.subsystemKind) return false;
  return !ship.hasWorkingSubsystem(spec.subsystemKind);
}

/**
 * Per-frame weapon bookkeeping: cooldowns, and the wave-motion-gun charge.
 * Called once per ship per frame by the simulation.
 */
export function updateWeaponMounts(ship, dt, world) {
  if (!ship.alive) return;
  const fast = CONFIG.debug?.fastCharge ? 4 : 1;

  for (const wid of ship.weaponIds) {
    const st = ship.weaponState[wid];
    if (!st) continue;
    const spec = st.spec || WEAPONS[wid];
    if (!spec) continue;

    if (st.cooldown > 0) st.cooldown = Math.max(0, st.cooldown - dt);

    if (spec.kind === 'wmgun') {
      const disabled = isWeaponDisabled(ship, wid);
      if (disabled) {
        if (st.charging || st.charge > 0) {
          world?.events?.emit?.('wmgunAborted', { ship, reason: 'disabled' });
        }
        st.charging = false;
        st.charge = 0;
        st.chargeRatio = 0;
        st.ready = false;
        continue;
      }
      if (st.charging && st.cooldown <= 0) {
        const wasReady = st.chargeRatio >= 1;
        st.charge = Math.min(spec.chargeTime, st.charge + dt * fast);
        st.chargeRatio = spec.chargeTime > 0 ? st.charge / spec.chargeTime : 1;
        if (!wasReady && st.chargeRatio >= 1) {
          world?.events?.emit?.('wmgunReady', { ship });
        }
      } else if (st.cooldown > 0) {
        // Fired or aborted: bleed the charge away.
        st.charge = Math.max(0, st.charge - dt * 2);
        st.chargeRatio = spec.chargeTime > 0 ? st.charge / spec.chargeTime : 0;
      }
      st.ready = st.cooldown <= 0 && st.chargeRatio >= 1;
    } else {
      st.ready = st.cooldown <= 0 && !isWeaponDisabled(ship, wid);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Firing                                                                     */
/* -------------------------------------------------------------------------- */

/** World positions to fire from: real hardpoints, or a synthesised fallback. */
function resolveMountPoints(ship, spec, count) {
  const pts = [];
  const real = ship.getMountsWorld ? ship.getMountsWorld(spec.mountPrefix) : [];
  if (real.length) {
    for (let i = 0; i < count; i++) pts.push(real[i % real.length]);
    return pts;
  }
  // Fallback: spread the shots along the centreline near the bow.
  const len = ship.def?.lengthM || 200;
  const fwd = _v2.set(0, 0, -1).applyQuaternion(ship.quaternion).clone();
  const right = _v.set(1, 0, 0).applyQuaternion(ship.quaternion).clone();
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0.5;
    const pos = ship.position.clone()
      .addScaledVector(fwd, len * (0.30 + t * 0.22))
      .addScaledVector(right, (i % 2 === 0 ? -1 : 1) * len * 0.05);
    pts.push({ pos, dir: fwd.clone(), kind: spec.mountPrefix, name: `${spec.mountPrefix}_fallback_${i}` });
  }
  return pts;
}

/**
 * Where should this ship aim for this weapon?
 * @param {Ship|null} [explicitTarget] overrides ship.target (AI passes its own)
 */
export function aimPointFor(ship, spec, world, explicitTarget = null) {
  const tgt = explicitTarget && explicitTarget.alive ? explicitTarget : ship.target;
  if (tgt && tgt.alive && spec.aimAssist > 0) {
    const lead = ship.aimPointAt ? ship.aimPointAt(tgt, spec.speed) : tgt.position.clone();
    // Blend toward the raw position for low-assist weapons.
    return lead.lerp(tgt.position, 1 - clamp(spec.aimAssist, 0, 1));
  }
  if (ship.aimPoint) return ship.aimPoint.clone();
  return ship.position.clone().addScaledVector(ship.forward, spec.range);
}

/**
 * Fire one weapon. Returns true if a shot actually left the ship.
 * For the wave motion gun this consumes the accumulated charge.
 */
export function fireWeapon(ship, weaponId, world, explicitTarget = null) {
  const spec = WEAPONS[weaponId];
  const st = ship?.weaponState?.[weaponId];
  if (!spec || !st || !ship.alive) return false;

  const target = (explicitTarget && explicitTarget.alive) ? explicitTarget : ship.target;
  // Keep ship.target authoritative for the rest of the systems (HUD, aim).
  if (target && ship.target !== target) ship.target = target;

  if (spec.kind === 'wmgun') return fireWaveMotionGun(ship, spec, st, world, target);

  // An AI ship with no target would otherwise spray shots down its own bow:
  // in a measured run that produced 136 shots for 2 hits (1.5%). Refuse instead.
  if (!ship.isPlayer && !target) return false;

  if (!canFire(ship, weaponId, target)) return false;

  const mounts = effectiveMounts(ship, weaponId, spec);
  if (mounts <= 0) return false;

  const total = mounts * Math.max(1, spec.salvo | 0);
  const pts = resolveMountPoints(ship, spec, Math.max(mounts, 1));
  const aim = aimPointFor(ship, spec, world, target);
  const tgt = target && target.alive ? target : null;

  // Accuracy: AI ships miss more; a dead bridge costs 25% (research §1.9).
  const doctrine = CONFIG.ai.doctrines?.[ship.stats?.aiDoctrine] || null;
  const accuracy = ship.isPlayer ? 1 : (doctrine?.accuracy ?? 0.6) * (ship.accuracyFactor ?? 1);
  const missScale = ship.isPlayer ? 1 : (2 - accuracy);

  for (let i = 0; i < total; i++) {
    const mount = pts[i % pts.length];
    _dir.copy(aim).sub(mount.pos);
    if (_dir.lengthSq() < 1e-6) _dir.copy(mount.dir);
    _dir.normalize();

    // Cone spread, widened by AI inaccuracy.
    const spread = (spec.spread || 0) * missScale;
    if (spread > 0) {
      _dir.x += (Math.random() * 2 - 1) * spread;
      _dir.y += (Math.random() * 2 - 1) * spread;
      _dir.z += (Math.random() * 2 - 1) * spread;
      _dir.normalize();
    }

    world.projectiles?.spawn({
      kind: spec.kind,
      owner: ship,
      spec,
      position: mount.pos,
      direction: _dir,
      target: tgt,
    });
  }

  st.cooldown = spec.cooldown;
  st.shotsFired += total;

  world.events?.emit?.('weaponFired', { ship, weaponId, count: total, spec });
  if (world.audio) world.audio.play(spec.sound, { position: ship.position, isPlayer: ship.isPlayer });

  // Recoil only shakes the camera when the player pulls the trigger.
  if (ship.isPlayer && spec.recoil) world.scene?.addShake?.(spec.recoil * 0.35);

  if (spec.recoil) {
    world.effects?.muzzleFlash?.(pts[0].pos, _dir, spec.tracerWidth * 2.2, spec.color);
  }
  return true;
}

/** The wave motion gun: consumes a full charge and hits like a superweapon. */
function fireWaveMotionGun(ship, spec, st, world, explicitTarget = null) {
  if (st.cooldown > 0) return false;
  if (isWeaponDisabled(ship, 'wmgun')) return false;
  if (st.chargeRatio < 0.35) return false;         // needs at least a partial charge

  const target = (explicitTarget && explicitTarget.alive) ? explicitTarget : ship.target;
  const aim = aimPointFor(ship, spec, world, target);

  // RANGE + ARC GATES.
  // `fireWeapon()` short-circuits to this function BEFORE `canFire()`, so
  // without these the wave motion gun fired in any direction — a player could
  // hold R and delete a cruiser 90° off the bow. The ±3° arc IS the weapon's
  // cost (research §1.2, §8), so it has to be enforced here.
  //
  // Deliberately NOT done by calling canFire(): canFire also demands a full
  // charge, and this path intentionally allows a partial release at >= 0.35.
  if (spec.requiresArc) {
    if (target && target.alive && ship.position.distanceTo(target.position) > spec.range) {
      world?.events?.emit?.('wmgunBlocked', { ship, reason: 'range' });
      return false;
    }
    // Check the beam's actual direction, which follows the aim point (lead
    // included), not the raw target position.
    if (!ship.inFiringArc(aim, spec.arcDeg)) {
      world?.events?.emit?.('wmgunBlocked', { ship, reason: 'arc' });
      return false;
    }
  }

  const power = clamp(st.chargeRatio, 0, 1);
  const mounts = resolveMountPoints(ship, spec, 1);
  const mount = mounts[0];

  _dir.copy(aim).sub(mount.pos);
  if (_dir.lengthSq() < 1e-6) _dir.copy(mount.dir);
  _dir.normalize();

  world.projectiles?.spawn({
    kind: 'wmgun',
    owner: ship,
    spec: { ...spec, damage: spec.chargeDamage * power },
    position: mount.pos,
    direction: _dir,
    target: target && target.alive ? target : null,
    damageScale: power,
  });

  // Muzzle and beam visuals.
  world.effects?.waveMotionBeam?.(mount.pos, _dir, spec, power);

  st.charge = 0;
  st.chargeRatio = 0;
  st.charging = false;
  st.cooldown = spec.cooldown;
  st.shotsFired += 1;

  // Canon flavour: the wave-motion engine is drained for a few seconds.
  if (spec.postFireSpeedFactor) {
    ship.drainEngine?.(spec.postFireSpeedFactor, spec.postFireDuration ?? 4);
  }

  world.events?.emit?.('wmgunFired', { ship, power, position: mount.pos.clone(), direction: _dir.clone() });
  world.audio?.play?.(spec.sound, { position: ship.position, isPlayer: ship.isPlayer });

  const shake = ship.isPlayer ? 2.4 : 1.0;
  world.scene?.addShake?.(shake);
  world.effects?.explosion?.(mount.pos, 120, spec.color);
  return true;
}

/** Begin charging (hold-to-charge input or AI telegraph). */
export function beginCharge(ship, weaponId = 'wmgun') {
  const st = ship?.weaponState?.[weaponId];
  const spec = WEAPONS[weaponId];
  if (!st || !spec || spec.kind !== 'wmgun') return false;
  if (isWeaponDisabled(ship, weaponId)) return false;
  if (st.cooldown > 0) return false;
  st.charging = true;
  return true;
}

/** Cancel a charge without firing. */
export function abortCharge(ship, weaponId = 'wmgun') {
  const st = ship?.weaponState?.[weaponId];
  if (st) st.charging = false;
}

/* -------------------------------------------------------------------------- */
/* Point defence — continuous interception aura (research §1.4)               */
/* -------------------------------------------------------------------------- */

/**
 * Damage hostile missiles/torpedoes inside each ship's PD envelope.
 * Called once per frame by the simulation.
 */
export function updatePointDefence(dt, world) {
  const PD = CONFIG.pointDefence;
  if (!PD || !world.projectiles) return;
  const active = world.projectiles.active;
  if (!active || !active.length) return;

  for (const ship of world.ships) {
    if (!ship.alive || !ship.pdMounts) continue;

    const live = ship.turretFactor ? ship.turretFactor('ciws') : 1;
    const mounts = ship.pdMounts * live;
    if (mounts <= 0) continue;

    const dps = PD.dpsPerMount * mounts;
    const r2 = PD.range * PD.range;

    // FOCUS FIRE on the nearest hostile inside the envelope.
    //
    // The previous version gave every projectile `dps / maxTargets`, where
    // maxTargets was the engagement CAP (8 for a Yamato-scale suite). A ship
    // therefore dealt 10 dps to each of six missiles instead of concentrating
    // 80 dps, and destroyed nothing at all — point defence was cosmetic.
    // Research §1.4 models the suite as engaging one target at a time
    // (80 dps x 2.25 s = 180 DP = 1.5 missiles of 120 hp), which this
    // reproduces; `maxTargetsPerMount` is retained only as a sanity cap.
    let best = null;
    let bestD2 = r2;
    for (const p of active) {
      if (!p.active) continue;
      if (!PD.targetKinds.includes(p.kind)) continue;
      if (p.faction === ship.faction) continue;
      const d2 = p.position.distanceToSquared(ship.position);
      if (d2 < bestD2) { bestD2 = d2; best = p; }
    }
    if (!best) continue;

    best.hp = (best.hp ?? 100) - dps * dt;
    if (best.hp <= 0) {
      world.effects?.impact?.(best.position, 0xfff0b0, 8);
      best._expire(world);
    }
  }
}

export default { WEAPONS, fireWeapon, updateWeaponMounts, updatePointDefence, beginCharge, abortCharge, canFire };
