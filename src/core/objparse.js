/**
 * src/core/objparse.js — minimal, dependency-free Wavefront OBJ + MTL parser.
 *
 * WHY NOT three's OBJLoader: three names the resulting meshes after the
 * *material*, so the `g <group>` names our asset contract depends on
 * (SPEC §5.3) are not reliably preserved. This parser keeps groups exact, and
 * being pure logic it is unit-testable under `node --test` (SPEC §2).
 *
 * Supported directives: v, vn, vt, f, g, o, s (ignored), usemtl, mtllib, #.
 * Faces may be `v`, `v/vt`, `v//vn`, or `v/vt/vn`; polygons are fan-triangulated.
 * Unknown directives are counted, not fatal.
 */

/** Parse a `v`/`vn`/`vt` line's numbers (index 1..n). */
function numbers(parts, from = 1) {
  const out = [];
  for (let i = from; i < parts.length; i++) {
    const v = parseFloat(parts[i]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * @param {string} text OBJ file contents
 * @returns {{mtllib:string|null, groups:Array, stats:Object, warnings:string[]}}
 *   groups: [{ name, material, positions:number[], normals:number[], indices:number[], vertexCount, triangleCount }]
 */
export function parseOBJ(text) {
  const positions = [];   // flat xyz, global
  const normals = [];     // flat xyz, global
  const groups = [];
  const byKey = new Map();  // "group\u0000material" -> group record
  const warnings = [];
  let current = null;
  let currentGroupName = 'default';
  let currentMaterial = null;
  let mtllib = null;
  let faceCount = 0;
  let skipped = 0;

  function groupFor(name, material) {
    const key = `${name}\u0000${material ?? ''}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        name: name || 'default',
        material: material ?? null,
        positions: [], normals: [], indices: [],
        _map: new Map(),
        vertexCount: 0, triangleCount: 0,
      };
      byKey.set(key, g);
      groups.push(g);
    }
    return g;
  }

  function vertexIndex(raw, total) {
    // OBJ indices are 1-based; negative values are relative to the end.
    let i = parseInt(raw, 10);
    if (!Number.isFinite(i) || i === 0) return -1;
    if (i < 0) i = total + i + 1;
    return i - 1;
  }

  function localVertex(g, vi, ni) {
    const key = `${vi}/${ni}`;
    const existing = g._map.get(key);
    if (existing !== undefined) return existing;
    const idx = g.vertexCount++;
    g._map.set(key, idx);
    g.positions.push(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]);
    if (ni >= 0 && normals.length) {
      g.normals.push(normals[ni * 3], normals[ni * 3 + 1], normals[ni * 3 + 2]);
    } else {
      g.normals.push(0, 0, 0);   // sentinel: caller recomputes
    }
    return idx;
  }

  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.trim();
    if (!line || line.charCodeAt(0) === 35 /* # */) continue;

    const parts = line.split(/\s+/);
    const tag = parts[0];

    switch (tag) {
      case 'v': {
        const n = numbers(parts);
        positions.push(n[0] || 0, n[1] || 0, n[2] || 0);
        break;
      }
      case 'vn': {
        const n = numbers(parts);
        normals.push(n[0] || 0, n[1] || 0, n[2] || 0);
        break;
      }
      case 'vt':
        break;                                  // textures unused by design
      case 'g':
      case 'o': {
        currentGroupName = parts.slice(1).join(' ') || 'default';
        current = groupFor(currentGroupName, currentMaterial);
        break;
      }
      case 'usemtl': {
        currentMaterial = parts.slice(1).join(' ') || null;
        current = groupFor(currentGroupName, currentMaterial);
        break;
      }
      case 'mtllib': {
        mtllib = parts.slice(1).join(' ') || null;
        break;
      }
      case 's':
        break;                                  // smoothing groups are ignored
      case 'f': {
        if (!current) current = groupFor(currentGroupName, currentMaterial);
        const verts = [];
        for (let i = 1; i < parts.length; i++) {
          const comps = parts[i].split('/');
          const vi = vertexIndex(comps[0], positions.length / 3);
          if (vi < 0 || vi * 3 >= positions.length) { skipped++; continue; }
          const ni = comps.length > 2 && comps[2] ? vertexIndex(comps[2], normals.length / 3) : -1;
          verts.push([vi, ni]);
        }
        if (verts.length < 3) { skipped++; break; }
        faceCount++;
        // Fan triangulation — correct for the convex quads/polygons we emit.
        for (let i = 1; i < verts.length - 1; i++) {
          const tri = [verts[0], verts[i], verts[i + 1]];
          for (const [vi, ni] of tri) current.indices.push(localVertex(current, vi, ni));
          current.triangleCount++;
        }
        break;
      }
      default:
        skipped++;
        break;
    }
  }

  if (skipped > 0) warnings.push(`${skipped} unsupported/ignored OBJ statement(s)`);
  for (const g of groups) delete g._map;

  const triangles = groups.reduce((a, g) => a + g.triangleCount, 0);
  return {
    mtllib,
    groups,
    warnings,
    stats: {
      vertices: positions.length / 3,
      normals: normals.length / 3,
      faces: faceCount,
      triangles,
      groups: groups.length,
    },
  };
}

/**
 * Parse an MTL file.
 * @returns {Map<string, {name, diffuse:number, specular:number, ambient:number,
 *          shininess:number, opacity:number, emissive:number|null}>}
 * Colours are packed 0xRRGGBB integers so callers need no colour library.
 */
export function parseMTL(text) {
  const out = new Map();
  let cur = null;

  const toHex = (parts) => {
    const r = Math.round(Math.min(1, Math.max(0, parseFloat(parts[1]) || 0)) * 255);
    const g = Math.round(Math.min(1, Math.max(0, parseFloat(parts[2]) || 0)) * 255);
    const b = Math.round(Math.min(1, Math.max(0, parseFloat(parts[3]) || 0)) * 255);
    return (r << 16) | (g << 8) | b;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.charCodeAt(0) === 35) continue;
    const parts = line.split(/\s+/);
    switch (parts[0]) {
      case 'newmtl':
        cur = {
          name: parts.slice(1).join(' '),
          diffuse: 0x808080, specular: 0x111111, ambient: 0x000000,
          shininess: 24, opacity: 1, emissive: null,
        };
        out.set(cur.name, cur);
        break;
      case 'Kd': if (cur) cur.diffuse = toHex(parts); break;
      case 'Ks': if (cur) cur.specular = toHex(parts); break;
      case 'Ka': if (cur) cur.ambient = toHex(parts); break;
      case 'Ke': if (cur) cur.emissive = toHex(parts); break;
      case 'Ns': if (cur) cur.shininess = parseFloat(parts[1]) || 24; break;
      case 'd':  if (cur) cur.opacity = parseFloat(parts[1]) ?? 1; break;
      case 'Tr': if (cur) cur.opacity = 1 - (parseFloat(parts[1]) || 0); break;
      default: break;
    }
  }
  return out;
}

export default { parseOBJ, parseMTL };
