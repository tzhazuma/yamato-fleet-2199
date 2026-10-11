/**
 * tests/objparse.test.mjs — SPEC §7.7 / task-5 Deliverable 1.
 *
 * Pure-logic coverage for src/core/objparse.js: group names must survive
 * EXACTLY (they are a stable API, SPEC §5.3), quads must fan-triangulate, and a
 * malformed face must be skipped rather than throwing.
 *
 * Verifier-owned file. Never touches product code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOBJ, parseMTL } from '../src/core/objparse.js';

/* -------------------------------------------------------------------------- */
/* parseOBJ                                                                    */
/* -------------------------------------------------------------------------- */

const OBJ = `# synthetic OBJ — exercises every directive the generator emits
mtllib test_ship.mtl

# 8 vertices: a unit-ish box plus two loose ones
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 -1
v 1 0 -1
v 1 1 -1
v 0 1 -1

vn 0 0 -1
vn 0 0 1
vn 0 1 0

o hull
g hull
usemtl hull_grey
s off
f 1//1 2//1 3//1 4//1

g superstructure
usemtl deck_dark
f 5/1/2 6/1/2 7/1/2
f 5/1/2 7/1/2 8/1/2

g turret_main
usemtl gun_metal
# a face written with negative (relative) indices
f -8 -7 -6

# --- deliberately broken statements, must be skipped, not thrown -----------
f 1 2
f 99 98 97
fx 1 2 3
v
`;

/** The single triangle-bearing record for `name` in the fixture. */
const solidGroup = (r, name) => r.groups.filter((g) => g.name === name && g.triangleCount > 0);

test('parseOBJ: group names survive exactly and in file order', () => {
  const r = parseOBJ(OBJ);
  // Group identity is (name, material); `g X` + `usemtl Y` yields one empty
  // record and one solid record. Names must be byte-exact — no mangling,
  // lower-casing or material substitution (SPEC §5.3: stable API).
  const names = r.groups.map((g) => g.name);
  assert.deepEqual([...new Set(names)], ['hull', 'superstructure', 'turret_main']);
  for (const n of names) assert.ok(['hull', 'superstructure', 'turret_main'].includes(n));
  assert.deepEqual(r.groups.map((g) => g.triangleCount), [0, 2, 0, 2, 0, 1]);
});

test('parseOBJ: usemtl is tracked per group', () => {
  const r = parseOBJ(OBJ);
  assert.equal(solidGroup(r, 'hull')[0].material, 'hull_grey');
  assert.equal(solidGroup(r, 'superstructure')[0].material, 'deck_dark');
  assert.equal(solidGroup(r, 'turret_main')[0].material, 'gun_metal');
});

test('parseOBJ: mtllib is captured', () => {
  assert.equal(parseOBJ(OBJ).mtllib, 'test_ship.mtl');
});

test('parseOBJ: triangle counts — quad fans to 2, tris stay 1', () => {
  const r = parseOBJ(OBJ);
  assert.equal(solidGroup(r, 'hull')[0].triangleCount, 2, 'quad must fan-triangulate to 2 tris');
  assert.equal(solidGroup(r, 'superstructure')[0].triangleCount, 2);
  assert.equal(solidGroup(r, 'turret_main')[0].triangleCount, 1, 'negative indices must resolve');
  assert.equal(r.stats.triangles, 5);
  assert.equal(r.stats.faces, 4, 'only the 4 well-formed faces count');
});

test('parseOBJ: fan triangulation uses vertex 0 of the polygon', () => {
  const r = parseOBJ(OBJ);
  const hull = solidGroup(r, 'hull')[0];
  assert.equal(hull.vertexCount, 4, '4 unique (v/vn) pairs');
  assert.deepEqual(hull.indices, [0, 1, 2, 0, 2, 3]);
  assert.equal(hull.indices.length, 6);
});

test('parseOBJ: negative indices resolve relative to the end of the vertex list', () => {
  const r = parseOBJ(OBJ);
  const turret = solidGroup(r, 'turret_main')[0];
  // -8 -7 -6 against 8 vertices => vertices 1,2,3 => (0,0,0),(1,0,0),(1,1,0)
  assert.deepEqual(turret.positions, [0, 0, 0, 1, 0, 0, 1, 1, 0]);
});

test('parseOBJ: a malformed face is skipped, never thrown', () => {
  let r;
  assert.doesNotThrow(() => { r = parseOBJ(OBJ); });
  // f 1 2 (2 verts) + f 99 98 97 (out of range) + fx (unknown) + bare `v`
  assert.ok(r.warnings.length >= 1, 'expected a warning about skipped statements');
  assert.match(r.warnings.join(' '), /unsupported|ignored/);
  assert.equal(r.stats.faces, 4);
});

test('parseOBJ: a face that is entirely out of range is skipped without a group', () => {
  const r = parseOBJ('v 0 0 0\nv 1 0 0\ng hull\nf 10 11 12\n');
  assert.equal(r.stats.triangles, 0);
  assert.equal(r.stats.faces, 0);
});

test('parseOBJ: v/vt/vn refs, v//vn refs and bare v refs all parse', () => {
  const text = [
    'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0',
    'vt 0 0', 'vt 1 0', 'vt 1 1', 'vt 0 1',
    'vn 0 0 -1',
    'g hull', 'usemtl hull_grey',
    'f 1/1/1 2/2/1 3/3/1',
    'f 2//1 3//1 4//1',
    'f 1 2 3',
  ].join('\n');
  const r = parseOBJ(text);
  assert.equal(r.stats.triangles, 3);
  // Only one record carries geometry; `g hull` before `usemtl` opens an empty
  // record (see the group-identity test below). Filter to the real one.
  const solid = r.groups.filter((g) => g.triangleCount > 0);
  assert.equal(solid.length, 1);
  assert.equal(solid[0].name, 'hull');
  assert.equal(solid[0].material, 'hull_grey');
  // `f 1/1/1` and `f 1 2 3` reference the same position with different normal
  // keys, so the parser must keep them as distinct local vertices:
  // 3 from the first face, 1 new from the second, 3 new from the third.
  assert.equal(solid[0].vertexCount, 7);
});

