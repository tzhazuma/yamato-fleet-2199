/**
 * src/entities/projectile.js — pooled projectiles: shells, beams, missiles,
 * torpedoes, point-defence and the wave motion gun beam.
 *
 * Collision is a swept sphere test against ship bounding spheres, which is the
 * right fidelity for a demo at these ranges and keeps 900 projectiles cheap.
 */

import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { clamp, interceptTime, segmentSegmentDistance } from '../core/math.js';
import { makeGlowTexture } from '../core/scene.js';
import { Rng } from '../core/rng.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _segA = new THREE.Vector3();
const _segB = new THREE.Vector3();

/** Shared geometries — created lazily so the module can be imported headless. */
let GEO = null;
function geometries() {
  if (GEO) return GEO;
  GEO = {
    tracer: new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1, true),
    cone: new THREE.ConeGeometry(0.5, 1, 7),
    sphere: new THREE.SphereGeometry(0.5, 10, 8),
  };
  // Point the cylinder/cone down -Z so `lookAt`-style orientation works.
  GEO.tracer.rotateX(Math.PI / 2);
  GEO.cone.rotateX(-Math.PI / 2);
  return GEO;
}

/**
 * Swept sphere test: shortest distance between segment a→b and point c.
 * @returns {number} distance
 */
function segmentPointDistance(a, b, c) {
  _v.copy(b).sub(a);
  const len2 = _v.lengthSq();
  if (len2 < 1e-9) return a.distanceTo(c);
  const t = clamp(_v2.copy(c).sub(a).dot(_v) / len2, 0, 1);
  _v3.copy(a).addScaledVector(_v, t);
  return _v3.distanceTo(c);
}

export class Projectile {
  constructor(system) {
    this.system = system;
    this.active = false;
    this.mesh = null;
    this.trailTimer = 0;
    this.reset();
  }

  reset() {
    this.active = false;
    this.kind = 'shell';
    this.owner = null;
    this.faction = 'neutral';
    this.spec = null;
    this.target = null;
    this.position = new THREE.Vector3();
    this.prevPosition = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.damage = 0;
    this.life = 0;
    this.maxLife = 1;
    this.radius = 1;
    this.homing = 0;
    this.homingDelay = 0;
    this.age = 0;
    this.pierce = false;
    this.hitSet = null;
    this.smoke = false;
    this.hp = 100;              // durability vs point defence; set from spec on spawn
    this.splashRadius = 0;
    this.color = 0xffffff;
    this._scale = new THREE.Vector3(1, 1, 1);
  }

  /**
   * @param {object} o
   * @param {string} o.kind shell|beam|missile|torpedo|wmgun|pd
   * @param {Ship} o.owner
   * @param {object} o.spec weapon spec from CONFIG.weapons
   * @param {THREE.Vector3} o.position
   * @param {THREE.Vector3} o.direction normalised
   * @param {Ship|null} [o.target]
   * @param {number} [o.damageScale]
   */
  spawn(o) {
    const spec = o.spec || {};
    this.active = true;
    this.kind = o.kind || spec.kind || 'shell';
    this.owner = o.owner || null;
    this.faction = o.owner ? o.owner.faction : 'neutral';
    this.spec = spec;
    this.target = o.target || null;

    this.position.copy(o.position);
    this.prevPosition.copy(o.position);
    this.velocity.copy(o.direction).normalize().multiplyScalar(spec.speed ?? 3000);

    const dmgScale = o.damageScale ?? 1;
    this.damage = (spec.damage ?? 100) * dmgScale;
    this.maxLife = spec.life ?? 2;
    this.life = this.maxLife;
    this.radius = Math.max(1.5, (spec.tracerWidth ?? 2) * 0.6);
    this.homing = spec.homing ?? 0;
    this.homingDelay = spec.homingDelay ?? 0;
    this.age = 0;
    this.pierce = this.kind === 'wmgun';
    this.hitSet = this.pierce ? new Set() : null;
    this.smoke = !!spec.smoke;
    this.hp = spec.hp ?? 100;   // point defence chews through this
    this.splashRadius = spec.splashRadius ?? 0;
    this.color = spec.color ?? 0xffffff;
    this.trailTimer = 0;

    this.mesh = this.system._acquireMesh(this.kind, this.color);
    if (this.mesh) {
      this.mesh.visible = true;
      const scale = this._computeScale(spec);
      this._scale.copy(scale);
      this.mesh.scale.copy(scale);
      this.mesh.position.copy(this.position);
      this._orient();
    }
    return this;
  }

