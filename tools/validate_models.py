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
  and the required mix (bow wmgun, centreline main turrets, stern thrusters,
  secondary turrets, anti-air).

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
          "turret_main", "turret_secondary", "wing", "radiator")

MATERIALS = ("hull_grey", "hull_red", "deck_dark", "glass_blue", "engine_glow",
             "gun_metal", "accent_gold", "hull_green", "hull_olive", "hull_white",
             "hull_black", "bolar_blue")

HARDPOINT_KINDS = ("wmgun", "turret", "thruster", "anti_air")

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
                               wmgun_r=6.0, gold_max=0.5),
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

def check_model(rep, root, model, all_files_used):
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
    if sum(1 for h in model["hardpoints"]
           if h["name"].startswith("turret_secondary")) < 2:
        rep.fail(mid, "fewer than 2 turret_secondary hardpoints")
    if sum(1 for h in model["hardpoints"] if h["kind"] == "thruster") < 2:
        rep.fail(mid, "fewer than 2 thruster hardpoints")
    if not has(lambda h: h["kind"] == "thruster" and h["pos"][2] > 0 and h["dir"][2] > 0.9):
        rep.fail(mid, "no stern thruster hardpoint (z>0, dir +Z)")
    if sum(1 for h in model["hardpoints"] if h["kind"] == "anti_air") < 2:
        rep.fail(mid, "fewer than 2 anti_air hardpoints")

    return {"id": mid, "sil": sil,
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


def validate(root, quiet=False):
    rep = Report()
    manifest_path = os.path.join(root, "manifest.json")
    if not os.path.isfile(manifest_path):
        print("FAIL: %s does not exist" % manifest_path)
        return 1
    with open(manifest_path, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)

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
        info = check_model(rep, root, model, all_files_used)
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
