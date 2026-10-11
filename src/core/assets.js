/**
 * src/core/assets.js — manifest + OBJ/MTL loading and ship-model assembly
 * (SPEC §6.1).
 *
 * Every model is built from the palette materials, tagged with its group name,
 * and paired with a hardpoint map the weapon system fires from. Loading is
 * defensive: a missing or malformed model degrades to a generated placeholder
 * rather than killing the demo.
 */

import * as THREE from 'three';
import { parseOBJ, parseMTL } from './objparse.js';
import { createShipMaterials, getMaterial, FALLBACK_MATERIAL } from '../render/materials.js';

const MANIFEST_URL = './assets/models/manifest.json';

/** Indexed, individually-traversable turret groups (SPEC §5 rule 3). */
export const TURRET_GROUP_RE = /^(turret_main|turret_secondary|ciws|missile_launcher|torpedo_tube)_\d+$/;
const modelCache = new Map();
let manifestCache = null;

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Load and lightly validate the model manifest. */
export async function loadManifest(url = MANIFEST_URL) {
  if (manifestCache && url === MANIFEST_URL) return manifestCache;
  const text = await fetchText(url);
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${err.message}`);
  }
  if (!data || !Array.isArray(data.models)) {
    throw new Error('manifest.json is missing the "models" array');
  }
  data.models.forEach((m, i) => {
    if (!m.id) throw new Error(`manifest model #${i} has no id`);
    if (!m.obj) throw new Error(`manifest model "${m.id}" has no obj filename`);
  });
  if (url === MANIFEST_URL) manifestCache = data;
  return data;
}

export function getModelDef(manifest, id) {
  const def = manifest.models.find((m) => m.id === id);
  if (!def) {
    const known = manifest.models.map((m) => m.id).join(', ');
    throw new Error(`unknown ship model "${id}" (manifest has: ${known})`);
  }
  return def;
}

export function listModelIds(manifest) { return manifest.models.map((m) => m.id); }

/* -------------------------------------------------------------------------- */
/* Geometry assembly                                                          */
/* -------------------------------------------------------------------------- */

function geometryFromGroup(g) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3));
  if (g.normals && g.normals.length === g.positions.length) {
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.normals, 3));
    // The parser writes (0,0,0) when a face had no vn — recompute just those.
    const arr = geo.getAttribute('normal').array;
    let degenerate = false;
    for (let i = 0; i < arr.length; i += 3) {
      if (arr[i] === 0 && arr[i + 1] === 0 && arr[i + 2] === 0) { degenerate = true; break; }
    }
    if (degenerate) { geo.deleteAttribute('normal'); geo.computeVertexNormals(); }
  } else {
    geo.computeVertexNormals();
  }
  geo.setIndex(g.indices);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Emergency placeholder PARTS so a missing OBJ never blanks the screen.
 * Returns the same {group, materialName, geometry} shape the real loader
 * produces, with every transform baked into the geometry so instances need no
 * per-mesh positioning.
 */
function buildPlaceholderParts(def) {
  const len = def.lengthM || 200;
  const beam = def.beamM || len / 7;
  const hullMat = def.faction === 'garmillas' ? 'hull_green'
    : def.faction === 'bolar' ? 'bolar_blue' : FALLBACK_MATERIAL;

  const tower = new THREE.BoxGeometry(beam * 0.3, beam * 0.7, len * 0.12);
  tower.translate(0, beam * 0.5, len * 0.05);
  const nozzle = new THREE.CylinderGeometry(beam * 0.22, beam * 0.26, len * 0.05, 12);
  nozzle.rotateX(Math.PI / 2);
  nozzle.translate(0, 0, len * 0.5);

  return [
    { group: 'hull', materialName: hullMat, geometry: new THREE.BoxGeometry(beam, beam * 0.45, len), mtlSpec: null },
    { group: 'bridge', materialName: 'deck_dark', geometry: tower, mtlSpec: null },
    { group: 'engine_nozzle', materialName: 'engine_glow', geometry: nozzle, mtlSpec: null },
  ];
}

