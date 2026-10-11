/**
 * tests/config.test.mjs — SPEC §7.7 / task-5 Deliverable 1.
 *
 * The balance contract: docs/research/02-combat-mechanics.md §1 is the frozen
 * source of the researched totals, and src/core/config.js must reproduce them
 * under the project's fire-rate rule
 *
 *     perMountDPS = damage * salvo / cooldown
 *     shipDPS     = mounts[weaponId] * perMountDPS
 *
 * with `salvo` PER MOUNT. Any drift here silently rebalances the demo, so this
 * file pins the numbers in the research table.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CONFIG } from '../src/core/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'assets/models/manifest.json'), 'utf8'));

/* -------------------------------------------------------------------------- */
/* §1.1 ship pools                                                             */
/* -------------------------------------------------------------------------- */

/** research §1.1 — totalEHP = shield + armor + hull. */
const RESEARCH_EHP = {
  yamato: 9000,
  andromeda: 11000,
  kirishima: 4000,
  yukikaze: 1000,
  garmillas_dessler: 9600,
  garmillas_kelkapia: 4200,
  garmillas_gaiderol: 8200,
  bolar_carrier: 7000,
};

/** research §1.1 — shield regen (DP/s) and regen delay (s). */
const RESEARCH_REGEN = {
  yamato: [120, 4], andromeda: [120, 4], kirishima: [80, 4], yukikaze: [60, 4],
  garmillas_dessler: [100, 5], garmillas_kelkapia: [80, 5],
  garmillas_gaiderol: [100, 5], bolar_carrier: [90, 5],
};

test('CONFIG.ships covers exactly the eight SPEC §5 ships', () => {
  assert.deepEqual(
    Object.keys(CONFIG.ships).sort(),
    Object.keys(RESEARCH_EHP).sort(),
  );
  assert.deepEqual(
    Object.keys(CONFIG.ships).sort(),
    manifest.models.map((m) => m.id).sort(),
    'CONFIG.ships and the model manifest must describe the same fleet',
  );
});

test('every ship: shield + armor + hull equals the researched totalEHP', () => {
  for (const [id, expected] of Object.entries(RESEARCH_EHP)) {
    const s = CONFIG.ships[id];
    const total = s.shield + s.armor + s.hull;
    assert.equal(total, expected, `${id}: ${s.shield}+${s.armor}+${s.hull} = ${total}, expected ${expected}`);
  }
});

test('every ship: shield regen rate and delay match research §1.1', () => {
  for (const [id, [rate, delay]] of Object.entries(RESEARCH_REGEN)) {
    assert.equal(CONFIG.ships[id].shieldRegen, rate, `${id} shieldRegen`);
    assert.equal(CONFIG.ships[id].shieldDelay, delay, `${id} shieldDelay`);
  }
});

test('every ship declares the movement fields the flight model reads', () => {
  for (const [id, s] of Object.entries(CONFIG.ships)) {
    for (const k of ['maxSpeed', 'boostSpeed', 'reverseSpeed', 'yawRate', 'pitchRate', 'rollRate', 'accel', 'collisionRadius']) {
      assert.equal(typeof s[k], 'number', `${id}.${k} must be a number`);
      assert.ok(s[k] > 0, `${id}.${k} must be positive`);
    }
    assert.ok(s.boostSpeed > s.maxSpeed, `${id}: boostSpeed must exceed maxSpeed`);
    assert.ok(s.reverseSpeed < s.maxSpeed, `${id}: reverseSpeed must be below maxSpeed`);
    assert.ok(s.pdMounts >= 1, `${id}: needs at least one point-defence mount`);
    assert.ok(['uncf', 'garmillas', 'bolar'].includes(s.faction), `${id}: bad faction ${s.faction}`);
    assert.ok(CONFIG.ai.doctrines[s.aiDoctrine], `${id}: aiDoctrine "${s.aiDoctrine}" is not a real doctrine`);
  }
});

/* -------------------------------------------------------------------------- */
/* §1.2 / §1.3 weapon fire rates                                               */
/* -------------------------------------------------------------------------- */

/**
 * Researched DPS. `perMount` is the §1.3 figure (DPS per mount); `ship` is the
 * §1.2 player figure (all mounts firing). Both are reproduced by the same rule.
 */
