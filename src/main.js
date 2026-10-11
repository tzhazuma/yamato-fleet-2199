/**
 * src/main.js — bootstrap, simulation loop, player control and wave flow.
 *
 * Owns the `world` object described in SPEC §6.3 and is the only place that
 * wires the modules together. Teammate-owned modules (HUD, radar, audio, fleet
 * AI) are imported *optionally* so a missing file degrades to a safe fallback
 * instead of a white screen.
 */

import * as THREE from 'three';
import { CONFIG } from './core/config.js';
import { Rng } from './core/rng.js';
import { Input } from './core/input.js';
import { SceneManager, CameraRig } from './core/scene.js';
import { loadManifest, loadShipModel, getModelDef } from './core/assets.js';
import { Ship } from './entities/ship.js';
import { ProjectileSystem } from './entities/projectile.js';
import { Effects } from './entities/effects.js';
import {
  fireWeapon, updateWeaponMounts, updatePointDefence, beginCharge, abortCharge,
} from './weapons/weapons.js';
import { clamp, formatDistance } from './core/math.js';

const FWD = new THREE.Vector3(0, 0, -1);
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

/* -------------------------------------------------------------------------- */
/* Tiny event bus                                                             */
/* -------------------------------------------------------------------------- */

class EventBus {
  constructor() { this._handlers = new Map(); }
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) { this._handlers.get(type)?.delete(fn); }
  emit(type, payload) {
    const set = this._handlers.get(type);
    if (set) {
      for (const fn of set) {
        try { fn(payload); } catch (err) { console.warn(`[events] handler for "${type}" threw`, err); }
      }
    }
    const any = this._handlers.get('*');
    if (any) for (const fn of any) { try { fn({ type, payload }); } catch { /* ignore */ } }
    if (CONFIG.debug.logEvents) console.debug('[event]', type, payload);
  }
}

/* -------------------------------------------------------------------------- */
/* Optional teammate modules                                                  */
/* -------------------------------------------------------------------------- */

async function optionalImport(path) {
  try {
    return await import(path);
  } catch (err) {
    console.warn(`[main] optional module ${path} unavailable — using fallback (${err.message})`);
    return null;
  }
}

/** No-op HUD so the demo runs before src/ui/hud.js exists. */
class NullHud {
  constructor() {}
  update() {}
  pushEvent() {}
  dispose() {}
}

/** No-op radar. */
class NullRadar {
  constructor() {}
  update() {}
  dispose() {}
}

/** No-op audio. */
class NullAudio {
  constructor() {}
  async resume() {}
  play() {}
  setMasterVolume() {}
  startEngineLoop() {}
  stopEngineLoop() {}
  update() {}
}

/**
 * Minimal fallback fleet AI, used only when src/ai/fleetai.js is unavailable.
 * Keeps ships closing to their preferred range and shooting — enough to make
 * the demo playable, deliberately dumber than the real module.
 */
function makeFallbackAI(world) {
  return {
    update(dt) {
      for (const ship of world.ships) {
        if (!ship.alive || ship.isPlayer) continue;
        if (!ship.target || !ship.target.alive) {
          ship.target = nearestEnemy(world, ship);
        }
        const tgt = ship.target;
        if (!tgt) { ship.controls.throttle = 0; continue; }

        const dist = ship.position.distanceTo(tgt.position);
        const longest = longestRange(ship);
        const want = longest * 0.8;

        const aim = ship.aimPointAt(tgt, 1200);
        ship.steerToward(aim, { gain: 1.6, level: 0.8 });
        ship.controls.throttle = dist > want ? 1 : dist < want * 0.7 ? -0.4 : 0.15;

        if (dist < longest * 0.95 && ship.inFiringArc(tgt.position, 60)) {
          for (const wid of ship.weaponIds) {
            if (wid === 'wmgun') continue;
            world.fireWeapon(ship, wid);
          }
        }
      }
    },
  };
}

function longestRange(ship) {
  let max = 0;
  for (const wid of ship.weaponIds) {
    const r = CONFIG.weapons[wid]?.range ?? 0;
    if (r > max && wid !== 'wmgun') max = r;
  }
  return max || 1800;
}

