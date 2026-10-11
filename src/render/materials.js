/**
 * src/render/materials.js — the fixed material palette (SPEC §5.5).
 *
 * Materials are shared instances keyed by palette name, so N ships reuse the
 * same GPU programs. Emissive entries (engine nozzles, windows) are the ones
 * the bloom pass picks up.
 */

import * as THREE from 'three';

/** Fallback used when an OBJ references a name outside the palette. */
export const FALLBACK_MATERIAL = 'hull_grey';

/**
 * name -> { color, metalness, roughness, emissive, emissiveIntensity, opacity }
 * Values chosen so the fleet reads correctly under a single directional key
 * light plus a cool rim light.
 */
export const PALETTE = {
  hull_grey:   { color: 0x9aa1a9, metalness: 0.10, roughness: 0.62 },
  hull_red:    { color: 0xa8403a, metalness: 0.06, roughness: 0.70 },
  deck_dark:   { color: 0x474e57, metalness: 0.12, roughness: 0.78 },
  glass_blue:  { color: 0x1b3a52, metalness: 0.04, roughness: 0.18, emissive: 0x4f9fe0, emissiveIntensity: 1.05 },
  engine_glow: { color: 0x0d1620, metalness: 0.00, roughness: 0.35, emissive: 0x6fd0ff, emissiveIntensity: 0.70 },
  gun_metal:   { color: 0x6b727b, metalness: 0.28, roughness: 0.42 },
  accent_gold: { color: 0xd0ac52, metalness: 0.32, roughness: 0.34 },

  hull_green:  { color: 0x5a6a46, metalness: 0.08, roughness: 0.66 },
  hull_olive:  { color: 0x7a7f50, metalness: 0.08, roughness: 0.70 },
  hull_white:  { color: 0xe0e5ea, metalness: 0.05, roughness: 0.60 },
  hull_black:  { color: 0x262a30, metalness: 0.12, roughness: 0.72 },
  bolar_blue:  { color: 0x44679c, metalness: 0.10, roughness: 0.58 },
};

const cache = new Map();

function build(name) {
  const spec = PALETTE[name] || PALETTE[FALLBACK_MATERIAL];
  const mat = new THREE.MeshStandardMaterial({
    color: spec.color,
    metalness: spec.metalness,
    roughness: spec.roughness,
    emissive: spec.emissive ?? 0x000000,
    emissiveIntensity: spec.emissiveIntensity ?? 0,
    flatShading: false,
    side: THREE.FrontSide,
  });
  mat.name = name;
  return mat;
}

/** Shared material instance for a palette name. */
export function getMaterial(name) {
  const key = PALETTE[name] ? name : FALLBACK_MATERIAL;
  let m = cache.get(key);
  if (!m) { m = build(key); cache.set(key, m); }
  return m;
}

/**
 * Per-ship material set.
 *
 * Every ship gets its OWN material instances so that one ship's engine glow or
 * shield cannot change another's. Ownership matters here: the previous version
 * only tracked two hard-coded names, so an MTL-derived clone handed to a mesh
 * was invisible to both `setEngineIntensity()` and `dispose()` — the engine
 * glow silently stopped tracking throttle and every destroyed ship leaked two
 * materials.
 *
 * Meshes must therefore call `register(name, material)` with whatever material
 * they actually end up using.
 */
export function createShipMaterials(paletteNames = []) {
  const base = new Map();       // name -> this ship's base material
  const inUse = new Map();      // name -> Set of materials actually on meshes
  const owned = new Set();      // everything this ship must dispose

  function ensureBase(name) {
    if (base.has(name)) return base.get(name);
    const m = getMaterial(name).clone();      // clone from the shared palette
    m.name = name;
    base.set(name, m);
    owned.add(m);
    return m;
  }

  const set = {
    /** Base material for a palette name (this ship's own instance). */
    get(name) { return ensureBase(name); },

    /** Record the material a mesh actually uses, so it is updated and freed. */
    register(name, mat) {
      if (!mat) return mat;
      if (!inUse.has(name)) inUse.set(name, new Set());
      inUse.get(name).add(mat);
      owned.add(mat);
      return mat;
    },

    /** Drive every engine-glow material on this ship from 0 (dark) to ~2. */
    setEngineIntensity(v) {
      const value = 0.70 * Math.max(0, Math.min(2, v));
      const list = inUse.get('engine_glow');
      if (list) for (const m of list) m.emissiveIntensity = value;
      const b = base.get('engine_glow');
      if (b) b.emissiveIntensity = value;
    },

    /** Names this ship has material instances for (diagnostics/tests). */
    get names() { return [...inUse.keys()]; },

    dispose() {
      for (const m of owned) m.dispose();
      owned.clear();
      inUse.clear();
      base.clear();
    },
  };

  for (const n of paletteNames) set.get(n);
  return set;
}

/** Faction tint used by the radar/HUD so colours stay in one place. */
export const FACTION_COLORS = {
  uncf:      0x63b8ff,
  garmillas: 0x9dff6a,
  bolar:     0xff8a5c,
  neutral:   0xb9c4d0,
};

export function factionColor(faction) {
  return FACTION_COLORS[faction] ?? FACTION_COLORS.neutral;
}

/** CSS hex string for DOM HUD elements. */
export function factionCss(faction) {
  return `#${factionColor(faction).toString(16).padStart(6, '0')}`;
}

export function disposeMaterialCache() {
  for (const m of cache.values()) m.dispose();
  cache.clear();
}