  _computeScale(spec) {
    const w = spec.tracerWidth ?? 2;
    switch (this.kind) {
      case 'wmgun':   return new THREE.Vector3(w * 1.6, w * 1.6, 260);
      case 'beam':    return new THREE.Vector3(w * 0.7, w * 0.7, 46);
      case 'pd':      return new THREE.Vector3(w * 0.5, w * 0.5, 22);
      case 'missile': return new THREE.Vector3(w * 1.6, w * 1.6, w * 7);
      case 'torpedo': return new THREE.Vector3(w * 2.0, w * 2.0, w * 9);
      default:        return new THREE.Vector3(w * 0.75, w * 0.75, 34);
    }
  }

  _orient() {
    if (!this.mesh) return;
    _v.copy(this.position).add(this.velocity);
    _m.lookAt(this.position, _v, this.system._up);
    this.mesh.quaternion.setFromRotationMatrix(_m);
  }

  update(dt, world) {
    if (!this.active) return;
    this.age += dt;
    this.life -= dt;
    if (this.life <= 0) { this._expire(world); return; }

    this.prevPosition.copy(this.position);

    // --- Homing -----------------------------------------------------------
    if (this.homing > 0 && this.age > this.homingDelay) {
      let tgt = this.target;
      if (!tgt || !tgt.alive) {
        tgt = this.system._acquireTarget(this);
        this.target = tgt;
      }
      if (tgt && tgt.alive) {
        // Aim at the intercept point so homing weapons actually connect.
        _v.copy(tgt.position).sub(this.position);
        const t = interceptTime(_v, tgt.velocity, this.velocity.length()) ?? _v.length() / Math.max(1, this.velocity.length());
        _v2.copy(tgt.position).addScaledVector(tgt.velocity, Math.min(t, 6));
        _v3.copy(_v2).sub(this.position).normalize();
        const speed = this.velocity.length();
        // Limited turn rate: heavy torpedoes arc, missiles snap.
        const maxTurn = this.homing * dt;
        const current = _v.copy(this.velocity).normalize();
        const angle = current.angleTo(_v3);
        if (angle > 1e-4) {
          const t2 = Math.min(1, maxTurn / angle);
          current.lerp(_v3, t2).normalize();
          this.velocity.copy(current).multiplyScalar(speed);
        }
      }
    }

    this.position.addScaledVector(this.velocity, dt);

    // --- Collision (swept) ------------------------------------------------
    this._collide(world);

    if (this.active && this.mesh) {
      this.mesh.position.copy(this.position);
      this._orient();
      // Missiles/torpedoes leave a visible smoke trail.
      if (this.smoke) {
        this.trailTimer -= dt;
        if (this.trailTimer <= 0) {
          this.trailTimer = 0.028;
          world.effects?.trail?.(this.position, this.color, this.kind === 'torpedo' ? 5.5 : 3.4, this.kind === 'torpedo' ? 1.5 : 0.9);
        }
      } else if (this.kind === 'shell' || this.kind === 'pd') {
        this.trailTimer -= dt;
        if (this.trailTimer <= 0) {
          this.trailTimer = 0.05;
          world.effects?.trail?.(this.position, this.color, 1.4, 0.28);
        }
      }
    }
  }