export async function loadShipModel(def, { basePath = './assets/models/' } = {}) {
  if (modelCache.has(def.id)) return modelCache.get(def.id);

  const promise = (async () => {
    let parts = [];                 // { group, materialName, geometry, mtlSpec }
    let triangles = 0;
    let warnings = [];
    let placeholder = false;

    try {
      const objText = await fetchText(basePath + def.obj);
      const parsed = parseOBJ(objText);
      warnings = parsed.warnings;

      // Material overrides from the MTL, if present and fetchable.
      let mtl = new Map();
      if (def.mtl) {
        try { mtl = parseMTL(await fetchText(basePath + def.mtl)); }
        catch { warnings.push(`mtl ${def.mtl} unavailable — using palette defaults`); }
      }

      for (const g of parsed.groups) {
        if (!g.triangleCount) continue;
        const matName = g.material || FALLBACK_MATERIAL;
        parts.push({
          group: g.name,
          materialName: matName,
          geometry: geometryFromGroup(g),
          mtlSpec: mtl.get(matName) || null,
        });
        triangles += g.triangleCount;
      }
      if (!parts.length) throw new Error('OBJ contained no faces');
    } catch (err) {
      console.warn(`[assets] ${def.id}: ${err.message} — using placeholder`);
      placeholder = true;
      triangles = 12;
      warnings.push(err.message);
      parts = buildPlaceholderParts(def);
    }

    // Bounds from the shared geometry, so every instance agrees.
    const bounds = new THREE.Box3();
    for (const part of parts) {
      part.geometry.computeBoundingBox();
      bounds.union(part.geometry.boundingBox);
    }
    const size = bounds.getSize(new THREE.Vector3());

    // Hardpoints: manifest values, with synthesised fallbacks so weapons always
    // have somewhere to fire from even if the generator omitted a mount.
    const hardpoints = new Map();
    for (const hp of def.hardpoints || []) {
      if (!hp || !hp.name || !Array.isArray(hp.pos)) continue;
      const dir = Array.isArray(hp.dir) ? hp.dir : [0, 0, -1];
      hardpoints.set(hp.name, {
        name: hp.name,
        kind: hp.kind || 'generic',
        pos: new THREE.Vector3(hp.pos[0] || 0, hp.pos[1] || 0, hp.pos[2] || 0),
        dir: new THREE.Vector3(dir[0] || 0, dir[1] || 0, dir[2] || 0).normalize(),
      });
    }
    ensureFallbackHardpoints(hardpoints, def, size);

    const template = {
      def, hardpoints, bounds, size, triangles, placeholder, warnings,
      groupNames: [...new Set(parts.map((x) => x.group))],

      /**
       * Build a renderable for ONE ship.
       *
       * This must be called per ship: a THREE.Object3D can only have one parent,
       * so handing every ship of a class the same Group silently re-parented it
       * and only the last writer was ever drawn — 4 of the 6 wave-1 ships were
       * invisible. Geometry is shared (it is immutable and expensive), but
       * materials are per ship so one ship's engine glow or shield cannot
       * change another's.
       */
      createInstance() {
        const materials = createShipMaterials(def.materials || []);
        const root = new THREE.Group();
        root.name = def.id;
        const groups = new Map();
        for (const part of parts) {
          let mat = materials.get(part.materialName);
          if (part.mtlSpec && part.mtlSpec.diffuse !== 0x808080) {
            mat = mat.clone();
            mat.name = part.materialName;
            mat.color = new THREE.Color(part.mtlSpec.diffuse);
            if (part.mtlSpec.emissive !== null) {
              mat.emissive = new THREE.Color(part.mtlSpec.emissive);
              mat.emissiveIntensity = 1.6;
            }
          }
          // Register whatever the mesh actually receives. Without this an
          // MTL-derived clone is invisible to setEngineIntensity() and dispose().
          materials.register(part.materialName, mat);
          const mesh = new THREE.Mesh(part.geometry, mat);
          mesh.name = part.group;                 // OBJ `g` group — stable API
          mesh.userData.group = part.group;
          mesh.userData.material = part.materialName;
          // An INDEXED turret group is authored centred on its own pivot
          // (SPEC §5 rule 3), so the renderer places it at the matching
          // hardpoint and can then traverse it about its local +Y.
          const pivotHp = hardpoints.get(part.group);
          if (pivotHp && TURRET_GROUP_RE.test(part.group)) {
            mesh.position.copy(pivotHp.pos);
            mesh.matrixAutoUpdate = true;          // traverse updates it per frame
            mesh.userData.turret = true;
            mesh.userData.pivot = pivotHp.pos.clone();
          } else {
            mesh.matrixAutoUpdate = false;         // ship parts never move alone
          }
          mesh.updateMatrix();
          root.add(mesh);
          if (!groups.has(part.group)) groups.set(part.group, []);
          groups.get(part.group).push(mesh);
        }
        return { object3D: root, materials, groups };
      },

      /** All hardpoints whose name starts with `prefix` (SPEC §6.4). */
      mountsFor(prefix) {
        const out = [];
        for (const hp of hardpoints.values()) if (hp.name.startsWith(prefix)) out.push(hp);
        return out;
      },
    };
    return template;
  })();

  modelCache.set(def.id, promise);
  return promise;
}

