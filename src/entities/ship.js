/**
 * src/entities/ship.js — the Ship entity (SPEC §6.3).
 *
 * One flight model serves both the player and the AI: a controller (input or
 * FleetAI) writes into `ship.controls`, and `update()` integrates it. Ship is
 * the single authority for attitude and velocity, so nothing fights over the
 * transform.
 *
 * Damage is strictly layered shield → armor → hull with overflow carrying to
 * the next layer inside the same hit (docs/research/02-combat-mechanics.md §3).
 * Only hull-layer damage can cripple a subsystem (§1.9).
 */

import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { clamp, damp, lerp, interceptTime, wrapAngle } from '../core/math.js';
import { factionColor } from '../render/materials.js';
import { TURRET_GROUP_RE } from '../core/assets.js';

const LOCAL_UP = new THREE.Vector3(0, 1, 0);
const LOCAL_RIGHT = new THREE.Vector3(1, 0, 0);
const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1);

// Scratch objects — the sim must not allocate per frame.
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();

let nextShipId = 1;

export class Ship {
  /**
   * @param {object} opts
   * @param {object} opts.model   ShipModel from src/core/assets.js
   * @param {object} [opts.stats] overrides merged over CONFIG.ships[def.id]
   * @param {string} [opts.faction]
   * @param {boolean} [opts.isPlayer]
   * @param {{position:THREE.Vector3, quaternion?:THREE.Quaternion, throttle?:number}} opts.spawn
   * @param {string} [opts.callsign]
   */
  constructor(opts) {
    const { model, spawn } = opts;
    if (!model || !model.def) throw new Error('Ship requires a loaded ShipModel');

    this.id = nextShipId++;
    this.def = model.def;
    this.model = model;
    this.stats = { ...(CONFIG.ships[model.def.id] || {}), ...(opts.stats || {}) };

    this.faction = opts.faction || this.stats.faction || model.def.faction || 'neutral';
    this.isPlayer = !!opts.isPlayer;
    this.callsign = opts.callsign || this.stats.callsign || model.def.displayName || model.def.id;
    this.displayName = this.stats.displayName || model.def.displayName || this.callsign;
    this.shipClass = this.stats.shipClass || model.def.shipClass || '';
    this.role = this.stats.role || model.def.role || 'ship';

    // --- Transform ---------------------------------------------------------
    this.position = (spawn.position || new THREE.Vector3()).clone();
    this.quaternion = spawn.quaternion ? spawn.quaternion.clone() : new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.throttle = spawn.throttle ?? 0;
    this.controls = { yaw: 0, pitch: 0, roll: 0, throttle: 0, boost: false, brake: false };

    // --- Pools -------------------------------------------------------------
    this.hullMax = this.stats.hull ?? 10000;
    this.hull = this.hullMax;
    this.armorMax = this.stats.armor ?? 0;
    this.armor = this.armorMax;
    this.shieldMax = this.stats.shield ?? 0;
    this.shield = this.shieldMax;
    this.alive = true;
    // `radius` sizes the shield bubble and AI avoidance. Hit detection uses a
    // CAPSULE instead (see hitSegment/_hitRadius): a sphere at the ship's centre
    // is a poor fit for a 638 m hull, and on the Desler flagship it was actually
    // smaller than the ship's own half-beam.
    this.radius = this.stats.collisionRadius ?? Math.max(12, (this.def.lengthM || 200) * 0.16);
    const _len = this.def.lengthM || 200;
    const _beam = this.def.beamM || _len / 7.5;
    this._hitHalfLength = _len * 0.45;
    this._hitRadius = Math.max(6, _beam * 0.5 * 1.15);

    this.timeSinceDamage = 99;
    this.timeAlive = 0;
    this.kills = 0;
    this.damageDealt = 0;

    // --- Engine output drain (wave motion gun post-fire, research §1.2) ----
    this.engineOutputFactor = 1;
    this._engineOutputTimer = 0;

    // --- Weapons -----------------------------------------------------------
    this.weaponIds = this.stats.weapons ? [...this.stats.weapons] : [];
    this.weaponState = {};
    for (const wid of this.weaponIds) {
      const spec = CONFIG.weapons[wid];
      this.weaponState[wid] = {
        cooldown: 0,
        charge: 0,
        chargeRatio: 0,
        charging: false,
        burstLeft: 0,
        burstTimer: 0,
        shotsFired: 0,
        ready: true,
        spec: spec || null,
      };
    }

    // --- Subsystems --------------------------------------------------------
    // HP is quoted for a Yamato-scale hull (research §1.9) and scaled to this
    // hull, so escorts do not carry battleship-grade subsystems.
    this.subsystems = {};
    const D0 = CONFIG.damage;
    this.subsystemScale = clamp(
      this.hullMax / (D0.subsystemReferenceHull || 4400),
      D0.subsystemScaleMin ?? 0.25,
      D0.subsystemScaleMax ?? 1.5,
    );

    const addSub = (name, kind) => {
      const base = D0.subsystemHp[kind] ?? 400;
      const hp = Math.max(1, Math.round(base * this.subsystemScale));
      this.subsystems[name] = { name, kind, hp, max: hp, disabled: false };
    };
    const addMany = (prefix, kind, count) => {
      for (let i = 0; i < Math.max(0, count | 0); i++) addSub(`${prefix}_${i + 1}`, kind);
    };

    addSub('bridge', 'bridge');
    if (this.weaponIds.includes('wmgun')) addSub('wave_motion_gun', 'wmgun');
    addMany('engine', 'engine', 2);
    for (const [wid, count] of Object.entries(this.stats.mounts || {})) {
      const spec = CONFIG.weapons[wid];
      const kind = spec && spec.subsystemKind;
      if (!kind) continue;
      // The wave motion gun is a single bow mount already created above. Adding
      // it again here gave the gun 1800 hp instead of the designed 900, and
      // destroying one of the two copies left the gun fully operational
      // (hasWorkingSubsystem is kind-based, so it still saw a live mount).
      if (kind === 'wmgun') continue;
      addMany(spec.mountPrefix || wid, kind, count);
    }
    this.pdMounts = this.stats.pdMounts ?? 0;
    addMany('ciws', 'ciws', this.pdMounts);

    // --- Render objects ----------------------------------------------------
    // One renderable PER SHIP. Sharing the template's Group would re-parent it
    // (a THREE.Object3D has exactly one parent), so every ship of a class drew
    // at whichever one wrote last — 4 of the 6 wave-1 ships were invisible.
    const inst = model.createInstance();
    this.object3D = inst.object3D;
    this.materials = inst.materials;
    this.groups = inst.groups;
    this.object3D.position.copy(this.position);
    this.object3D.quaternion.copy(this.quaternion);

    // --- Traversable mounts ------------------------------------------------
    // Only groups the generator authored on their OWN pivot can turn (SPEC §5
    // rule 3). A model with a single merged `turret_main` group simply gets no
    // traverse, which is why every read below is guarded.
    this.turrets = [];
    this.turretAim = {};
    const T = CONFIG.turrets || {};
    const traverseRate = ((T.traverseRateDeg ?? 55) * Math.PI) / 180;
    const elevateRate = ((T.elevateRateDeg ?? 35) * Math.PI) / 180;
    for (const [name, meshes] of this.groups || []) {
      if (!TURRET_GROUP_RE.test(name)) continue;
      const hp = model.hardpoints.get(name);
      const spec = this._weaponForMount(name);
      for (const mesh of meshes) {
        this.turrets.push({
          name, mesh, spec,
          arcRad: spec ? (spec.arcDeg * Math.PI) / 180 : Math.PI,
          rate: traverseRate * (spec && spec.kind === 'wmgun' ? 0.25 : 1),
          elevateRate,
          angle: 0, targetAngle: 0, elevation: 0, targetElevation: 0,
          canBear: true, bearing: 0,
          restDir: hp ? hp.dir.clone() : new THREE.Vector3(0, 0, -1),
        });
      }
    }

    this._buildShieldBubble();

    // AI/player bookkeeping
    this.target = null;
    this.formationSlot = null;
    this.aiState = 'idle';
    this.threat = 0;
    this._engineGlowPhase = Math.random() * 10;
  }