  _collide(world) {
    const ships = world.ships;
    for (let i = 0; i < ships.length; i++) {
      const ship = ships[i];
      if (!ship.alive) continue;
      if (ship === this.owner) continue;
      if (this.hitSet && this.hitSet.has(ship.id)) continue;

      // Swept test against the hull CAPSULE (segment + radius), not a sphere at
      // the ship's centre: the sphere missed everything fore and aft of
      // amidships, which on a 638 m flagship is nearly the whole ship.
      const reach = ship.hitRadius + this.radius + (this.kind === 'wmgun' ? 0 : 4);
      const seg = ship.hitSegment(_segA, _segB);
      const d = segmentSegmentDistance(this.prevPosition, this.position, seg.a, seg.b);
      if (d > reach) continue;

      // Point defence only intercepts missiles/torpedoes; everything else
      // treats PD fire as ordinary (weak) damage.
      if (this.kind === 'pd') {
        const hitMissile = this.system._damageProjectileNear(this.position, 60, this.damage, this.faction);
        if (hitMissile) { this._impact(world, null); return; }
      }

      this._hit(world, ship);
      if (!this.active) return;
    }
  }

  _hit(world, ship) {
    const spec = this.spec || {};
    const result = ship.applyDamage(this.damage, {
      type: this.kind,
      shieldMultiplier: spec.shieldMultiplier ?? 1,
      armorMultiplier: spec.armorMultiplier ?? 1,
      hullMultiplier: spec.hullMultiplier ?? 1,
      from: this.owner,
      hitPoint: this.position,
      weaponId: spec.id,
    });

    if (this.owner) this.owner.damageDealt += result.shieldHit + result.armorHit + result.hullHit;

    world.events?.emit?.('hit', {
      ship, from: this.owner, result,
      position: this.position.clone(), weaponId: spec.id, kind: this.kind,
    });

    // Impact visuals scale with the weapon.
    const big = this.kind === 'wmgun';
    world.effects?.impact?.(this.position, this.color, big ? 90 : this.kind === 'torpedo' ? 34 : 12);

    if (big) {
      // Wave motion gun: massive splash along the beam, then pierce onward.
      world.effects?.explosion?.(this.position, 260, 0xcfefff);
      if (this.splashRadius > 0) this._splash(world, ship);
      this.hitSet.add(ship.id);
      if (result.killed) world.events?.emit?.('kill', { ship, from: this.owner });
      return;
    }

    if (result.killed) world.events?.emit?.('kill', { ship, from: this.owner });

    if (this.pierce) {
      this.hitSet.add(ship.id);
    } else {
      this._impact(world, ship);
    }
  }

  /** Wave-motion-gun splash: damages everything near the beam's endpoint. */
  _splash(world, exclude) {
    for (const ship of world.ships) {
      if (ship === exclude || ship === this.owner || !ship.alive) continue;
      const d = ship.position.distanceTo(this.position);
      if (d > this.splashRadius) continue;
      const falloff = 1 - d / this.splashRadius;
      const r = ship.applyDamage(this.damage * 0.22 * falloff, {
        type: 'wmgun_splash', from: this.owner, hitPoint: this.position, weaponId: 'wmgun',
      });
      if (this.owner) this.owner.damageDealt += r.shieldHit + r.armorHit + r.hullHit;
      if (r.killed) world.events?.emit?.('kill', { ship, from: this.owner });
    }
  }

  _impact(world, ship) {
    this.active = false;
    if (this.mesh) this.mesh.visible = false;
    this.system._release(this);
  }

  _expire(world) {
    // A torpedo that runs out of fuel still detonates.
    if ((this.kind === 'torpedo' || this.kind === 'missile') && this.age > 0.4) {
      world.effects?.explosion?.(this.position, this.kind === 'torpedo' ? 90 : 40, this.color);
    }
    if (this.kind === 'wmgun') {
      world.effects?.explosion?.(this.position, 400, 0xcfefff);
      if (this.splashRadius > 0) this._splash(world, null);
    }
    this.active = false;
    if (this.mesh) this.mesh.visible = false;
    this.system._release(this);
  }
}

/* -------------------------------------------------------------------------- */