/**
 * Guarantee that each weapon family has at least one mount. Positions are
 * derived from the model's real bounding box, so this works for any ship.
 */
function ensureFallbackHardpoints(hardpoints, def, size) {
  const len = def.lengthM || size.z || 200;
  const beam = def.beamM || size.x || len / 7;
  const bow = -len / 2;
  const stern = len / 2;

  const add = (name, kind, pos, dir) => {
    if (!hardpoints.has(name)) {
      hardpoints.set(name, {
        name, kind,
        pos: new THREE.Vector3(pos[0], pos[1], pos[2]),
        dir: new THREE.Vector3(dir[0], dir[1], dir[2]).normalize(),
      });
    }
  };
  const count = (prefix) => [...hardpoints.keys()].filter((k) => k.startsWith(prefix)).length;

  if (count('wave_motion_gun') === 0) {
    add('wave_motion_gun', 'wmgun', [0, 0, bow + len * 0.06], [0, 0, -1]);
  }
  if (count('turret_main') === 0) {
    add('turret_main_1', 'turret', [0, beam * 0.18, bow + len * 0.16], [0, 0, -1]);
    add('turret_main_2', 'turret', [0, beam * 0.18, bow + len * 0.30], [0, 0, -1]);
    add('turret_main_3', 'turret', [0, beam * 0.18, stern - len * 0.16], [0, 0, 1]);
  }
  if (count('turret_secondary') === 0) {
    for (let i = 0; i < 4; i++) {
      const z = bow + len * (0.22 + i * 0.18);
      const side = i % 2 === 0 ? -1 : 1;
      add(`turret_secondary_${i + 1}`, 'turret', [side * beam * 0.34, beam * 0.16, z], [0, 0, -1]);
    }
  }
  if (count('ciws') === 0) {
    for (let i = 0; i < 6; i++) {
      const z = bow + len * (0.14 + i * 0.14);
      const side = i % 2 === 0 ? -1 : 1;
      add(`ciws_${i + 1}`, 'ciws', [side * beam * 0.40, beam * 0.20, z], [0, 0.25, -1]);
    }
  }
  if (count('torpedo_tube') === 0) {
    for (let i = 0; i < 3; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      add(`torpedo_tube_${i + 1}`, 'torpedo', [side * beam * 0.26, -beam * 0.02, bow + len * (0.34 + i * 0.10)], [0, 0, -1]);
    }
  }
  if (count('missile_launcher') === 0) {
    for (let i = 0; i < 4; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      add(`missile_launcher_${i + 1}`, 'missile', [side * beam * 0.30, beam * 0.30, stern - len * (0.06 + i * 0.05)], [0, 0.35, 1]);
    }
  }
  if (count('engine') === 0) {
    add('engine_1', 'thruster', [-beam * 0.22, 0, stern - len * 0.02], [0, 0, 1]);
    add('engine_2', 'thruster', [beam * 0.22, 0, stern - len * 0.02], [0, 0, 1]);
  }
}

/** Drop cached models — used by tests and hot-reload. */
export function clearModelCache() { modelCache.clear(); manifestCache = null; }