const RESEARCH_DPS = {
  shock_cannon: { perMount: 45.0, ship: 135.0, shipId: 'yamato' },
  secondary_battery: { perMount: 29.333333333333332, ship: 58.666666666666664, shipId: 'yamato' },
  torpedo: { perMount: 86.66666666666667, ship: 86.66666666666667, shipId: 'yamato' },
  garmillas_beam: { perMount: 12.0, ship: null },
  missile: { perMount: 36.0, ship: null },
  bolar_beam: { perMount: 16.8, ship: null },
};

test('every weapon reproduces the researched DPS under damage*salvo/cooldown', () => {
  for (const [id, w] of Object.entries(CONFIG.weapons)) {
    const perMount = (w.damage * w.salvo) / w.cooldown;
    assert.ok(Number.isFinite(perMount) && perMount > 0, `${id}: bad DPS ${perMount}`);
    const research = RESEARCH_DPS[id];
    if (research) {
      assert.ok(
        Math.abs(perMount - research.perMount) < 0.01,
        `${id}: per-mount DPS ${perMount.toFixed(4)} != researched ${research.perMount}`,
      );
    }
  }
});

test('player ship DPS = mounts * damage * salvo / cooldown (research §1.2 totals)', () => {
  const y = CONFIG.ships.yamato;
  for (const [id, research] of Object.entries(RESEARCH_DPS)) {
    if (!research.ship) continue;
    const w = CONFIG.weapons[id];
    const mounts = y.mounts[id];
    assert.ok(mounts > 0, `yamato must mount ${id}`);
    const shipDPS = mounts * (w.damage * w.salvo) / w.cooldown;
    assert.ok(
      Math.abs(shipDPS - research.ship) < 0.01,
      `${id}: ship DPS ${shipDPS.toFixed(4)} != researched ${research.ship}`,
    );
  }
});

test('all-guns player DPS (shock + secondary) is the researched 193.7 DP/s', () => {
  const y = CONFIG.ships.yamato;
  const dps = ['shock_cannon', 'secondary_battery'].reduce((acc, id) => {
    const w = CONFIG.weapons[id];
    return acc + y.mounts[id] * (w.damage * w.salvo) / w.cooldown;
  }, 0);
  assert.ok(Math.abs(dps - 193.7) < 0.1, `all-guns DPS ${dps}`);
});

test('every weapon has the SPEC §6.4 spec fields and a legal kind', () => {
  const KINDS = ['beam', 'shell', 'missile', 'torpedo', 'wmgun'];
  const REQUIRED = ['id', 'displayName', 'kind', 'damage', 'shieldMultiplier', 'speed',
    'range', 'cooldown', 'salvo', 'spread', 'color', 'tracerWidth', 'life', 'sound'];
  for (const [key, w] of Object.entries(CONFIG.weapons)) {
    assert.equal(w.id, key, `CONFIG.weapons.${key}.id must match its key`);
    assert.ok(KINDS.includes(w.kind), `${key}: illegal kind "${w.kind}"`);
    for (const f of REQUIRED) {
      assert.ok(w[f] !== undefined && w[f] !== null, `${key}: missing SPEC §6.4 field "${f}"`);
    }
    assert.ok(w.damage > 0 && w.salvo >= 1 && w.cooldown > 0, `${key}: non-positive fire-rate input`);
    assert.ok(w.range > 0 && w.speed > 0 && w.life > 0, `${key}: non-positive range/speed/life`);
    assert.ok(w.spread >= 0, `${key}: negative spread`);
    assert.ok(w.shieldMultiplier >= 0, `${key}: negative shieldMultiplier`);
    assert.equal(typeof w.displayName, 'string');
    assert.ok(w.displayName.length > 0);
  }
  // Homing weapons must declare homing; the wmgun must declare its charge.
  for (const id of ['torpedo', 'missile']) {
    assert.ok(CONFIG.weapons[id].homing > 0, `${id} must be homing`);
    assert.ok(CONFIG.weapons[id].hp > 0, `${id} needs hp so point defence can chew it`);
  }
  assert.ok(CONFIG.weapons.wmgun.chargeTime > 0);
  assert.ok(CONFIG.weapons.wmgun.chargeDamage > 0);
});

test('research §1.3 projectile durability: missile hp 120, torpedo hp 150', () => {
  assert.equal(CONFIG.weapons.missile.hp, 120);
  assert.equal(CONFIG.weapons.torpedo.hp, 150);
});

test('torpedo is weak vs shields, strong vs armor (research §1.2 split)', () => {
  assert.equal(CONFIG.weapons.torpedo.shieldMultiplier, 0.60);
  assert.equal(CONFIG.weapons.torpedo.armorMultiplier, 1.50);
});

