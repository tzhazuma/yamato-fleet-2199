/**
 * src/core/config.js — THE single source of balance truth (SPEC §6.2).
 *
 * Units: 1 world unit = 1 metre (SPEC §4), seconds, radians.
 * Damage is in abstract "damage points" (DP); pools are plain numbers.
 *
 * FIRE-RATE RULE (one rule for every weapon — this resolves the ambiguity
 * between §1.2 and §1.11 of docs/research/02-combat-mechanics.md):
 *
 *     perMountDPS = damage * salvo / cooldown
 *     shipDPS     = mounts[weaponId] * perMountDPS
 *
 * `salvo` is projectiles PER MOUNT per trigger pull. `mounts` is the number of
 * mounts on that hull. So the Yamato's main battery is mounts:3, salvo:1 →
 * three shells per volley → 3 * 90 * 1 / 2.0 = 135 DP/s, exactly the researched
 * total. Every DPS figure in the research doc reproduces under this rule; see
 * docs/research/02-combat-mechanics.md §1.2 / §1.3.
 *
 * `mounts` is authoritative for DPS and is deliberately decoupled from the
 * model's hardpoint count: salvos are distributed round-robin over whatever
 * hardpoints the OBJ actually provides.
 *
 * Balance source: docs/research/02-combat-mechanics.md §1 (TTK-verified).
 */