export class ProjectileSystem {
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    this.active = [];
    this.max = CONFIG.fx.maxProjectiles;
    this.rng = new Rng(0xbeef);
    this._up = new THREE.Vector3(0, 1, 0);
    this._meshPool = new Map();     // key: kind|color
    this._glow = makeGlowTexture(64);
    this.group = new THREE.Group();
    this.group.name = 'projectiles';
    scene.add(this.group);
  }

  _materialFor(kind, color) {
    const key = `${kind}|${color}`;
    let mat = this._matCache?.get(key);
    if (!this._matCache) this._matCache = new Map();
    mat = this._matCache.get(key);
    if (mat) return mat;

    const geo = geometries();
    if (kind === 'missile' || kind === 'torpedo') {
      mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
    } else if (kind === 'wmgun') {
      mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.92,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
    } else {
      mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
    }
    mat.userData.geoKind = (kind === 'missile' || kind === 'torpedo') ? 'cone' : (kind === 'wmgun' ? 'tracer' : 'tracer');
    this._matCache.set(key, mat);
    return mat;
  }

  _acquireMesh(kind, color) {
    const geoKind = (kind === 'missile' || kind === 'torpedo') ? 'cone' : 'tracer';
    const key = `${kind}|${color}`;
    const bucket = this._meshPool.get(key) || [];
    let mesh = bucket.pop();
    if (!mesh) {
      mesh = new THREE.Mesh(geometries()[geoKind], this._materialFor(kind, color));
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = true;
      mesh.userData.kind = kind;
    }
    this._meshPool.set(key, bucket);
    if (!mesh.parent) this.group.add(mesh);
    mesh.visible = true;
    return mesh;
  }

  _releaseMesh(proj) {
    if (!proj.mesh) return;
    const key = `${proj.kind}|${proj.color}`;
    const bucket = this._meshPool.get(key) || [];
    bucket.push(proj.mesh);
    this._meshPool.set(key, bucket);
    proj.mesh.visible = false;
  }

  _acquire() {
    let p = this.pool.pop();
    if (!p) p = new Projectile(this);
    return p;
  }

  _release(proj) {
    this._releaseMesh(proj);
    proj.reset();
    if (this.pool.length < this.max) this.pool.push(proj);
  }

  /**
   * Fire one projectile.
   * @returns {Projectile|null}
   */
  spawn(opts) {
    if (this.active.length >= this.max) return null;
    const p = this._acquire();
    p.spawn(opts);
    this.active.push(p);
    return p;
  }

  /** Pick the nearest valid enemy for a homing projectile. */
  _acquireTarget(proj) {
    let best = null, bestD = Infinity;
    const range = proj.spec?.range ?? 12000;
    for (const ship of this._world?.ships || []) {
      if (!ship.alive || ship === proj.owner) continue;
      if (ship.faction === proj.faction) continue;
      const d = ship.position.distanceTo(proj.position);
      if (d < bestD && d < range * 1.6) { bestD = d; best = ship; }
    }
    return best;
  }

  /** Point defence: damage hostile projectiles inside `radius`. */
  _damageProjectileNear(position, radius, damage, faction) {
    let hit = false;
    const r2 = radius * radius;
    for (const p of this.active) {
      if (!p.active || p.faction === faction) continue;
      if (p.kind !== 'missile' && p.kind !== 'torpedo') continue;
      if (p.position.distanceToSquared(position) > r2) continue;
      p.life -= 0.5;                 // PD chews through missile lifetime
      if (p.life <= 0) { p._expire(this._world); }
      hit = true;
    }
    return hit;
  }

  update(dt, world) {
    this._world = world;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      p.update(dt, world);
      if (!p.active) {
        this.active[i] = this.active[this.active.length - 1];
        this.active.pop();
      }
    }
  }

  get count() { return this.active.length; }

  clear() {
    for (const p of this.active) { p.active = false; this._releaseMesh(p); }
    this.active.length = 0;
  }

  dispose() {
    this.clear();
    for (const bucket of this._meshPool.values()) {
      for (const m of bucket) m.geometry?.dispose?.();
    }
    for (const m of this._matCache?.values() || []) m.dispose();
    this.scene.remove(this.group);
  }
}

export default ProjectileSystem;