test('research §1.2 ranges: shock 2000, secondary 1200, torpedo 1500, missile 2500', () => {
  assert.equal(CONFIG.weapons.shock_cannon.range, 2000);
  assert.equal(CONFIG.weapons.secondary_battery.range, 1200);
  assert.equal(CONFIG.weapons.torpedo.range, 1500);
  assert.equal(CONFIG.weapons.missile.range, 2500);
  assert.equal(CONFIG.weapons.wmgun.range, 12000);
});

/* -------------------------------------------------------------------------- */
/* Wave motion gun — the specific numbers the brief calls out                  */
/* -------------------------------------------------------------------------- */

test('wmgun: chargeTime in [6,10] and cooldown in [45,70]', () => {
  const w = CONFIG.weapons.wmgun;
  assert.ok(w.chargeTime >= 6 && w.chargeTime <= 10, `chargeTime ${w.chargeTime} outside [6,10]`);
  assert.ok(w.cooldown >= 45 && w.cooldown <= 70, `cooldown ${w.cooldown} outside [45,70]`);
  assert.equal(w.chargeTime, 8.0, 'research §1.2 pins chargeTime at 8.0 s');
  assert.equal(w.cooldown, 60.0, 'research §1.2 pins cooldown at 60.0 s');
});

test('wmgun: ±3° bow arc, 1.25 shield multiplier, 4800 damage', () => {
  const w = CONFIG.weapons.wmgun;
  assert.equal(w.arcDeg, 3);
  assert.equal(w.shieldMultiplier, 1.25);
  assert.equal(w.damage, 4800);
  assert.equal(w.chargeDamage, 4800);
  assert.equal(w.requiresArc, true);
  assert.equal(w.salvo, 1);
});

test('wmgun one-shots a Kelkapia (4200 EHP) but cannot one-shot a Yamato (9000)', () => {
  const dmg = CONFIG.weapons.wmgun.chargeDamage;
  const kel = CONFIG.ships.garmillas_kelkapia;
  const yam = CONFIG.ships.yamato;
  assert.ok(dmg > kel.shield + kel.armor + kel.hull, 'WMG must one-shot a cruiser');
  assert.ok(dmg < yam.shield + yam.armor + yam.hull, 'WMG must NOT one-shot the player');
});

test('wmgun post-fire engine drain is declared', () => {
  assert.ok(CONFIG.weapons.wmgun.postFireSpeedFactor > 0
    && CONFIG.weapons.wmgun.postFireSpeedFactor < 1);
  assert.ok(CONFIG.weapons.wmgun.postFireDuration > 0);
});

/* -------------------------------------------------------------------------- */
/* mounts / mountPrefix consistency                                            */
/* -------------------------------------------------------------------------- */

test('every `mounts` key and every `weapons` entry names a real weapon', () => {
  for (const [id, s] of Object.entries(CONFIG.ships)) {
    for (const wid of Object.keys(s.mounts)) {
      assert.ok(CONFIG.weapons[wid], `${id}.mounts references unknown weapon "${wid}"`);
      assert.ok(s.mounts[wid] >= 1 && Number.isInteger(s.mounts[wid]), `${id}.mounts.${wid} must be a positive integer`);
    }
    for (const wid of s.weapons) {
      assert.ok(CONFIG.weapons[wid], `${id}.weapons references unknown weapon "${wid}"`);
      assert.ok(s.mounts[wid] >= 1, `${id}.weapons lists "${wid}" but mounts has no entry for it`);
    }
    // No orphan mounts.
    for (const wid of Object.keys(s.mounts)) {
      assert.ok(s.weapons.includes(wid), `${id}.mounts has "${wid}" but weapons does not list it`);
    }
  }
});

