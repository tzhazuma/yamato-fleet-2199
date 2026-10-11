/**
 * tests/fallback_manifest.test.mjs — SPEC §7.7 / task-5 Deliverable 1.
 *
 * src/core/fallback_manifest.js is the "never white-screen" path: if
 * assets/models/manifest.json cannot be fetched, main.js builds the fleet from
 * CONFIG instead. That path must produce a SPEC §5-shaped manifest with a
 * usable hardpoint for every weapon, or the demo degrades to a grey box that
 * cannot shoot.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFallbackManifest } from '../src/core/fallback_manifest.js';
import { CONFIG } from '../src/core/config.js';

const manifest = buildFallbackManifest();

test('fallback manifest declares the SPEC §5 schema, units and axis', () => {
  assert.equal(manifest.schema, 'yamato-fleet/models@1');
  assert.equal(manifest.units, 'meters');
  assert.deepEqual(manifest.axis, { forward: '-Z', up: '+Y' });
  assert.ok(Array.isArray(manifest.models));
});

test('fallback manifest has exactly one entry per CONFIG.ships key', () => {
  assert.deepEqual(
    manifest.models.map((m) => m.id).sort(),
    Object.keys(CONFIG.ships).sort(),
  );
  const ids = manifest.models.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate model ids');
});

test('every fallback entry carries the SPEC §5 fields', () => {
  const PALETTE = new Set(['hull_grey', 'hull_red', 'deck_dark', 'glass_blue', 'engine_glow',
    'gun_metal', 'accent_gold', 'hull_green', 'hull_olive', 'hull_white', 'hull_black', 'bolar_blue']);
  for (const m of manifest.models) {
    for (const f of ['id', 'displayName', 'displayNameJa', 'faction', 'shipClass', 'role',
      'obj', 'mtl', 'lengthM', 'beamM', 'triangles', 'groups', 'hardpoints', 'materials']) {
      assert.ok(m[f] !== undefined && m[f] !== null, `${m.id}: missing field "${f}"`);
    }
    assert.equal(m.obj, `${m.id}.obj`);
    assert.equal(m.mtl, `${m.id}.mtl`);
    assert.ok(m.lengthM > 0 && m.beamM > 0, `${m.id}: non-positive dimensions`);
    assert.ok(['uncf', 'garmillas', 'bolar'].includes(m.faction), `${m.id}: bad faction ${m.faction}`);
    assert.ok(['battleship', 'cruiser', 'destroyer', 'carrier', 'flagship'].includes(m.role),
      `${m.id}: bad role ${m.role}`);
    assert.ok(Array.isArray(m.materials) && m.materials.length > 0, `${m.id}: no materials`);
    for (const mat of m.materials) {
      assert.ok(PALETTE.has(mat), `${m.id}: material "${mat}" is outside the SPEC §5 palette`);
    }
    assert.ok(Array.isArray(m.groups) && m.groups.length > 0, `${m.id}: no groups`);
  }
});

test('every fallback hardpoint has a valid name, kind and finite position/direction', () => {
  const KINDS = new Set(['wmgun', 'turret', 'torpedo', 'missile', 'thruster', 'ciws', 'generic']);
  for (const m of manifest.models) {
    assert.ok(m.hardpoints.length > 0, `${m.id}: no hardpoints`);
    const names = new Set();
    for (const hp of m.hardpoints) {
      assert.equal(typeof hp.name, 'string', `${m.id}: hardpoint without a name`);
      assert.match(hp.name, /^[a-z0-9_]+$/, `${m.id}: hardpoint name "${hp.name}" is not a clean id`);
      assert.ok(!names.has(hp.name), `${m.id}: duplicate hardpoint "${hp.name}"`);
      names.add(hp.name);
      assert.ok(KINDS.has(hp.kind), `${m.id}/${hp.name}: bad kind "${hp.kind}"`);
      assert.ok(Array.isArray(hp.pos) && hp.pos.length === 3, `${m.id}/${hp.name}: pos must be [x,y,z]`);
      assert.ok(hp.pos.every(Number.isFinite), `${m.id}/${hp.name}: non-finite pos`);
      assert.ok(Array.isArray(hp.dir) && hp.dir.length === 3, `${m.id}/${hp.name}: dir must be [x,y,z]`);
      assert.ok(hp.dir.every(Number.isFinite), `${m.id}/${hp.name}: non-finite dir`);
      assert.ok(Math.hypot(...hp.dir) > 1e-6, `${m.id}/${hp.name}: zero-length dir`);
    }
  }
});

test('every weapon on every ship has a matching hardpoint family in the fallback', () => {
  for (const m of manifest.models) {
    const names = m.hardpoints.map((h) => h.name);
    const stats = CONFIG.ships[m.id];
    for (const wid of Object.keys(stats.mounts)) {
      const prefix = CONFIG.weapons[wid].mountPrefix;
      const matches = names.filter((n) => n.startsWith(prefix));
      assert.ok(matches.length > 0, `${m.id}: no fallback hardpoint for ${wid} (prefix "${prefix}")`);
      if (wid === 'wmgun') {
        assert.ok(names.includes('wave_motion_gun'), `${m.id}: wmgun needs the canonical hardpoint name`);
      }
    }
    // Engines are needed for the engine-glow and drain logic.
    assert.ok(names.some((n) => n.startsWith('engine')), `${m.id}: no engine hardpoint`);
    assert.equal(
      names.filter((n) => n.startsWith('ciws')).length,
      stats.pdMounts,
      `${m.id}: ciws hardpoint count must equal pdMounts`,
    );
  }
});

test('hardpoints sit inside the hull envelope (bow -L/2 .. stern +L/2)', () => {
  for (const m of manifest.models) {
    const half = m.lengthM / 2;
    for (const hp of m.hardpoints) {
      assert.ok(
        hp.pos[2] >= -half - 1e-6 && hp.pos[2] <= half + 1e-6,
        `${m.id}/${hp.name}: z=${hp.pos[2]} outside the ${m.lengthM} m hull`,
      );
      assert.ok(Math.abs(hp.pos[0]) <= m.beamM, `${m.id}/${hp.name}: x=${hp.pos[0]} outside the beam`);
      assert.ok(Math.abs(hp.pos[1]) <= m.beamM, `${m.id}/${hp.name}: y=${hp.pos[1]} outside the beam`);
    }
  }
});

test('fallback lengths match SPEC §5 / research §1.1', () => {
  const expected = {
    yamato: 333, andromeda: 444, kirishima: 222, yukikaze: 80,
    garmillas_dessler: 400, garmillas_kelkapia: 250,
    garmillas_gaiderol: 390, bolar_carrier: 380,
  };
  for (const m of manifest.models) {
    assert.equal(m.lengthM, expected[m.id], `${m.id} length`);
  }
});

test('the fallback manifest JSON-round-trips without loss', () => {
  const round = JSON.parse(JSON.stringify(manifest));
  assert.deepEqual(round, manifest);
  // And the fields src/core/assets.js actually reads survive.
  for (const m of round.models) {
    assert.ok(m.obj && m.mtl && Array.isArray(m.hardpoints));
    for (const hp of m.hardpoints) {
      assert.ok(Array.isArray(hp.pos) && hp.pos.length === 3);
      assert.ok(Array.isArray(hp.dir) && hp.dir.length === 3);
    }
  }
});

test('fallback manifest is flagged so a caller can tell it apart', () => {
  assert.equal(manifest._fallback, true);
  assert.ok(typeof manifest._note === 'string' && manifest._note.length > 0);
});

test('buildFallbackManifest is pure — two calls produce identical output', () => {
  assert.deepEqual(buildFallbackManifest(), buildFallbackManifest());
});

test('fallback materials use faction-appropriate palettes', () => {
  const byId = new Map(manifest.models.map((m) => [m.id, m]));
  assert.ok(byId.get('yamato').materials.includes('hull_red'));
  assert.ok(byId.get('garmillas_dessler').materials.includes('hull_green'));
  assert.ok(byId.get('bolar_carrier').materials.includes('bolar_blue'));
});