export const CONFIG = {
  version: '0.1.0-demo',

  debug: {
    // ?debug=1 in the URL turns these on
    showColliders: false,
    showHardpoints: false,
    invincible: false,
    logEvents: false,
    fastCharge: false,      // ?debug=1 also shortens the WM-gun charge for testing
  },

  world: {
    shipScale: 1.0,
    boundsRadius: 6000,     // arenaRadius — research §1.6
    fixedDt: 1 / 60,      // sim rate; swept projectile collision makes this safe
    maxSubSteps: 4,
  },

  camera: {
    fov: 55,
    near: 1,
    far: 400000,
    // research 03 §4 item 15: the reference frames ships filling 40-60% of frame
    // width. Closer and higher than a typical chase cam gets us there while
    // still leaving the battle visible.
    chaseDistance: 372,
    chaseHeight: 132,
    chaseLag: 3.4,
    lookAhead: 600,
    orbitSpeed: 0.0022,
    shakeDecay: 2.6,
    modes: ['chase', 'orbit', 'cinematic'],
  },

  render: {
    bloom: { strength: 0.72, radius: 0.5, threshold: 0.72 },
    starCount: 9000,
    starRadius: 160000,
    nebula: false,          // research 03: the reference has NO nebula; black sky is the look
    maxPixelRatio: 2,
    fog: false,
  },

  fx: {
    maxProjectiles: 900,
    maxParticles: 2600,
    explosionParticles: { small: 26, medium: 60, large: 140, huge: 260 },
    trailLength: 26,
  },

  audio: { master: 0.7, music: 0.38, sfx: 0.85 },

  // ---------------------------------------------------------------------------
  // HUD — every value src/ui/** reads, so nothing is hardcoded in the UI layer.
  // ---------------------------------------------------------------------------
  ui: {
    // Half-angle used to DRAW the firing arc. A real 150 deg traverse fan covers
    // the whole screen and reads as a flat wash rather than a cone, so the drawn
    // fan is clamped. The TRUE arc is always reported numerically (the weapons
    // panel shows "3/3 BEARING", the target panel shows IN/OUT OF ARC), so the
    // clamp never hides whether a shot will actually leave the barrel.
    arcMaxDisplayDeg: 26,
    colors: {
      arcIn: 'rgba(120, 255, 170, 0.17)',
      arcOut: 'rgba(255, 150, 90, 0.16)',
      arcAxis: 'rgba(200, 235, 255, 0.5)',
      lead: 'rgba(255, 214, 130, 0.95)',
      mountReady: 'rgba(150, 255, 190, 0.95)',
      mountSlew: 'rgba(255, 214, 130, 0.9)',
      mountBlocked: 'rgba(255, 120, 90, 0.85)',
      mountGhost: 'rgba(150, 175, 205, 0.35)',
    },
  },

  keys: {
    throttleUp: ['KeyW', 'ArrowUp'],
    throttleDown: ['KeyS', 'ArrowDown'],
    yawLeft: ['KeyA', 'ArrowLeft'],
    yawRight: ['KeyD', 'ArrowRight'],
    rollLeft: ['KeyQ'],
    rollRight: ['KeyE'],
    pitchUp: ['KeyI'],
    pitchDown: ['KeyK'],
    boost: ['ShiftLeft', 'ShiftRight'],
    brake: ['KeyX'],
    fireMain: ['Space'],
    fireSecondary: ['KeyG'],
    fireTorpedo: ['KeyF'],
    waveMotionGun: ['KeyR'],
    cycleTarget: ['Tab'],
    cycleCamera: ['KeyC'],
    pause: ['KeyP'],
    toggleRadarZoom: ['KeyZ'],
    toggleFireMode: ['KeyT'],
    cycleAimWeapon: ['KeyB'],
    mute: ['KeyM'],
  },

  // ---------------------------------------------------------------------------
  // SHIPS — keyed by the `id` field of assets/models/manifest.json.
  // Pools + movement from research §1.1 / §1.8; mounts from §1.3.
  // totalEHP = shield + armor + hull. Only the shield regenerates.
  // ---------------------------------------------------------------------------
  ships: {
    yamato: {
      callsign: 'YAMATO', displayName: 'Yamato (BBY-01)', shipClass: 'Yamato-class',
      faction: 'uncf', role: 'battleship',
      shield: 2400, armor: 2200, hull: 4400,
      shieldRegen: 120, shieldDelay: 4,
      maxSpeed: 90, boostSpeed: 180, reverseSpeed: 30,
      yawRate: 0.20, pitchRate: 0.15, rollRate: 0.50, accel: 25, brakeDecel: 60,
      mass: 1.0, collisionRadius: 52,
      weapons: ['shock_cannon', 'secondary_battery', 'torpedo', 'missile', 'wmgun'],
      // missile: 1 mount, not 12. The model emits all twelve canon launchers
      // (10 ventral tubes + the eight-barrel box + the funnel launcher) for
      // silhouette fidelity, but the game issues the missile WEAPON once and
      // fires it from a single fire-control channel — 36 DPS is a meaningful
      // addition to a 360 DPS ship and a role-breaking one to a destroyer.
      mounts: { shock_cannon: 3, secondary_battery: 2, torpedo: 1, missile: 1, wmgun: 1 },
      pdMounts: 4,
      aiDoctrine: 'uncf',
    },
    andromeda: {
      callsign: 'ANDROMEDA', displayName: 'Andromeda (AAA-01)', shipClass: 'Andromeda-class',
      faction: 'uncf', role: 'battleship',
      shield: 3000, armor: 2600, hull: 5400,
      shieldRegen: 120, shieldDelay: 4,
      maxSpeed: 85, boostSpeed: 170, reverseSpeed: 28,
      yawRate: 0.17, pitchRate: 0.13, rollRate: 0.45, accel: 22, brakeDecel: 55,
      mass: 1.15, collisionRadius: 62,
      weapons: ['uncf_beam', 'torpedo'],
      mounts: { uncf_beam: 4, torpedo: 1 },
      pdMounts: 4,
      aiDoctrine: 'uncf',
    },
    kirishima: {
      callsign: 'KIRISHIMA', displayName: 'Kirishima (CC-3)', shipClass: 'Kongo-class (refit)',
      faction: 'uncf', role: 'cruiser',
      shield: 1100, armor: 1000, hull: 1900,
      shieldRegen: 80, shieldDelay: 4,
      maxSpeed: 120, boostSpeed: 240, reverseSpeed: 40,
      yawRate: 0.40, pitchRate: 0.28, rollRate: 0.80, accel: 40, brakeDecel: 70,
      mass: 0.62, collisionRadius: 34,
      weapons: ['uncf_beam', 'torpedo'],
      // 4 mounts, not 2: she carries four triple 36 cm turrets (docs/research/01
      // section 1.3) and the model emits all four as `turret_main_1..4`. One
      // mount per turret is the convention Andromeda already followed. She has no
      // secondary battery at all — canon gives her four identical main turrets
      // and nothing between them and her torpedoes.
      mounts: { uncf_beam: 4, torpedo: 1 },
      pdMounts: 2,
      aiDoctrine: 'uncf',
    },
    yukikaze: {
      callsign: 'YUKIKAZE', displayName: 'Yukikaze (DD-117)', shipClass: 'Isokaze-class',
      faction: 'uncf', role: 'destroyer',
      shield: 300, armor: 250, hull: 450,
      shieldRegen: 60, shieldDelay: 4,
      maxSpeed: 200, boostSpeed: 400, reverseSpeed: 70,
      yawRate: 0.80, pitchRate: 0.55, rollRate: 1.40, accel: 80, brakeDecel: 110,
      mass: 0.30, collisionRadius: 16,
      weapons: ['uncf_beam'],
      // 2 mounts, not 1: she carries two triple 12.7 cm turrets, one abaft the
      // canopy and one mirrored on the hull's underside, and the model emits
      // both as `turret_main_1..2`. Her two FIXED forward 12.7 cm anti-ship guns
      // are geometry only — giving a 1000 EHP destroyer a battleship-grade
      // `secondary_battery` (29.3 DPS per mount) would triple her firepower for
      // no canon reason.
      mounts: { uncf_beam: 2 },
      pdMounts: 1,
      aiDoctrine: 'uncf',
    },
    garmillas_kelkapia: {
      callsign: 'KELKAPIA', displayName: 'Kelkapia-class', shipClass: 'Kelkapia-class',
      faction: 'garmillas', role: 'cruiser',
      shield: 1200, armor: 1000, hull: 2000,
      shieldRegen: 80, shieldDelay: 5,
      maxSpeed: 110, boostSpeed: 220, reverseSpeed: 38,
      yawRate: 0.35, pitchRate: 0.26, rollRate: 0.75, accel: 38, brakeDecel: 65,
      mass: 0.66, collisionRadius: 36,
      weapons: ['garmillas_beam'],
      mounts: { garmillas_beam: 3 },   // canon: three dorsal domed mounts at 0.25/0.50/0.75
      pdMounts: 2,
      aiDoctrine: 'garmillas',
    },
    garmillas_gaiderol: {
      callsign: 'GAIDEROL', displayName: 'Gaiderol-class', shipClass: 'Gaiderol-class',
      faction: 'garmillas', role: 'battleship',
      shield: 2200, armor: 2000, hull: 4000,
      shieldRegen: 100, shieldDelay: 5,
      maxSpeed: 80, boostSpeed: 160, reverseSpeed: 26,
      yawRate: 0.18, pitchRate: 0.14, rollRate: 0.45, accel: 20, brakeDecel: 50,
      mass: 1.05, collisionRadius: 56,
      weapons: ['garmillas_beam', 'missile'],
      mounts: { garmillas_beam: 4, missile: 1 },
      pdMounts: 4,
      aiDoctrine: 'garmillas',
    },
    garmillas_dessler: {
      callsign: 'DESSLER', displayName: 'Desler Flagship', shipClass: 'Desler flagship',
      faction: 'garmillas', role: 'flagship',
      shield: 2600, armor: 2400, hull: 4600,
      shieldRegen: 100, shieldDelay: 5,
      maxSpeed: 85, boostSpeed: 170, reverseSpeed: 28,
      yawRate: 0.18, pitchRate: 0.14, rollRate: 0.45, accel: 22, brakeDecel: 52,
      mass: 1.40, collisionRadius: 100,
      weapons: ['garmillas_beam', 'missile', 'wmgun'],
      // 6, not 4: canon gives the Dessler 4-6 dorsal domed mounts and the model
      // emits six at the canon stations (0.20/0.45/0.70 x +/-0.22B).
      mounts: { garmillas_beam: 6, missile: 1, wmgun: 1 },
      pdMounts: 4,
      aiDoctrine: 'garmillas',
    },
    bolar_carrier: {
      callsign: 'BOLAR', displayName: 'Bolar Carrier', shipClass: 'Bolar carrier',
      faction: 'bolar', role: 'carrier',
      shield: 1900, armor: 1700, hull: 3400,
      shieldRegen: 90, shieldDelay: 5,
      maxSpeed: 70, boostSpeed: 140, reverseSpeed: 24,
      yawRate: 0.15, pitchRate: 0.12, rollRate: 0.40, accel: 18, brakeDecel: 44,
      mass: 1.20, collisionRadius: 60,
      weapons: ['bolar_beam', 'missile'],
      mounts: { bolar_beam: 3, missile: 1 },
      pdMounts: 3,
      aiDoctrine: 'bolar',
    },
  },

  // ---------------------------------------------------------------------------
  // WEAPONS (SPEC §6.4; src/weapons/weapons.js re-exports this table as WEAPONS)
  // `mountPrefix` selects hardpoints from the model manifest. `salvo` is per
  // mount. `arcDeg` is the PER-MOUNT TRAVERSE half-angle around the mount's
  // rest direction (research §6, "turret-level arcs"): centreline turrets train
  // broadly (150°), so bow-on is merely the *best* bearing rather than the only
  // one. The wave motion gun is the exception — it is fixed in the bow at ±3°,
  // and that narrow arc is the entire cost of the weapon (research §8).
  // ---------------------------------------------------------------------------
  weapons: {
    shock_cannon: {
      id: 'shock_cannon', displayName: 'Shock Cannon (主砲)', kind: 'shell',
      mountPrefix: 'turret_main', subsystemKind: 'turret_main', arcDeg: 150,
      damage: 90, salvo: 1, cooldown: 2.0, spread: 0.010,
      speed: 900, range: 2000, life: 2.6,
      shieldMultiplier: 1.00, armorMultiplier: 1.00,
      tracerWidth: 2.6, color: 0x6ce9fc, sound: 'shock_cannon',   // measured UNCF beam colour (research 03)
      aimAssist: 0.6, recoil: 0.6,
    },
    secondary_battery: {
      id: 'secondary_battery', displayName: 'Secondary Battery (副砲)', kind: 'shell',
      mountPrefix: 'turret_secondary', subsystemKind: 'turret_secondary', arcDeg: 120,
      damage: 22, salvo: 2, cooldown: 1.5, spread: 0.020,
      speed: 800, range: 1200, life: 1.8,
      shieldMultiplier: 1.00, armorMultiplier: 0.90,
      tracerWidth: 1.4, color: 0xa8ecff, sound: 'secondary',     // same family, dimmer
      aimAssist: 0.45, recoil: 0.2,
    },
    torpedo: {
      id: 'torpedo', displayName: 'Torpedo (魚雷)', kind: 'torpedo',
      mountPrefix: 'torpedo_tube', subsystemKind: null, arcDeg: 45,
      damage: 260, salvo: 4, cooldown: 12.0, spread: 0.030,
      speed: 300, range: 1500, life: 9,
      shieldMultiplier: 0.60, armorMultiplier: 1.50,
      homing: 0.55, homingDelay: 0.8, hp: 150,
      tracerWidth: 1.6, color: 0xffb060, sound: 'torpedo',
      smoke: true, aimAssist: 0.9,
    },
    missile: {
      id: 'missile', displayName: 'Missile (ミサイル)', kind: 'missile',
      mountPrefix: 'missile_launcher', subsystemKind: null, arcDeg: 120,
      damage: 60, salvo: 6, cooldown: 10.0, spread: 0.075,
      speed: 400, range: 2500, life: 10,
      shieldMultiplier: 1.00, armorMultiplier: 1.00,
      homing: 1.1, homingDelay: 0.35, hp: 120,
      tracerWidth: 1.2, color: 0xffcf7a, sound: 'missile',
      smoke: true, aimAssist: 0.7,
    },
    uncf_beam: {
      id: 'uncf_beam', displayName: 'Beam Turret (地球連邦光線砲)', kind: 'beam',
      mountPrefix: 'turret_main', subsystemKind: 'turret_main', arcDeg: 150,
      damage: 18, salvo: 2, cooldown: 3.0, spread: 0.028,
      speed: 1200, range: 1800, life: 1.6,
      shieldMultiplier: 1.00, armorMultiplier: 0.95,
      tracerWidth: 2.0, color: 0x7fc4ff, sound: 'beam',
      aimAssist: 0.55,
    },
    garmillas_beam: {
      id: 'garmillas_beam', displayName: 'Garmillas Beam (ガミラス光線砲)', kind: 'beam',
      mountPrefix: 'turret_main', subsystemKind: 'turret_main', arcDeg: 150,
      damage: 18, salvo: 2, cooldown: 3.0, spread: 0.028,
      speed: 1200, range: 1800, life: 1.6,
      shieldMultiplier: 1.00, armorMultiplier: 0.95,
      tracerWidth: 2.0, color: 0x9dff7a, sound: 'beam',
      aimAssist: 0.55,
    },
    bolar_beam: {
      id: 'bolar_beam', displayName: 'Bolar Beam (ボラー光線砲)', kind: 'beam',
      mountPrefix: 'turret_main', subsystemKind: 'turret_main', arcDeg: 150,
      damage: 21, salvo: 2, cooldown: 2.5, spread: 0.030,
      speed: 1100, range: 1700, life: 1.6,
      shieldMultiplier: 1.00, armorMultiplier: 0.95,
      tracerWidth: 2.4, color: 0x6ab86a, sound: 'beam',          // measured Bolar comet green (research 03)
      aimAssist: 0.55,
    },
    wmgun: {
      id: 'wmgun', displayName: 'Wave Motion Gun (波動砲)', kind: 'wmgun',
      mountPrefix: 'wave_motion_gun', subsystemKind: 'wmgun', arcDeg: 3,
      damage: 4800, salvo: 1, cooldown: 60, spread: 0.002,
      speed: 4000, range: 12000, life: 1.0,
      shieldMultiplier: 1.25, armorMultiplier: 1.40,
      chargeTime: 8.0, chargeDamage: 4800,
      tracerWidth: 16, beamRadius: 12, splashRadius: 180,
      color: 0xcfefff, sound: 'wmgun_fire', chargeSound: 'wmgun_charge',
      // Canon flavour: firing drains the wave-motion engine for a few seconds.
      postFireSpeedFactor: 0.6, postFireDuration: 4,
      aimAssist: 1.0, requiresArc: true,
    },
  },

  // ---------------------------------------------------------------------------
  // TURRET TRAVERSE — how fast a mount slews onto its target.
  // `arcDeg` on a weapon is the traverse LIMIT; these are the rates.
  // ---------------------------------------------------------------------------
  turrets: {
    traverseRateDeg: 55,      // deg/s about the mount's vertical axis
    settleToleranceDeg: 5,    // "on target" once within this of the aim bearing
    // A mount that cannot bear returns to rest rather than tracking.
    returnToRestWhenBlocked: true,
    // How far a mount may elevate. The renderer applies pitch as a fraction of
    // the traverse demand so guns visibly rise toward a high target.
    elevateRateDeg: 35,
    maxElevationDeg: 45,
  },

  // ---------------------------------------------------------------------------
  // FIRING MODES — 'manual' (player pulls the trigger) or 'auto' (lock a target
  // and the guns fire whenever they bear). Toggled with CONFIG.keys.toggleFireMode.
  // ---------------------------------------------------------------------------
  fireModes: {
    default: 'manual',
    order: ['manual', 'auto'],
    autoMinChargeRatio: 0.999,   // auto never releases a partial wave motion gun
    autoRequiresTarget: true,
  },

  // ---------------------------------------------------------------------------
  // POINT DEFENCE — continuous interception aura (research §1.4), not a weapon.
  // ---------------------------------------------------------------------------
  pointDefence: {
    range: 900,
    dpsPerMount: 20,
    maxTargetsPerMount: 2,
    targetKinds: ['missile', 'torpedo'],
  },

  // ---------------------------------------------------------------------------
  // WAVES — read by src/ai/fleetai.js spawnWave(); never hardcode ship ids there.
  // `bearingDeg` / `range` place the group relative to the player.
  // Enemy composition is research §1.6. UNCF escorts are our addition so the
  // battle reads as a fleet action (see docs/research/03). NOTE: escorts soak
  // fire, so the solo-player TTK model in research §9.4 is an upper bound on
  // difficulty; the verifier playtests against it.
  // ---------------------------------------------------------------------------
  waves: [
    {
      index: 0, id: 1,
      name: '第一波 — ガミラス前衛',
      banner: 'WAVE 1 — GARMILAS PATROL',
      allies: [
        { id: 'yukikaze', count: 2, bearingDeg: [-28, 28], range: 700, speed: 0.85 },
      ],
      enemies: [
        { id: 'garmillas_kelkapia', count: 3, bearingDeg: [-16, 0, 16], range: 3500, speed: 1.0 },
      ],
    },
    {
      index: 1, id: 2,
      name: '第二波 — ガミラス戦隊',
      banner: 'WAVE 2 — GARMILAS BATTLE GROUP',
      allies: [
        { id: 'yukikaze', count: 2, bearingDeg: [-32, 32], range: 700, speed: 0.85 },
        { id: 'kirishima', count: 1, bearingDeg: [0], range: 900, speed: 0.85 },
      ],
      enemies: [
        { id: 'garmillas_gaiderol', count: 1, bearingDeg: [0], range: 4200, speed: 0.95 },
        { id: 'garmillas_kelkapia', count: 1, bearingDeg: [22], range: 3800, speed: 1.0 },
      ],
    },
    {
      index: 2, id: 3,
      name: '最終波 — デスラー旗艦・ボラー連合',
      banner: 'WAVE 3 — DESSLER’S FLAGSHIP & BOLAR FEDERATION',
      allies: [
        { id: 'andromeda', count: 1, bearingDeg: [-18], range: 1100, speed: 0.85 },
        { id: 'yukikaze', count: 2, bearingDeg: [-40, 40], range: 700, speed: 0.85 },
      ],
      enemies: [
        { id: 'bolar_carrier', count: 1, bearingDeg: [24], range: 4500, speed: 0.9 },
        { id: 'garmillas_kelkapia', count: 2, bearingDeg: [-20, 4], range: 3800, speed: 1.0 },
      ],
    },
  ],

  waveLull: 10,            // seconds of calm between waves
  spawnDistance: 3500,
  spawnSpread: 400,
  spawnDelayPerShip: 0.6,
  wave1Delay: 8,
  waveBannerTime: 4.0,

  // ---------------------------------------------------------------------------
  // AI — research §1.7. `doctrines` is the canonical location; flat aliases are
  // attached below so either access style works.
  // ---------------------------------------------------------------------------
  ai: {
    doctrines: {
      garmillas: {
        accuracy: 0.55, aggression: 0.60, preferredRangeFactor: 0.80, broadsideBias: 0.70,   // §6: Garmillas fight broadside
        focusFire: true, focusFireSwitchCooldown: 8, reactionTime: 1.2,
        retreatHullThreshold: 0.25, formationSlotRadius: 1.5, formationSlotCount: 6,
        missileFireMinRange: 800, missileFireMaxRange: 2400,
        wmgunTelegraphTime: 2.5, dodgeWMGChance: 0.60,
      },
      bolar: {
        accuracy: 0.50, aggression: 0.75, preferredRangeFactor: 0.75, broadsideBias: 0.60,
        focusFire: true, focusFireSwitchCooldown: 6, reactionTime: 1.0,
        retreatHullThreshold: 0.15, formationSlotRadius: 1.2, formationSlotCount: 6,
        missileFireMinRange: 800, missileFireMaxRange: 2400,
        wmgunTelegraphTime: 2.5, dodgeWMGChance: 0.60,
      },
      uncf: {
        accuracy: 0.60, aggression: 0.50, preferredRangeFactor: 0.85, broadsideBias: 0.20,   // §6: Yamato's turrets are centreline -> bow-on
        focusFire: true, focusFireSwitchCooldown: 8, reactionTime: 1.0,
        retreatHullThreshold: 0.30, formationSlotRadius: 1.5, formationSlotCount: 6,
        missileFireMinRange: 800, missileFireMaxRange: 2400,
        wmgunTelegraphTime: 2.5, dodgeWMGChance: 0.70,
      },
    },
    // `player` is an extra weight (not in the research table): without it a
    // Yukikaze actively shooting outranked the Yamato and the enemy fleet
    // ignored the player entirely. Consumed by src/ai/fleetai.js.
    targetPriority: { threat: 0.45, role: 0.30, proximity: 0.25, player: 0.55 },
    roleValue: { flagship: 1.00, battleship: 0.90, carrier: 0.80, cruiser: 0.60, destroyer: 0.40 },
    threatRange: 4000,
    collisionAvoid: 260,
    formationTolerance: 320,
  },

  // ---------------------------------------------------------------------------
  // DAMAGE — strict layering; overflow carries to the next layer in the SAME hit.
  // ---------------------------------------------------------------------------
  damage: {
    layering: ['shield', 'armor', 'hull'],
    // Fraction of a hull-layer hit redirected to one random surviving subsystem.
    // Deliberately NOT applied to shield/armor-layer hits (research §1.9): doing
    // so strips the player's wave motion gun before the demo even starts.
    subsystemDamageFraction: 0.15,
    critChance: 0.08,          // 2x subsystem share on a crit
    friendlyFireScale: 0.15,
    // Subsystem HP is quoted for a Yamato-scale hull (research §1.9) and scaled
    // by hullMax/4400 so escorts do not carry battleship-grade subsystems.
    subsystemHp: {
      wmgun: 900, engine: 1200, turret_main: 600,
      turret_secondary: 400, bridge: 700, ciws: 200,
    },
    subsystemReferenceHull: 4400,
    subsystemScaleMin: 0.25,
    subsystemScaleMax: 1.5,
  },

  progression: {
    waveClearDelay: 6.0,
    waveBannerTime: 4.0,
    startWave: 0,
  },
};

// Flat doctrine aliases — `CONFIG.ai.garmillas` works as well as
// `CONFIG.ai.doctrines.garmillas`.
CONFIG.ai.garmillas = CONFIG.ai.doctrines.garmillas;
CONFIG.ai.bolar = CONFIG.ai.doctrines.bolar;
CONFIG.ai.uncf = CONFIG.ai.doctrines.uncf;

export default CONFIG;
