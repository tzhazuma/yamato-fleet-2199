/**
 * src/core/fallback_manifest.js — a manifest synthesised from CONFIG.
 *
 * WHY THIS EXISTS: the demo must never white-screen because a generated asset
 * is missing or mid-regeneration. If assets/models/manifest.json cannot be
 * fetched or parsed, main.js builds the fleet description from CONFIG.ships
 * instead, and src/core/assets.js substitutes placeholder geometry for the
 * missing OBJ files. Every hardpoint, weapon mount and subsystem then still
 * works, so the simulation is fully playable — it just looks like grey blocks.
 *
 * This is also what makes the game testable in CI without running the Python
 * generator first.
 */

import { CONFIG } from './config.js';

/**
 * @returns {object} a manifest matching the SPEC §5 schema
 */
export function buildFallbackManifest() {
  const models = [];

  for (const [id, s] of Object.entries(CONFIG.ships)) {
    const len = lengthFor(id);
    const beam = beamFor(id, len);
    const hardpoints = [];

    // Weapon mounts, spread along the centreline from bow to stern.
    for (const wid of s.weapons || []) {
      const spec = CONFIG.weapons[wid];
      if (!spec) continue;
      const count = Math.max(1, s.mounts?.[wid] ?? 1);

      if (spec.kind === 'wmgun') {
        hardpoints.push({
          name: 'wave_motion_gun',
          kind: 'wmgun',
          pos: [0, beam * 0.10, -len * 0.44],
          dir: [0, 0, -1],
        });
        continue;
      }

      for (let i = 0; i < count; i++) {
        const t = count > 1 ? i / (count - 1) : 0.5;
        let z;
        let y;
        let side = 0;
        switch (spec.mountPrefix) {
          case 'turret_main':
            z = -len * 0.26 + t * len * 0.52;
            y = beam * 0.16;
            break;
          case 'turret_secondary':
            z = -len * 0.34 + t * len * 0.68;
            y = beam * 0.14;
            side = i % 2 === 0 ? -1 : 1;
            break;
          case 'torpedo_tube':
            z = -len * 0.16 + t * len * 0.30;
            y = -beam * 0.02;
            side = i % 2 === 0 ? -1 : 1;
            break;
          case 'missile_launcher':
            z = len * 0.18 + t * len * 0.24;
            y = beam * 0.24;
            side = i % 2 === 0 ? -1 : 1;
            break;
          default:
            z = -len * 0.20 + t * len * 0.40;
            y = beam * 0.15;
            side = i % 2 === 0 ? -1 : 1;
            break;
        }
        hardpoints.push({
          name: `${spec.mountPrefix}_${i + 1}`,
          kind: spec.kind === 'missile' ? 'missile' : spec.kind === 'torpedo' ? 'torpedo' : 'turret',
          pos: [side * beam * 0.30, y, z],
          dir: [0, 0, -1],
        });
      }
    }

    // Point-defence mounts.
    for (let i = 0; i < (s.pdMounts || 0); i++) {
      const t = (s.pdMounts > 1) ? i / (s.pdMounts - 1) : 0.5;
      hardpoints.push({
        name: `ciws_${i + 1}`,
        kind: 'ciws',
        pos: [(i % 2 === 0 ? -1 : 1) * beam * 0.40, beam * 0.22, -len * 0.30 + t * len * 0.60],
        dir: [0, 0.3, -1],
      });
    }

    // Engines.
    hardpoints.push({ name: 'engine_1', kind: 'thruster', pos: [-beam * 0.20, 0, len * 0.46], dir: [0, 0, 1] });
    hardpoints.push({ name: 'engine_2', kind: 'thruster', pos: [beam * 0.20, 0, len * 0.46], dir: [0, 0, 1] });

    models.push({
      id,
      displayName: s.displayName || id,
      displayNameJa: s.displayName || id,
      faction: s.faction || 'neutral',
      shipClass: s.shipClass || 'unknown',
      role: s.role || 'ship',
      obj: `${id}.obj`,
      mtl: `${id}.mtl`,
      lengthM: len,
      beamM: beam,
      triangles: 0,
      groups: ['hull', 'superstructure', 'bridge', 'wave_motion_gun', 'engine_nozzle', 'turret_main', 'turret_secondary'],
      hardpoints,
      materials: s.faction === 'garmillas'
        ? ['hull_green', 'hull_olive', 'deck_dark', 'glass_blue', 'engine_glow', 'gun_metal']
        : s.faction === 'bolar'
          ? ['bolar_blue', 'hull_white', 'deck_dark', 'glass_blue', 'engine_glow', 'gun_metal']
          : ['hull_grey', 'hull_red', 'deck_dark', 'glass_blue', 'engine_glow', 'gun_metal', 'accent_gold'],
      _synthesised: true,
    });
  }

  return {
    schema: 'yamato-fleet/models@1',
    units: 'meters',
    axis: { forward: '-Z', up: '+Y' },
    models,
    _fallback: true,
    _note: 'Synthesised from CONFIG because assets/models/manifest.json was unavailable. Run `python3 tools/gen_models.py --out assets/models` for real geometry.',
  };
}

/** Canon-ish lengths, matching docs/SPEC.md §5 and the research doc. */
function lengthFor(id) {
  const table = {
    yamato: 333, andromeda: 444, kirishima: 222, yukikaze: 80,
    garmillas_dessler: 400, garmillas_kelkapia: 250, garmillas_gaiderol: 390,
    bolar_carrier: 380,
  };
  return table[id] ?? 240;
}

function beamFor(id, len) {
  const table = { yamato: 48, andromeda: 60, kirishima: 34, yukikaze: 14 };
  return table[id] ?? len / 7.5;
}

export default buildFallbackManifest;
