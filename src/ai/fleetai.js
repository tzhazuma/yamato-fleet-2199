/**
 * YAMATO FLEET 2199 — src/ai/fleetai.js  (owner: engine-dev)
 *
 * Fleet AI (SPEC §6.7) + wave spawning.
 *
 * Frozen interface:
 *   export class FleetAI {
 *     constructor({ faction, ships, world, doctrine })   // 'garmillas'|'bolar'|'uncf'
 *     update(dt, world): void
 *   }
 *   export function spawnWave(waveIndex, world): Ship[]
 *
 * CONTROL CONTRACT (src/entities/ship.js — the single authority for flight):
 *   The AI never touches `ship.quaternion` or `ship.throttle`. It writes
 *   `ship.controls = { yaw, pitch, roll, throttle, boost, brake }`, normally via
 *   the Ship helpers `steerToward() / steerBroadside() / levelRoll()`, and
 *   publishes a free-form `ship.aiControl` bag for debugging only.
 *
 * Behaviour: formation-slot keeping, threat/priority target selection with
 * focus fire, broadside arc discipline, per-doctrine fire discipline, wave
 * motion gun telegraph before firing, and WMG-charge dodging.
 *
 * Everything is defensive: a Ship missing a helper, a CONFIG field that moved,
 * or a world without a ship factory degrades to "skip that ship / warn once"
 * instead of throwing. No ship ids are hardcoded — CONFIG.waves drives spawning.
 */

import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { clamp, clamp01, dist, interceptTime } from '../core/math.js';

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Fallbacks for every doctrine field we read; CONFIG always wins. */
const DEFAULT_DOCTRINE = {
  accuracy: 0.72,
  aggression: 0.8,
  preferredRangeFactor: 0.72,
  broadsideBias: 0.55,
  focusFire: 0.65,
  switchCooldown: 2.2,
  reactionTime: 0.9,
  retreatHullThreshold: 0.15,
  formationSlotRadius: 1.8,
  formationSlotCount: 6,
  missileFireMinRange: 400,
  missileFireMaxRange: null,     // null => derive from the weapon spec
  torpedoRangeFactor: 0.85,
  wmgunTelegraphTime: 2.4,
  dodgeWMGChance: 0.3,
  wmgunMinRange: null,
  wmgunMaxRange: null,
};

const DEFAULT_PRIORITY = { threat: 0.45, role: 0.30, proximity: 0.25, player: 0.35 };
const DEFAULT_ROLE_VALUE = { flagship: 1.0, battleship: 0.9, carrier: 0.8, cruiser: 0.6, destroyer: 0.4 };

const PATTERNS = { garmillas: 'abreast', bolar: 'echelon', uncf: 'wedge' };

/** mountPrefix → subsystem kind (CONFIG.damage.subsystemHp keys). */
const PREFIX_KIND = {
  wave_motion_gun: 'wmgun',
  turret_main: 'turret_main',
  turret_secondary: 'turret_secondary',
  ciws: 'ciws',
  engine: 'engine',
};

// ── small vector helpers (plain objects; no per-frame allocation) ────────

/** Rotate (x,y,z) by quaternion q into `out`. */
function rotate(q, x, y, z, out) {
  if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.w)) {
    out.x = x; out.y = y; out.z = z; return out;
  }
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** Rotate (x,y,z) by the conjugate of q (world → ship local). */
function rotateInv(q, x, y, z, out) {
  if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.w)) {
    out.x = x; out.y = y; out.z = z; return out;
  }
  return rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, x, y, z, out);
}

const hasVec = (v) => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