test('parseOBJ: group identity is (name, material) — a `g` before `usemtl` opens an empty record', () => {
  // This mirrors the real generator output (`g hull` then `usemtl hull_grey`),
  // so the phantom record is expected behaviour, not a parse failure: the
  // renderer skips zero-triangle groups (src/core/assets.js).
  const text = 'v 0 0 0\nv 1 0 0\nv 1 1 0\ng hull\nusemtl hull_grey\nf 1 2 3\n';
  const r = parseOBJ(text);
  assert.deepEqual(r.groups.map((g) => g.name), ['hull', 'hull']);
  assert.deepEqual(r.groups.map((g) => g.material), [null, 'hull_grey']);
  assert.deepEqual(r.groups.map((g) => g.triangleCount), [0, 1]);
  assert.equal(r.stats.groups, 2);
});

test('parseOBJ: same group name with a different material yields separate records', () => {
  const text = 'v 0 0 0\nv 1 0 0\nv 1 1 0\ng hull\nusemtl hull_grey\nf 1 2 3\ng hull\nusemtl hull_red\nf 1 2 3\n';
  const r = parseOBJ(text);
  const solid = r.groups.filter((g) => g.triangleCount > 0);
  assert.deepEqual(solid.map((g) => g.name), ['hull', 'hull']);
  assert.deepEqual(solid.map((g) => g.material), ['hull_grey', 'hull_red']);
  assert.equal(r.stats.triangles, 2, 'the two faces are distinct geometry');
});

test('parseOBJ: faces before any g/usemtl land in the "default" group', () => {
  const r = parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n');
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].name, 'default');
  assert.equal(r.groups[0].material, null);
});

test('parseOBJ: comments, blank lines and CRLF do not break parsing', () => {
  const r = parseOBJ('# c\r\n\r\nv 0 0 0\r\nv 1 0 0\r\nv 1 1 0\r\n# mid\r\ng hull\r\nf 1 2 3\r\n');
  assert.equal(r.stats.triangles, 1);
  assert.equal(r.groups[0].name, 'hull');
});

test('parseOBJ: `o` also opens a group (generators emit o before g)', () => {
  const r = parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\no engine_nozzle\nf 1 2 3\n');
  assert.equal(r.groups[0].name, 'engine_nozzle');
});

test('parseOBJ: vn is optional — missing normals are written as the 0,0,0 sentinel', () => {
  const r = parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\ng hull\nf 1 2 3\n');
  assert.deepEqual(r.groups[0].normals, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('parseOBJ: empty input is not an error', () => {
  const r = parseOBJ('');
  assert.deepEqual(r.groups, []);
  assert.equal(r.stats.triangles, 0);
  assert.equal(r.warnings.length, 0);
});

/* -------------------------------------------------------------------------- */
/* parseMTL                                                                    */
/* -------------------------------------------------------------------------- */

const MTL = `# palette
newmtl hull_grey
Ka 0.10 0.10 0.12
Kd 0.42 0.45 0.50
Ks 0.20 0.20 0.20
Ns 48
d 1.0

newmtl engine_glow
Kd 0.10 0.60 1.00
Ke 0.10 0.60 1.00
d 0.85
`;

test('parseMTL: material names and packed diffuse colours', () => {
  const m = parseMTL(MTL);
  assert.equal(m.size, 2);
  assert.ok(m.has('hull_grey'));
  assert.ok(m.has('engine_glow'));
  const grey = m.get('hull_grey');
  // 0.42*255 = 107.1 -> 107 = 0x6b ; 0.45*255 = 114.75 -> 115 = 0x73 ; 0.50*255 = 127.5 -> 128 = 0x80
  assert.equal(grey.diffuse, (107 << 16) | (115 << 8) | 128);
  assert.equal(grey.shininess, 48);
  assert.equal(grey.opacity, 1);
});

test('parseMTL: Ke (emissive) is captured, defaults are sane', () => {
  const m = parseMTL(MTL);
  const glow = m.get('engine_glow');
  assert.equal(glow.emissive, (26 << 16) | (153 << 8) | 255);
  assert.equal(glow.opacity, 0.85);
  // No Ke on hull_grey.
  assert.equal(m.get('hull_grey').emissive, null);
  // Documented defaults for a material that only declares newmtl.
  const bare = parseMTL('newmtl bare\n');
  assert.equal(bare.get('bare').diffuse, 0x808080);
  assert.equal(bare.get('bare').specular, 0x111111);
  assert.equal(bare.get('bare').shininess, 24);
});

test('parseMTL: Tr is the inverse of opacity, Kd clamps out-of-range values', () => {
  const m = parseMTL('newmtl x\nTr 0.25\nKd 2.0 -1.0 0.5\n');
  const x = m.get('x');
  assert.equal(x.opacity, 0.75);
  assert.equal(x.diffuse, (255 << 16) | (0 << 8) | 128);
});

test('parseMTL: property lines before any newmtl are ignored, not fatal', () => {
  let m;
  assert.doesNotThrow(() => { m = parseMTL('Kd 1 1 1\nnewmtl a\nKd 1 1 1\n'); });
  assert.equal(m.size, 1);
});