test('every weapon mountPrefix is a plausible hardpoint prefix', () => {
  // Prefixes that the generator emits, plus the ones src/core/assets.js
  // synthesises when a model omits a mount family (ensureFallbackHardpoints).
  const generatorPrefixes = new Set();
  for (const m of manifest.models) {
    for (const hp of m.hardpoints || []) {
      generatorPrefixes.add(String(hp.name).replace(/_\d+$/, ''));
    }
  }
  const synthesised = new Set([
    'wave_motion_gun', 'turret_main', 'turret_secondary', 'ciws',
    'torpedo_tube', 'missile_launcher', 'engine',
  ]);
  const plausible = new Set([...generatorPrefixes, ...synthesised]);

  for (const [id, w] of Object.entries(CONFIG.weapons)) {
    assert.equal(typeof w.mountPrefix, 'string', `${id}: mountPrefix must be a string`);
    assert.ok(w.mountPrefix.length > 0, `${id}: empty mountPrefix`);
    assert.ok(
      plausible.has(w.mountPrefix),
      `${id}: mountPrefix "${w.mountPrefix}" matches no generated or synthesised hardpoint family`,
    );
  }
  // Every weapon family the fleet actually uses must be reachable somewhere.
  for (const [id, s] of Object.entries(CONFIG.ships)) {
    for (const wid of Object.keys(s.mounts)) {
      assert.ok(CONFIG.weapons[wid].mountPrefix, `${id}/${wid} has no mountPrefix`);
    }
  }
});