  _buildShieldBubble() {
    const r = Math.max(this.radius * 1.55, (this.def.lengthM || 200) * 0.30);
    const geo = new THREE.SphereGeometry(r, 32, 20);
    // A flat additive sphere reads as an opaque disc that hides the ship. A
    // fresnel rim (bright at grazing angles, transparent face-on) reads as an
    // energy bubble instead, and never obscures the hull.
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(factionColor(this.faction)) },
        uOpacity: { value: 0 },
        uPower: { value: 2.6 },
      },
      vertexShader: `
        varying vec3 vNormalW;
        varying vec3 vViewW;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vViewW = normalize(cameraPosition - world.xyz);
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uPower;
        varying vec3 vNormalW;
        varying vec3 vViewW;
        void main() {
          float f = 1.0 - abs(dot(normalize(vNormalW), normalize(vViewW)));
          f = pow(clamp(f, 0.0, 1.0), uPower);
          float a = f * uOpacity;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor * (0.6 + f * 0.9) * a, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
    });
    this.shieldMesh = new THREE.Mesh(geo, mat);
    this.shieldMesh.name = 'shieldBubble';
    this.shieldMesh.visible = false;
    this.shieldMesh.frustumCulled = false;
    this.object3D.add(this.shieldMesh);
    this._shieldFlash = 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Derived state                                                          */
  /* ---------------------------------------------------------------------- */

  get forward() { return _fwd.set(0, 0, -1).applyQuaternion(this.quaternion).clone(); }
  get up() { return _up.set(0, 1, 0).applyQuaternion(this.quaternion).clone(); }
  get right() { return _right.set(1, 0, 0).applyQuaternion(this.quaternion).clone(); }

  get healthRatio() { return clamp(this.hull / Math.max(1, this.hullMax), 0, 1); }
  get shieldRatio() { return this.shieldMax > 0 ? clamp(this.shield / this.shieldMax, 0, 1) : 0; }
  get armorRatio() { return this.armorMax > 0 ? clamp(this.armor / this.armorMax, 0, 1) : 0; }
  get speed() { return this.velocity.length(); }
  get isDisabled() { return !this.alive; }

  /** Engine subsystem health => sluggish when shot up. */
  get engineHealthFactor() {
    const e = Object.values(this.subsystems).filter((s) => s.kind === 'engine');
    if (!e.length) return 1;
    const worst = Math.min(...e.map((s) => (s.disabled ? 0 : s.hp / s.max)));
    return lerp(0.45, 1, clamp(worst, 0, 1));
  }

  /** Combined engine output: subsystem damage × temporary post-fire drain. */
  get engineOutput() {
    return this.engineHealthFactor * (this._engineOutputTimer > 0 ? this.engineOutputFactor : 1);
  }

  hasWorkingSubsystem(kind) {
    const list = Object.values(this.subsystems).filter((s) => s.kind === kind);
    if (!list.length) return true;
    return list.some((s) => !s.disabled);
  }

  /** Fraction of mounts of `kind` still able to shoot (0..1). */
  turretFactor(kind = 'turret_main') {
    const list = Object.values(this.subsystems).filter((s) => s.kind === kind);
    if (!list.length) return 1;
    return list.filter((s) => !s.disabled).length / list.length;
  }

  /** A dead bridge doubles reaction time and costs 25% accuracy (research §1.9). */
  get bridgeDisabled() {
    const b = Object.values(this.subsystems).find((s) => s.kind === 'bridge');
    return !!b && b.disabled;
  }
  get accuracyFactor() { return this.bridgeDisabled ? 0.75 : 1; }
  get reactionFactor() { return this.bridgeDisabled ? 2 : 1; }

  /** Temporarily reduce engine output (wave motion gun recoil drain). */
  drainEngine(factor = 0.6, duration = 4) {
    this.engineOutputFactor = clamp(factor, 0.1, 1);
    this._engineOutputTimer = Math.max(this._engineOutputTimer, duration);
  }

  /** Which weapon (if any) fires from a mount group named `name`. */
  _weaponForMount(name) {
    for (const wid of this.weaponIds) {
      const spec = CONFIG.weapons[wid];
      if (spec && spec.mountPrefix && name.startsWith(spec.mountPrefix)) return spec;
    }
    return null;
  }

  /**
   * Slew every traversable mount onto the current aim point.
   *
   * The demand is computed in SHIP-LOCAL space, so a mount's angle is
   * independent of the hull's attitude. A mount whose traverse LIMIT
   * (`spec.arcDeg`) cannot reach the target stops at the limit and reports
   * `canBear: false` rather than tracking something it could never shoot.
   */
  updateTurrets(dt) {
    if (!this.turrets.length) return;
    const aim = this.aimPoint || (this.target && this.target.alive ? this.target.position : null);
    const T = CONFIG.turrets || {};
    const restWhenBlocked = T.returnToRestWhenBlocked !== false;
    const maxElev = ((T.maxElevationDeg ?? 45) * Math.PI) / 180;

    for (const t of this.turrets) {
      let demand = 0;          // traverse angle, radians, 0 = trained fore/aft
      let elevate = 0;
      let bearing = 0;
      let canBear = true;

      if (aim) {
        _v.copy(aim).sub(this.position);
        const dist = _v.length();
        if (dist > 1e-4) {
          _v.divideScalar(dist);
          _q.copy(this.quaternion).invert();
          _v.applyQuaternion(_q);                    // into ship-local space
          // A mount rests along its hardpoint dir (usually -Z). Solve the yaw
          // that swings that rest direction onto the target bearing.
          const restYaw = Math.atan2(-t.restDir.x, -t.restDir.z);
          demand = wrapAngle(Math.atan2(-_v.x, -_v.z) - restYaw);
          bearing = demand;
          elevate = clamp(Math.asin(clamp(_v.y, -1, 1)), -maxElev, maxElev);
          canBear = Math.abs(demand) <= t.arcRad;
        }
      }

      t.bearing = bearing;
      t.canBear = canBear;
      // A blocked mount holds at its limit (so the player can SEE it straining)
      // or returns to rest, depending on config.
      t.targetAngle = canBear ? demand : (restWhenBlocked ? 0 : clamp(demand, -t.arcRad, t.arcRad));
      t.targetElevation = canBear ? elevate : 0;

      const dA = wrapAngle(t.targetAngle - t.angle);
      const stepA = t.rate * dt;
      t.angle = wrapAngle(t.angle + clamp(dA, -stepA, stepA));
      const dE = t.targetElevation - t.elevation;
      const stepE = t.elevateRate * dt;
      t.elevation += clamp(dE, -stepE, stepE);

      if (t.mesh) {
        t.mesh.rotation.y = t.angle;
        t.mesh.rotation.x = -t.elevation;
      }
      this.turretAim[t.name] = {
        angle: t.angle, targetAngle: t.targetAngle,
        elevation: t.elevation,
        bearing, inArc: canBear, canBear,
      };
    }
  }

  /** True once a mount has settled onto its demanded bearing. */
  turretReady(name) {
    const t = this.turrets.find((x) => x.name === name);
    if (!t) return true;                       // no traverse = always "ready"
    const tol = ((CONFIG.turrets?.settleToleranceDeg ?? 5) * Math.PI) / 180;
    return Math.abs(wrapAngle(t.targetAngle - t.angle)) <= tol;
  }

  /** How many mounts of `weaponId` can bear on the ship's current target. */
  mountsBearing(weaponId) {
    const spec = CONFIG.weapons[weaponId];
    if (!spec || !spec.mountPrefix) return 0;
    const list = this.turrets.filter((t) => t.name.startsWith(spec.mountPrefix));
    if (!list.length) return this.target && this.target.alive ? 1 : 0;   // merged group
    return list.filter((t) => t.canBear).length;
  }

  /* ---------------------------------------------------------------------- */
  /* Flight                                                                 */
  /* ---------------------------------------------------------------------- */

  update(dt, world) {
    if (!this.alive) { this._updateVisuals(dt, world); return; }

    this.timeAlive += dt;
    this.timeSinceDamage += dt;
    this.updateTurrets(dt);

    if (this._engineOutputTimer > 0) {
      this._engineOutputTimer -= dt;
      if (this._engineOutputTimer <= 0) { this._engineOutputTimer = 0; this.engineOutputFactor = 1; }
    }

    const eng = this.engineOutput;
    const baseSpeed = this.stats.maxSpeed ?? 100;
    const boostMul = this.controls.boost
      ? (this.stats.boostSpeed ?? baseSpeed * 1.5) / Math.max(1, baseSpeed)
      : 1;
    const maxSpeed = baseSpeed * eng;
    const reverseSpeed = (this.stats.reverseSpeed ?? baseSpeed * 0.33) * eng;

    // --- Attitude ---------------------------------------------------------
    const yawRate = (this.stats.yawRate ?? 0.2) * eng;
    const pitchRate = (this.stats.pitchRate ?? 0.12) * eng;
    const rollRate = (this.stats.rollRate ?? 0.5) * eng;

    const yawIn = clamp(this.controls.yaw, -1, 1);
    const pitchIn = clamp(this.controls.pitch, -1, 1);
    const rollIn = clamp(this.controls.roll, -1, 1);

    if (yawIn) { _q.setFromAxisAngle(LOCAL_UP, yawIn * yawRate * dt); this.quaternion.multiply(_q); }
    if (pitchIn) { _q.setFromAxisAngle(LOCAL_RIGHT, pitchIn * pitchRate * dt); this.quaternion.multiply(_q); }
    if (rollIn) { _q.setFromAxisAngle(LOCAL_FORWARD, rollIn * rollRate * dt); this.quaternion.multiply(_q); }
    this.quaternion.normalize();

    // --- Velocity ---------------------------------------------------------
    const throttleIn = clamp(this.controls.throttle, -1, 1);
    this.throttle = damp(this.throttle, throttleIn, 2.6, dt);

    // Reverse uses its own (much lower) top speed rather than a fraction of
    // forward speed.
    const targetSpeed = this.throttle >= 0
      ? maxSpeed * boostMul * this.throttle
      : reverseSpeed * this.throttle;

    _v.set(0, 0, -1).applyQuaternion(this.quaternion).multiplyScalar(targetSpeed);

    const accel = (this.stats.accel ?? 25) * eng * (this.controls.brake ? 2.2 : 1);
    const rate = this.controls.brake ? (this.stats.brakeDecel ?? 50) : accel;
    const k = 1 - Math.exp(-(rate / Math.max(8, maxSpeed)) * dt);
    this.velocity.lerp(_v, k);

    this.position.addScaledVector(this.velocity, dt);

    // --- Soft battle-space bounds ----------------------------------------
    // Cancel only the OUTWARD velocity component, then apply a gentle inward
    // acceleration. Damping the whole velocity every frame (the previous
    // behaviour) collapsed a ship's speed to ~0 at the boundary and left it
    // pinned there forever, unable to turn around and rejoin the fight.
    const bounds = CONFIG.world.boundsRadius;
    const d2 = this.position.lengthSq();
    if (d2 > bounds * bounds) {
      const d = Math.sqrt(d2);
      _v.copy(this.position).divideScalar(d);           // outward unit normal
      this.position.multiplyScalar((bounds * 0.99) / d);
      const outward = this.velocity.dot(_v);
      if (outward > 0) this.velocity.addScaledVector(_v, -outward);
      this.velocity.addScaledVector(_v, -25 * dt);      // pull back toward the centre
    }

    // --- Shield regeneration ---------------------------------------------
    if (this.shieldMax > 0 && this.shield < this.shieldMax
        && this.timeSinceDamage > (this.stats.shieldDelay ?? 4)) {
      this.shield = Math.min(this.shieldMax, this.shield + (this.stats.shieldRegen ?? 100) * dt);
    }

    this._updateVisuals(dt, world);
  }

  _updateVisuals(dt, world) {
    this.object3D.position.copy(this.position);
    this.object3D.quaternion.copy(this.quaternion);

    // Engine glow tracks throttle; a dead engine goes dark.
    const eng = this.alive ? this.engineOutput : 0;
    const thrust = clamp(Math.abs(this.throttle) * (this.controls.boost ? 1.35 : 1), 0, 1.4);
    if (this.materials && this.materials.setEngineIntensity) {
      // Kept below 1.0: emissive above ~1 clips to pure white through ACES
      // and then blooms into a featureless disc that hides the stern.
      this.materials.setEngineIntensity(0.15 + thrust * eng * 0.55);
    }

    // Shield bubble flashes on impact, then fades. It is a rim effect, so a low
    // peak opacity already reads clearly without hiding the hull.
    this._shieldFlash = Math.max(0, this._shieldFlash - dt * 2.6);
    const ratio = this.shieldRatio;
    const visible = this._shieldFlash > 0.01 && ratio > 0.001;
    this.shieldMesh.visible = visible;
    if (visible) {
      this.shieldMesh.material.uniforms.uOpacity.value = Math.min(0.9, this._shieldFlash * 1.1) * (0.35 + ratio * 0.65);
      const pulse = 1 + Math.sin(this.timeAlive * 9) * 0.012;
      this.shieldMesh.scale.setScalar(pulse);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Hardpoints & weapons                                                   */
  /* ---------------------------------------------------------------------- */

  getHardpointWorld(name) {
    const hp = this.model.hardpoints.get(name);
    if (!hp) return null;
    const pos = hp.pos.clone().applyQuaternion(this.quaternion).add(this.position);
    const dir = hp.dir.clone().applyQuaternion(this.quaternion).normalize();
    return { pos, dir, kind: hp.kind, name };
  }

  /** Every hardpoint whose name begins with `prefix`, in world space. */
  getMountsWorld(prefix) {
    const out = [];
    for (const hp of this.model.hardpoints.values()) {
      if (hp.name.startsWith(prefix)) out.push(this.getHardpointWorld(hp.name));
    }
    return out;
  }

  /** True when `point` is inside the ship's forward firing cone. */
  inFiringArc(point, arcDeg) {
    if (!arcDeg || arcDeg >= 180) return true;
    _v.copy(point).sub(this.position);
    const dist = _v.length();
    if (dist < 1e-3) return true;
    _v.divideScalar(dist);
    _v2.set(0, 0, -1).applyQuaternion(this.quaternion);
    const cos = clamp(_v.dot(_v2), -1, 1);
    return Math.acos(cos) <= (arcDeg * Math.PI) / 180;
  }

  /* ---------------------------------------------------------------------- */
  /* Steering helpers — the AI writes `controls`, never the quaternion.      */
  /* ---------------------------------------------------------------------- */

  /**
   * Point the nose at a world position by writing yaw/pitch into `controls`.
   * @param {THREE.Vector3} point world-space target
   * @param {{gain?:number, maxYaw?:number, maxPitch?:number, level?:number}} [opts]
   * @returns {{yaw:number, pitch:number, dist:number, aligned:boolean}}
   */
  steerToward(point, opts = {}) {
    const gain = opts.gain ?? 1.9;
    const maxYaw = opts.maxYaw ?? 1;
    const maxPitch = opts.maxPitch ?? 1;
    const level = opts.level ?? 0;          // 0 = ignore roll, >0 = roll to level

    _v.copy(point).sub(this.position);
    const dist = _v.length();
    if (dist < 1e-4) return { yaw: 0, pitch: 0, dist: 0, aligned: true };
    _v.divideScalar(dist);

    // Into ship-local space, then read off the yaw/pitch needed to align -Z.
    _q.copy(this.quaternion).invert();
    _v.applyQuaternion(_q);
    const yaw = Math.atan2(-_v.x, -_v.z);
    const pitch = Math.asin(clamp(_v.y, -1, 1));

    this.controls.yaw = clamp(yaw * gain, -maxYaw, maxYaw);
    this.controls.pitch = clamp(pitch * gain, -maxPitch, maxPitch);

    if (level > 0) this.levelRoll(level);

    return {
      yaw, pitch, dist,
      aligned: Math.abs(yaw) < 0.035 && Math.abs(pitch) < 0.035,
    };
  }

  /** Roll so the ship's local up matches world up. */
  levelRoll(gain = 1.2) {
    _v.set(0, 1, 0).applyQuaternion(_q.copy(this.quaternion).invert());
    const roll = Math.atan2(_v.x, _v.y);
    this.controls.roll = clamp(-roll * gain, -1, 1);
    return roll;
  }

  /** Hold a heading that puts `point` on the beam (broadside doctrine). */
  steerBroadside(point, side = 1, opts = {}) {
    _v.copy(point).sub(this.position).normalize();
    // Rotate the desired facing 90° off the target bearing.
    _v2.set(-_v.z * side, 0, _v.x * side);
    if (_v2.lengthSq() < 1e-6) _v2.set(side, 0, 0);
    _v3.copy(this.position).addScaledVector(_v2.normalize(), 1000);
    return this.steerToward(_v3, opts);
  }

  /** World-space aim point that leads a moving target for `speed` m/s rounds. */
  aimPointAt(target, projectileSpeed) {
    _v.copy(target.position).sub(this.position);
    const t = interceptTime(_v, target.velocity, projectileSpeed);
    const lead = Math.min(t ?? 0, 8);
    return _v2.copy(target.position).addScaledVector(target.velocity, lead).clone();
  }

  fireWeapon(weaponId, world) {
    // Delegated to main.js, which owns the weapon system.
    return world.fireWeapon(this, weaponId);
  }

  /* ---------------------------------------------------------------------- */
  /* Damage                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * @param {number} amount raw damage
   * @param {{type?:string, shieldMultiplier?:number, armorMultiplier?:number,
   *          hullMultiplier?:number, from?:Ship, hitPoint?:THREE.Vector3,
   *          weaponId?:string}} [opts]
   * @returns {{absorbed:number, shieldHit:number, armorHit:number, hullHit:number,
   *            killed:boolean, subsystemHit:string|null, disabled:boolean,
   *            crit:boolean, subsystemShare:number, overkill:number}}
   */
  applyDamage(amount, opts = {}) {
    const result = {
      absorbed: 0, shieldHit: 0, armorHit: 0, hullHit: 0,
      killed: false, subsystemHit: null, disabled: false,
      crit: false, subsystemShare: 0, overkill: 0,
    };
    if (!this.alive || amount <= 0) return result;

    const D = CONFIG.damage;
    const shieldMul = opts.shieldMultiplier ?? 1;
    const armorMul = opts.armorMultiplier ?? 1;
    const hullMul = opts.hullMultiplier ?? 1;

    // Friendly fire is heavily scaled down, and never from yourself.
    let dmg = amount;
    if (opts.from && opts.from.faction === this.faction && opts.from !== this) {
      dmg *= D.friendlyFireScale;
    }

    let remaining = dmg;

    // 1) Shields — scaled by weapon-vs-shield efficiency.
    if (this.shield > 0 && remaining > 0) {
      const incoming = remaining * shieldMul;
      const taken = Math.min(this.shield, incoming);
      this.shield -= taken;
      const raw = shieldMul > 0 ? taken / shieldMul : taken;
      result.shieldHit = raw;
      remaining -= raw;
      this._shieldFlash = 1;
    }

    // 2) Armor — scaled by weapon-vs-armor efficiency. Never regenerates.
    if (this.armor > 0 && remaining > 0) {
      const incoming = remaining * armorMul;
      const taken = Math.min(this.armor, incoming);
      this.armor -= taken;
      const raw = armorMul > 0 ? taken / armorMul : taken;
      result.armorHit = raw;
      remaining -= raw;
    }

    // 3) Hull takes whatever is left.
    if (remaining > 0) {
      let hullDmg = remaining * hullMul;

      // A share of hull-layer damage is *redirected* to one subsystem
      // (research §1.9). It is taken out of the hull's share, not added on top.
      let share = hullDmg * (D.subsystemDamageFraction ?? 0.15);
      if (Math.random() < (D.critChance ?? 0)) { share *= 2; result.crit = true; }

      if (share > 0) {
        const hit = this._damageRandomSubsystem(share);
        if (hit) {
          result.subsystemHit = hit.name;
          result.subsystemShare = share;
          if (hit.disabled) result.disabled = true;
          hullDmg -= share;
        }
      }

      this.hull -= hullDmg;
      result.hullHit = hullDmg;
    }

    this.timeSinceDamage = 0;
    result.absorbed = dmg - Math.max(0, remaining);

    if (this.hull <= 0) {
      result.overkill = -this.hull;
      this.hull = 0;
      this.alive = false;
      result.killed = true;
    }
    return result;
  }

  _damageRandomSubsystem(amount) {
    const list = Object.values(this.subsystems).filter((s) => !s.disabled);
    if (!list.length) return null;
    const s = list[Math.floor(Math.random() * list.length)];
    s.hp -= amount;
    if (s.hp <= 0) { s.hp = 0; s.disabled = true; }
    return s;
  }

  repairSubsystem(kind, fraction = 1) {
    for (const s of Object.values(this.subsystems)) {
      if (s.kind === kind) { s.hp = Math.min(s.max, s.hp + s.max * fraction); s.disabled = s.hp <= 0; }
    }
  }

  /**
   * World-space capsule approximating the hull, for projectile collision.
   * @param {THREE.Vector3} outA receives the bow end
   * @param {THREE.Vector3} outB receives the stern end
   */
  hitSegment(outA, outB) {
    _v.set(0, 0, -1).applyQuaternion(this.quaternion);
    outA.copy(this.position).addScaledVector(_v, -this._hitHalfLength);
    outB.copy(this.position).addScaledVector(_v, this._hitHalfLength);
    return { a: outA, b: outB };
  }

  /** Capsule radius for hit detection (roughly half the beam, slightly padded). */
  get hitRadius() { return this._hitRadius; }

  /** Distance to another ship's centre, in metres. */
  distanceTo(other) { return this.position.distanceTo(other.position); }

  /** Relative bearing of `other` in degrees, 0 = dead ahead, 180 = astern. */
  bearingTo(other) {
    _v.copy(other.position).sub(this.position).normalize();
    _v2.set(0, 0, -1).applyQuaternion(this.quaternion);
    return (Math.acos(clamp(_v.dot(_v2), -1, 1)) * 180) / Math.PI;
  }

  dispose() {
    this.object3D.parent?.remove(this.object3D);
    // Geometry and the shared palette materials belong to the cached template
    // and are used by every ship of this class — disposing them here would
    // break the siblings. Only this ship's own clones and its shield bubble
    // are ours to free.
    this.materials?.dispose?.();
    this.shieldMesh?.geometry?.dispose?.();
    this.shieldMesh?.material?.dispose?.();
  }
}

export default Ship;