function nearestEnemy(world, ship) {
  let best = null, bestD = Infinity;
  for (const other of world.ships) {
    if (!other.alive || other === ship || other.faction === ship.faction) continue;
    const d = ship.position.distanceTo(other.position);
    if (d < bestD) { bestD = d; best = other; }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

const bootEl = document.getElementById('boot');
const bootBar = document.getElementById('boot-progress');
const bootStatus = document.getElementById('boot-status');

function progress(pct, text) {
  if (bootBar) bootBar.style.width = `${clamp(pct, 0, 100)}%`;
  if (bootStatus && text) bootStatus.textContent = text;
}

let world = null;

export async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.has('debug')) {
    CONFIG.debug.showColliders = true;
    CONFIG.debug.logEvents = params.get('debug') === 'verbose';
    CONFIG.debug.fastCharge = true;
  }

  progress(4, '初期化 / initialising renderer…');
  const canvas = document.getElementById('game');
  if (!canvas) throw new Error('#game canvas is missing from index.html');

  const sm = new SceneManager(canvas);
  const rig = new CameraRig(sm);
  const effects = new Effects(sm.scene);
  const projectiles = new ProjectileSystem(sm.scene);
  const events = new EventBus();
  const rng = new Rng(0x2199);

  progress(14, 'モデル読み込み / loading fleet manifest…');
  let manifest;
  let usedFallbackManifest = false;
  try {
    manifest = await loadManifest();
  } catch (err) {
    // Never white-screen on a missing/!regenerated asset: synthesise the fleet
    // description from CONFIG and let assets.js use placeholder geometry.
    console.warn('[main] manifest unavailable — using CONFIG-derived fallback:', err.message);
    const fb = await import('./core/fallback_manifest.js');
    manifest = fb.buildFallbackManifest();
    usedFallbackManifest = true;
  }
  progress(22, `艦船モデル ${manifest.models.length} 隻 / loading ship models…`);

  const models = new Map();
  let done = 0;
  for (const def of manifest.models) {
    try {
      models.set(def.id, await loadShipModel(def));
    } catch (err) {
      console.error(`[main] failed to load model "${def.id}"`, err);
    }
    done++;
    progress(22 + (done / manifest.models.length) * 46, `モデル ${done}/${manifest.models.length} — ${def.displayName || def.id}`);
  }
  if (models.size === 0) throw new Error('no ship models could be loaded');

  progress(72, '世界構築 / building battle space…');

  /* ---- world ------------------------------------------------------------ */
  const fleets = { uncf: [], garmillas: [], bolar: [], neutral: [] };

  world = {
    scene: sm.scene,
    renderer: sm.renderer,
    camera: sm.camera,
    sceneManager: sm,
    rig,
    effects,
    projectiles,
    events,
    rng,
    models,
    manifest,
    fleets,
    ships: [],
    player: null,
    time: 0,
    dt: 0,
    state: 'boot',            // boot | playing | paused | victory | defeat
    fireMode: CONFIG.fireModes?.default ?? 'manual',   // 'manual' | 'auto'
    firingSolution: null,     // per-frame aim/arc/range state for the HUD
    aimWeaponId: 'shock_cannon',   // which weapon's arc the HUD draws
    waveIndex: -1,
    waveTimer: 0,
    pendingWave: null,
    hud: null,
    radar: null,
    audio: null,
    ai: null,
    stats: { kills: 0, losses: 0, shotsFired: 0, startedAt: 0, elapsed: 0 },

    // --- Verification hooks (used by tests and the verifier) --------------
    // `tick` advances the simulation by an explicit dt without waiting on
    // requestAnimationFrame, so a full 5-minute battle can be exercised
    // deterministically from a test harness.
    tick(dt) {
      // Faithful to the real frame loop: a paused world does not advance.
      if (world.state === 'paused') return false;
      simulate(dt);
      return true;
    },
    startWave(i) { return startWave(i); },
    endGame(victory) { endGame(victory); },
    /** Nearest living hostile to `ship`, or null. */
    nearestEnemy(ship) { return nearestEnemy(world, ship); },

    spawnProjectile(p) { return projectiles.spawn(p); },
    spawnEffect(e) {
      if (!e || !e.type) return;
      const fn = effects[e.type];
      if (typeof fn === 'function') fn.call(effects, e.position, e.scale ?? 40, e.color ?? 0xffffff);
    },
    fireWeapon(ship, weaponId, target) { return fireWeapon(ship, weaponId, world, target ?? null); },

    spawnShip(opts = {}) {
      let def = opts.def;
      if (!def && opts.id) def = getModelDef(manifest, opts.id);
      if (!def) throw new Error('spawnShip requires def or id');
      const model = models.get(def.id);
      if (!model) throw new Error(`model "${def.id}" was not loaded`);

      const spawn = {
        position: opts.spawn?.position ? opts.spawn.position.clone() : new THREE.Vector3(),
        quaternion: opts.spawn?.quaternion ? opts.spawn.quaternion.clone() : new THREE.Quaternion(),
        throttle: opts.spawn?.throttle ?? 0,
      };
      const ship = new Ship({
        model, def,
        faction: opts.faction || def.faction,
        isPlayer: !!opts.isPlayer,
        spawn,
        callsign: opts.callsign,
        stats: opts.stats,
      });
      ship.controls.throttle = opts.speed ?? 0.75;

      world.ships.push(ship);
      (fleets[ship.faction] ||= []).push(ship);
      sm.scene.add(ship.object3D);
      events.emit('shipSpawned', { ship });
      return ship;
    },
  };

  /* ---- player ----------------------------------------------------------- */
  const playerDef = getModelDef(manifest, 'yamato');
  world.player = world.spawnShip({
    def: playerDef,
    faction: 'uncf',
    isPlayer: true,
    callsign: 'YAMATO',
    spawn: { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
  });
  world.player.controls.throttle = 0.55;
  rig.snapTo(world.player);

  /* ---- optional teammate modules --------------------------------------- */
  progress(82, 'HUD・レーダー / wiring interface…');
  const hudMod = await optionalImport('./ui/hud.js');
  const radarMod = await optionalImport('./ui/radar.js');
  const audioMod = await optionalImport('./core/audio.js');
  const aiMod = await optionalImport('./ai/fleetai.js');

  const hudRoot = document.getElementById('hud');
  if (hudMod?.Hud && hudRoot) {
    try { world.hud = new hudMod.Hud(hudRoot, world); }
    catch (err) { console.warn('[main] Hud failed to construct', err); world.hud = new NullHud(); }
  } else {
    world.hud = new NullHud();
  }

  if (radarMod?.Radar && hudRoot) {
    try {
      const cv = document.createElement('canvas');
      cv.className = 'radar-canvas';
      cv.style.width = '240px';
      cv.style.height = '240px';
      hudRoot.appendChild(cv);
      world.radar = new radarMod.Radar(cv, world);
    } catch (err) { console.warn('[main] Radar failed to construct', err); world.radar = new NullRadar(); }
  } else {
    world.radar = new NullRadar();
  }

  if (audioMod?.AudioEngine) {
    try { world.audio = new audioMod.AudioEngine(); }
    catch (err) { console.warn('[main] AudioEngine failed to construct', err); world.audio = new NullAudio(); }
  } else {
    world.audio = new NullAudio();
  }

  const input = new Input(window);
  world.input = input;

  if (aiMod?.FleetAI && typeof aiMod.spawnWave === 'function') {
    try {
      world.ai = {
        uncf: new aiMod.FleetAI({ faction: 'uncf', ships: fleets.uncf, world, doctrine: 'uncf' }),
        garmillas: new aiMod.FleetAI({ faction: 'garmillas', ships: fleets.garmillas, world, doctrine: 'garmillas' }),
        bolar: new aiMod.FleetAI({ faction: 'bolar', ships: fleets.bolar, world, doctrine: 'bolar' }),
        spawnWave: (i, w) => aiMod.spawnWave(i, w),
      };
    } catch (err) {
      console.warn('[main] FleetAI failed to construct — using fallback AI', err);
      world.ai = null;
    }
  }
  if (!world.ai) {
    const fb = makeFallbackAI(world);
    world.ai = {
      uncf: fb, garmillas: fb, bolar: fb,
      spawnWave: (i, w) => fallbackSpawnWave(i, w),
    };
  }

  /**
   * Rebuild the per-faction AI instances.
   *
   * FleetAI is handed a per-faction ship array. If it copies that array in its
   * constructor (rather than holding the reference), an instance built before a
   * wave spawns sees an empty fleet and never drives anything — which is
   * exactly the bug this guards against. Rebuilding after every spawn is cheap
   * (one object per faction) and correct under either implementation.
   */
  function refreshAI() {
    if (!aiMod?.FleetAI) return;
    for (const faction of ['uncf', 'garmillas', 'bolar']) {
      try {
        world.ai[faction] = new aiMod.FleetAI({
          faction, ships: fleets[faction], world, doctrine: faction,
        });
      } catch (err) {
        console.warn(`[main] FleetAI(${faction}) rebuild failed`, err);
      }
    }
  }
  world.refreshAI = refreshAI;

  /* ---- event relay ------------------------------------------------------ */
  events.on('kill', ({ ship, from }) => {
    const byPlayer = from && from.isPlayer;
    world.stats.kills += byPlayer ? 1 : 0;
    if (from) from.kills++;
    if (ship.faction === 'uncf') world.stats.losses++;
    world.hud?.pushEvent?.({
      type: 'kill',
      text: `${ship.callsign} 撃沈 — sunk by ${from ? from.callsign : '?'}`,
      byPlayer,
      faction: ship.faction,
    });
    if (from && from.isPlayer) sm.addShake(0.5);
  });

  events.on('wmgunFired', ({ ship }) => {
    if (ship.isPlayer) return;
    world.hud?.pushEvent?.({ type: 'warning', text: `⚠ ${ship.callsign} 波動砲発射 / WAVE MOTION GUN`, faction: ship.faction });
  });

  events.on('shipSpawned', ({ ship }) => {
    if (ship.isPlayer) return;
    if (ship.weaponIds.includes('wmgun')) {
      world.hud?.pushEvent?.({ type: 'warning', text: `⚠ ${ship.callsign} 波動砲搭載艦を確認`, faction: ship.faction });
    }
  });

  /* ---- first wave ------------------------------------------------------- */
  progress(94, '艦隊展開 / deploying fleet…');
  startWave(0);

  world.state = 'playing';
  world.stats.startedAt = performance.now();

  progress(100, '準備完了 / ready');
  setTimeout(() => bootEl?.classList.add('hidden'), 260);

  // Expose for debugging, automated verification and console poking.
  window.__YAMATO__ = world;

  let last = performance.now();
  let acc = 0;
  const FIXED = CONFIG.world.fixedDt;

  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    dt = Math.min(dt, 0.25);

    if (world.state === 'playing') {
      acc += dt;
      let steps = 0;
      while (acc >= FIXED && steps < CONFIG.world.maxSubSteps) {
        simulate(FIXED);
        acc -= FIXED;
        steps++;
      }
      if (steps >= CONFIG.world.maxSubSteps) acc = 0;   // never spiral
    } else {
      handleMetaInput();
    }

    // Presentation runs on the real frame time regardless of sim stepping.
    effects.update(dt);
    rig.update(dt, world.player && world.player.alive ? world.player : world.player);
    sm.followCamera();
    try {
      world.hud?.update?.(dt, world);
      world.radar?.update?.(dt, world);
      world.audio?.update?.(dt, world);
    } catch (err) { console.warn('[main] UI update threw', err); }

    sm.render();
  }
  requestAnimationFrame(frame);

  /* ---------------------------------------------------------------------- */

  function handleMetaInput() {
    if (input.consumePressed('Enter') && (world.state === 'victory' || world.state === 'defeat')) {
      location.reload();
    }
    if (input.consumeAction('pause') && world.state === 'paused') {
      world.state = 'playing';
      events.emit('resumed', {});
    }
  }

  function simulate(dt) {
    world.dt = dt;
    world.time += dt;
    world.stats.elapsed = world.time;

    if (input.consumeAction('pause')) {
      world.state = 'paused';
      events.emit('paused', {});
      return;
    }
    if (input.consumeAction('mute')) {
      const muted = !(world.muted ?? false);
      world.muted = muted;
      world.audio?.setMasterVolume?.(muted ? 0 : CONFIG.audio.master);
    }
    if (input.consumeAction('cycleCamera')) {
      const mode = rig.cycleMode();
      world.hud?.pushEvent?.({ type: 'info', text: `camera: ${mode}` });
    }

    // --- Player control ---------------------------------------------------
    const p = world.player;
    if (p && p.alive) {
      const c = p.controls;
      c.yaw = (input.actionDown('yawRight') ? 1 : 0) - (input.actionDown('yawLeft') ? 1 : 0);
      c.pitch = (input.actionDown('pitchUp') ? 1 : 0) - (input.actionDown('pitchDown') ? 1 : 0);
      c.roll = (input.actionDown('rollRight') ? 1 : 0) - (input.actionDown('rollLeft') ? 1 : 0);
      c.boost = input.actionDown('boost');
      c.brake = input.actionDown('brake');

      const up = input.actionDown('throttleUp');
      const down = input.actionDown('throttleDown');
      const rate = 0.85 * dt;
      if (up) c.throttle = clamp(c.throttle + rate, -1, 1);
      else if (down) c.throttle = clamp(c.throttle - rate, -1, 1);
      else if (c.brake) c.throttle = c.throttle > 0 ? Math.max(0, c.throttle - rate * 2) : Math.min(0, c.throttle + rate * 2);

      updatePlayerAim(dt, p);
      handleFireMode(p);
      handlePlayerWeapons(dt, p);
      world.firingSolution = computeFiringSolution(p);

      const mouse = input.takeMouseDelta();
      if (mouse.dx || mouse.dy) rig.addOrbit(mouse.dx, mouse.dy);
    } else {
      input.takeMouseDelta();
      input.endFrame();
    }

    // --- Simulation -------------------------------------------------------
    for (const ship of world.ships) {
      if (!ship.alive) continue;
      updateWeaponMounts(ship, dt, world);
    }

    for (const faction of ['uncf', 'garmillas', 'bolar']) {
      try { world.ai?.[faction]?.update?.(dt, world); }
      catch (err) { console.warn(`[main] AI (${faction}) threw`, err); }
    }

    // Invariant: every living AI ship has a target. Target *selection* belongs
    // to FleetAI, but `ship.target` is the documented SPEC §6.3 field the weapon
    // system, the HUD panel and Tab-cycling all read. If the AI leaves it unset
    // the ship sits silent (fireWeapon refuses blind AI fire), so backfill
    // defensively AFTER the AI has had its say — the AI's own choice wins.
    for (const ship of world.ships) {
      if (ship.isPlayer || !ship.alive) continue;
      if (!ship.target || !ship.target.alive) ship.target = nearestEnemy(world, ship);
    }

    for (const ship of world.ships) ship.update(dt, world);
    projectiles.update(dt, world);
    updatePointDefence(dt, world);

    // --- Wave flow --------------------------------------------------------
    updateWaveFlow(dt);

    // --- Death handling ---------------------------------------------------
    for (const ship of world.ships) {
      if (!ship.alive && !ship._deathHandled) {
        ship._deathHandled = true;
        const scale = (ship.def.lengthM || 200) * 0.55;
        effects.explosion(ship.position, scale, 0xffb060);
        for (let i = 0; i < 5; i++) {
          const off = new THREE.Vector3(rng.jitter(scale), rng.jitter(scale * 0.6), rng.jitter(scale));
          effects.explosion(ship.position.clone().add(off), scale * rng.range(0.3, 0.7), 0xff8a3c);
        }
        sm.addShake(ship.isPlayer ? 3.2 : clamp(900 / Math.max(80, ship.position.distanceTo(world.player?.position || ship.position)), 0.15, 1.4));
        world.audio?.play?.(scale > 150 ? 'explosion_big' : 'explosion_small', { position: ship.position });
        if (ship === world.player) endGame(false);
      }
    }

    if (world.hud) { /* updated in the render phase */ }
    input.endFrame();
  }

  /** Toggle between manual trigger and lock-on automatic fire. */
  function handleFireMode(p) {
    if (!input.consumeAction('toggleFireMode')) return;
    const order = CONFIG.fireModes?.order ?? ['manual', 'auto'];
    const i = order.indexOf(world.fireMode);
    world.fireMode = order[(i + 1) % order.length];
    world.hud?.pushEvent?.({
      type: 'info',
      text: world.fireMode === 'auto'
        ? '自動射撃 AUTO FIRE — 目標をロックして自動で射撃'
        : '手動射撃 MANUAL FIRE — トリガーは自分で',
    });
    world.audio?.play?.('ui_click', {});
  }

  /**
   * Aim / arc / range state for the player's currently selected weapon.
   * The HUD reads this so its "IN FIRING ARC" label can never disagree with
   * what the guns actually do.
   */
  function computeFiringSolution(p) {
    const id = world.aimWeaponId || 'shock_cannon';
    const spec = CONFIG.weapons[id] || CONFIG.weapons.shock_cannon;
    const tgt = p.target && p.target.alive ? p.target : null;
    if (!tgt) {
      return {
        weaponId: id, hasTarget: false, inArc: false, inRange: false,
        distance: 0, bearingDeg: 0, arcDeg: spec.arcDeg, leadPoint: null,
        mountsBearing: 0, mountsTotal: p.stats?.mounts?.[id] ?? 0,
      };
    }
    const distance = p.position.distanceTo(tgt.position);
    // The beam follows the AIM point (lead included), so the arc test must too.
    const lead = p.aimPointAt(tgt, spec.speed);
    const bearingDeg = (Math.atan2(
      p.forward.clone().cross(p.position.clone().sub(lead)).y,
      p.forward.dot(p.position.clone().sub(lead).normalize()),
    ) * 180) / Math.PI;
    return {
      weaponId: id,
      hasTarget: true,
      inArc: p.inFiringArc(lead, spec.arcDeg),
      inRange: distance <= spec.range,
      distance,
      bearingDeg: Number.isFinite(bearingDeg) ? Math.abs(bearingDeg) : 0,
      arcDeg: spec.arcDeg,
      leadPoint: lead,
      mountsBearing: p.mountsBearing ? p.mountsBearing(id) : 0,
      mountsTotal: p.stats?.mounts?.[id] ?? 0,
      // The wave motion gun is the weapon the player actually watches, so
      // report its arc separately.
      wmgun: (() => {
        const ws = CONFIG.weapons.wmgun;
        if (!p.weaponState?.wmgun) return null;
        const wlead = p.aimPointAt(tgt, ws.speed);
        return {
          inArc: p.inFiringArc(wlead, ws.arcDeg),
          inRange: distance <= ws.range,
          arcDeg: ws.arcDeg,
          chargeRatio: p.weaponState.wmgun.chargeRatio,
          cooldown: p.weaponState.wmgun.cooldown,
          leadPoint: wlead,
        };
      })(),
    };
  }

  /** In AUTO mode the guns fire themselves whenever they bear on the lock. */
  function autoFire(p) {
    if (!p.alive) return;
    const needTarget = CONFIG.fireModes?.autoRequiresTarget !== false;
    if (needTarget && !(p.target && p.target.alive)) return;
    for (const wid of p.weaponIds) {
      if (wid === 'wmgun') {
        const st = p.weaponState.wmgun;
        if (!st || st.cooldown > 0) continue;
        st.charging = true;
        const min = CONFIG.fireModes?.autoMinChargeRatio ?? 0.999;
        if (st.chargeRatio >= min) world.fireWeapon(p, 'wmgun');
        continue;
      }
      world.fireWeapon(p, wid);
    }
  }

  function updatePlayerAim(dt, p) {
    p._retargetTimer = (p._retargetTimer ?? 0) - dt;
    if (p._retargetTimer <= 0) {
      p._retargetTimer = 0.3;
      if (!p.target || !p.target.alive) p.target = nearestEnemy(world, p);
    }
    if (input.consumeAction('cycleTarget')) cycleTarget(p);

    if (p.target && p.target.alive) {
      p.aimPoint = p.aimPointAt(p.target, CONFIG.weapons.shock_cannon.speed);
    } else {
      p.aimPoint = p.position.clone().addScaledVector(p.forward, 2000);
    }
  }

  function cycleTarget(p) {
    const enemies = world.ships
      .filter((s) => s.alive && s.faction !== p.faction)
      .sort((a, b) => p.position.distanceTo(a.position) - p.position.distanceTo(b.position));
    if (!enemies.length) { p.target = null; return; }
    const idx = enemies.indexOf(p.target);
    p.target = enemies[(idx + 1) % enemies.length];
    world.hud?.pushEvent?.({
      type: 'info',
      text: `target: ${p.target.callsign} (${formatDistance(p.position.distanceTo(p.target.position))})`,
    });
  }

  function handlePlayerWeapons(dt, p) {
    // Cycle which weapon's arc the HUD draws (and which one AUTO leads with).
    if (input.consumeAction('cycleAimWeapon') && p.weaponIds.length) {
      const i = p.weaponIds.indexOf(world.aimWeaponId);
      world.aimWeaponId = p.weaponIds[(i + 1) % p.weaponIds.length];
      world.hud?.pushEvent?.({ type: 'info', text: `aim: ${CONFIG.weapons[world.aimWeaponId]?.displayName ?? world.aimWeaponId}` });
    }

    // AUTO: the guns fire themselves; manual keys still work as an override.
    if (world.fireMode === 'auto') {
      autoFire(p);
      input.consumeAction('fireMain');
      input.consumeAction('fireSecondary');
      input.consumeAction('fireTorpedo');
      const stA = p.weaponState.wmgun;
      if (stA) stA.charging = stA.cooldown <= 0;
      return;
    }

    // Main battery / secondaries / torpedoes are edge-triggered.
    if (input.consumeAction('fireMain')) {
      if (world.fireWeapon(p, 'shock_cannon')) world.stats.shotsFired++;
    }
    if (input.consumeAction('fireSecondary')) world.fireWeapon(p, 'secondary_battery');
    if (input.consumeAction('fireTorpedo')) world.fireWeapon(p, 'torpedo');

    // Wave motion gun: hold to charge, release to fire.
    const holding = input.actionDown('waveMotionGun');
    const st = p.weaponState.wmgun;
    if (holding && st) {
      if (!st.charging) {
        if (beginCharge(p, 'wmgun')) {
          world.audio?.play?.('wmgun_charge', { position: p.position, isPlayer: true });
        } else if (st.cooldown > 0) {
          world.hud?.pushEvent?.({ type: 'info', text: `波動砲 再充填中 / WM gun reloading ${Math.ceil(st.cooldown)}s` });
        }
      }
    } else if (st && st.charging) {
      // Released: fire if charged enough, otherwise abort.
      const fired = world.fireWeapon(p, 'wmgun');
      if (!fired) {
        abortCharge(p, 'wmgun');
        // Otherwise the charge whine keeps running for its full 8 s duration.
        world.audio?.stopCharge?.();
        if (st.chargeRatio < 0.35) {
          world.hud?.pushEvent?.({ type: 'info', text: '波動砲 チャージ不足 / insufficient charge' });
        }
      }
    }
  }

  /* ---- waves ------------------------------------------------------------ */

  function startWave(index) {
    const w = CONFIG.waves[index];
    if (!w) return false;
    world.waveIndex = index;
    let spawned = [];
    // fleetai.js's spawnWave also emits 'wave'. Exactly one banner per wave is
    // wanted, so detect a spawner-emitted event and only emit our own if the
    // spawner stayed silent (e.g. the fallback spawner).
    let spawnerEmitted = false;
    const stopListening = events.on('wave', () => { spawnerEmitted = true; });
    try {
      spawned = world.ai.spawnWave(index, world) || [];
    } catch (err) {
      console.warn('[main] spawnWave threw — using fallback', err);
      spawned = fallbackSpawnWave(index, world);
    }
    stopListening();
    refreshAI();   // make sure the AI owns the ships that just arrived
    if (!spawnerEmitted) {
      events.emit('wave', {
        index, name: w.name, banner: w.banner,
        allies: w.allies, enemies: w.enemies,
        spawned: spawned.length,
      });
    }
    world.hud?.pushEvent?.({ type: 'wave', text: w.banner, subtitle: w.name, index });
    world.audio?.play?.('alarm', {});
    world.pendingWave = null;
    world.waveTimer = 0;
    return true;
  }

  function updateWaveFlow(dt) {
    if (world.state !== 'playing') return;

    const enemiesLeft = world.ships.filter((s) => s.alive && s.faction !== 'uncf').length;

    if (enemiesLeft === 0 && !world.pendingWave) {
      const next = world.waveIndex + 1;
      if (next >= CONFIG.waves.length) {
        endGame(true);
        return;
      }
      world.pendingWave = next;
      world.waveTimer = 0;
      world.hud?.pushEvent?.({
        type: 'info',
        text: `敵艦隊壊滅 — 次波まで ${Math.round(CONFIG.waveLull)}s / sector clear`,
      });
    }

    if (world.pendingWave !== null) {
      world.waveTimer += dt;
      if (world.waveTimer >= CONFIG.waveLull) startWave(world.pendingWave);
    }
  }

  function endGame(victory) {
    if (world.state === 'victory' || world.state === 'defeat') return;
    world.state = victory ? 'victory' : 'defeat';
    events.emit('gameover', { victory, stats: world.stats, time: world.time });
    world.hud?.pushEvent?.({
      type: victory ? 'victory' : 'defeat',
      text: victory ? '作戦成功 / MISSION COMPLETE' : '艦船喪失 / YAMATO LOST',
      stats: { ...world.stats, elapsed: world.time },
    });
    world.audio?.play?.(victory ? 'ui_click' : 'explosion_big', {});
  }

  /**
   * Fallback wave spawner (used when src/ai/fleetai.js is unavailable).
   * Reads CONFIG.waves only — never hardcodes ship ids.
   */
  function fallbackSpawnWave(index, w) {
    const wave = CONFIG.waves[index];
    if (!wave) return [];
    const out = [];
    const groups = [
      ...(wave.allies || []).map((g) => ({ ...g, faction: 'uncf' })),
      ...(wave.enemies || []).map((g) => ({ ...g, faction: null })),
    ];
    for (const g of groups) {
      for (let i = 0; i < (g.count || 1); i++) {
        const bearings = g.bearingDeg && g.bearingDeg.length ? g.bearingDeg : [0];
        const bearing = (bearings[i % bearings.length] * Math.PI) / 180;
        const range = g.range ?? CONFIG.spawnDistance;
        const jitter = CONFIG.spawnSpread;
        const pos = new THREE.Vector3(
          Math.sin(bearing) * range + rng.jitter(jitter),
          rng.jitter(jitter * 0.35),
          -Math.cos(bearing) * range + rng.jitter(jitter),
        );
        _v.copy(pos).negate().normalize();
        const quat = new THREE.Quaternion().setFromUnitVectors(FWD, _v);
        try {
          out.push(world.spawnShip({
            id: g.id,
            faction: g.faction || undefined,
            spawn: { position: pos, quaternion: quat },
            speed: (g.speed ?? 0.9) * 0.7,
          }));
        } catch (err) {
          console.warn(`[main] could not spawn ${g.id}`, err);
        }
      }
    }
    return out;
  }

  return world;
}

/* -------------------------------------------------------------------------- */
/* Pointer lock + audio unlock                                                */
/* -------------------------------------------------------------------------- */

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    if (e.target?.id === 'game' && world?.input) {
      world.input.requestPointerLock(e.target);
      world.audio?.resume?.().catch?.(() => {});
    }
  });
  document.addEventListener('keydown', () => {
    world?.audio?.resume?.().catch?.(() => {});
  }, { once: true });
}

export default boot;