function lerpPoint(a, b, t, out) {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

// ── doctrine normalisation (supports both CONFIG.ai generations) ─────────

/**
 * Build a complete doctrine from CONFIG, accepting either the flat per-faction
 * shape (accuracy/aggression/preferredRangeFactor/broadsideBias/focusFire/...)
 * or the earlier shape (aggression/standoffMul/broadside/torpedoRange plus
 * top-level engagementRange/accuracy/focusFireBias/retargetInterval/...).
 */
function normalizeDoctrine(name, faction) {
  const ai = (CONFIG && typeof CONFIG.ai === 'object' && CONFIG.ai) ? CONFIG.ai : {};
  const key = (typeof name === 'string' && name) ? name
    : ((typeof faction === 'string' && faction) ? faction : 'garmillas');
  const raw = (ai.doctrines && typeof ai.doctrines === 'object' && ai.doctrines[key]) || {};
  const d = Object.assign({}, DEFAULT_DOCTRINE);

  d.accuracy = num(raw.accuracy, num(ai.accuracy, d.accuracy));
  d.aggression = num(raw.aggression, d.aggression);
  d.broadsideBias = clamp01(num(raw.broadsideBias, num(raw.broadside, num(ai.broadsideBias, d.broadsideBias))));
  // focusFire is a probability in the old shape and a boolean in the new one.
  d.focusFire = (typeof raw.focusFire === 'boolean')
    ? (raw.focusFire ? 1 : 0)
    : clamp01(num(raw.focusFire, num(ai.focusFireBias, d.focusFire)));
  d.switchCooldown = num(raw.switchCooldown, num(raw.focusFireSwitchCooldown, num(ai.retargetInterval, d.switchCooldown)));
  d.formationSlotCount = Math.max(1, Math.floor(num(raw.formationSlotCount, num(ai.formationSlotCount, 6))));
  d.reactionTime = num(raw.reactionTime, num(ai.reactionTime, d.reactionTime));
  d.retreatHullThreshold = num(raw.retreatHullThreshold, d.retreatHullThreshold);
  d.formationSlotRadius = num(raw.formationSlotRadius, d.formationSlotRadius);
  d.missileFireMinRange = num(raw.missileFireMinRange, d.missileFireMinRange);
  d.missileFireMaxRange = num(raw.missileFireMaxRange, d.missileFireMaxRange);
  d.torpedoRangeFactor = num(raw.torpedoRange, d.torpedoRangeFactor);
  d.wmgunTelegraphTime = num(raw.wmgunTelegraphTime, num(ai.wmgunTelegraph, d.wmgunTelegraphTime));
  d.dodgeWMGChance = clamp01(num(raw.dodgeWMGChance, d.dodgeWMGChance));
  d.wmgunMinRange = num(raw.wmgunMinRange, num(ai.wmgunMinRange, d.wmgunMinRange));
  d.wmgunMaxRange = num(raw.wmgunMaxRange, num(ai.wmgunMaxRange, d.wmgunMaxRange));

  // Preferred range = longest weapon range × factor. Old shape expressed the
  // standoff as an absolute fraction (engagementRange) scaled by standoffMul.
  d.preferredRangeFactor = clamp(num(
    raw.preferredRangeFactor,
    num(ai.engagementRange, d.preferredRangeFactor) * num(raw.standoffMul, 1),
  ), 0.05, 1.5);

  d.name = key;
  return d;
}

function modelDefFor(world, id) {
  const models = world ? world.models : null;
  if (!models || !id) return null;
  if (typeof models.get === 'function') {
    const m = models.get(id);
    return (m && m.def) || null;
  }
  const m = models[id];
  return (m && m.def) || null;
}

// ─────────────────────────────────────────────────────────────── FleetAI ──

export class FleetAI {
  /**
   * @param {object} opts { faction, ships, world, doctrine }
   */
  constructor(opts = {}) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    this.faction = (typeof o.faction === 'string' && o.faction) ? o.faction : 'neutral';
    this.doctrineName = (typeof o.doctrine === 'string' && o.doctrine) ? o.doctrine : this.faction;
    this.d = normalizeDoctrine(this.doctrineName, this.faction);
    this.pattern = PATTERNS[this.doctrineName] || 'line';

    // Hold the caller's array BY REFERENCE — never copy it. main.js builds the
    // fleet AI before any ship exists and then pushes arrivals into this very
    // array (world.fleets[faction]), so a snapshot would freeze the fleet empty
    // forever. Equally: never splice it.
    this.ships = Array.isArray(o.ships) ? o.ships : [];
    this._roster = [];               // reused per-frame working list
    this.world = (o.world && typeof o.world === 'object') ? o.world : null;
    this.enabled = true;

    this._states = new Map();
    this._focusTarget = null;
    this._focusTimer = 0;
    this._slotCount = -1;
    this._slotsDirty = true;
    this._warned = new Set();
    this._broadsideBroken = false;   // set if Ship.steerBroadside throws in this build
    this._rngFallback = Math.random;

    // scratch
    this._v = { x: 0, y: 0, z: 0 };
    this._v2 = { x: 0, y: 0, z: 0 };
    this._v3 = { x: 0, y: 0, z: 0 };
    this._frame = {
      fx: 0, fy: 0, fz: -1, rx: 1, ry: 0, rz: 0,
      anchor: { x: 0, y: 0, z: 0 },
    };
  }

  // ────────────────────────────────────────────────────────────── public ──

  get aliveShips() {
    return this.ships.filter((s) => s && s.alive !== false && !s.isPlayer);
  }

  addShips(list) {
    if (!Array.isArray(list)) return;
    for (const s of list) if (s && this.ships.indexOf(s) === -1) this.ships.push(s);
    this._slotsDirty = true;
  }

  /**
   * The ships this fleet owns, resolved FRESH every frame: the world's ship
   * list filtered by faction, unioned with the array handed to the constructor
   * (main.js keeps pushing into it). Nothing about the roster is cached across
   * updates, so arrivals are picked up the frame they appear.
   */
  _rosterFor(world) {
    const out = this._roster;
    out.length = 0;
    const push = (s) => {
      if (!s || s.isPlayer || s.alive === false) return;
      if (s.faction !== this.faction) return;
      if (out.indexOf(s) === -1) out.push(s);
    };
    const all = (world && Array.isArray(world.ships)) ? world.ships : null;
    if (all) for (let i = 0; i < all.length; i++) push(all[i]);
    for (let i = 0; i < this.ships.length; i++) push(this.ships[i]);
    if (!out.length) {
      // Fallback for a fleet whose ships do not share this.faction (e.g. a
      // standalone/test fleet): trust the array we were handed.
      for (let i = 0; i < this.ships.length; i++) {
        const s = this.ships[i];
        if (s && !s.isPlayer && s.alive !== false && out.indexOf(s) === -1) out.push(s);
      }
    }
    return out;
  }

  update(dt, world) {
    if (!this.enabled) return;
    const w = (world && typeof world === 'object') ? world : this.world;
    if (!w) return;
    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;
    if (step <= 0) return;
    try {
      const roster = this._rosterFor(w);
      if (!roster.length) return;
      const ctx = this._context(w, step, roster);
      this._assignSlots(ctx);
      this._updateFocus(ctx, step);
      for (let i = 0; i < roster.length; i++) {
        const ship = roster[i];
        if (!ship || ship.isPlayer || ship.alive === false) continue;
        const st = this._state(ship);
        this._updateShip(ship, st, ctx, step, w);
      }
    } catch (err) {
      this._warn('update', 'FleetAI update failed: ' + (err && err.message ? err.message : err));
    }
  }

  dispose() {
    this.enabled = false;
    this._states.clear();
    this._roster.length = 0;
    // Never touch this.ships: it is world.fleets[faction], owned by main.js.
  }

  // ────────────────────────────────────────────────────────────── state ──

  _state(ship) {
    let st = this._states.get(ship);
    if (!st) {
      st = {
        ship,
        slotIndex: Number.isFinite(ship.formationSlot) ? ship.formationSlot : 0,
        side: 0,
        sideFor: null,
        sideTimer: 0,
        target: null,
        targetTimer: 0,
        acquire: 0,
        timers: {},
        wmgun: null,
        wmgunBlocked: 0,
        dodge: 0,
        dodgeDir: null,
        dodgedForCharge: false,
        slotPos: { x: ship.position ? ship.position.x : 0, y: ship.position ? ship.position.y : 0, z: ship.position ? ship.position.z : 0 },
        debug: {
          doctrine: this.doctrineName, faction: this.faction, target: null,
          slot: null, slotIndex: 0, throttle: 0, charging: false,
          telegraph: false, dodge: false, state: 'idle',
        },
      };
      this._states.set(ship, st);
    }
    return st;
  }

  _rand(world) {
    const rng = world ? world.rng : null;
    if (rng && typeof rng.next === 'function') { try { return clamp01(rng.next()); } catch (_) { /* fall through */ } }
    return clamp01(this._rngFallback());
  }

  _warn(key, msg) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    try { if (typeof console !== 'undefined' && console.warn) console.warn('[fleetai] ' + msg); } catch (_) { /* ignore */ }
  }

  // ─────────────────────────────────────────────────────────── context ──

  _spec(id, ship) {
    const fromConfig = (CONFIG && CONFIG.weapons && CONFIG.weapons[id]) ? CONFIG.weapons[id] : null;
    if (fromConfig) return fromConfig;
    const ws = ship && ship.weaponState ? ship.weaponState[id] : null;
    return (ws && ws.spec) || null;
  }

  /** Longest non-PD, non-WMG weapon range on this hull (the WMG must not set
   *  the standoff distance or a Desler would snipe from 10 km all day). */
  _shipMaxRange(ship) {
    let m = 0;
    const ids = Array.isArray(ship.weaponIds) ? ship.weaponIds : [];
    for (const id of ids) {
      const spec = this._spec(id, ship);
      if (!spec) continue;
      if (spec.kind === 'pd' || spec.kind === 'wmgun') continue;
      if (Number.isFinite(spec.range) && spec.range > m) m = spec.range;
    }
    if (m > 0) return m;
    return num(CONFIG?.weapons?.shock_cannon?.range, 2000);
  }

  _engageRange(ship) {
    return this._shipMaxRange(ship) * this.d.preferredRangeFactor;
  }

  _shipLength(ship) {
    const l = num(ship?.def?.lengthM, num(ship?.stats?.collisionRadius ? ship.stats.collisionRadius * 3 : null, 200));
    return Math.max(20, l);
  }

  _centroid(list, out) {
    const arr = Array.isArray(list) ? list : this.ships;
    let n = 0, x = 0, y = 0, z = 0;
    for (const s of arr) {
      if (!s || s.alive === false || !hasVec(s.position)) continue;
      x += s.position.x; y += s.position.y; z += s.position.z; n++;
    }
    if (!n) {
      const first = arr.find((s) => s && hasVec(s.position));
      out.x = first ? first.position.x : 0;
      out.y = first ? first.position.y : 0;
      out.z = first ? first.position.z : 0;
      return out;
    }
    out.x = x / n; out.y = y / n; out.z = z / n;
    return out;
  }

  _context(w, dt, roster) {
    const ai = (CONFIG && CONFIG.ai && typeof CONFIG.ai === 'object') ? CONFIG.ai : {};
    const player = (w.player && typeof w.player === 'object') ? w.player : null;
    const allShips = Array.isArray(w.ships) ? w.ships : this.ships;
    const mine = Array.isArray(roster) ? roster : this.ships;

    const hostile = !!(player && typeof player.faction === 'string' && player.faction !== this.faction);
    const centroid = this._centroid(mine, { x: 0, y: 0, z: 0 });

    // Fleet engagement range = mean of the members' preferred ranges.
    let sum = 0, n = 0;
    for (const s of mine) {
      if (!s || s.alive === false) continue;
      sum += this._engageRange(s); n++;
    }
    const engageRange = n ? sum / n : num(CONFIG?.weapons?.shock_cannon?.range, 2000) * this.d.preferredRangeFactor;

    // Formation anchor + frame.
    const anchor = { x: centroid.x, y: centroid.y, z: centroid.z };
    const frame = { fx: 0, fy: 0, fz: -1, rx: 1, ry: 0, rz: 0 };
    const playerAlive = !!(player && player.alive !== false && hasVec(player.position));

    if (playerAlive && !hostile) {
      // Escort: hold station ahead/abeam of the player, using the player's frame.
      const pf = rotate(player.quaternion, 0, 0, -1, this._v);
      const pr = rotate(player.quaternion, 1, 0, 0, this._v2);
      frame.fx = pf.x; frame.fz = pf.z; frame.rx = pr.x; frame.rz = pr.z;
      anchor.x = player.position.x + pf.x * 320;
      anchor.y = player.position.y;
      anchor.z = player.position.z + pf.z * 320;
    } else if (playerAlive) {
      // Hostile: form up on the standoff ring around the player, on the side we
      // are already approaching from.
      let dx = centroid.x - player.position.x;
      let dz = centroid.z - player.position.z;
      let len = Math.hypot(dx, dz);
      if (len < 1e-3) {
        const pf = rotate(player.quaternion, 0, 0, -1, this._v);
        dx = -pf.x; dz = -pf.z; len = Math.hypot(dx, dz) || 1;
      }
      dx /= len; dz /= len;
      const standoff = Math.max(120, engageRange * 0.95);
      anchor.x = player.position.x + dx * standoff;
      anchor.y = player.position.y;
      anchor.z = player.position.z + dz * standoff;
      // Attack axis points from the fleet back toward the player.
      frame.fx = -dx; frame.fz = -dz;
      frame.rx = -frame.fz; frame.rz = frame.fx;
    } else {
      const first = mine.find((s) => s && hasVec(s.position));
      const f = rotate(first ? first.quaternion : null, 0, 0, -1, this._v);
      frame.fx = f.x; frame.fz = f.z;
      frame.rx = -f.z; frame.rz = f.x;
    }

    return {
      w, dt, player, playerAlive, hostile, allShips, roster: mine, centroid, engageRange,
      anchor, frame,
      priority: Object.assign({}, DEFAULT_PRIORITY, (ai.targetPriority && typeof ai.targetPriority === 'object') ? ai.targetPriority : {}),
      playerPriority: num((ai.targetPriority && ai.targetPriority.player), DEFAULT_PRIORITY.player),
      roleValue: Object.assign({}, DEFAULT_ROLE_VALUE, (ai.roleValue && typeof ai.roleValue === 'object') ? ai.roleValue : {}),
      threatRange: num(ai.threatRange, num(ai.wmgunMaxRange, 4000)),
      formationTolerance: num(ai.formationTolerance, 320),
      collisionAvoid: num(ai.collisionAvoid, 260),
      ai,
    };
  }

  // ──────────────────────────────────────────────────────── formations ──

  /**
   * Formation slots in the fleet frame (x = abeam, y = up, z = toward the enemy).
   * `formationSlotCount` caps a row; extra ships fall into a second rank behind.
   */
  _formationOffsets(n, spacing) {
    const out = [];
    const perRow = Math.max(1, Math.floor(num(this.d.formationSlotCount, 6)));
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const cols = Math.min(perRow, n - row * perRow);
      const k = col - (cols - 1) / 2;
      let ox = k * spacing;
      let oy = 0;
      let oz = -row * spacing * 0.9;
      if (this.pattern === 'wedge') {
        oz += -Math.abs(k) * spacing * 0.55;
      } else if (this.pattern === 'echelon') {
        oz += -col * spacing * 0.35;
        oy = (i % 2 ? 1 : -1) * spacing * 0.28;
      } else if (this.pattern === 'abreast') {
        oz += (i % 2 ? 1 : -1) * spacing * 0.18;
      } else {
        oz += -Math.abs(k) * spacing * 0.3;
      }
      out.push({ x: ox, y: oy, z: oz });
    }
    return out;
  }

  _assignSlots(ctx) {
    const alive = ctx.roster;
    const n = alive.length;
    if (n !== this._slotCount) {
      this._slotCount = n;
      this._slotsDirty = true;
    }
    if (this._slotsDirty) {
      // Slot indices are stable per ship id, not per array position.
      const ordered = alive.slice().sort((a, b) => num(a.id, 0) - num(b.id, 0));
      for (let i = 0; i < ordered.length; i++) {
        const st = this._state(ordered[i]);
        st.slotIndex = i;
        try { ordered[i].formationSlot = i; } catch (_) { /* ignore */ }
      }
      this._slotsDirty = false;
    }

    const frame = ctx.frame;
    for (let i = 0; i < n; i++) {
      const ship = alive[i];
      const st = this._state(ship);
      const spacing = this._shipLength(ship) * Math.max(0.5, this.d.formationSlotRadius);
      const offsets = this._formationOffsets(n, spacing);
      const off = offsets[clamp(st.slotIndex, 0, n - 1)] || { x: 0, y: 0, z: 0 };
      const a = ctx.anchor;
      st.slotPos.x = a.x + frame.rx * off.x + frame.fx * off.z;
      st.slotPos.y = a.y + off.y;
      st.slotPos.z = a.z + frame.rz * off.x + frame.fz * off.z;
    }
  }

  // ──────────────────────────────────────────────────────── targeting ──

  _candidates(ship, ctx) {
    const out = [];
    const list = Array.isArray(ctx.allShips) ? ctx.allShips : [];
    for (const c of list) {
      if (!c || c === ship || c.alive === false) continue;
      if (c.faction === ship.faction) continue;
      if (!hasVec(c.position)) continue;
      out.push(c);
    }
    return out;
  }

  _score(ship, candidate, st, ctx) {
    if (!hasVec(ship.position) || !hasVec(candidate.position)) return -Infinity;
    const P = ctx.priority;
    const d = dist(ship.position, candidate.position);
    const prox = clamp01(1 - d / Math.max(1, ctx.threatRange));
    const role = num(ctx.roleValue[candidate.role], 0.5);

    let threat = clamp01(num(candidate.threat, 0) * 0.5 + num(candidate.damageDealt, 0) / 20000);
    if (candidate.target === ship) threat = clamp01(threat + 0.5);
    // Something already shooting at the fleet is the nearest real threat.
    if (candidate.target && candidate.target.faction === ship.faction) threat = clamp01(threat + 0.2);

    let score = P.threat * threat + P.role * role + P.proximity * prox;
    if (candidate === this._focusTarget) score += this.d.focusFire * 0.35;
    if (candidate === st.target) score += 0.25;               // hysteresis
    // The player is the scenario's focus: enemies press the Yamato rather than
    // chase escorts. An escort that is actively shooting still scores, it just
    // does not outrank the player. Weight lives in CONFIG.ai.targetPriority.player.
    if (candidate.isPlayer) score += num(ctx.playerPriority, DEFAULT_PRIORITY.player);
    return score;
  }

  _pickTarget(ship, st, ctx, world) {
    const cands = this._candidates(ship, ctx);
    if (!cands.length) return null;
    let best = null, bestScore = -Infinity;
    for (const c of cands) {
      const s = this._score(ship, c, st, ctx);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    // Focus fire: with doctrine probability, join the fleet's focus target.
    if (this._focusTarget && this._focusTarget !== best
      && this._focusTarget.alive !== false && this._focusTarget.faction !== ship.faction
      && this._rand(world) < this.d.focusFire) {
      return this._focusTarget;
    }
    return best;
  }

  _bestTarget(ctx) {
    let best = null, bestScore = -Infinity;
    for (const ship of ctx.roster) {
      if (!ship || ship.alive === false || ship.isPlayer || !hasVec(ship.position)) continue;
      for (const c of this._candidates(ship, ctx)) {
        const s = this._score(ship, c, { target: null }, ctx);
        if (s > bestScore) { bestScore = s; best = c; }
      }
    }
    return best;
  }

  _updateFocus(ctx, dt) {
    this._focusTimer -= dt;
    if (this._focusTimer > 0 && this._focusTarget && this._focusTarget.alive !== false) return;
    this._focusTimer = Math.max(0.5, this.d.switchCooldown);
    this._focusTarget = this._bestTarget(ctx);
  }

  // ─────────────────────────────────────────────────────── per ship ──

  _updateShip(ship, st, ctx, dt, world) {
    if (!ship.controls || typeof ship.controls !== 'object') {
      this._warn('controls', 'ship has no controls bag — skipping AI for it');
      return;
    }
    if (!hasVec(ship.position)) return;

    // 1) target selection / retention
    st.targetTimer -= dt;
    if (!st.target || st.target.alive === false || !hasVec(st.target.position) || st.targetTimer <= 0) {
      const next = this._pickTarget(ship, st, ctx, world);
      if (next !== st.target) { st.acquire = 0; st.sideFor = null; }
      st.target = next;
      st.targetTimer = Math.max(0.4, this.d.switchCooldown * (0.6 + 0.8 * this._rand(world)));
    }
    // Publish the choice to the documented SPEC §6.3 field: the weapon system
    // (canFire), the HUD target panel and Tab-cycling all read `ship.target`.
    // Without this the fleet fires blind — measured at a 1.5% hit rate.
    if (ship.target !== st.target) {
      try { ship.target = st.target; } catch (_) { /* ignore */ }
    }
    st.acquire += dt;

    // 2) dodge a charging wave motion gun
    this._updateDodge(ship, st, ctx, dt, world);

    // 3) flight
    this._steer(ship, st, ctx, dt, world);

    // 4) weapons
    this._updateWeapons(ship, st, ctx, dt, world);

    // 5) debug bag
    this._publish(ship, st, ctx);
  }

  _updateDodge(ship, st, ctx, dt, world) {
    st.dodge = Math.max(0, st.dodge - dt);
    if (!ctx.hostile) { st.dodgedForCharge = false; return; }
    const pws = ctx.player && ctx.player.weaponState ? ctx.player.weaponState.wmgun : null;
    const charging = !!(pws && (pws.charging === true || num(pws.chargeRatio, 0) > 0.25));
    if (!charging) { st.dodgedForCharge = false; return; }
    if (st.dodgedForCharge) return;
    st.dodgedForCharge = true;
    if (this._rand(world) < this.d.dodgeWMGChance) {
      st.dodge = 3.2;
      // Break laterally: perpendicular to the line of sight to the player.
      const px = ctx.player.position.x - ship.position.x;
      const pz = ctx.player.position.z - ship.position.z;
      const len = Math.hypot(px, pz) || 1;
      const side = this._sideFor(ship, st, ctx.player);
      st.dodgeDir = { x: (-pz / len) * side, y: 0.15 * side, z: (px / len) * side };
    }
  }

  _sideFor(ship, st, target) {
    if (st.side && st.sideFor === target) return st.side;
    st.sideFor = target;
    if (!target || !hasVec(target.position) || !hasVec(ship.position)) { st.side = 1; return 1; }
    const f = rotate(ship.quaternion, 0, 0, -1, this._v);
    const dx = target.position.x - ship.position.x;
    const dz = target.position.z - ship.position.z;
    const len = Math.hypot(dx, dz) || 1;
    const rx = -dz / len, rz = dx / len;               // starboard beam
    st.side = (f.x * rx + f.z * rz) >= 0 ? 1 : -1;     // turn the short way
    return st.side;
  }

  /** Aim point that leads a moving target; falls back to a local solve. */
  _aimPoint(ship, target, spec, ctx, dispersion) {
    const out = { x: target.position.x, y: target.position.y, z: target.position.z };
    const speed = spec && Number.isFinite(spec.speed) ? spec.speed : 3000;

    let solved = false;
    if (typeof ship.aimPointAt === 'function') {
      try {
        const p = ship.aimPointAt(target, speed);
        if (hasVec(p)) { out.x = p.x; out.y = p.y; out.z = p.z; solved = true; }
      } catch (err) {
        this._warn('aimPointAt', 'ship.aimPointAt threw (' + (err && err.message ? err.message : err) + ') — using local lead solve');
      }
    }
    if (!solved) {
      const rel = {
        x: target.position.x - ship.position.x,
        y: target.position.y - ship.position.y,
        z: target.position.z - ship.position.z,
      };
      const vel = hasVec(target.velocity) ? target.velocity : { x: 0, y: 0, z: 0 };
      let lead = 0;
      try { lead = Math.min(interceptTime(rel, vel, speed) ?? 0, 8); } catch (_) { lead = 0; }
      out.x += vel.x * lead; out.y += vel.y * lead; out.z += vel.z * lead;
    }

    // Doctrine accuracy → aim error, scaled by the target's size.
    if (dispersion) {
      const miss = (1 - clamp01(this.d.accuracy)) * dispersion;
      if (miss > 0) {
        out.x += this._jitter(ctx.w, miss);
        out.y += this._jitter(ctx.w, miss * 0.6);
        out.z += this._jitter(ctx.w, miss);
      }
    }
    return out;
  }

  _jitter(world, amount) {
    const rng = world ? world.rng : null;
    if (rng && typeof rng.jitter === 'function') { try { return rng.jitter(amount); } catch (_) { /* fall through */ } }
    return (this._rngFallback() * 2 - 1) * amount;
  }

  _angleTo(ship, point) {
    const f = rotate(ship.quaternion, 0, 0, -1, this._v);
    const dx = point.x - ship.position.x;
    const dy = point.y - ship.position.y;
    const dz = point.z - ship.position.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return 0;
    const dot = clamp((dx * f.x + dy * f.y + dz * f.z) / len, -1, 1);
    return Math.acos(dot);
  }

  _inArc(ship, point, arcDeg) {
    const arc = num(arcDeg, 180);
    if (arc >= 180) return true;
    if (typeof ship.inFiringArc === 'function') {
      try { return !!ship.inFiringArc(point, arc); } catch (_) { /* fall through to local test */ }
    }
    return this._angleTo(ship, point) <= (arc * Math.PI) / 180;
  }

  _steerToward(ship, point, gain, maxYaw, maxPitch, level) {
    if (typeof ship.steerToward === 'function') {
      try {
        ship.steerToward(point, { gain, maxYaw, maxPitch, level });
        return true;
      } catch (err) {
        this._warn('steerToward', 'ship.steerToward threw (' + (err && err.message ? err.message : err) + ') — using local steering');
      }
    }
    // Local fallback: same maths as Ship.steerToward.
    const dx = point.x - ship.position.x;
    const dy = point.y - ship.position.y;
    const dz = point.z - ship.position.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return false;
    const local = rotateInv(ship.quaternion, dx / len, dy / len, dz / len, this._v2);
    const yaw = Math.atan2(-local.x, -local.z);
    const pitch = Math.asin(clamp(local.y, -1, 1));
    ship.controls.yaw = clamp(yaw * gain, -maxYaw, maxYaw);
    ship.controls.pitch = clamp(pitch * gain, -maxPitch, maxPitch);
    if (level > 0) this._levelRoll(ship, level);
    return true;
  }

  _steerBroadside(ship, point, side) {
    if (typeof ship.steerBroadside !== 'function' || this._broadsideBroken) return false;
    try {
      ship.steerBroadside(point, side, { gain: 1.7, maxYaw: 1, maxPitch: 0.8, level: 0.5 });
      return true;
    } catch (err) {
      // Warn once, then stop calling a helper that is broken in this build.
      this._broadsideBroken = true;
      this._warn('steerBroadside', 'ship.steerBroadside threw (' + (err && err.message ? err.message : err) + ') — using local beam heading from now on');
      return false;
    }
  }

  _levelRoll(ship, gain) {
    if (typeof ship.levelRoll === 'function') {
      try { ship.levelRoll(gain); return true; } catch (_) { /* fall through */ }
    }
    const up = rotateInv(ship.quaternion, 0, 1, 0, this._v3);
    const roll = Math.atan2(up.x, up.y);
    ship.controls.roll = clamp(-roll * gain, -1, 1);
    return true;
  }

  /** Repulsion vector away from nearby hulls, or null. */
  _avoidance(ship, ctx) {
    const list = Array.isArray(ctx.allShips) ? ctx.allShips : this.ships;
    const base = ctx.collisionAvoid;
    let ax = 0, ay = 0, az = 0, n = 0;
    for (const other of list) {
      if (!other || other === ship || other.alive === false || !hasVec(other.position)) continue;
      const dx = ship.position.x - other.position.x;
      const dy = ship.position.y - other.position.y;
      const dz = ship.position.z - other.position.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const r = base + num(other.radius, num(ship.radius, 40));
      if (d2 > r * r || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const wgt = 1 - d / r;
      ax += (dx / d) * wgt; ay += (dy / d) * wgt; az += (dz / d) * wgt;
      n++;
    }
    if (!n) return null;
    const len = Math.hypot(ax, ay, az);
    if (len < 1e-5) return null;
    return { x: ax / len, y: ay / len, z: az / len };
  }

  _steer(ship, st, ctx, dt, world) {
    const controls = ship.controls;
    const pos = ship.position;
    if (!hasVec(pos)) return;

    const target = st.target;
    const slot = st.slotPos;
    const engage = this._engageRange(ship);
    const d = (target && hasVec(target.position)) ? dist(pos, target.position) : Infinity;

    let facePoint = null;
    let throttle = 0.5;
    let boost = false;
    let brake = false;
    let usedBroadside = false;

    // A wave motion gun only bears inside a ~3° cone, so a WMG run overrides
    // the broadside doctrine: the ship turns its bow on and holds the band.
    const wm = this._wmgunOf(ship);
    const wmgunWants = !!wm && (!!st.wmgun || this._wmgunReady(ship, st, wm, ctx));

    if (st.dodge > 0 && st.dodgeDir) {
      // Break formation and run perpendicular — survival over station keeping.
      facePoint = { x: pos.x + st.dodgeDir.x * 1500, y: pos.y + st.dodgeDir.y * 1500, z: pos.z + st.dodgeDir.z * 1500 };
      throttle = 1;
      boost = true;
    } else if (!target) {
      facePoint = slot;
      throttle = 0.45;
    } else if (d > engage * 1.15) {
      // Close the distance, nose on.
      facePoint = this._aimPoint(ship, target, this._spec(this._primaryWeaponId(ship), ship), ctx, 0);
      throttle = 1;
      boost = d > engage * 1.8;
    } else if (wmgunWants) {
      // Wave motion gun run: bow onto the target, hold the band.
      facePoint = this._aimPoint(ship, target, wm ? wm.spec : null, ctx, 0);
      throttle = d < engage * 0.55 ? -0.25 : 0.35;
    } else if (d < engage * 0.55) {
      // Too close — back off toward the standoff ring.
      facePoint = slot;
      throttle = -0.3;
      brake = true;
    } else {
      // On station: present the broadside, blended by doctrine.
      const bias = clamp01(this.d.broadsideBias);
      const side = this._sideFor(ship, st, target);
      if (bias >= 0.6) usedBroadside = this._steerBroadside(ship, target.position, side);
      if (!usedBroadside) {
        const aim = this._aimPoint(ship, target, null, ctx, 0);
        const dx = target.position.x - pos.x;
        const dz = target.position.z - pos.z;
        const len = Math.hypot(dx, dz) || 1;
        const beam = { x: pos.x + (-dz / len) * side * 1200, y: pos.y, z: pos.z + (dx / len) * side * 1200 };
        facePoint = lerpPoint(aim, beam, bias, { x: 0, y: 0, z: 0 });
      }
      throttle = 0.4;
    }

    // Station keeping: never drift far from the slot.
    const slotErr = hasVec(slot) ? dist(pos, slot) : 0;
    const tol = ctx.formationTolerance;
    if (slotErr > tol) {
      throttle += 0.35;
      if (facePoint && !usedBroadside) facePoint = lerpPoint(facePoint, slot, 0.35, { x: 0, y: 0, z: 0 });
      else if (!facePoint && !usedBroadside) facePoint = slot;
    } else if (slotErr < tol * 0.25) {
      throttle -= 0.1;
    }

    // Collision avoidance: bend the desired heading away from close hulls.
    const avoid = this._avoidance(ship, ctx);
    if (avoid) {
      const dir = facePoint
        ? { x: facePoint.x - pos.x, y: facePoint.y - pos.y, z: facePoint.z - pos.z }
        : rotate(ship.quaternion, 0, 0, -1, { x: 0, y: 0, z: 0 });
      const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
      const bx = dir.x / dl + avoid.x * 1.6;
      const by = dir.y / dl + avoid.y * 1.6;
      const bz = dir.z / dl + avoid.z * 1.6;
      const bl = Math.hypot(bx, by, bz) || 1;
      facePoint = { x: pos.x + (bx / bl) * 1200, y: pos.y + (by / bl) * 1200, z: pos.z + (bz / bl) * 1200 };
      usedBroadside = false;
      throttle = Math.min(throttle, 0.6);
    }

    if (!usedBroadside && facePoint) {
      // A WMG run needs a tighter, faster track than formation flying.
      this._steerToward(ship, facePoint, wmgunWants ? 2.4 : 1.9, 1, 1, 0.45);
    }

    const waveSpeed = num(ship.waveSpeed, 1);
    controls.throttle = clamp(throttle * waveSpeed, -1, 1);
    controls.boost = !!boost;
    controls.brake = !!brake;
    if (!usedBroadside) this._levelRoll(ship, 1.1);
  }

  _primaryWeaponId(ship) {
    const ids = Array.isArray(ship.weaponIds) ? ship.weaponIds : [];
    let best = null, bestRange = -1;
    for (const id of ids) {
      const spec = this._spec(id, ship);
      if (!spec || spec.kind === 'pd' || spec.kind === 'wmgun') continue;
      if (num(spec.range, 0) > bestRange) { bestRange = num(spec.range, 0); best = id; }
    }
    return best || ids[0] || null;
  }

  /** Is the subsystem that feeds this weapon still alive? */
  _subsystemOk(ship, spec) {
    // CONFIG.weapons[*].subsystemKind is authoritative; `null` = no subsystem.
    const kind = (spec && Object.prototype.hasOwnProperty.call(spec, 'subsystemKind'))
      ? spec.subsystemKind
      : (spec && spec.mountPrefix ? PREFIX_KIND[spec.mountPrefix] : null);
    if (!kind) return true;
    if (typeof ship.hasWorkingSubsystem === 'function') {
      try { return !!ship.hasWorkingSubsystem(kind); } catch (_) { /* fall through */ }
    }
    if (!ship.subsystems) return true;
    const list = Object.values(ship.subsystems).filter((s) => s && s.kind === kind);
    if (!list.length) return true;
    return list.some((s) => !s.disabled);
  }

  /** The ship's wave motion gun, if it carries one. */
  _wmgunOf(ship) {
    const ids = Array.isArray(ship.weaponIds) ? ship.weaponIds : [];
    for (const id of ids) {
      const spec = this._spec(id, ship);
      if (spec && spec.kind === 'wmgun') return { id, spec };
    }
    return null;
  }

  /**
   * Range band in which the WMG is worth charging. CONFIG wins; otherwise the
   * gun is used from inside its range but not at knife-fighting distance.
   */
  _wmgunBand(ship, spec) {
    const range = num(spec.range, 0);
    const engage = this._engageRange(ship);
    const min = this.d.wmgunMinRange != null ? this.d.wmgunMinRange
      : Math.min(range * 0.25, Math.max(600, engage * 0.9));
    const max = this.d.wmgunMaxRange != null ? this.d.wmgunMaxRange : (range > 0 ? range : Infinity);
    return { min, max };
  }

  /** Should this ship turn its bow onto the target and start a WMG run? */
  _wmgunReady(ship, st, wm, ctx) {
    if (!wm || st.wmgunBlocked > 0) return false;
    const target = st.target;
    if (!target || !hasVec(target.position)) return false;
    if (st.acquire < this.d.reactionTime) return false;
    if (!this._subsystemOk(ship, wm.spec)) return false;
    const ws = ship.weaponState ? ship.weaponState[wm.id] : null;
    if (ws) {
      if (num(ws.cooldown, 0) > 0) return false;
      if (num(ws.chargeRatio, 0) > 0.02) return false;
      if (ws.ready === false) return false;
    }
    const band = this._wmgunBand(ship, wm.spec);
    const d = dist(ship.position, target.position);
    return d >= band.min && d <= band.max;
  }

  _fire(ship, id, world, target) {
    // main.js owns the weapon system: world.fireWeapon(ship, weaponId, target)
    // takes an explicit target, checks range/arc against it, and keeps
    // ship.target authoritative for the HUD and the player's Tab cycling.
    if (world && typeof world.fireWeapon === 'function') {
      try {
        const r = world.fireWeapon(ship, id, target || null);
        return r === undefined ? true : !!r;
      } catch (err) {
        this._warn('worldFireWeapon', 'world.fireWeapon threw (' + (err && err.message ? err.message : err) + ')');
      }
    }
    if (typeof ship.fireWeapon === 'function') {
      try {
        const r = ship.fireWeapon(id, world);
        return r === undefined ? true : !!r;
      } catch (err) {
        this._warn('fireWeapon', 'ship.fireWeapon threw (' + (err && err.message ? err.message : err) + ')');
      }
    }
    return false;
  }

  _updateWeapons(ship, st, ctx, dt, world) {
    const ids = Array.isArray(ship.weaponIds) ? ship.weaponIds : [];
    const target = st.target;

    for (const id of ids) {
      const spec = this._spec(id, ship);
      if (!spec) continue;
      const kind = spec.kind || '';

      if (kind === 'pd' || id === 'point_defense') continue;   // interception aura, not a fired weapon
      if (kind === 'wmgun') { this._updateWmgun(ship, st, spec, id, ctx, dt, world); continue; }

      if (!target || !hasVec(target.position)) continue;
      if (!this._subsystemOk(ship, spec)) continue;

      const ws = ship.weaponState ? ship.weaponState[id] : null;
      if (ws) {
        if (num(ws.cooldown, 0) > 0) continue;
        if (ws.ready === false) continue;
        if (ws.charging === true) continue;
      }

      const d = dist(ship.position, target.position);
      const range = num(spec.range, 0);
      if (!(range > 0) || d > range) continue;

      // Torpedo / missile fire discipline: a range band, not just "in range".
      if (kind === 'missile' || kind === 'torpedo') {
        const maxR = this.d.missileFireMaxRange != null ? this.d.missileFireMaxRange : range * this.d.torpedoRangeFactor;
        const minR = this.d.missileFireMinRange != null ? this.d.missileFireMinRange : 0;
        if (d > maxR || d < minR) continue;
      }

      // Reaction time before the first shot at a new target.
      if (st.acquire < this.d.reactionTime) continue;

      const dispersion = num(target.radius, 40) * 0.8;
      const aim = this._aimPoint(ship, target, spec, ctx, dispersion);
      if (!this._inArc(ship, aim, spec.arcDeg)) continue;

      // Small per-weapon gate; the real cadence is weaponState.cooldown.
      const key = 'f_' + id;
      st.timers[key] = num(st.timers[key], 0) - dt;
      if (st.timers[key] > 0) continue;
      st.timers[key] = 0.12;

      this._fire(ship, id, world, target);
    }
  }

  /**
   * Wave motion gun: telegraph → charge request → fire.
   * The HUD/audio warning is emitted the moment the telegraph starts so the
   * player gets a fair chance to dodge.
   */
  _updateWmgun(ship, st, spec, id, ctx, dt, world) {
    const ws = ship.weaponState ? ship.weaponState[id] : null;
    if (!this._subsystemOk(ship, spec)) { this._abortWmgun(ship, st); return; }

    // Back-off after a charge that never discharged (e.g. weapons.js refuses).
    if (st.wmgunBlocked > 0) { st.wmgunBlocked -= dt; this._abortWmgun(ship, st); return; }

    const target = st.target;
    if (!target || !hasVec(target.position)) { this._abortWmgun(ship, st); return; }

    const range = num(spec.range, 0);
    const band = this._wmgunBand(ship, spec);
    const minR = band.min;
    const maxR = band.max;
    const d = dist(ship.position, target.position);
    const inBand = d >= minR && d <= maxR;

    const aim = this._aimPoint(ship, target, spec, ctx, 0);
    // Starting the run needs the real (tight) firing arc; once charging, a
    // somewhat wider cone keeps the run alive through steering jitter.
    const arc = num(spec.arcDeg, 8);
    const aligned = this._inArc(ship, aim, arc);
    const holding = st.wmgun ? this._inArc(ship, aim, Math.max(arc * 2.5, 12)) : aligned;
    const offCooldown = !ws || num(ws.cooldown, 0) <= 0;

    if (!st.wmgun) {
      const idle = !ws || num(ws.chargeRatio, 0) < 0.02;
      if (inBand && aligned && offCooldown && idle && st.acquire >= this.d.reactionTime) {
        st.wmgun = { phase: 'telegraph', t: 0, id, retry: 0 };
        this._emitTelegraph(ship, target, ctx, world, id, spec);
      }
      return;
    }

    st.wmgun.t += dt;
    if (!inBand || !holding || !offCooldown) { this._abortWmgun(ship, st); return; }
    if (ws) { try { ws.charging = true; } catch (_) { /* weapons.js owns charge state */ } }

    if (st.wmgun.phase === 'telegraph') {
      if (st.wmgun.t >= this.d.wmgunTelegraphTime) { st.wmgun.phase = 'fire'; st.wmgun.t = 0; }
      return;
    }

    // phase 'fire': keep asking until the weapon actually discharges.
    st.wmgun.retry -= dt;
    if (st.wmgun.retry <= 0) {
      st.wmgun.retry = 0.2;
      if (this._fire(ship, id, world, target)) {
        st.wmgun = { phase: 'cooldown', t: 0, id, retry: 0 };
        return;
      }
    }
    if (st.wmgun.t > num(spec.chargeTime, 8) + 3) {
      // Never discharged (weapons.js refused the charge): back off for a while
      // instead of re-telegraphing forever.
      st.wmgunBlocked = Math.min(30, num(spec.cooldown, 30));
      this._abortWmgun(ship, st);
    }
  }

  _abortWmgun(ship, st) {
    if (!st.wmgun) return;
    st.wmgun = null;
    const ws = ship.weaponState ? ship.weaponState.wmgun : null;
    if (ws) { try { ws.charging = false; } catch (_) { /* ignore */ } }
  }

  _emitTelegraph(ship, target, ctx, world, id, spec) {
    const time = this.d.wmgunTelegraphTime;
    const payload = {
      ship, target, weaponId: id, time, faction: ship.faction,
      text: 'WAVE MOTION GUN CHARGING',
    };
    try { if (world && world.events && typeof world.events.emit === 'function') world.events.emit('wmgun_telegraph', payload); } catch (_) { /* ignore */ }
    try { if (world && world.events && typeof world.events.emit === 'function') world.events.emit('warning', payload); } catch (_) { /* ignore */ }
    try { if (world && world.hud && typeof world.hud.pushEvent === 'function') world.hud.pushEvent({ type: 'warning', text: payload.text, duration: time }); } catch (_) { /* ignore */ }
    try { if (world && world.audio && typeof world.audio.play === 'function') world.audio.play('wmgun_charge', { position: ship.position, duration: time }); } catch (_) { /* ignore */ }
  }

  _publish(ship, st, ctx) {
    const dbg = st.debug;
    dbg.doctrine = this.doctrineName;
    dbg.faction = this.faction;
    dbg.target = st.target || null;
    dbg.slot = st.slotPos;
    dbg.slotIndex = st.slotIndex;
    dbg.throttle = ship.controls ? ship.controls.throttle : 0;
    dbg.charging = !!st.wmgun;
    dbg.telegraph = !!(st.wmgun && st.wmgun.phase === 'telegraph');
    dbg.dodge = st.dodge > 0;
    dbg.state = st.dodge > 0 ? 'evading'
      : (st.wmgun ? 'charging' : (st.target ? 'engaging' : 'forming'));
    ship.aiControl = dbg;
    try { ship.aiState = dbg.state; } catch (_) { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────────── spawnWave ──

/** Resolve a wave definition from CONFIG.waves (by index, never by id). */
function waveEntryFor(waveIndex) {
  const waves = (CONFIG && Array.isArray(CONFIG.waves)) ? CONFIG.waves : null;
  if (!waves || !waves.length) return null;
  for (const w of waves) if (w && num(w.index, NaN) === waveIndex) return w;
  return waves[waveIndex] || null;
}

/** Normalise a wave entry into [{ list, faction }] groups. */
function waveGroups(entry) {
  const groups = [];
  if (Array.isArray(entry.allies)) groups.push({ list: entry.allies, faction: 'uncf' });
  if (Array.isArray(entry.enemies)) groups.push({ list: entry.enemies, faction: null });
  if (!groups.length && Array.isArray(entry.ships)) groups.push({ list: entry.ships, faction: entry.faction || null });
  return groups;
}

function attachFleet(world, faction, ships, doctrine) {
  if (!world || !ships.length) return null;
  const fleets = world.fleets;
  let existing = null;
  if (fleets && typeof fleets.get === 'function') existing = fleets.get(faction) || null;
  else if (Array.isArray(fleets)) existing = fleets.find((f) => f && f.faction === faction) || null;
  if (existing && Array.isArray(existing.ships)) {
    existing.addShips ? existing.addShips(ships) : existing.ships.push(...ships);
    return existing;
  }
  const ai = new FleetAI({ faction, ships, world, doctrine });
  if (typeof world.registerFleet === 'function') {
    try { world.registerFleet(ai); return ai; } catch (_) { /* fall through */ }
  }
  if (fleets && typeof fleets.set === 'function') { try { fleets.set(faction, ai); return ai; } catch (_) { /* ignore */ } }
  if (Array.isArray(fleets)) { try { fleets.push(ai); return ai; } catch (_) { /* ignore */ } }
  return ai;
}

/**
 * Spawn one wave from CONFIG.waves.
 *
 * Requires `world.spawnShip({def, faction, isPlayer, spawn:{position,
 * quaternion}, callsign, stats})` (or `world.createShip`), and `world.models`
 * (Map|object of id → ShipModel) to resolve `def`. Ships are placed on the
 * given bearing/range relative to the player and turned to face them.
 *
 * @returns {Ship[]} the ships that were actually created
 */
export function spawnWave(waveIndex, world) {
  const out = [];
  const w = (world && typeof world === 'object') ? world : null;
  if (!w) return out;

  const entry = waveEntryFor(num(waveIndex, 0));
  if (!entry) {
    try { if (console && console.warn) console.warn('[fleetai] no CONFIG.waves entry for wave ' + waveIndex); } catch (_) { /* ignore */ }
    return out;
  }

  const spawnFn = (typeof w.spawnShip === 'function') ? w.spawnShip
    : ((typeof w.createShip === 'function') ? w.createShip : null);
  if (!spawnFn) {
    try { if (console && console.warn) console.warn('[fleetai] world.spawnShip() is required by spawnWave()'); } catch (_) { /* ignore */ }
    return out;
  }

  const player = w.player && hasVec(w.player.position) ? w.player : null;
  const origin = player ? player.position : { x: 0, y: 0, z: 0 };
  const fwd = rotate(player ? player.quaternion : null, 0, 0, -1, { x: 0, y: 0, z: -1 });
  const right = rotate(player ? player.quaternion : null, 1, 0, 0, { x: 1, y: 0, z: 0 });
  const rand = () => (w.rng && typeof w.rng.next === 'function' ? w.rng.next() : Math.random());

  const groups = waveGroups(entry);
  for (const group of groups) {
    for (const spec of group.list) {
      if (!spec) continue;
      const id = spec.id || spec.model || spec.shipId;
      if (!id) continue;
      const def = modelDefFor(w, id);
      if (!def) {
        try { if (console && console.warn) console.warn('[fleetai] no model for "' + id + '" in world.models — skipping'); } catch (_) { /* ignore */ }
        continue;
      }
      const count = Math.max(1, Math.floor(num(spec.count, 1)));
      const bearings = Array.isArray(spec.bearingDeg) && spec.bearingDeg.length ? spec.bearingDeg : [0];
      const range = num(spec.range, 3000);
      const faction = spec.faction || group.faction || def.faction || 'garmillas';
      const baseCallsign = (CONFIG && CONFIG.ships && CONFIG.ships[id] && CONFIG.ships[id].callsign) || def.callsign || id;

      for (let i = 0; i < count; i++) {
        const bearing = (num(bearings[i % bearings.length], 0) * Math.PI) / 180;
        const r = range * (1 + (rand() - 0.5) * 0.06);
        const px = origin.x + fwd.x * Math.cos(bearing) * r + right.x * Math.sin(bearing) * r;
        const py = origin.y + (rand() - 0.5) * Math.max(60, range * 0.04);
        const pz = origin.z + fwd.z * Math.cos(bearing) * r + right.z * Math.sin(bearing) * r;

        // Face the player: yaw-only, bow along -Z.
        const dx = origin.x - px, dz = origin.z - pz;
        const yaw = Math.atan2(-dx, -dz);
        const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

        const spawn = {
          position: new THREE.Vector3(px, py, pz),
          quaternion,
          throttle: num(spec.speed, 1) * 0.5,
        };
        const callsign = count > 1 ? baseCallsign + '-' + (i + 1) : baseCallsign;

        let ship = null;
        try {
          // `speed` is main.js's documented spawn throttle; waveSpeed is our own
          // per-wave multiplier applied on top of the AI's throttle commands.
          ship = spawnFn.call(w, { def, faction, isPlayer: false, spawn, callsign, speed: num(spec.speed, 0.75) });
        } catch (err) {
          try { if (console && console.warn) console.warn('[fleetai] spawnShip failed for ' + id + ': ' + (err && err.message ? err.message : err)); } catch (_) { /* ignore */ }
        }
        if (!ship) continue;
        try { ship.waveSpeed = num(spec.speed, 1); } catch (_) { /* ignore */ }
        out.push(ship);
      }
    }
  }

  // Attach one FleetAI per faction present in this wave.
  const byFaction = new Map();
  for (const s of out) {
    const f = (typeof s.faction === 'string' && s.faction) ? s.faction : 'neutral';
    if (!byFaction.has(f)) byFaction.set(f, []);
    byFaction.get(f).push(s);
  }
  for (const [faction, list] of byFaction) {
    const doctrine = (CONFIG && CONFIG.ships && CONFIG.ships[list[0]?.def?.id]?.aiDoctrine) || faction;
    attachFleet(w, faction, list, doctrine);
  }

  // Announce the wave.
  const payload = {
    index: num(entry.index, num(waveIndex, 0)),
    name: entry.name || '',
    banner: entry.banner || entry.name || ('WAVE ' + (num(waveIndex, 0) + 1)),
    allies: Array.isArray(entry.allies) ? entry.allies : [],
    enemies: Array.isArray(entry.enemies) ? entry.enemies : [],
    spawned: out.length,
  };
  // SPEC §6.7: spawnWave() returns the spawned ships. The orchestrator
  // (main.js startWave) owns wave announcements, so we deliberately do NOT emit
  // a 'wave' event here — that produced doubled banners and klaxons. A world
  // with no event bus (standalone/test harness) still gets a direct nudge.
  const hasBus = !!(w.events && typeof w.events.emit === 'function');
  if (!hasBus) {
    if (w.hud && typeof w.hud.pushEvent === 'function') {
      try { w.hud.pushEvent(Object.assign({ type: 'wave' }, payload)); } catch (_) { /* ignore */ }
    }
    try { if (w.audio && typeof w.audio.play === 'function') w.audio.play('alarm', { volume: 0.6 }); } catch (_) { /* ignore */ }
  }

  return out;
}

export default FleetAI;
