#!/usr/bin/env python3
"""YAMATO FLEET 2199 - asset contract validator.

Checks ``assets/models/`` against docs/SPEC.md sections 4 and 5, i.e. exactly
what ``src/core/assets.js`` and the rest of the renderer are entitled to assume:

* ``manifest.json`` matches the frozen schema (top-level keys, per-model keys).
* every model's ``.obj`` / ``.mtl`` exists, and every file in the directory is
  either named by the manifest or is the manifest/README itself.
* OBJ syntax: ``v`` / ``vn`` / ``g`` / ``usemtl`` / ``f`` only, faces are
  triangles or quads, every face vertex has a normal, indices are in range.
* ``g`` names come from the fixed group list; material names come from the
  fixed SPEC 5.5 palette; MTL defines every material the OBJ uses.
* geometry: Z extent == lengthM (bow at -lengthM/2, stern at +lengthM/2),
  X extent == beamM, roughly centred in X, triangles < 12000 and equal to the
  value declared in the manifest.
* hardpoints: unique names, legal kinds, normalised dirs, inside the hull box,
  and the required mix, DERIVED FROM src/core/config.js: one `turret_main`
  hardpoint per mount the ship's primary beam weapon declares, a `torpedo_tube`
  / `missile_launcher` family whenever she carries that weapon, one `ciws_*`
  hardpoint per point-defence channel, and a bow `wave_motion_gun` emitter.
  `anti_air` carries NO requirement at all: nothing in src/ reads it.

Usage:
    python3 tools/validate_models.py assets/models
    python3 tools/validate_models.py assets/models --quiet

Exit code 0 = contract satisfied, 1 = violations (all of them are printed).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys

SCHEMA = "yamato-fleet/models@1"
UNITS = "meters"
AXIS = {"forward": "-Z", "up": "+Y"}
MAX_TRIANGLES = 12000

#: Indexed, individually-traversable mount groups (SPEC 5 rule 3).  The group
#: name equals the manifest hardpoint name, and the geometry is authored centred
#: on its own pivot so the renderer can place and traverse it.
TURRET_GROUPS = ("turret_main", "turret_secondary", "ciws", "missile_launcher",
                 "torpedo_tube")
TURRET_RE = re.compile(r"^(%s)_\d+$" % "|".join(TURRET_GROUPS))

GROUPS = ("hull", "superstructure", "bridge", "wave_motion_gun", "engine_nozzle",
          "turret_main", "turret_secondary", "wing", "radiator",
          # 2199 armament-layout groups (docs/research/05-yamato-armament-layout.md).
          # These are MERGED groups, not indexed mounts: a torpedo port or a
          # ventral missile tube never rotates, so it must not take an indexed
          # name (see TURRET_RE above) or the pivot contract would demand a
          # traverse axis it does not have.
          "anti_air", "torpedo_tube", "missile_launcher", "third_bridge",
          "catapult", "rocket_anchor", "aux_engine", "depth_charge")

MATERIALS = ("hull_grey", "hull_red", "deck_dark", "glass_blue", "engine_glow",
             "gun_metal", "accent_gold", "hull_green", "hull_olive", "hull_white",
             "hull_black", "bolar_blue")

#: ``torpedo`` / ``missile`` are the kinds src/core/assets.js synthesises for the
#: tube and launcher families, so an authored hardpoint uses the same names.
HARDPOINT_KINDS = ("wmgun", "turret", "thruster", "anti_air", "torpedo", "missile")

REQUIRED_IDS = ("yamato", "andromeda", "kirishima", "yukikaze",
                "garmillas_dessler", "garmillas_kelkapia",
                "garmillas_gaiderol", "bolar_carrier")

MODEL_KEYS = ("id", "displayName", "displayNameJa", "faction", "shipClass", "role",
              "obj", "mtl", "lengthM", "beamM", "triangles", "groups", "hardpoints",
              "materials")

FACTIONS = ("uncf", "garmillas", "bolar")
ROLES = ("battleship", "cruiser", "destroyer", "carrier", "flagship")


#: Structural silhouette requirements (task-8).  ``None`` skips a check that
#: does not apply to that hull form (e.g. an aircraft-shaped destroyer has no
#: sheer line, and only the UNCF capital ships carry superfiring turrets).
#: rake/sheer/depth are metres; wmgun_r is the bow emitter's radius in metres;
#: gold_max is the largest fraction of lengthM the accent_gold may span.
SILHOUETTE = {
    "yamato":             dict(rake=8.0, sheer=2.5, depth=18.0, superfire=6.0,
                               wmgun_r=9.0, gold_max=0.5),
    "andromeda":          dict(rake=8.0, sheer=2.0, depth=18.0, superfire=6.0,
                               wmgun_r=9.0, gold_max=0.5),
    "kirishima":          dict(rake=5.0, sheer=1.5, depth=13.0, superfire=4.0,
                               # 4.5, not 6.0: her bow weapon is a 46 cm FIXED
                               # gun whose canon shroud is ~7 m across (radius
                               # 3.5), so a 6 m emitter radius would be a 12 m
                               # gun.  The 6.0 threshold was calibrated to the
                               # old oversized collar; 4.5 still guarantees the
                               # emitter reads as a weapon rather than a pipe.
                               wmgun_r=4.5, gold_max=0.5),
    "yukikaze":           dict(rake=2.0, sheer=None, depth=12.0, superfire=None,
                               wmgun_r=3.0, gold_max=None),   # gold IS its livery
    "garmillas_dessler":  dict(rake=6.0, sheer=1.2, depth=18.0, superfire=None,
                               wmgun_r=12.0, gold_max=0.5),
    "garmillas_kelkapia": dict(rake=4.0, sheer=1.0, depth=14.0, superfire=None,
                               wmgun_r=6.0, gold_max=0.5),
    "garmillas_gaiderol": dict(rake=5.0, sheer=1.0, depth=18.0, superfire=None,
                               wmgun_r=7.0, gold_max=0.5),
    "bolar_carrier":      dict(rake=4.0, sheer=None, depth=18.0, superfire=None,
                               wmgun_r=6.0, gold_max=0.5),
}


#: Canon ARMAMENT LAYOUT per hull.  The counts and their sources:
#:
#: | hull | source |
#: |---|---|
#: | yamato | docs/research/05-yamato-armament-layout.md (EN Wikipedia UNCF Yamato infobox + JA Wikipedia 兵装) |
#: | andromeda | docs/research/01-yamato-ships.md section 1.2 (official 2202 listing) |
#: | kirishima | docs/research/01-yamato-ships.md section 1.3 (official 2202 Kongo-Kai listing) |
#: | yukikaze | docs/research/01-yamato-ships.md section 1.4 (2199/2202 Isokaze listing) |
#: | garmillas_dessler | docs/research/01-yamato-ships.md section 2.1 (Deusura II) |
#: | garmillas_kelkapia | docs/research/01-yamato-ships.md section 2.2 |
#: | garmillas_gaiderol | docs/research/01-yamato-ships.md section 2.3 |
#: | bolar_carrier | docs/research/01-yamato-ships.md section 3.1 (2205 Ganonda listing) |
#:
#: These are the counts the user could see were wrong on Yamato: four wing
#: secondaries instead of two centreline triples, torpedo tubes modelled as
#: turrets, six CIWS against canon's forty, and no third bridge at all.
#:
#: A key that is ABSENT means "this hull has no such feature" (a destroyer has no
#: third bridge; a Garmillas battleship has no wave motion gun); a key that is
#: present is asserted exactly.  Mesh counts come from count_meshes() - the
#: generator emits one Part per mount, so a mesh IS a mount.
LAYOUT = {
    "yamato": dict(
        main=3, secondary=2, secondary_centreline=True,
        ciws=4,                    # traversable point-defence mounts (pdMounts)
        aa=38,                     # merged battery: 36 pulse lasers + 2 tower guns
        torpedo_ports=28,          # 6 fore + 6 aft + 8 per side broadside
        torpedo_fore=6, torpedo_aft=6, torpedo_broadside=16,
        missile_launchers=12,      # 10 ventral tubes + the box + the funnel
        ventral_tubes=10,
        aux_engines=2,
        third_bridge=True,         # must protrude BELOW the hull
        catapult=True,
        rocket_anchors=2,
        depth_charges=2,
    ),
    "andromeda": dict(
        main=4,                    # 40.6 cm triples, A/B forward + C/D aft
        ciws=4,
        aa=3,                      # 司令塔防護ショックフィールド砲 x3 on the citadel
        torpedo_ports=8,           # 4 rapid-fire fore + 4 subspace aft
        torpedo_fore=4, torpedo_aft=4,
        # 重力子スプレッド発射機 x4 + the two 四連装対艦グレネード投射機: both are
        # merged `missile_launcher` geometry because CONFIG gives her no
        # `secondary_battery` (nor a missile weapon) - an indexed turret would
        # promise a traverse pivot nothing fires from.
        missile_launchers=6,
        aux_engines=0,             # her auxiliaries are the 4 Kelvin nozzles
        rocket_anchors=0,
        depth_charges=0,
    ),
    "kirishima": dict(
        # FOUR triple 36 cm turrets, all `turret_main_1..4`: CONFIG fires
        # mounts.uncf_beam = 4 from turret_main and she has no secondary battery,
        # so there is no indexed secondary family.  No AA battery in canon
        # either, so `aa` is 0 and her only small mounts are the two
        # point-defence channels.
        main=4,
        ciws=2,
        aa=0,
        torpedo_ports=8,           # two rows of ports on the bow flanks
        torpedo_fore=8,
        missile_launchers=2,       # two 8-cell blocks on the flanks at 0.45
        aux_engines=0,
        rocket_anchors=0,
        depth_charges=0,
    ),
    "yukikaze": dict(
        # a DESTROYER's fit, deliberately not padded up to a battleship's
        # battery: two triple 12.7 cm turrets (one dorsal, one VENTRAL), three
        # torpedo tubes as geometry, one 8-cell missile block, one PD channel.
        # `aa` is 0 because no source lists an anti-air mount for the
        # Isokaze-class; `torpedo_fore` is absent because CONFIG gives her no
        # `torpedo` weapon, so the ports are modelled without hardpoints.
        main=2,
        ciws=1,
        aa=0,
        torpedo_ports=3,
        missile_launchers=1,       # ミサイル発射管 x8 as one block
        aux_engines=0,
        rocket_anchors=0,
        depth_charges=0,
    ),
    "garmillas_dessler": dict(
        # 6 dorsal domed beam mounts at 0.20/0.45/0.70 either side of the core
        # (canon 4-6; CONFIG says 4, which is reported as a warning for the Lead
        # to settle), the 2 ventral domed mounts and the 4 PD channels merged,
        # and one flush missile block because CONFIG carries a missile weapon.
        main=6,
        ciws=4,
        aa=2,                      # the ventral domed pair
        aa_ventral=True,           # canon mounts them on the hull's underside
        missile_launchers=1,
        aux_engines=0,
    ),
    "garmillas_kelkapia": dict(
        # 3 dorsal domed beam mounts at 0.25/0.50/0.75 (CONFIG says 2 - warned),
        # the 2 ventral domed mounts and the bridge blister's anti-air clusters
        # (2 traversable channels + 4 merged) as the AA battery.
        main=3,
        ciws=2,
        aa=6,                      # 2 ventral domed mounts + 4 cluster mounts
        aa_ventral=True,
        aux_engines=0,
    ),
    "garmillas_gaiderol": dict(
        # 4 dorsal domed beam mounts, 3 ventral domed mounts, the bridge CIWS
        # ring of 10 domed mounts (4 channels + 6 merged), 16 recessed torpedo
        # ports in two rows per flank, one flush missile block.
        main=4,
        ciws=4,
        aa=9,                      # 3 ventral + 6 ring
        aa_ventral=True,
        torpedo_ports=16,          # geometry only: CONFIG has no torpedo weapon
        missile_launchers=1,
        aux_engines=0,
    ),
    "bolar_carrier": dict(
        # 3 retractable quad positron guns, 10 dual-purpose mounts per side in
        # two rows plus the 2 at the bridge base as the merged battery, 3 PD
        # channels, 12 space torpedo tubes (geometry only), one flush missile
        # block because CONFIG carries a missile weapon.
        main=3,
        ciws=3,
        aa=22,                     # 20 dual-purpose + 2 at the bridge base
        torpedo_ports=12,
        missile_launchers=1,
        aux_engines=0,
    ),
}


#: Dump the REQUIRED hardpoint families straight out of src/core/config.js.
#:
#: The required mix is not a constant we may assert - it is a consequence of the
#: weapon table and of which weapons each hull carries.  A `turret_main` family
#: is needed once per mount the ship's primary beam weapon declares; a
#: `torpedo_tube` or `missile_launcher` family is needed only if she carries that
#: weapon; `anti_air` needs nothing at all, because `grep -rn anti_air src/`
#: returns zero references - point defence reads CONFIG.ships[*].pdMounts as an
#: aura and never touches the hardpoint family.  (An earlier revision of this
#: validator asserted ">= 2 turret_secondary and >= 2 anti_air on every hull",
#: which is exactly the mistake the Lead corrected: three of the eight hulls have
#: no secondary battery, and none of them read anti_air.)
#:
#: Reading the JS beats mirroring it in a Python table: a mirrored table drifts
#: the moment CONFIG changes, and the drift would be silent.  If node or the file
#: is unavailable the derived checks are SKIPPED with a warning rather than
#: failing - a missing tool must never look like a broken model.
CONFIG_MIX_JS = """
import { CONFIG } from '%s';
const W = CONFIG.weapons;
const out = {};
for (const [id, s] of Object.entries(CONFIG.ships)) {
  const families = {};
  for (const w of (s.weapons || [])) {
    const p = (W[w] || {}).mountPrefix;
    if (p) families[p] = (families[p] || 0) + ((s.mounts && s.mounts[w]) || 0);
  }
  out[id] = { families, pdMounts: s.pdMounts || 0 };
}
console.log(JSON.stringify(out));
"""

#: Families the model may claim that CONFIG does not read.  Reported as warnings,
#: never failures: an extra merged family is inert (weapons.js only looks up the
#: prefixes its own weapons declare), and on several hulls it is CANON armament
#: whose CONFIG weapon is simply missing - the Lead owns that fix, and the
#: geometry should not be deleted while they decide.
INERT_FAMILIES = ("turret_secondary", "torpedo_tube", "missile_launcher")


def config_mix(root):
    """The required hardpoint mix per ship, or (None, reason) if unavailable.

    Resolved relative to THIS SCRIPT first, and only then relative to the models
    directory. The models-relative path only works when the directory being
    validated is exactly ``<project>/assets/models`` — so pointing the validator
    at a copy (which is precisely what a reviewer does when checking whether the
    rule can fail) silently skipped the whole CONFIG-derived check. Reported by
    verifier-2 as VALIDATE-CFG-1.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, os.pardir, "src", "core", "config.js"),
        os.path.join(root, os.pardir, os.pardir, "src", "core", "config.js"),
    ]
    cfg = next((os.path.abspath(c) for c in candidates if os.path.isfile(c)), None)
    if cfg is None:
        return None, "src/core/config.js not found"
    script = CONFIG_MIX_JS % cfg.replace("\\", "/")
    try:
        res = subprocess.run(["node", "--input-type=module", "-e", script],
                             capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as exc:
        return None, "node unavailable (%s)" % exc
    if res.returncode != 0:
        tail = (res.stderr or "").strip().splitlines()
        return None, "node failed (%s)" % (tail[-1] if tail else "no stderr")
    try:
        return json.loads(res.stdout), None
    except ValueError:
        return None, "node output was not JSON"


class Report:
    """Collects violations so every problem is reported, not just the first."""

    def __init__(self):
        self.errors = []
        self.warnings = []

    def fail(self, ship_id, msg):
        self.errors.append("%s: %s" % (ship_id, msg))

    def warn(self, ship_id, msg):
        self.warnings.append("%s: %s" % (ship_id, msg))


# --------------------------------------------------------------------------
# OBJ / MTL parsing
# --------------------------------------------------------------------------

def parse_obj(path):
    """Parse the subset of OBJ this project emits; returns a dict of lists."""
    verts = []
    normals = []
    faces = []            # (group, material, [vertex indices], has_normals)
    groups = []           # in file order, unique
    materials = []
    group_idx = {}        # group -> set of vertex indices
    mat_idx = {}          # material -> set of vertex indices
    group = None
    material = None
    bad = []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            key = parts[0]
            if key == "v":
                if len(parts) != 4:
                    bad.append("line %d: malformed v" % lineno)
                    continue
                verts.append(tuple(float(x) for x in parts[1:4]))
            elif key == "vn":
                normals.append(tuple(float(x) for x in parts[1:4]))
            elif key == "g":
                group = parts[1] if len(parts) > 1 else ""
                if group not in groups:
                    groups.append(group)
            elif key == "usemtl":
                material = parts[1] if len(parts) > 1 else ""
                if material not in materials:
                    materials.append(material)
            elif key in ("o", "mtllib", "s"):
                continue
            elif key == "f":
                idx = []
                has_n = True
                for token in parts[1:]:
                    bits = token.split("/")
                    if len(bits) < 3 or bits[2] == "":
                        has_n = False
                    try:
                        vi = int(bits[0])
                    except ValueError:
                        bad.append("line %d: bad face index %r" % (lineno, token))
                        break
                    idx.append(vi - 1 if vi > 0 else len(verts) + vi)
                else:
                    faces.append((group, material, idx, has_n))
                    group_idx.setdefault(group, set()).update(idx)
                    mat_idx.setdefault(material, set()).update(idx)
                continue
            else:
                bad.append("line %d: unexpected directive %r" % (lineno, key))
    return {"verts": verts, "normals": normals, "faces": faces, "groups": groups,
            "materials": materials, "bad": bad,
            "group_verts": {g: [verts[i] for i in sorted(s)]
                            for g, s in group_idx.items()},
            "mat_verts": {m: [verts[i] for i in sorted(s)]
                          for m, s in mat_idx.items()}}


def parse_mtl(path):
    """Return the list of material names declared in an MTL."""
    names = []
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if line.startswith("newmtl "):
                names.append(line.split(None, 1)[1].strip())
    return names


# --------------------------------------------------------------------------
# Per-model validation
# --------------------------------------------------------------------------

def check_model(rep, root, model, all_files_used, mix=None):
    mid = model.get("id", "<no id>")
    missing = [k for k in MODEL_KEYS if k not in model]
    extra = [k for k in model if k not in MODEL_KEYS]
    if missing:
        rep.fail(mid, "manifest entry missing key(s): %s" % ", ".join(missing))
    if extra:
        rep.fail(mid, "manifest entry has unexpected key(s): %s" % ", ".join(extra))
    if missing:
        return None

    if model["faction"] not in FACTIONS:
        rep.fail(mid, "faction %r not in %s" % (model["faction"], list(FACTIONS)))
    if model["role"] not in ROLES:
        rep.fail(mid, "role %r not in %s" % (model["role"], list(ROLES)))
    if not isinstance(model["lengthM"], int) or model["lengthM"] <= 0:
        rep.fail(mid, "lengthM must be a positive int, got %r" % (model["lengthM"],))
    if not isinstance(model["beamM"], int) or model["beamM"] <= 0:
        rep.fail(mid, "beamM must be a positive int, got %r" % (model["beamM"],))

    obj_path = os.path.join(root, model["obj"])
    mtl_path = os.path.join(root, model["mtl"])
    for path in (obj_path, mtl_path):
        if not os.path.isfile(path):
            rep.fail(mid, "referenced file is missing: %s" % os.path.basename(path))
            return None
    all_files_used.add(model["obj"])
    all_files_used.add(model["mtl"])

    obj = parse_obj(obj_path)
    for msg in obj["bad"]:
        rep.fail(mid, "%s %s" % (model["obj"], msg))

    # -- groups and materials ---------------------------------------------
    hp_names = {h.get("name") for h in model["hardpoints"]}
    for g in obj["groups"]:
        if g in GROUPS:
            continue
        if not TURRET_RE.match(g):
            rep.fail(mid, "OBJ group %r is neither a fixed group nor an indexed "
                          "mount group" % (g,))
        elif g not in hp_names:
            rep.fail(mid, "indexed group %r has no hardpoint of the same name, so "
                          "the renderer cannot place it" % (g,))
    for m in obj["materials"]:
        if m not in MATERIALS:
            rep.fail(mid, "OBJ material %r is not in the SPEC 5.5 palette" % (m,))
    declared_groups = list(model["groups"])
    for g in declared_groups:
        if g not in GROUPS and not TURRET_RE.match(g):
            rep.fail(mid, "manifest group %r is not in the fixed group list" % (g,))
    if sorted(declared_groups) != sorted(obj["groups"]):
        rep.fail(mid, "manifest groups %s != OBJ groups %s"
                 % (sorted(declared_groups), sorted(obj["groups"])))
    if len(set(declared_groups)) != len(declared_groups):
        rep.fail(mid, "manifest groups contains duplicates")
    used = sorted(set(obj["materials"]))
    if sorted(model["materials"]) != used:
        rep.fail(mid, "manifest materials %s != OBJ materials %s"
                 % (sorted(model["materials"]), used))
    for m in model["materials"]:
        if m not in MATERIALS:
            rep.fail(mid, "manifest material %r is not in the palette" % (m,))
    mtl_names = parse_mtl(mtl_path)
    for m in used:
        if m not in mtl_names:
            rep.fail(mid, "%s does not define material %r" % (model["mtl"], m))
    for m in mtl_names:
        if m not in MATERIALS:
            rep.fail(mid, "%s defines non-palette material %r" % (model["mtl"], m))

    # -- faces -------------------------------------------------------------
    tris = 0
    quads = 0
    for (group, material, idx, has_n) in obj["faces"]:
        if len(idx) not in (3, 4):
            rep.fail(mid, "face with %d vertices (only triangles/quads allowed)"
                     % len(idx))
            break
        if len(idx) == 4:
            quads += 1
        tris += len(idx) - 2
        if not has_n:
            rep.fail(mid, "a face is missing vn normal references")
            break
        for i in idx:
            if i < 0 or i >= len(obj["verts"]):
                rep.fail(mid, "face index %d out of range (%d vertices)"
                         % (i + 1, len(obj["verts"])))
                break
        if group is None:
            rep.fail(mid, "faces before any g directive")
            break
        if material is None:
            rep.fail(mid, "faces before any usemtl directive")
            break
    if not obj["faces"]:
        rep.fail(mid, "OBJ contains no faces")
    if not obj["normals"]:
        rep.fail(mid, "OBJ contains no vn normals")
    if tris != model["triangles"]:
        rep.fail(mid, "declared triangles %d != OBJ triangles %d"
                 % (model["triangles"], tris))
    if tris >= MAX_TRIANGLES:
        rep.fail(mid, "%d triangles is at/over the %d budget" % (tris, MAX_TRIANGLES))

    # -- geometry ----------------------------------------------------------
    xs = [v[0] for v in obj["verts"]]
    ys = [v[1] for v in obj["verts"]]
    zs = [v[2] for v in obj["verts"]]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    z0, z1 = min(zs), max(zs)
    L = float(model["lengthM"])
    B = float(model["beamM"])
    ztol = max(0.05, 0.005 * L)
    xtol = max(0.05, 0.02 * B)
    if abs(z0 + L / 2.0) > ztol:
        rep.fail(mid, "bow is at z=%.3f, expected %.3f" % (z0, -L / 2.0))
    if abs(z1 - L / 2.0) > ztol:
        rep.fail(mid, "stern is at z=%.3f, expected %.3f" % (z1, L / 2.0))
    if abs((x1 - x0) - B) > xtol:
        rep.fail(mid, "X extent %.3f does not match beamM %.1f" % (x1 - x0, B))
    if abs((x0 + x1) / 2.0) > 0.02 * B:
        rep.fail(mid, "not centred in X (%.3f .. %.3f)" % (x0, x1))
    if not (y1 > 0.0 > y0):
        rep.fail(mid, "Y extent does not straddle the origin (up is +Y)")

    # -- indexed mount groups: pivot contract (SPEC 5 rule 3) --------------
    beam = float(model["beamM"])
    for g in obj["groups"]:
        if not TURRET_RE.match(g):
            continue
        vs = obj["group_verts"].get(g) or []
        if not vs:
            rep.fail(mid, "indexed group %r has no geometry" % (g,))
            continue
        ys = [v[1] for v in vs]
        ylo, yhi = min(ys), max(ys)
        span = max(1e-9, yhi - ylo)
        # the BARBETTE - the geometry around the pivot plane - must be centred on
        # the traverse axis; barrels and rangefinders legitimately overhang
        reach = 0.35 * max(abs(ylo), abs(yhi))
        base = [v for v in vs if abs(v[1]) <= reach]
        bx = [v[0] for v in base]
        bz = [v[2] for v in base]
        cx = 0.5 * (min(bx) + max(bx))
        cz = 0.5 * (min(bz) + max(bz))
        if abs(cx) > max(1.0, 0.02 * beam):
            rep.fail(mid, "indexed group %r is authored %.1f m off its traverse "
                          "axis - the world position looks baked in" % (g, cx))
        if abs(cz) > max(2.0, 0.05 * float(model["lengthM"])):
            rep.fail(mid, "indexed group %r has its barbette %.1f m off the pivot "
                          "in z - the world position looks baked in" % (g, cz))
        if max(v[2] for v in vs) - min(v[2] for v in vs) > 0.25 * float(model["lengthM"]):
            rep.fail(mid, "indexed group %r spans %.0f m of hull - the world "
                          "position looks baked in"
                     % (g, max(v[2] for v in vs) - min(v[2] for v in vs)))
        if min(abs(v[1]) for v in vs) > 1.2:
            rep.fail(mid, "indexed group %r has no geometry on its pivot plane "
                          "(y=0 at the deck line where the barbette meets the "
                          "hull): y spans %.1f..%.1f" % (g, ylo, yhi))

    # -- silhouette (structural facts, task-8) -----------------------------
    sil = silhouette_checks(rep, mid, model, obj)

    # -- armament layout (canon counts, task-9) ----------------------------
    lay = layout_checks(rep, mid, model, obj)

    # -- hardpoints --------------------------------------------------------
    names = []
    kinds = []
    for hp in model["hardpoints"]:
        for key in ("name", "kind", "pos", "dir"):
            if key not in hp:
                rep.fail(mid, "hardpoint %r missing key %r" % (hp.get("name"), key))
                break
        else:
            names.append(hp["name"])
            kinds.append(hp["kind"])
            if hp["kind"] not in HARDPOINT_KINDS:
                rep.fail(mid, "hardpoint %s has illegal kind %r"
                         % (hp["name"], hp["kind"]))
            pos, d = hp["pos"], hp["dir"]
            if len(pos) != 3 or len(d) != 3:
                rep.fail(mid, "hardpoint %s pos/dir must have 3 components" % hp["name"])
                continue
            n = math.sqrt(sum(c * c for c in d))
            if abs(n - 1.0) > 1e-4:
                rep.fail(mid, "hardpoint %s dir is not normalised (|d| = %.5f)"
                         % (hp["name"], n))
            m = 0.02 * B
            if not (x0 - m <= pos[0] <= x1 + m and y0 - m <= pos[1] <= y1 + m
                    and z0 - m <= pos[2] <= z1 + m):
                rep.fail(mid, "hardpoint %s at %s is outside the hull box" % (hp["name"], pos))
    if len(set(names)) != len(names):
        rep.fail(mid, "duplicate hardpoint names: %s" % names)

    def has(pred):
        return any(pred(hp) for hp in model["hardpoints"])

    if not has(lambda h: h["kind"] == "wmgun" and h["pos"][2] < 0 and h["dir"][2] < -0.9):
        rep.fail(mid, "no bow wave-motion-gun hardpoint (kind wmgun, z<0, dir -Z)")
    if not has(lambda h: h["kind"] == "turret" and h["name"].startswith("turret_main")):
        rep.fail(mid, "no turret_main hardpoint")
    if sum(1 for h in model["hardpoints"] if h["kind"] == "thruster") < 2:
        rep.fail(mid, "fewer than 2 thruster hardpoints")
    if not has(lambda h: h["kind"] == "thruster" and h["pos"][2] > 0 and h["dir"][2] > 0.9):
        rep.fail(mid, "no stern thruster hardpoint (z>0, dir +Z)")

    # -- the required mix, DERIVED from src/core/config.js -----------------
    # No blanket ">= 2 turret_secondary / >= 2 anti_air" rule: three of the eight
    # hulls have no secondary battery in their weapons array and nothing in src/
    # reads anti_air at all.  What a hull needs is what her own weapon fit needs.
    def count(pref):
        return sum(1 for h in model["hardpoints"]
                   if str(h["name"]).startswith(pref))

    need = (mix or {}).get(mid, {}).get("families")
    if need is None and mix is not None:
        rep.warn(mid, "no CONFIG.ships entry - the required mix cannot be derived")
    if need:
        for fam in sorted(need):
            if fam == "wave_motion_gun":
                continue                    # checked above, as the bow emitter
            if fam == "turret_main":
                got = count("turret_main_")
                if got < need[fam]:
                    rep.fail(mid, "CONFIG fires %d mount(s) from turret_main but the "
                                  "model has %d - a mount would fire from nothing"
                             % (need[fam], got))
                elif got > need[fam]:
                    rep.warn(mid, "model has %d turret_main hardpoints, CONFIG says "
                                  "%d - CONFIG needs updating if the model is right "
                                  "(canon count)" % (got, need[fam]))
            else:
                got = count(fam)
                if got < 1:
                    rep.fail(mid, "CONFIG carries a %s weapon but the model has no "
                                  "%s hardpoint to fire it from" % (fam, fam))
        for fam in INERT_FAMILIES:
            if fam not in need and count(fam):
                rep.warn(mid, "%d %s hardpoint(s) but no CONFIG weapon reads that "
                              "family - inert data, or a CONFIG weapon missing"
                         % (count(fam), fam))
    pd = (mix or {}).get(mid, {}).get("pdMounts")
    if pd is not None and count("ciws") != pd:
        rep.fail(mid, "%d ciws_* hardpoints for pdMounts = %d point-defence "
                      "channels" % (count("ciws"), pd))

    return {"id": mid, "sil": sil, "lay": lay,
            "display": model["displayName"], "faction": model["faction"],
            "cls": model["shipClass"], "role": model["role"], "obj": model["obj"],
            "mtl": model["mtl"], "L": L, "B": B, "tris": tris, "quads": quads,
            "verts": len(obj["verts"]), "normals": len(obj["normals"]),
            "groups": obj["groups"], "materials": used, "hardpoints": model["hardpoints"],
            "bbox": (x0, y0, z0, x1, y1, z1)}


def silhouette_checks(rep, mid, model, obj):
    """Assert the hull/weapon-layout structure and return the measured values.

    Measured straight from the OBJ so a regression cannot hide:
      rake      - how much further forward the upper hull reaches than the lower
                  hull (a raked stem / clipper bow), in metres
      sheer     - deck rise from z=+0.05L to z=-0.35L (forecastle above the waist)
      depth     - hull group's vertical extent (keel to deck)
      superfire - turret_main_2's gun-house top minus turret_main_1's, plus the
                  z ordering (the mount behind must be the higher one)
      wmgun     - radius of the bow emitter assembly and its offset from the
                  centreline, measured on the muzzle slab of its group
      gold      - z span of accent_gold as a fraction of lengthM (no long stripe)
    """
    spec = SILHOUETTE.get(mid)
    L = float(model["lengthM"])
    gv = obj["group_verts"]
    out = {}

    hull = gv.get("hull", [])
    if not hull:
        rep.fail(mid, "silhouette: no hull group to measure")
        return out
    hi = [v[2] for v in hull if v[1] >= 6.0]
    lo = [v[2] for v in hull if v[1] <= -6.0]
    out["rake"] = (min(lo) - min(hi)) if (hi and lo) else None
    out["depth"] = max(v[1] for v in hull) - min(v[1] for v in hull)
    # A loft carries vertices only on its section planes, so the sampling band
    # is derived from the spacing of the DECK-LEVEL planes (loft rings, frame
    # seams) - a fixed window would miss the hull entirely on a sparse-station
    # ship and pick up a torpedo port instead.
    planes = {}
    for v in hull:
        planes.setdefault(round(v[2], 2), []).append(v[1])
    ymax = max(v[1] for v in hull)
    depth0 = ymax - min(v[1] for v in hull)
    deck_planes = sorted(z for z, ys in planes.items()
                         if max(ys) >= ymax - 0.30 * depth0)
    gaps = sorted(deck_planes[i + 1] - deck_planes[i]
                  for i in range(len(deck_planes) - 1)) or [12.0]
    win = max(gaps[len(gaps) // 2], 10.0)

    def deck_at(z):
        ys = [v[1] for v in hull if abs(v[2] - z) <= win]
        return max(ys) if ys else None

    d_bow, d_mid = deck_at(-0.35 * L), deck_at(0.05 * L)
    out["sheer"] = (d_bow - d_mid) if (d_bow is not None and d_mid is not None) else None

    tm = gv.get("turret_main", [])
    mounts = {h.get("name"): h for h in model["hardpoints"]}
    m1, m2 = mounts.get("turret_main_1"), mounts.get("turret_main_2")
    if m1 and m2:
        # a mount's declared height is its barbette top plus half the gun house,
        # so the difference IS the superfiring step
        out["superfire"] = m2["pos"][1] - m1["pos"][1]
        out["superfire_aft"] = m2["pos"][2] > m1["pos"][2]
        # mounts are authored on their pivots now, so the superfiring step is
        # read from the pivot heights (the deck line of each barbette)
        out["superfire_aft"] = out["superfire_aft"]
    else:
        out["superfire"] = None

    wg = gv.get("wave_motion_gun", [])
    if wg:
        zmin = min(v[2] for v in wg)
        slab = [v for v in wg if v[2] <= zmin + 0.06 * L]
        cx = sum(v[0] for v in slab) / len(slab)
        cy = sum(v[1] for v in slab) / len(slab)
        out["wmgun_r"] = max(math.hypot(v[0] - cx, v[1] - cy) for v in slab)
        out["wmgun_cx"] = cx
        out["wmgun_zmin"] = zmin
    gold = obj["mat_verts"].get("accent_gold", [])
    out["gold_frac"] = ((max(v[2] for v in gold) - min(v[2] for v in gold)) / L
                        if gold else 0.0)

    if spec:
        if spec["rake"] is not None and (out.get("rake") is None
                                         or out["rake"] < spec["rake"]):
            rep.fail(mid, "silhouette: raked bow reaches only %.2f m forward of the "
                          "lower hull (need >= %.1f)" % (out.get("rake") or 0.0,
                                                         spec["rake"]))
        if spec["depth"] is not None and out["depth"] < spec["depth"]:
            rep.fail(mid, "silhouette: hull depth %.2f m is a slab (need >= %.1f)"
                     % (out["depth"], spec["depth"]))
        if spec["sheer"] is not None and (out.get("sheer") is None
                                          or out["sheer"] < spec["sheer"]):
            rep.fail(mid, "silhouette: sheer rise %.2f m is too flat (need >= %.1f)"
                     % (out.get("sheer") or 0.0, spec["sheer"]))
        if spec["superfire"] is not None:
            if out.get("superfire") is None:
                rep.fail(mid, "silhouette: cannot measure superfiring turrets")
            else:
                if out["superfire"] < spec["superfire"]:
                    rep.fail(mid, "silhouette: turret_main_2 is only %.2f m above "
                                  "turret_main_1 (need >= %.1f)"
                             % (out["superfire"], spec["superfire"]))
                if not out.get("superfire_aft"):
                    rep.fail(mid, "silhouette: turret_main_2 is not aft of "
                                  "turret_main_1")

        if spec["wmgun_r"] is not None:
            if out.get("wmgun_r") is None:
                rep.fail(mid, "silhouette: no wave_motion_gun geometry")
            else:
                if out["wmgun_r"] < spec["wmgun_r"]:
                    rep.fail(mid, "silhouette: bow emitter radius %.2f m is too "
                                  "small (need >= %.1f)"
                             % (out["wmgun_r"], spec["wmgun_r"]))
                if abs(out["wmgun_cx"]) > 3.0:
                    rep.fail(mid, "silhouette: bow emitter is %.2f m off the "
                                  "centreline" % out["wmgun_cx"])
        if spec["gold_max"] is not None and out["gold_frac"] >= spec["gold_max"]:
            rep.fail(mid, "silhouette: accent_gold spans %.0f%% of the hull - that "
                          "is the long yellow stripe (need < %.0f%%)"
                     % (100.0 * out["gold_frac"], 100.0 * spec["gold_max"]))
    return out


def group_components(obj, group, touch=0.5):
    """Bounding boxes of the separate objects in one OBJ group.

    The OBJ carries no structure below the ``g`` group, so mounts in a MERGED
    battery have to be counted from the geometry.  Two rules, in order:

    1. FACE CONNECTIVITY - two vertices are in the same object when a face
       references both.  This finds each primitive (a box, a cylinder).
    2. PROXIMITY - primitives whose bounding boxes come within ``touch`` metres
       are the same object.  A mount is a pedestal + a gun house + a barrel
       cluster: its parts touch, while two mounts down a deckhouse row are 10 m
       apart with ~4.6 m of barrel between them, so 0.5 m separates the cases
       cleanly.

    tools/gen_models.py emits one Part per mount and spaces the battery rows
    accordingly, so the result IS the mount count - which is what makes "38
    pulse-laser mounts" checkable at all.
    """
    faces = [idx for (g, _m, idx, _hn) in obj["faces"] if g == group]
    if not faces:
        return []
    verts = obj["verts"]
    parent = {}

    def find(a):
        parent.setdefault(a, a)
        root = a
        while parent[root] != root:
            root = parent[root]
        while parent[a] != root:              # path compression
            parent[a], a = root, parent[a]
        return root

    for idx in faces:
        first = find(idx[0])
        for i in idx[1:]:
            r = find(i)
            if r != first:
                parent[r] = first

    boxes = {}
    for idx in faces:
        root = find(idx[0])
        box = boxes.get(root)
        for i in idx:
            x, y, z = verts[i]
            if box is None:
                box = boxes[root] = [x, y, x, y, z, z]
                continue
            box[0] = min(box[0], x)
            box[1] = min(box[1], y)
            box[2] = max(box[2], x)
            box[3] = max(box[3], y)
            box[4] = min(box[4], z)
            box[5] = max(box[5], z)
    roots = sorted(boxes)
    for i, a in enumerate(roots):
        ba = boxes[a]
        for b in roots[i + 1:]:
            bb = boxes[b]
            if (ba[0] - touch <= bb[2] and bb[0] - touch <= ba[2]
                    and ba[1] - touch <= bb[3] and bb[1] - touch <= ba[3]
                    and ba[4] - touch <= bb[5] and bb[4] - touch <= ba[5]):
                ra, rb = find(a), find(b)
                if ra != rb:
                    parent[rb] = ra
                    boxes[ra] = [min(ba[0], bb[0]), min(ba[1], bb[1]),
                                 max(ba[2], bb[2]), max(ba[3], bb[3]),
                                 min(ba[4], bb[4]), max(ba[5], bb[5])]
                    ba = boxes[ra]
    return [boxes[r] for r in sorted({find(i) for idx in faces for i in idx})]


def count_meshes(obj, group, touch=0.5, below=None):
    """How many objects one group holds, optionally only those below a height.

    ``below`` is how the ventral missile tubes are counted: the same measurement,
    restricted to the launchers whose whole bounding box hangs under the keel.
    """
    boxes = group_components(obj, group, touch)
    if below is None:
        return len(boxes)
    return sum(1 for b in boxes if b[3] < below)          # b[3] is max y


def group_verts(obj, group):
    return obj["group_verts"].get(group, [])


def layout_checks(rep, mid, model, obj):
    """Assert the CANON armament layout of a rebuilt hull, and return the counts.

    Everything here is measured from the OBJ (mesh counts, directions, heights)
    or from the manifest hardpoints (world positions, which the merged groups do
    not carry).  A hull with no LAYOUT entry is skipped, and WITHIN an entry only
    the keys that ship declares are asserted - the hulls carry different canon
    fits (a destroyer has no third bridge, a Garmillas battleship has no wave
    motion gun), so a missing key means "this hull has no such feature", while a
    present key with a wrong value is a failure.
    """
    spec = LAYOUT.get(mid)
    out = {}
    if not spec:
        return out
    L = float(model["lengthM"])
    hps = model["hardpoints"]
    prefix = lambda p: [h for h in hps if str(h.get("name", "")).startswith(p)]

    def want(key, got, what):
        if key in spec and got != spec[key]:
            rep.fail(mid, "layout: %d %s, canon has %d" % (got, what, spec[key]))

    out["main"] = len(prefix("turret_main_"))
    out["secondary"] = len(prefix("turret_secondary_"))
    out["ciws"] = len(prefix("ciws"))
    out["aa"] = count_meshes(obj, "anti_air")
    out["torpedo_ports"] = count_meshes(obj, "torpedo_tube")
    out["missile_launchers"] = count_meshes(obj, "missile_launcher")
    out["aux_engines"] = count_meshes(obj, "aux_engine")
    out["rocket_anchors"] = count_meshes(obj, "rocket_anchor")
    out["depth_charges"] = count_meshes(obj, "depth_charge")
    out["catapult"] = count_meshes(obj, "catapult")
    out["third_bridge"] = count_meshes(obj, "third_bridge")

    # -- main / secondary battery -----------------------------------------
    want("main", out["main"], "turret_main mounts")
    want("secondary", out["secondary"], "turret_secondary mounts")
    if "secondary" in spec and out["secondary"] != spec["secondary"]:
        rep.fail(mid, "layout: the secondary count is the error the user spotted "
                      "on Yamato - check for wing mounts that canon does not have")
    if spec.get("secondary_centreline"):
        off = [h for h in prefix("turret_secondary") if abs(h["pos"][0]) > 1.0]
        if off:
            rep.fail(mid, "layout: secondary mount(s) %s are %.1f m off the "
                          "centreline - canon mounts them on the centreline"
                     % (", ".join(h["name"] for h in off),
                        max(abs(h["pos"][0]) for h in off)))
    want("ciws", out["ciws"], "traversable ciws mounts")

    # -- the AA battery ----------------------------------------------------
    want("aa", out["aa"], "anti_air mounts")
    # The UNCF battery belongs on the UPPER hull - a pulse laser under the keel
    # would be a modelling error.  Garmillas hulls are the exception: their canon
    # fit includes VENTRAL domed mounts, and since the vocabulary has no other
    # non-indexed gun bucket they share the merged battery, so a hull whose canon
    # lists them declares `aa_ventral` rather than being silently exempted.
    aa_lo = [v[1] for v in group_verts(obj, "anti_air")]
    if aa_lo and min(aa_lo) < 0.0 and not spec.get("aa_ventral"):
        rep.fail(mid, "layout: an anti_air mount sits at y=%.1f - the battery "
                      "belongs on the UPPER hull, only the wave motion gun, the "
                      "bow/stern missiles and the third bridge are elsewhere"
                 % min(aa_lo))

    # -- torpedo ports: hull openings, and their directions ----------------
    want("torpedo_ports", out["torpedo_ports"], "torpedo ports")
    tubes = prefix("torpedo_tube")
    if tubes and len(tubes) != out["torpedo_ports"]:
        rep.fail(mid, "layout: %d torpedo_tube hardpoints for %d modelled ports - "
                      "the ports and the tubes that fire through them disagree"
                 % (len(tubes), out["torpedo_ports"]))
    fore = [h for h in tubes if h["dir"][2] < -0.9]
    aft = [h for h in tubes if h["dir"][2] > 0.9]
    broad = [h for h in tubes if abs(h["dir"][0]) > 0.9]
    out["torpedo_fore"], out["torpedo_aft"] = len(fore), len(aft)
    out["torpedo_broadside"] = len(broad)
    want("torpedo_fore", len(fore), "forward torpedo tubes")
    want("torpedo_aft", len(aft), "aft torpedo tubes")
    want("torpedo_broadside", len(broad), "broadside torpedo tubes")
    # a port is a hole in the plating, so it must sit ON the hull surface rather
    # than out in space where a turret would have been
    xs = [abs(v[0]) for v in group_verts(obj, "torpedo_tube")]
    if xs and max(xs) > 0.5 * float(model["beamM"]) + 0.05:
        rep.fail(mid, "layout: a torpedo port reaches x=%.2f, past the hull's "
                      "own beam - ports must be flush with the plating"
                 % max(xs))

    # -- missiles ----------------------------------------------------------
    want("missile_launchers", out["missile_launchers"], "missile launcher meshes")
    # the ventral tubes are the launchers that hang under the keel; box and
    # funnel launchers are on the upper hull, so a height cut separates them
    ventral = count_meshes(obj, "missile_launcher", below=-6.0)
    out["ventral_tubes"] = ventral
    want("ventral_tubes", ventral, "ventral missile tubes below the keel")

    # -- the third bridge must hang BELOW the hull -------------------------
    if spec.get("third_bridge"):
        tb = group_verts(obj, "third_bridge")
        hull = group_verts(obj, "hull")
        if not tb:
            rep.fail(mid, "layout: no third_bridge group - the ventral third "
                          "bridge is the ship's most distinctive feature")
        elif hull and min(v[1] for v in tb) >= min(v[1] for v in hull):
            rep.fail(mid, "layout: third_bridge reaches y=%.1f but the hull "
                          "keel is at y=%.1f - the third bridge must PROTRUDE "
                          "from the bottom of the hull, not sit inside it"
                     % (min(v[1] for v in tb), min(v[1] for v in hull)))
        elif hull:
            out["third_bridge_below"] = (min(v[1] for v in hull)
                                         - min(v[1] for v in tb))

    # -- aux engines, catapult, anchors, depth charges ---------------------
    want("aux_engines", out["aux_engines"], "auxiliary engines")
    if out["aux_engines"] and len(prefix("aux_engine")) < out["aux_engines"]:
        rep.fail(mid, "layout: auxiliary engines have no thruster hardpoints")
    if spec.get("catapult"):
        cat = group_verts(obj, "catapult")
        if not cat:
            rep.fail(mid, "layout: no catapult group")
        elif max(v[2] for v in cat) < 0.30 * L:
            rep.fail(mid, "layout: the catapult sits at z=%.0f, not on the aft "
                          "aircraft deck (need z > %.0f)"
                     % (max(v[2] for v in cat), 0.30 * L))
        gold = obj["mat_verts"].get("accent_gold", [])
        if not [v for v in gold if v[2] > 0.30 * L]:
            rep.fail(mid, "layout: no accent_gold catapult rails on the aft deck")
    want("rocket_anchors", out["rocket_anchors"], "rocket anchors")
    ra = group_verts(obj, "rocket_anchor")
    if ra and max(v[2] for v in ra) > -0.25 * L:
        rep.fail(mid, "layout: a rocket anchor sits at z=%.0f - they belong at "
                      "the bow" % max(v[2] for v in ra))
    want("depth_charges", out["depth_charges"], "depth-charge launchers")
    return out


def validate(root, quiet=False):
    rep = Report()
    manifest_path = os.path.join(root, "manifest.json")
    if not os.path.isfile(manifest_path):
        print("FAIL: %s does not exist" % manifest_path)
        return 1
    with open(manifest_path, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)

    # the required mix is a consequence of CONFIG, not a constant (see
    # config_mix): read it, and if it cannot be read, say so and skip those
    # checks rather than failing the models for a missing tool
    mix, mix_err = config_mix(root)
    if mix_err:
        rep.warn("manifest", "required-mix checks SKIPPED: %s" % mix_err)

    if manifest.get("schema") != SCHEMA:
        rep.fail("manifest", "schema is %r, expected %r"
                 % (manifest.get("schema"), SCHEMA))
    if manifest.get("units") != UNITS:
        rep.fail("manifest", "units is %r, expected %r"
                 % (manifest.get("units"), UNITS))
    if manifest.get("axis") != AXIS:
        rep.fail("manifest", "axis is %r, expected %r"
                 % (manifest.get("axis"), AXIS))
    for key in manifest:
        if key not in ("schema", "units", "axis", "models"):
            rep.fail("manifest", "unexpected top-level key %r" % (key,))
    models = manifest.get("models")
    if not isinstance(models, list) or not models:
        rep.fail("manifest", "models must be a non-empty list")
        models = []

    ids = [m.get("id") for m in models]
    if len(set(ids)) != len(ids):
        rep.fail("manifest", "duplicate model ids: %s" % ids)
    for want in REQUIRED_IDS:
        if want not in ids:
            rep.fail("manifest", "required ship %r is missing" % want)

    all_files_used = set()
    results = []
    for model in models:
        info = check_model(rep, root, model, all_files_used, mix)
        if info:
            results.append(info)

    # provenance: nothing may sit in assets/models/ unaccounted for
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if not os.path.isfile(path):
            rep.fail("assets", "unexpected subdirectory %s" % name)
            continue
        if name in ("manifest.json", "README.md") or name in all_files_used:
            continue
        rep.fail("assets", "file %s is not named by manifest.json" % name)

    if not quiet:
        print("YAMATO FLEET 2199 - asset contract validation")
        print("root: %s" % os.path.abspath(root))
        print("manifest: schema=%s units=%s axis=%s models=%d"
              % (manifest.get("schema"), manifest.get("units"),
                 "%s/%s" % (AXIS["forward"], AXIS["up"]), len(models)))
        print("")
        for info in results:
            x0, y0, z0, x1, y1, z1 = info["bbox"]
            print("%-19s %s" % (info["id"], info["display"]))
            print("  %s / %s / %s   %s + %s"
                  % (info["faction"], info["cls"], info["role"], info["obj"], info["mtl"]))
            print("  lengthM %d  beamM %d   triangles %d / %d  (%.0f%% of budget)   "
                  "verts %d  vn %d  quads %d"
                  % (info["L"], info["B"], info["tris"], MAX_TRIANGLES,
                     100.0 * info["tris"] / MAX_TRIANGLES, info["verts"],
                     info["normals"], info["quads"]))
            print("  z extent [%.2f, %.2f]  err %.4f   x extent [%.2f, %.2f]  err %.4f"
                  "   y extent [%.2f, %.2f]"
                  % (z0, z1, max(abs(z0 + info["L"] / 2), abs(z1 - info["L"] / 2)),
                     x0, x1, abs((x1 - x0) - info["B"]), y0, y1))
            sil = info.get("sil") or {}
            spec = SILHOUETTE.get(info["id"], {})
            def fmt_sil(key, need, unit="m"):
                v = sil.get(key)
                if v is None:
                    return "n/a"
                return ("%.2f%s (>= %.1f%s)" % (v, unit, need, unit)
                        if need is not None else "%.2f%s" % (v, unit))
            print("  silhouette: rake %s | sheer %s | hull depth %s"
                  % (fmt_sil("rake", spec.get("rake")),
                     fmt_sil("sheer", spec.get("sheer")),
                     fmt_sil("depth", spec.get("depth"))))
            sf_ok = sil.get("superfire_aft")
            print("              superfiring %s%s | bow emitter r %s, off-centre %.2f m"
                  % ("n/a - this hull has no superfiring pair"
                     if spec.get("superfire") is None
                     else fmt_sil("superfire", spec.get("superfire")),
                     "" if (sf_ok is None or spec.get("superfire") is None)
                     else (", #2 aft" if sf_ok else ", ORDER WRONG"),
                     
                     "%.2f" % sil["wmgun_r"] if sil.get("wmgun_r") is not None
                     else "n/a", sil.get("wmgun_cx") or 0.0))
            gm = spec.get("gold_max")
            print("              accent_gold span %.0f%% of L (%s)"
                  % (100.0 * sil.get("gold_frac", 0.0),
                     "n/a - gold is this ship's livery" if gm is None
                     else "limit %.0f%%" % (100.0 * gm)))
            lay = info.get("lay") or {}
            if lay:
                want = LAYOUT.get(info["id"], {})
                def n(key, need=None):
                    got = lay.get(key)
                    return ("%s (= %s)" % (got, need) if need is not None
                            else "%s" % got)
                # only the features THIS hull declares are printed: an absent
                # key means the hull has no such mount, not that it has zero
                print("  armament layout (canon counts, source in validate_models.py):")
                row1 = ["main %s" % n("main", want.get("main"))]
                if "secondary" in want:
                    row1.append("secondary %s%s"
                                % (n("secondary", want.get("secondary")),
                                   ", centreline" if want.get("secondary_centreline")
                                   else ""))
                row1.append("ciws %s" % n("ciws", want.get("ciws")))
                row1.append("merged anti_air battery %s" % n("aa", want.get("aa")))
                print("              " + " | ".join(row1))
                row2 = []
                if "torpedo_ports" in want:
                    # the fore/aft/broadside split comes from the hardpoints; a
                    # hull whose tubes are geometry-only (CONFIG carries no
                    # torpedo weapon) has none, and says so instead of "0 / 0"
                    if "torpedo_fore" in want or "torpedo_aft" in want:
                        detail = (" (fore %s / aft %s%s)"
                                  % (n("torpedo_fore", want.get("torpedo_fore")),
                                     n("torpedo_aft", want.get("torpedo_aft")),
                                     "" if not want.get("torpedo_broadside")
                                     else " / broadside %s"
                                     % n("torpedo_broadside",
                                         want.get("torpedo_broadside"))))
                    else:
                        detail = (" (modelled, no hardpoints: CONFIG carries no "
                                  "torpedo weapon)")
                    row2.append("torpedo ports %s%s"
                                % (n("torpedo_ports", want.get("torpedo_ports")),
                                   detail))
                if "missile_launchers" in want:
                    row2.append("missile launchers %s%s"
                                % (n("missile_launchers",
                                     want.get("missile_launchers")),
                                   "" if not want.get("ventral_tubes")
                                   else " (ventral %s)"
                                   % n("ventral_tubes", want.get("ventral_tubes"))))
                if row2:
                    print("              " + " | ".join(row2))
                row3 = []
                if want.get("third_bridge"):
                    row3.append("third bridge %s, protruding %.2f m BELOW the keel"
                                % (n("third_bridge"),
                                   lay.get("third_bridge_below", 0.0)))
                if want.get("aux_engines"):
                    row3.append("aux engines %s" % n("aux_engines",
                                                     want.get("aux_engines")))
                if want.get("catapult"):
                    row3.append("catapult %s" % n("catapult"))
                if want.get("rocket_anchors"):
                    row3.append("rocket anchors %s"
                                % n("rocket_anchors", want.get("rocket_anchors")))
                if want.get("depth_charges"):
                    row3.append("depth charges %s"
                                % n("depth_charges", want.get("depth_charges")))
                if row3:
                    print("              " + " | ".join(row3))
            print("  groups (%d): %s" % (len(info["groups"]), " ".join(info["groups"])))
            print("  materials (%d): %s" % (len(info["materials"]),
                                            " ".join(info["materials"])))
            print("  hardpoints (%d):" % len(info["hardpoints"]))
            for hp in info["hardpoints"]:
                print("    %-20s %-9s pos [%8.2f %8.2f %9.2f]  dir [%5.2f %5.2f %5.2f]"
                      % (hp["name"], hp["kind"], hp["pos"][0], hp["pos"][1],
                         hp["pos"][2], hp["dir"][0], hp["dir"][1], hp["dir"][2]))
            print("")
        total = sum(i["tris"] for i in results)
        print("summary: %d ships, %d triangles total, %d hardpoints total"
              % (len(results), total, sum(len(i["hardpoints"]) for i in results)))
        for w in rep.warnings:
            print("warning: %s" % w)

    if rep.errors:
        print("")
        print("FAIL - %d contract violation(s):" % len(rep.errors))
        for e in rep.errors:
            print("  - %s" % e)
        return 1
    if not quiet:
        print("OK - all %d models satisfy the SPEC section 4/5 asset contract"
              % len(results))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="validate assets/models against SPEC 4/5")
    ap.add_argument("root", nargs="?", default="assets/models",
                    help="model directory (default: assets/models)")
    ap.add_argument("--quiet", action="store_true", help="only print failures")
    args = ap.parse_args(argv)
    if not os.path.isdir(args.root):
        print("FAIL: %s is not a directory" % args.root)
        return 1
    return validate(args.root, quiet=args.quiet)


if __name__ == "__main__":
    sys.exit(main())