test('subsystemKind is a real CONFIG.damage.subsystemHp key (or null)', () => {
  for (const [id, w] of Object.entries(CONFIG.weapons)) {
    if (w.subsystemKind === null || w.subsystemKind === undefined) continue;
    assert.ok(
      Object.prototype.hasOwnProperty.call(CONFIG.damage.subsystemHp, w.subsystemKind),
      `${id}: subsystemKind "${w.subsystemKind}" has no HP entry`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* waves                                                                       */
/* -------------------------------------------------------------------------- */

test('every wave references only ids that exist in CONFIG.ships', () => {
  assert.ok(Array.isArray(CONFIG.waves) && CONFIG.waves.length === 3, 'three waves per SPEC §1');
  CONFIG.waves.forEach((w, i) => {
    assert.equal(w.index, i, `wave ${i} has index ${w.index}`);
    assert.equal(w.id, i + 1, `wave ${i} id should be ${i + 1}`);
    assert.ok(typeof w.banner === 'string' && w.banner.length > 0, `wave ${i} needs a banner`);
    assert.ok((w.enemies || []).length > 0, `wave ${i} has no enemies`);
    for (const g of [...(w.allies || []), ...(w.enemies || [])]) {
      assert.ok(CONFIG.ships[g.id], `wave ${i} references unknown ship id "${g.id}"`);
      assert.ok(g.count >= 1, `wave ${i}/${g.id} count must be >= 1`);
      assert.ok(g.range > 0, `wave ${i}/${g.id} needs a spawn range`);
      if (g.bearingDeg) {
        assert.ok(Array.isArray(g.bearingDeg) && g.bearingDeg.length >= 1);
        assert.ok(g.bearingDeg.every((b) => Number.isFinite(b)), `wave ${i}/${g.id} has a bad bearing`);
      }
    }
  });
});

test('wave composition matches research §1.6 (Garmillas x2, then Desler + Bolar)', () => {
  const enemies = (i) => CONFIG.waves[i].enemies.flatMap((g) => Array(g.count).fill(g.id));
  assert.deepEqual(enemies(0), ['garmillas_kelkapia', 'garmillas_kelkapia', 'garmillas_kelkapia']);
  assert.deepEqual(enemies(1), ['garmillas_gaiderol', 'garmillas_kelkapia']);
  const w3 = enemies(2);
  assert.ok(w3.includes('bolar_carrier'), 'wave 3 must include the Bolar carrier');
  assert.ok(w3.includes('garmillas_kelkapia'), 'wave 3 must include Garmillas cruisers');
});

test('waveLull and progression timings are positive and sane', () => {
  assert.ok(CONFIG.waveLull > 0 && CONFIG.waveLull <= 30, `waveLull ${CONFIG.waveLull}`);
  assert.equal(CONFIG.progression.startWave, 0);
  assert.ok(CONFIG.progression.waveClearDelay > 0);
  assert.ok(CONFIG.world.fixedDt > 0 && CONFIG.world.fixedDt <= 1 / 30);
  assert.ok(CONFIG.world.boundsRadius > 0);
});

/* -------------------------------------------------------------------------- */
/* damage model                                                                */
/* -------------------------------------------------------------------------- */

test('damage layering is strict shield -> armor -> hull, in that order', () => {
  assert.deepEqual(CONFIG.damage.layering, ['shield', 'armor', 'hull']);
});

test('subsystem routing constants match research §1.1 (15%, 8% crit, doubled)', () => {
  assert.equal(CONFIG.damage.subsystemDamageFraction, 0.15);
  assert.equal(CONFIG.damage.critChance, 0.08);
  assert.equal(CONFIG.damage.armorRegen ?? 0, 0, 'armor must never regenerate');
  assert.equal(CONFIG.damage.hullRegen ?? 0, 0, 'hull must never regenerate');
});

test('subsystem HP table is quoted for a Yamato-scale hull (research §1.9)', () => {
  assert.equal(CONFIG.damage.subsystemReferenceHull, 4400);
  assert.equal(CONFIG.damage.subsystemHp.wmgun, 900);
  assert.equal(CONFIG.damage.subsystemHp.engine, 1200);
  assert.ok(CONFIG.damage.subsystemScaleMin > 0 && CONFIG.damage.subsystemScaleMax >= 1);
});

test('friendly fire is scaled down but non-zero', () => {
  assert.ok(CONFIG.damage.friendlyFireScale > 0 && CONFIG.damage.friendlyFireScale < 1);
});

/* -------------------------------------------------------------------------- */
/* point defence                                                               */
/* -------------------------------------------------------------------------- */

test('point defence is a continuous aura over missile/torpedo only', () => {
  const pd = CONFIG.pointDefence;
  assert.equal(pd.range, 900);
  assert.equal(pd.dpsPerMount, 20);
  assert.deepEqual(pd.targetKinds, ['missile', 'torpedo']);
  assert.ok(!pd.targetKinds.includes('shell'), 'PD must not engage shells');
  assert.ok(!pd.targetKinds.includes('beam'), 'PD must not engage beams');
});

test('PD dps x mounts x torpedo flight time is enough to matter', () => {
  // A Yamato has 4 PD mounts => 80 DP/s. A torpedo has 150 hp, so it must be
  // killable within its 9 s life by one ship, and comfortably by several.
  const mounts = CONFIG.ships.yamato.pdMounts;
  const dps = mounts * CONFIG.pointDefence.dpsPerMount;
  const ttk = CONFIG.weapons.torpedo.hp / dps;
  assert.ok(ttk < CONFIG.weapons.torpedo.life, `one ship needs ${ttk}s to kill a torpedo (life ${CONFIG.weapons.torpedo.life}s)`);
});

/* -------------------------------------------------------------------------- */
/* keys                                                                        */
/* -------------------------------------------------------------------------- */

test('CONFIG.keys binds every control SPEC §6.9 requires', () => {
  const k = CONFIG.keys;
  for (const name of ['throttleUp', 'throttleDown', 'yawLeft', 'yawRight', 'rollLeft', 'rollRight',
    'boost', 'fireMain', 'fireTorpedo', 'waveMotionGun', 'cycleTarget', 'cycleCamera', 'pause']) {
    assert.ok(Array.isArray(k[name]) && k[name].length > 0, `CONFIG.keys.${name} missing`);
  }
  assert.ok(k.fireMain.includes('Space'));
  assert.ok(k.fireTorpedo.includes('KeyF'));
  assert.ok(k.waveMotionGun.includes('KeyR'));
  assert.ok(k.cycleTarget.includes('Tab'));
  assert.ok(k.pause.includes('KeyP'));
  assert.ok(k.throttleUp.includes('KeyW') && k.throttleDown.includes('KeyS'));
  assert.ok(k.yawLeft.includes('KeyA') && k.yawRight.includes('KeyD'));
  assert.ok(k.rollLeft.includes('KeyQ') && k.rollRight.includes('KeyE'));
});

test('every weapon sound name resolves to an AudioEngine synth or alias', () => {
  // SPEC §6.8's list plus the ALIASES table in src/core/audio.js. A weapon whose
  // `sound` is neither would fall through to the generic synth and warn.
  const audioSrc = readFileSync(join(ROOT, 'src/core/audio.js'), 'utf8');
  const synthNames = new Set([...audioSrc.matchAll(/_snd_([a-z_]+)\s*\(/g)].map((m) => m[1]));
  const aliasBlock = audioSrc.slice(audioSrc.indexOf('const ALIASES'), audioSrc.indexOf('};', audioSrc.indexOf('const ALIASES')));
  const aliasKeys = new Set([...aliasBlock.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]));
  for (const [id, w] of Object.entries(CONFIG.weapons)) {
    const s = w.sound;
    assert.ok(
      synthNames.has(s) || aliasKeys.has(s),
      `${id}: sound "${s}" is neither a synth (_snd_${s}) nor an ALIASES key`,
    );
  }
});
