#!/usr/bin/env python3
"""YAMATO FLEET 2199 - procedural fleet modeller.

Generates the whole v0.1 fleet as ASCII Wavefront OBJ + MTL plus
``manifest.json`` for the Three.js renderer.

Contract (docs/SPEC.md sections 4 and 5 - binding):

* 1 unit = 1 metre.  Ship local space: bow toward -Z, up +Y, origin at the
  ship's centre (mid-length, centreline, mid-height of the hull).
* One ``<id>.obj`` + one ``<id>.mtl`` per ship in ``assets/models/``.
* OBJ ``g`` groups come from the fixed list ``GROUPS``.
* Material names come from the fixed palette ``PALETTE`` (SPEC 5.5).
* Faces are triangles or quads only; ``vn`` normals are written.
* Every ship stays under ``MAX_TRIANGLES`` triangles.

Everything is deterministic: no wall-clock or environment input, seeded
``random.Random`` instances, insertion-ordered containers and coordinates
formatted to 4 decimals.  Re-running produces byte-identical files.

Stdlib only - no numpy, no third-party packages, no pip installs.

Usage:
    python3 tools/gen_models.py --out assets/models
    python3 tools/gen_models.py --out assets/models --only yamato
    python3 tools/gen_models.py --selftest
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import random
import sys

# --------------------------------------------------------------------------
# Frozen contract constants
# --------------------------------------------------------------------------

SCHEMA = "yamato-fleet/models@1"
UNITS = "meters"
AXIS = {"forward": "-Z", "up": "+Y"}
MAX_TRIANGLES = 12000

#: Stable group API - the renderer recolours/animates by these names.
#: Indexed, individually-traversable mount groups (SPEC 5 rule 3).  The group
#: name IS the manifest hardpoint name (``turret_main_1`` group <->
#: ``turret_main_1`` hardpoint), and its geometry is authored centred on its own
#: pivot: x = z = 0 on the traverse axis, y = 0 at the deck line where the
#: barbette meets the hull.  The renderer does ``mesh.position = hardpoint.pos``
#: and then ``mesh.rotation.y = <traverse>``, 0 meaning trained fore-and-aft.
TURRET_GROUPS = ("turret_main", "turret_secondary", "ciws", "missile_launcher",
                 "torpedo_tube")
_TURRET_RE = re.compile(r"^(%s)_\d+$" % "|".join(TURRET_GROUPS))


def is_group(name):
    """True for a fixed group name or an indexed mount group."""
    return name in GROUPS or bool(_TURRET_RE.match(name))


#: Fixed (merged) part groups.  A part that does NOT rotate keeps one of these
#: names even when it is a weapon: the indexed names above are not a naming
#: convention, they are a PROMISE that the geometry is authored on its own
#: traverse pivot and that a hardpoint of the same name exists to place it.  A
#: torpedo port is a flush opening in the plating and a ventral missile tube is
#: welded into the keel - neither ever turns, so both ship as merged groups and
#: carry their direction in the hardpoint ``dir`` instead.  Naming them
#: ``torpedo_tube_3`` would drag them into the pivot contract (and correctly
#: fail it), which is why the 2199 rebuild splits the vocabulary this way.
GROUPS = (
    "hull",
    "superstructure",
    "bridge",
    "wave_motion_gun",
    "engine_nozzle",
    "turret_main",
    "turret_secondary",
    "wing",
    "radiator",
    # 2199 armament-layout groups (docs/research/05-yamato-armament-layout.md):
    "anti_air",          # pulse-laser battery that is not individually traversable
    "torpedo_tube",      # hull torpedo ports (6 fore + 6 aft + 8 per side)
    "missile_launcher",  # ventral tubes, the eight-barrel box, the funnel launcher
    "third_bridge",      # the ventral sub-bridge pod under the command tower
    "catapult",          # aft aircraft-deck catapult
    "rocket_anchor",     # bow rocket anchors
    "aux_engine",        # the two auxiliary engines (secondary thrusters)
    "depth_charge",      # Type 94 depth-charge launchers
)

#: Fixed material NAME palette (SPEC 5.5).  Values are the faction hexes from
#: docs/research/01-yamato-ships.md (MTLLoader converts sRGB -> linear, so these
#: are authored as sRGB).  Names are the frozen API; the *values* vary per ship,
#: which is what makes cyan / amber / red drive glow read apart at 200 m.
def _hex(h):
    h = h.lstrip("#")
    return tuple(round(int(h[k:k + 2], 16) / 255.0, 4) for k in (0, 2, 4))


def _mat(hex_kd, ks=0.30, ns=38.0, glow=0.0, ka=0.08, d=1.0):
    kd = _hex(hex_kd)
    return (kd, (ka, ka, round(min(1.0, ka + 0.01), 4)), (ks, ks, ks), ns,
            tuple(round(c * glow, 4) for c in kd), d)


PALETTE = {                                  # UNCF / Yamato baseline
    "hull_grey":   _mat("#8a8f96", 0.30, 38.0),
    "hull_red":    _mat("#a8342c", 0.22, 26.0),
    "deck_dark":   _mat("#3a3f45", 0.20, 22.0),
    "glass_blue":  _mat("#2b4a63", 0.60, 90.0, glow=0.35),
    "engine_glow": _mat("#6fd0ff", 0.10, 12.0, glow=0.90),
    "gun_metal":   _mat("#5a5f66", 0.42, 60.0),
    "accent_gold": _mat("#c9a227", 0.60, 72.0),
    "hull_green":  _mat("#4a5c3a", 0.24, 30.0),
    "hull_olive":  _mat("#6b7a4a", 0.28, 34.0),
    "hull_white":  _mat("#dfe3e6", 0.28, 34.0),
    "hull_black":  _mat("#17181c", 0.16, 20.0),
    "bolar_blue":  _mat("#4a4a7a", 0.32, 44.0),
}

#: Per-ship overrides (research doc palette tables).
SHIP_PALETTE = {
    "andromeda": {
        "hull_grey":   _mat("#8f949b", 0.30, 38.0),
        "hull_red":    _mat("#9e3230", 0.22, 26.0),
        "deck_dark":   _mat("#343a41", 0.20, 22.0),
        "glass_blue":  _mat("#2f5570", 0.60, 90.0, glow=0.35),
        "engine_glow": _mat("#7fdcff", 0.10, 12.0, glow=0.90),
        "gun_metal":   _mat("#565b62", 0.42, 60.0),
    },
    "kirishima": {
        "hull_grey":   _mat("#82878e", 0.30, 38.0),
        "deck_dark":   _mat("#3d4249", 0.20, 22.0),
        "engine_glow": _mat("#5fc4f5", 0.10, 12.0, glow=0.85),
    },
    "yukikaze": {                            # the colourful one: yellow / red / white
        "hull_grey":   _mat("#dfe3e6", 0.28, 34.0),
        "hull_red":    _mat("#b8322a", 0.22, 26.0),
        "deck_dark":   _mat("#2f3338", 0.20, 22.0),
        "glass_blue":  _mat("#33556e", 0.60, 90.0, glow=0.35),
        "gun_metal":   _mat("#4e535a", 0.42, 60.0),
        "accent_gold": _mat("#d8b23a", 0.60, 72.0),
        "hull_white":  _mat("#dfe3e6", 0.28, 34.0),
    },
    "garmillas_dessler": {
        "hull_green":  _mat("#4a5c3a", 0.24, 30.0),
        "hull_olive":  _mat("#6b7a4a", 0.28, 34.0),
        "deck_dark":   _mat("#23281f", 0.20, 22.0),
        "gun_metal":   _mat("#4a4a46", 0.42, 60.0),
        "accent_gold": _mat("#b08d3a", 0.60, 72.0),
        "engine_glow": _mat("#ffd27a", 0.10, 12.0, glow=0.95),
        "hull_black":  _mat("#1a1d15", 0.16, 20.0),
        "glass_blue":  _mat("#35543f", 0.60, 90.0, glow=0.40),
    },
    "garmillas_kelkapia": {
        "hull_green":  _mat("#46583a", 0.24, 30.0),
        "hull_olive":  _mat("#66744a", 0.28, 34.0),
        "deck_dark":   _mat("#20261c", 0.20, 22.0),
        "gun_metal":   _mat("#47473f", 0.42, 60.0),
        "accent_gold": _mat("#b08d3a", 0.60, 72.0),
        "engine_glow": _mat("#ffc861", 0.10, 12.0, glow=0.95),
        "hull_black":  _mat("#1a1d15", 0.16, 20.0),
        "glass_blue":  _mat("#35543f", 0.60, 90.0, glow=0.40),
    },
    "garmillas_gaiderol": {
        "hull_green":  _mat("#43553a", 0.24, 30.0),
        "hull_olive":  _mat("#5f6d45", 0.28, 34.0),
        "deck_dark":   _mat("#1e241b", 0.20, 22.0),
        "gun_metal":   _mat("#45453d", 0.42, 60.0),
        "accent_gold": _mat("#a8862f", 0.60, 72.0),
        "engine_glow": _mat("#ffbe55", 0.10, 12.0, glow=0.95),
        "hull_black":  _mat("#1a1d15", 0.16, 20.0),
        "glass_blue":  _mat("#35543f", 0.60, 90.0, glow=0.40),
    },
    "bolar_carrier": {
        "bolar_blue":  _mat("#4a4a7a", 0.32, 44.0),
        "hull_olive":  _mat("#5c5c8c", 0.28, 34.0),
        "hull_white":  _mat("#d9dce4", 0.28, 34.0),
        "deck_dark":   _mat("#22223a", 0.20, 22.0),
        "engine_glow": _mat("#ff3b30", 0.10, 12.0, glow=1.00),
        "gun_metal":   _mat("#3f3f55", 0.42, 60.0),
        "accent_gold": _mat("#b0342c", 0.60, 72.0),
        "glass_blue":  _mat("#3a3a5e", 0.60, 90.0, glow=0.35),
    },
}


def resolved_palette(ship_id):
    """Base palette with this ship's faction/ship overrides applied."""
    out = dict(PALETTE)
    out.update(SHIP_PALETTE.get(ship_id, {}))
    return out


MATERIAL_ORDER = (
    "hull_grey", "hull_red", "deck_dark", "glass_blue", "engine_glow",
    "gun_metal", "accent_gold", "hull_green", "hull_olive", "hull_white",
    "hull_black", "bolar_blue",
)

#: ``torpedo`` / ``missile`` are the kinds ``src/core/assets.js`` synthesises for
#: the tube and launcher families, so an authored hardpoint uses the same names
#: the fallback path would have produced rather than inventing a parallel set.
HARDPOINT_KINDS = ("wmgun", "turret", "thruster", "anti_air", "torpedo",
                   "missile")

#: The hull loft is inset by RELIEF so that the raised detail ribbons (transverse
#: seams) land EXACTLY on beamM / 2 at the widest station: the relief defines the
#: beam and the painted band sits just inside it.  The chase camera rides ~355 m
#: behind the ship where 1 px is ~0.17 m, so ~0.5 m of relief is the minimum that
#: still reads as a seam rather than a texture-less slab.
RELIEF = 1.022


# --------------------------------------------------------------------------
# Small vector helpers (pure stdlib)
# --------------------------------------------------------------------------

def v_add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def v_sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def v_dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def v_cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def v_len(a):
    return math.sqrt(v_dot(a, a))


def v_norm(a):
    n = v_len(a)
    if n < 1e-12:
        return (0.0, 0.0, 0.0)
    return (a[0] / n, a[1] / n, a[2] / n)


def lerp(a, b, t):
    return a + (b - a) * t


def fmt(x):
    """Deterministic 4-decimal formatting with no negative zero."""
    if abs(x) < 5e-5:
        x = 0.0
    s = "%.4f" % x
    if s == "-0.0000":
        s = "0.0000"
    return s


# --------------------------------------------------------------------------
# Part: a chunk of geometry with one group, one material per face, one
# shading mode.  Primitives build Parts; ships compose them.
# --------------------------------------------------------------------------

class Part:
    """A rigid chunk of geometry in ship-local coordinates."""

    __slots__ = ("verts", "faces", "mats", "group", "smooth")

    def __init__(self, verts, faces, mat, group, smooth=False, mats=None):
        if not is_group(group):
            raise ValueError("illegal group name: %r" % (group,))
        self.verts = list(verts)
        self.faces = [tuple(f) for f in faces]
        self.mats = list(mats) if mats is not None else [mat] * len(self.faces)
        for m in self.mats:
            if m not in PALETTE:
                raise ValueError("illegal material name: %r" % (m,))
        if len(self.mats) != len(self.faces):
            raise ValueError("mats/faces length mismatch")
        self.group = group
        self.smooth = smooth

    # -- transforms --------------------------------------------------------
    def translate(self, d):
        dx, dy, dz = d
        self.verts = [(x + dx, y + dy, z + dz) for (x, y, z) in self.verts]
        return self

    def rotate_y(self, ang):
        c, s = math.cos(ang), math.sin(ang)
        self.verts = [(x * c + z * s, y, -x * s + z * c) for (x, y, z) in self.verts]
        return self

    def rotate_z(self, ang):
        c, s = math.cos(ang), math.sin(ang)
        self.verts = [(x * c - y * s, x * s + y * c, z) for (x, y, z) in self.verts]
        return self

    def rotate_x(self, ang):
        c, s = math.cos(ang), math.sin(ang)
        self.verts = [(x, y * c - z * s, y * s + z * c) for (x, y, z) in self.verts]
        return self

    def reverse(self):
        """Flip every face - used for inner surfaces (nozzle throats) seen from
        inside the geometry."""
        self.faces = [tuple(reversed(f)) for f in self.faces]
        return self

    def mirror_x(self):
        """Mirror across the centreline; winding is reversed to keep normals out."""
        self.verts = [(-x, y, z) for (x, y, z) in self.verts]
        self.faces = [tuple(reversed(f)) for f in self.faces]
        return self

    def mirror_y(self):
        """Mirror in Y (belly mounts); winding is reversed to keep normals out."""
        self.verts = [(x, -y, z) for (x, y, z) in self.verts]
        self.faces = [tuple(reversed(f)) for f in self.faces]
        return self

    def copy(self):
        return Part(self.verts, self.faces, None, self.group, self.smooth, mats=self.mats)

    # -- queries -----------------------------------------------------------
    def bbox(self):
        xs = [v[0] for v in self.verts]
        ys = [v[1] for v in self.verts]
        zs = [v[2] for v in self.verts]
        return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))

    def tri_count(self):
        return sum(len(f) - 2 for f in self.faces)

    def face_normal(self, f):
        """Newell's method - correct for triangles and for non-planar quads."""
        nx = ny = nz = 0.0
        m = len(f)
        for i in range(m):
            a = self.verts[f[i]]
            b = self.verts[f[(i + 1) % m]]
            nx += (a[1] - b[1]) * (a[2] + b[2])
            ny += (a[2] - b[2]) * (a[0] + b[0])
            nz += (a[0] - b[0]) * (a[1] + b[1])
        return v_norm((nx, ny, nz))

    def normals(self):
        """Normals in OBJ order: per face (flat) or per vertex (smooth)."""
        if not self.smooth:
            return [self.face_normal(f) for f in self.faces]
        acc = [[0.0, 0.0, 0.0] for _ in self.verts]
        for f in self.faces:
            n = self.face_normal(f)
            a = self.verts[f[0]]
            b = self.verts[f[1]]
            c = self.verts[f[2]]
            w = v_len(v_cross(v_sub(b, a), v_sub(c, a)))
            for i in f:
                acc[i][0] += n[0] * w
                acc[i][1] += n[1] * w
                acc[i][2] += n[2] * w
        out = []
        for a in acc:
            n = v_norm((a[0], a[1], a[2]))
            if n == (0.0, 0.0, 0.0):
                n = self.face_normal(self.faces[0]) if self.faces else (0.0, 1.0, 0.0)
            out.append(n)
        return out

    def signed_volume(self):
        """Divergence-theorem volume; positive when faces wind outward."""
        tot = 0.0
        for f in self.faces:
            v0 = self.verts[f[0]]
            for i in range(1, len(f) - 1):
                v1 = self.verts[f[i]]
                v2 = self.verts[f[i + 1]]
                tot += v_dot(v0, v_cross(v1, v2))
        return tot / 6.0


# --------------------------------------------------------------------------
# Primitive helpers
# --------------------------------------------------------------------------

def _ring(n, radius, phase=0.0):
    return [(radius * math.cos(phase + 2.0 * math.pi * i / n),
             radius * math.sin(phase + 2.0 * math.pi * i / n)) for i in range(n)]


def _basis(axis):
    """Right-handed (e1, e2) with cross(e1, e2) == +axis."""
    if axis == "x":
        return (0, 1, 0), (0, 0, 1)
    if axis == "y":
        return (0, 0, 1), (1, 0, 0)
    if axis == "z":
        return (1, 0, 0), (0, 1, 0)
    raise ValueError("bad axis %r" % (axis,))


def _pt(axis, e1, e2, u, v, w):
    """Map in-plane (u, v) plus axis coordinate w into 3D."""
    if axis == "x":
        return (w, u, v)
    if axis == "y":
        return (v, w, u)
    return (u, v, w)


def hexa(corners, mat, group, smooth=False):
    """General 8-corner hexahedron; faces wind outward.

    Corner order: 0..3 = bottom (-Y) ring, 4..7 = top (+Y) ring, both listed
    counter-clockwise seen from +Y.
    """
    if len(corners) != 8:
        raise ValueError("hexa needs 8 corners")
    faces = [
        (0, 1, 2, 3),   # bottom  -Y
        (4, 7, 6, 5),   # top     +Y
        (0, 4, 5, 1),   # front   -Z
        (3, 2, 6, 7),   # back    +Z
        (1, 5, 6, 2),   # right   +X
        (0, 3, 7, 4),   # left    -X
    ]
    return Part(corners, faces, mat, group, smooth)


def box(sx, sy, sz, center=(0.0, 0.0, 0.0), mat="hull_grey", group="hull", smooth=False):
    """Axis-aligned box."""
    cx, cy, cz = center
    x0, x1 = cx - sx / 2.0, cx + sx / 2.0
    y0, y1 = cy - sy / 2.0, cy + sy / 2.0
    z0, z1 = cz - sz / 2.0, cz + sz / 2.0
    corners = [
        (x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1),
        (x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1),
    ]
    return hexa(corners, mat, group, smooth)


def frustum_box(sx, sy, sz, center=(0.0, 0.0, 0.0), scale_top=(1.0, 1.0),
                top_offset=(0.0, 0.0), scale_bottom=(1.0, 1.0),
                mat="hull_grey", group="hull", smooth=False):
    """Box with independently scaled/offset top and bottom faces.

    ``scale_top`` is (x, z); ``top_offset`` shifts the top face in (x, z),
    which gives swept/wedge silhouettes (towers, turret bodies, fins).
    """
    cx, cy, cz = center
    hx, hz = sx / 2.0, sz / 2.0
    bx, bz = hx * scale_bottom[0], hz * scale_bottom[1]
    tx, tz = hx * scale_top[0], hz * scale_top[1]
    ox, oz = top_offset
    y0, y1 = cy - sy / 2.0, cy + sy / 2.0
    corners = [
        (cx - bx, y0, cz - bz), (cx + bx, y0, cz - bz),
        (cx + bx, y0, cz + bz), (cx - bx, y0, cz + bz),
        (cx - tx + ox, y1, cz - tz + oz), (cx + tx + ox, y1, cz - tz + oz),
        (cx + tx + ox, y1, cz + tz + oz), (cx - tx + ox, y1, cz + tz + oz),
    ]
    return hexa(corners, mat, group, smooth)


def cylinder(radius, length, axis="z", center=(0.0, 0.0, 0.0), segments=16,
             radius2=None, mat="hull_grey", group="hull", caps=True,
             smooth=True, phase=0.0):
    """Cylinder / cone frustum along an axis; ``radius`` is at the -axis end."""
    r2 = radius if radius2 is None else radius2
    e1, e2 = _basis(axis)
    h = length / 2.0
    verts = []
    for (u, v) in _ring(segments, radius, phase):
        verts.append(_pt(axis, e1, e2, u, v, -h))
    for (u, v) in _ring(segments, r2, phase):
        verts.append(_pt(axis, e1, e2, u, v, h))
    faces = []
    for i in range(segments):
        j = (i + 1) % segments
        faces.append((i, j, segments + j, segments + i))
    if caps:
        cb = len(verts)
        verts.append(_pt(axis, e1, e2, 0.0, 0.0, -h))
        ct = len(verts)
        verts.append(_pt(axis, e1, e2, 0.0, 0.0, h))
        for i in range(segments):
            j = (i + 1) % segments
            faces.append((cb, j, i))                        # -axis cap
            faces.append((ct, segments + i, segments + j))  # +axis cap
    return Part(verts, faces, mat, group, smooth).translate(center)


def ring(inner_r, outer_r, length, axis="z", center=(0.0, 0.0, 0.0), segments=16,
         mat="gun_metal", group="hull", smooth=False):
    """Annular tube (raised collar / muzzle lip) with both end faces capped."""
    e1, e2 = _basis(axis)
    h = length / 2.0
    verts = []
    for (u, v) in _ring(segments, outer_r):
        verts.append(_pt(axis, e1, e2, u, v, -h))
    for (u, v) in _ring(segments, outer_r):
        verts.append(_pt(axis, e1, e2, u, v, h))
    for (u, v) in _ring(segments, inner_r):
        verts.append(_pt(axis, e1, e2, u, v, -h))
    for (u, v) in _ring(segments, inner_r):
        verts.append(_pt(axis, e1, e2, u, v, h))
    n = segments
    O0, O1, I0, I1 = 0, n, 2 * n, 3 * n
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append((O0 + i, O0 + j, O1 + j, O1 + i))   # outer skin
        faces.append((I0 + j, I0 + i, I1 + i, I1 + j))   # inner skin
        faces.append((O1 + i, O1 + j, I1 + j, I1 + i))   # +axis annulus
        faces.append((O0 + j, O0 + i, I0 + i, I0 + j))   # -axis annulus
    return Part(verts, faces, mat, group, smooth).translate(center)


def disc(radius, thickness, axis="z", center=(0.0, 0.0, 0.0), segments=16,
         mat="engine_glow", group="engine_nozzle"):
    return cylinder(radius, thickness, axis=axis, center=center, segments=segments,
                    mat=mat, group=group, caps=True, smooth=False)


def dome(radius, height, center=(0.0, 0.0, 0.0), segments=20, rings=4,
         mat="hull_grey", group="bridge", squash=(1.0, 1.0)):
    """Half-ellipsoid dome (Garmillas bridge domes); flat base at -Y."""
    sx, sz = squash
    verts = []
    faces = []
    ring_start = []
    for k in range(rings + 1):
        t = k / float(rings)
        ang = (math.pi / 2.0) * t
        r = radius * math.cos(ang)
        y = height * math.sin(ang)
        ring_start.append(len(verts))
        if k == rings:
            verts.append((0.0, y, 0.0))
        else:
            for i in range(segments):
                a = 2.0 * math.pi * i / segments
                verts.append((r * math.cos(a) * sx, y, -r * math.sin(a) * sz))
    for k in range(rings):
        base = ring_start[k]
        nxt = ring_start[k + 1]
        if k == rings - 1:
            for i in range(segments):
                j = (i + 1) % segments
                faces.append((base + i, base + j, nxt))
        else:
            for i in range(segments):
                j = (i + 1) % segments
                faces.append((base + i, base + j, nxt + j, nxt + i))
    base = ring_start[0]
    cb = len(verts)
    verts.append((0.0, 0.0, 0.0))
    for i in range(segments):
        j = (i + 1) % segments
        faces.append((cb, base + j, base + i))
    return Part(verts, faces, mat, group, smooth=True).translate(center)


# -- 2D polygon helpers ----------------------------------------------------

def poly_area(pts):
    a = 0.0
    m = len(pts)
    for i in range(m):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % m]
        a += x0 * y1 - x1 * y0
    return a / 2.0


def ensure_ccw(pts):
    """CCW in the XY plane as seen from +Z, so lofted quads face outward."""
    return list(pts) if poly_area(pts) >= 0.0 else list(reversed(pts))


def resample_closed(pts, n):
    """Resample a closed polygon to exactly n points by arc length."""
    m = len(pts)
    segs = []
    total = 0.0
    for i in range(m):
        a = pts[i]
        b = pts[(i + 1) % m]
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        segs.append(d)
        total += d
    if total <= 1e-9:
        return [pts[0]] * n
    out = []
    for k in range(n):
        target = total * k / n
        acc = 0.0
        for i, d in enumerate(segs):
            if acc + d >= target - 1e-12:
                t = 0.0 if d <= 1e-12 else (target - acc) / d
                a = pts[i]
                b = pts[(i + 1) % m]
                out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
                break
            acc += d
        else:
            out.append(pts[-1])
    return out


def resample_keep(pts, n):
    """Grow a polygon to n points by splitting its longest edges.

    Unlike uniform arc-length resampling this preserves every original vertex,
    which matters because the widest point of a hull section defines the beam.
    """
    out = list(pts)
    if n <= len(out):
        return resample_closed(out, n)
    while len(out) < n:
        best_i = 0
        best_d = -1.0
        m = len(out)
        for i in range(m):
            a = out[i]
            b = out[(i + 1) % m]
            d = math.hypot(b[0] - a[0], b[1] - a[1])
            if d > best_d:
                best_d = d
                best_i = i
        a = out[best_i]
        b = out[(best_i + 1) % m]
        out.insert(best_i + 1, ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0))
    return out


def _clip_half(pts, bound, keep_above):
    out = []
    m = len(pts)
    for i in range(m):
        a = pts[i]
        b = pts[(i + 1) % m]
        ain = (a[1] >= bound) if keep_above else (a[1] <= bound)
        bin_ = (b[1] >= bound) if keep_above else (b[1] <= bound)
        if ain:
            out.append(a)
        if ain != bin_:
            dy = b[1] - a[1]
            t = 0.0 if abs(dy) < 1e-12 else (bound - a[1]) / dy
            out.append((a[0] + (b[0] - a[0]) * t, bound))
    return out


def clip_polygon_y(pts, y0, y1):
    """Sutherland-Hodgman clip of a closed polygon against a y slab."""
    out = _clip_half(_clip_half(pts, y0, True), y1, False)
    clean = []
    for p in out:
        if not clean or abs(p[0] - clean[-1][0]) > 1e-9 or abs(p[1] - clean[-1][1]) > 1e-9:
            clean.append(p)
    if len(clean) > 1 and abs(clean[0][0] - clean[-1][0]) < 1e-9 \
            and abs(clean[0][1] - clean[-1][1]) < 1e-9:
        clean.pop()
    return clean


def hull_section(hw, y_deck, y_keel, deck_frac=0.84, bulge_y=0.50, bilge=0.30,
                 bilge_steps=4):
    """UNCF battleship cross-section: flat deck, flared topsides, a turn of the
    bilge and a keel - i.e. it tapers to a keel instead of ending in a slab.

    ``bulge_y`` is where the maximum beam sits (fraction of hull depth below the
    deck), ``bilge`` the depth fraction at which the bottom starts to round in.
    """
    h = y_deck - y_keel
    right = [
        (hw * deck_frac, y_deck),                 # deck edge
        (hw, y_deck - h * bulge_y),               # maximum beam
        (hw * 0.97, y_keel + h * (bilge + 0.10)),
    ]
    # turn of the bilge: a quarter ellipse from the side down to the keel plate
    cx, cy = hw * 0.20, y_keel + h * bilge
    rx, ry = hw * 0.77, h * bilge
    for k in range(bilge_steps):
        a = (math.pi / 2.0) * (k + 1) / float(bilge_steps + 1)
        right.append((cx + rx * math.cos(a), cy + ry * math.sin(a)))
    right.append((cx, y_keel))                    # keel plate edge
    right.append((0.0, y_keel))                   # keel
    pts = right + [(-x, y) for (x, y) in reversed(right[:-1])]
    return ensure_ccw(pts)


def make_rake(L, z_bow, z_stern, y_deck_bow, y_keel_bow, bow_r=0.0, bow_p=1.8,
              bow_fade=0.24, stern_r=0.0, stern_p=1.8, stern_fade=0.20):
    """Return a z-deformation giving a raked clipper bow and a shaped transom.

    ``rake(y, z)`` pulls the *lower* hull aft near the bow (so the stem rakes
    forward going up and the upper bow overhangs the waterline entry) and pulls
    the lower hull forward near the stern (so the transom overhangs the nozzles).
    The deck-level line is never moved, so the extreme bow stays exactly at
    -lengthM/2 and the transom top exactly at +lengthM/2.
    """
    def clamp01(v):
        return 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)

    def rake(y, z):
        t = clamp01((y - y_keel_bow) / max(1e-9, y_deck_bow - y_keel_bow))
        dz = 0.0
        if bow_r:
            # full strength at the stem, ramped out by bow_fade * L
            f = clamp01((z - (z_bow + bow_fade * L)) / (-0.14 * L))
            dz += bow_r * ((1.0 - t) ** bow_p) * f
        if stern_r:
            f = clamp01(((z_stern - stern_fade * L) - z) / (-0.12 * L))
            dz -= stern_r * ((1.0 - t) ** stern_p) * f
        return dz
    return rake


def apply_rake(ship, rake, exclude=("wave_motion_gun", "engine_nozzle")):
    """Deform every hull-following part with the rake.

    The bow gun and the engine bells are excluded: they are placed deliberately
    on the exact bow and stern planes, and the deformed hull is shaped around
    them (a proud muzzle forward, bells recessed into the transom aft).
    """
    for part in ship.parts:
        if part.group in exclude or _TURRET_RE.match(part.group):
            continue
        part.verts = [(x, y, z + rake(y, z)) for (x, y, z) in part.verts]
    return ship


def angular_section(hw, y_top, y_bot, shoulder=0.52, chine_y=0.50, keel_frac=0.0):
    """Angular Garmillas cross-section: hard chines, faceted sides."""
    h = y_top - y_bot
    right = [
        (hw * shoulder, y_top),
        (hw, y_top - h * chine_y),
        (hw * 0.52, y_bot + h * 0.18),
        (hw * keel_frac, y_bot),
        (0.0, y_bot),
    ]
    pts = right + [(-x, y) for (x, y) in reversed(right[:-1])]
    return ensure_ccw(pts)


def block_section(hw, y_top, y_bot):
    """Rectangular cross-section for the blocky Bolar hulls."""
    return ensure_ccw([(-hw, y_top), (hw, y_top), (hw, y_bot), (-hw, y_bot)])


def loft(sections, mat, group, smooth=True, cap_start=True, cap_end=True):
    """Loft (z, [(x, y), ...]) sections ordered by increasing z.

    All sections must share a point count.  Bow cap at the first section,
    stern cap at the last.
    """
    if len(sections) < 2:
        raise ValueError("loft needs >= 2 sections")
    n = len(sections[0][1])
    for z, pts in sections:
        if len(pts) != n:
            raise ValueError("loft sections must share a point count")
    verts = []
    for (z, pts) in sections:
        for (x, y) in pts:
            verts.append((x, y, z))
    faces = []
    for si in range(len(sections) - 1):
        a = si * n
        b = (si + 1) * n
        for j in range(n):
            k = (j + 1) % n
            faces.append((a + j, a + k, b + k, b + j))
    if cap_start:
        cb = len(verts)
        verts.append(_centroid3(sections[0]))
        for j in range(n):
            faces.append((cb, (j + 1) % n, j))
    if cap_end:
        base = (len(sections) - 1) * n
        ce = len(verts)
        verts.append(_centroid3(sections[-1]))
        for j in range(n):
            faces.append((ce, base + j, base + (j + 1) % n))
    return Part(verts, faces, mat, group, smooth)


def _centroid3(section):
    z, pts = section
    sx = sum(p[0] for p in pts) / len(pts)
    sy = sum(p[1] for p in pts) / len(pts)
    return (sx, sy, z)


def belt(sections, y0, y1, n_side, out_scale, mat, group, smooth=True):
    """A stripe ribbon that follows the hull between two horizontal lines.

    The hull cross-section is clipped to the y slab, resampled and scaled
    slightly outward, so the stripe tracks the hull taper exactly (this is how
    the red waterline band is painted on).
    """
    loops = []
    for (z, pts) in sections:
        loop = clip_polygon_y(pts, y0, y1)
        if len(loop) < 3:
            continue
        loop = ensure_ccw([(x * out_scale, y * out_scale) for (x, y) in loop])
        loops.append((z, loop))
    if len(loops) < 2:
        raise ValueError("belt: the y slab did not intersect the hull")
    n = max([n_side * 2] + [len(loop) for (_, loop) in loops])
    clipped = [(z, resample_keep(loop, n)) for (z, loop) in loops]
    return loft(clipped, mat, group, smooth=smooth, cap_start=False, cap_end=False)


def slab_along_sections(sections, half_w_frac, y_off, thickness, mat, group,
                        smooth=False):
    """Thin plate following the hull plan-form (the main deck / flight deck)."""
    slab = []
    for (z, pts) in sections:
        hw = max(abs(p[0]) for p in pts)
        w = hw * half_w_frac
        y = max(p[1] for p in pts) + y_off
        rect = ensure_ccw([(-w, y), (w, y), (w, y + thickness), (-w, y + thickness)])
        slab.append((z, resample_keep(rect, 8)))
    return loft(slab, mat, group, smooth=smooth, cap_start=True, cap_end=True)


# --------------------------------------------------------------------------
# Composite primitives - each returns a list of Parts built at the origin
# --------------------------------------------------------------------------

def as_list(objs):
    """Normalise a Part or a list of Parts to a list."""
    if isinstance(objs, Part):
        return [objs]
    return list(objs)


def merge_parts(objs, group=None):
    """Concatenate several Parts into ONE Part (one mesh in the OBJ).

    WHY THIS EXISTS: a weapon mount is one object - a pedestal, a gun house and
    a barrel cluster - but it is built from several primitives, and the OBJ
    carries no structure below the ``g`` group.  Emitting a mount as one Part
    makes it COUNTABLE from the file: tools/validate_models.py counts
    face-connected components per group, so "38 pulse-laser mounts" is exactly
    38 meshes instead of 178 loose boxes, and a battery that silently thinned
    back to six mounts fails the check.  It costs nothing at runtime either -
    src/core/assets.js merges a group's faces into one BufferGeometry anyway -
    and it preserves each face's own material and normal.
    """
    parts = as_list(objs)
    if len(parts) == 1:
        return parts[0]
    verts, faces, mats = [], [], []
    for p in parts:
        off = len(verts)
        verts.extend(p.verts)
        for f, m in zip(p.faces, p.mats):
            faces.append(tuple(i + off for i in f))
            mats.append(m)
    return Part(verts, faces, None, group or parts[0].group, parts[0].smooth,
                mats=mats)


def xf_translate(objs, d):
    for p in as_list(objs):
        p.translate(d)
    return objs


def xf_rotate_y(objs, ang):
    for p in as_list(objs):
        p.rotate_y(ang)
    return objs


def xf_rotate_z(objs, ang):
    for p in as_list(objs):
        p.rotate_z(ang)
    return objs


def xf_mirror_y(objs):
    for p in as_list(objs):
        p.mirror_y()
    return objs


def xf_mirror_x(objs):
    for p in as_list(objs):
        p.mirror_x()
    return objs


def xf_copy(objs):
    return [p.copy() for p in as_list(objs)]


def tri_count(objs):
    return sum(p.tri_count() for p in as_list(objs))


def barrel(length, radius, segments=10, mat="gun_metal", group="turret_main",
           muzzle=True, sleeve=True, muzzle_ring=False):
    """Gun barrel pointing -Z, built at the origin (breech at +Z).

    Stepped: a thicker jacket over the breech third, a tapered tube, and a
    muzzle step with a ring - so barrels read as machinery, not sticks.
    """
    parts = [cylinder(radius, length * 0.86, axis="z",
                      center=(0.0, 0.0, -length * 0.07), segments=segments,
                      radius2=radius * 0.86, mat=mat, group=group, caps=True,
                      smooth=True)]
    if sleeve:
        parts.append(cylinder(radius * 1.55, length * 0.30, axis="z",
                              center=(0.0, 0.0, length * 0.20), segments=8,
                              radius2=radius * 1.30, mat=mat, group=group,
                              caps=False, smooth=True))
    if muzzle:
        parts.append(cylinder(radius * 1.35, length * 0.14, axis="z",
                              center=(0.0, 0.0, -length * 0.43), segments=8,
                              radius2=radius * 1.2, mat=mat, group=group,
                              caps=False, smooth=True))
        if muzzle_ring:
            parts.append(ring(radius * 1.05, radius * 1.55, length * 0.045, axis="z",
                              center=(0.0, 0.0, -length * 0.465), segments=8,
                              mat=mat, group=group))
    return parts


def turret(barbette_r, barbette_h, body, barrels, barrel_r, barrel_len,
           group="turret_main", body_mat="hull_grey", barbette_mat="gun_metal",
           barrel_mat="gun_metal", muzzle=True, elev=0.0, deck_ring=True,
           muzzle_ring=False, barbette_seg=14):
    """Turret: barbette + sloped body + barrels.

    Built at the origin with its base on y=0, facing -Z; the caller places it
    (``rot_y=math.pi`` for aft mounts).
    """
    cx, cy, cz = body
    deck = barbette_h - 0.4                  # gun-house floor, above the pivot
    parts = []
    if deck_ring:
        # barbette ring at deck level so the mount sits INTO the deck
        parts.append(ring(barbette_r * 0.95, barbette_r * 1.12,
                          max(1.4, barbette_h * 0.34), axis="y",
                          center=(0.0, 0.7, 0.0), segments=8,
                          mat=barbette_mat, group=group))
    parts += [
        cylinder(barbette_r, barbette_h, axis="y",
                 center=(0.0, barbette_h / 2.0, 0.0), segments=barbette_seg,
                 mat=barbette_mat, group=group, smooth=True),
        # flared lower skirt of the gun house
        frustum_box(cx * 1.05, cy * 0.40, cz * 1.05,
                    center=(0.0, deck + cy * 0.20, 0.0), scale_top=(0.97, 0.98),
                    mat=body_mat, group=group),
        # main sloped body
        frustum_box(cx, cy * 0.64, cz,
                    center=(0.0, deck + cy * 0.40 + cy * 0.32, 0.0),
                    scale_top=(0.76, 0.84), top_offset=(0.0, cz * 0.05),
                    mat=body_mat, group=group),
        # inset roof plate
        frustum_box(cx * 0.70, cy * 0.20, cz * 0.86,
                    center=(0.0, deck + cy * 0.96, 0.0), scale_top=(0.92, 0.94),
                    mat="deck_dark", group=group),
        # mantlet plate where the barrels pass through the face
        frustum_box(cx * 0.84, cy * 0.46, max(1.0, cz * 0.06),
                    center=(0.0, deck + cy * 0.46, -cz / 2.0 - 0.15),
                    scale_top=(0.82, 1.0), mat=barbette_mat, group=group),
    ]
    by = deck + cy * 0.50
    spread = barrel_r * 3.4
    if barrels == 1:
        offsets = [0.0]
    elif barrels == 2:
        offsets = [-spread, spread]
    else:
        offsets = [-spread * 1.5, 0.0, spread * 1.5]
    for ox in offsets:
        b = barrel(barrel_len, barrel_r, segments=10, mat=barrel_mat, group=group,
                   muzzle=muzzle, muzzle_ring=muzzle_ring)
        if elev:
            for q in b:
                q.rotate_x(elev)          # guns at rest, elevated a few degrees
        xf_translate(b, (ox, by, -cz / 2.0 - barrel_len * 0.30))
        parts.extend(b)
    return parts


def nozzle(radius, length, center=(0.0, 0.0, 0.0), segments=20, glow=True,
           fins=4, group="engine_nozzle", bell_mat="hull_grey",
           lip_mat="gun_metal", fin_mat="deck_dark", lip=0.12, vanes=6,
           throat=True, actuator=True, trim=None):
    """Engine bell pointing +Z: flared cone, lip ring, inner throat, vanes,
    actuator ring and a glow disc so the drive reads as machinery."""
    z1 = length / 2.0
    parts = [
        cylinder(radius * 0.62, length, axis="z", center=(0.0, 0.0, 0.0),
                 segments=segments, radius2=radius, mat=bell_mat, group=group,
                 caps=False, smooth=True),
    ]
    lip_len = max(1.2, length * lip)
    trim = segments if trim is None else trim
    parts.append(ring(radius * 0.86, radius * 1.06, lip_len, axis="z",
                      center=(0.0, 0.0, z1 - lip_len / 2.0), segments=trim,
                      mat=lip_mat, group=group))
    if actuator:
        # actuator ring around the throat
        parts.append(ring(radius * 0.60, radius * 0.76, max(1.0, length * 0.08),
                          axis="z", center=(0.0, 0.0, -length * 0.10),
                          segments=trim, mat=lip_mat, group=group))
    if throat:
        th = cylinder(radius * 0.78, length * 0.62, axis="z",
                      center=(0.0, 0.0, -length * 0.14), segments=trim,
                      radius2=radius * 0.97, mat="hull_black", group=group,
                      caps=False, smooth=True)
        th.reverse()                      # inner skin faces the viewer
        parts.append(th)
    if vanes:
        for k in range(vanes):
            ang = 2.0 * math.pi * k / vanes
            vane = box(radius * 0.40, max(0.5, radius * 0.10), length * 0.34,
                       center=(radius * 0.60, 0.0, -length * 0.06),
                       mat=lip_mat, group=group)
            vane.rotate_z(ang)
            parts.append(vane)
    if glow:
        parts.append(disc(radius * 0.84, max(0.6, length * 0.05), axis="z",
                          center=(0.0, 0.0, z1 - lip_len - 0.8), segments=trim,
                          mat="engine_glow", group=group))
    for k in range(fins):
        ang = 2.0 * math.pi * k / fins + math.pi / fins
        fin = box(radius * 0.5, 0.9, length * 0.45,
                  center=(radius * 1.02, 0.0, -length * 0.16), mat=fin_mat, group=group)
        fin.rotate_z(ang)
        parts.append(fin)
    for p in parts:
        p.translate(center)
    return parts


def bow_gun(radius, length, z_muzzle, y=0.0, segments=20, collar=None,
           group="wave_motion_gun", housing_mat="hull_grey", collar_mat="gun_metal",
           bore_mat="hull_black", glow=True):
    """Wave-motion-gun / bow-beam emitter: barrel housing, collar, dark bore.

    ``z_muzzle`` is the exact forward face (must be -lengthM/2 for the ship).
    The barrel extends aft by ``length``.
    """
    zc = z_muzzle + length / 2.0
    parts = [cylinder(radius, length, axis="z", center=(0.0, y, zc),
                      segments=segments, radius2=radius * 0.94, mat=housing_mat,
                      group=group, caps=False, smooth=True)]
    if collar is None:
        collar = radius * 1.16
    collar_len = max(1.6, radius * 0.45)
    parts.append(ring(radius * 0.86, collar, collar_len, axis="z",
                      center=(0.0, y, z_muzzle + collar_len / 2.0), segments=segments,
                      mat=collar_mat, group=group))
    bore_in = radius * 0.60
    parts.append(ring(bore_in, radius * 0.88, collar_len * 0.8, axis="z",
                      center=(0.0, y, z_muzzle + collar_len * 0.4), segments=segments,
                      mat=bore_mat, group=group))
    if glow:
        parts.append(disc(bore_in * 0.96, max(0.6, radius * 0.12), axis="z",
                          center=(0.0, y, z_muzzle + collar_len * 0.4 + 0.6),
                          segments=segments, mat="engine_glow", group=group))
    return parts


def mast(height, base_r, segments=6, arms=2, dish_r=0.0, mat="hull_grey",
         group="bridge", dish_mat="deck_dark"):
    """Radar mast built at the origin with its base on y=0: column, yards, dish."""
    parts = [cylinder(base_r, height, axis="y", center=(0.0, height / 2.0, 0.0),
                      segments=segments, radius2=base_r * 0.45, mat=mat,
                      group=group, smooth=True)]
    for k in range(arms):
        ay = height * (0.60 + 0.22 * k)
        arm_len = base_r * (8.0 - 2.5 * k)
        parts.append(box(arm_len, 0.6, 0.6, center=(0.0, ay, 0.0), mat=mat,
                         group=group))
        parts.append(box(0.6, 0.6, arm_len * 0.55, center=(0.0, ay, 0.0), mat=mat,
                         group=group))
    if dish_r > 0.0:
        parts.append(cylinder(dish_r, 0.7, axis="y", center=(0.0, height * 0.88, 0.0),
                              segments=12, radius2=dish_r * 0.85, mat=dish_mat,
                              group=group))
        parts.append(cylinder(dish_r * 0.22, 2.4, axis="y",
                              center=(0.0, height * 0.88 + 1.5, 0.0), segments=8,
                              mat=dish_mat, group=group))
    return parts


def greeble_row(rng, count, x, y, z0, z1, size, mat, group, half_w=0.0, jitter=0.35):
    """Deterministic row of small surface boxes (vents, hatches, thruster pods)."""
    parts = []
    for i in range(count):
        t = (i + 0.5) / count
        z = lerp(z0, z1, t)
        sx = size[0] * (1.0 + jitter * (rng.random() - 0.5))
        sy = size[1] * (1.0 + jitter * (rng.random() - 0.5))
        sz = size[2] * (1.0 + jitter * (rng.random() - 0.5))
        off = (rng.random() - 0.5) * half_w
        parts.append(box(sx, sy, sz, center=(x + off, y, z), mat=mat, group=group))
    return parts


def panel_lines(sections, y, thickness, height, mat, group, mat_frac=0.93):
    """Thin strakes/panel strips that follow the hull taper, section to section."""
    parts = []
    for i in range(len(sections) - 1):
        z0, pts0 = sections[i]
        z1, pts1 = sections[i + 1]
        hw0 = x_at_y(pts0, y) * mat_frac
        hw1 = x_at_y(pts1, y) * mat_frac
        dz = z1 - z0
        ang = math.atan2(hw1 - hw0, dz)
        length = math.hypot(dz, hw1 - hw0)
        right = box(thickness, height, length * 0.96, center=(0.0, 0.0, 0.0),
                    mat=mat, group=group)
        right.rotate_y(ang)
        right.translate(((hw0 + hw1) / 2.0, y, (z0 + z1) / 2.0))
        parts.append(right)
        parts.append(right.copy().mirror_x())
    return parts


def hw_at(sections, z):
    """Interpolated hull half-width at z (plan-form query)."""
    for i in range(len(sections) - 1):
        z0 = sections[i][0]
        z1 = sections[i + 1][0]
        if z0 <= z <= z1:
            t = 0.0 if abs(z1 - z0) < 1e-9 else (z - z0) / (z1 - z0)
            return lerp(max(abs(p[0]) for p in sections[i][1]),
                        max(abs(p[0]) for p in sections[i + 1][1]), t)
    if z < sections[0][0]:
        return max(abs(p[0]) for p in sections[0][1])
    return max(abs(p[0]) for p in sections[-1][1])


def x_at_y(pts, y):
    """Right-side x of a closed section polygon at height y."""
    best = None
    m = len(pts)
    for i in range(m):
        a = pts[i]
        b = pts[(i + 1) % m]
        if a[0] < 0.0 and b[0] < 0.0:
            continue
        lo, hi = min(a[1], b[1]), max(a[1], b[1])
        if lo - 1e-9 <= y <= hi + 1e-9:
            if abs(b[1] - a[1]) < 1e-12:
                x = max(a[0], b[0])
            else:
                t = (y - a[1]) / (b[1] - a[1])
                x = a[0] + (b[0] - a[0]) * t
            if best is None or x > best:
                best = x
    if best is None:
        best = max(abs(q[0]) for q in pts)
    return best


def hx_at(sections, z, y):
    """Hull surface half-width at (z, y) - the seating point for surface detail."""
    for i in range(len(sections) - 1):
        z0 = sections[i][0]
        z1 = sections[i + 1][0]
        if z0 <= z <= z1:
            t = 0.0 if abs(z1 - z0) < 1e-9 else (z - z0) / (z1 - z0)
            return lerp(x_at_y(sections[i][1], y), x_at_y(sections[i + 1][1], y), t)
    if z < sections[0][0]:
        return x_at_y(sections[0][1], y)
    return x_at_y(sections[-1][1], y)


def ydeck_at(sections, z):
    """Interpolated deck height at z."""
    for i in range(len(sections) - 1):
        z0 = sections[i][0]
        z1 = sections[i + 1][0]
        if z0 <= z <= z1:
            t = 0.0 if abs(z1 - z0) < 1e-9 else (z - z0) / (z1 - z0)
            return lerp(max(p[1] for p in sections[i][1]),
                        max(p[1] for p in sections[i + 1][1]), t)
    if z < sections[0][0]:
        return max(p[1] for p in sections[0][1])
    return max(p[1] for p in sections[-1][1])


# --------------------------------------------------------------------------
# Detail library: hull plating, windows, fittings, faction surface language
# --------------------------------------------------------------------------

def section_at(sections, z):
    """Interpolated cross-section polygon at z (same point count as the loft)."""
    if z <= sections[0][0]:
        return list(sections[0][1])
    if z >= sections[-1][0]:
        return list(sections[-1][1])
    for i in range(len(sections) - 1):
        z0, p0 = sections[i]
        z1, p1 = sections[i + 1]
        if z0 <= z <= z1:
            t = 0.0 if abs(z1 - z0) < 1e-9 else (z - z0) / (z1 - z0)
            return [(lerp(a[0], b[0], t), lerp(a[1], b[1], t)) for a, b in zip(p0, p1)]
    return list(sections[-1][1])


#: Chase-camera legibility floors.  Enlarging a box or a ribbon costs no
#: extra triangles, so every detail helper clamps its dimensions up to these:
#: below them the feature is sub-pixel from the chase camera and the triangles
#: are wasted.
MIN_SEAM = 2.8            # transverse seam thickness (m)
MIN_RELIEF = 1.018        # minimum ribbon relief factor
MIN_STRAKE = (1.8, 2.4)   # strake thickness, height (m)
MIN_WINDOW = (2.8, 1.9)   # hull window width, height (m)
MIN_GRID = (2.4, 1.8)     # superstructure window width, height (m)
MIN_DEPTH = 0.8           # window depth off the face (m)


def hull_band(sections, z0, z1, out_scale, mat, group, smooth=True,
              prismatic=False):
    """Open ribbon wrapping the whole hull between two z stations.

    ``prismatic`` extrudes the exact station polygon instead of interpolating
    the taper, so a seam that sits on the widest station reaches precisely
    ``out_scale * half_beam`` - that is what pins the ship's beam.
    """
    if prismatic:
        p = section_at(sections, (z0 + z1) / 2.0)
        a = [(x * out_scale, y * out_scale) for (x, y) in p]
        b = a
    else:
        a = [(x * out_scale, y * out_scale) for (x, y) in section_at(sections, z0)]
        b = [(x * out_scale, y * out_scale) for (x, y) in section_at(sections, z1)]
    return loft([(z0, a), (z1, b)], mat, group, smooth=smooth, cap_start=False,
                cap_end=False)


def frame_rings(s, sections, stations, thickness, mat, group="hull",
                out_scale=None):
    """Transverse hull seams: raised ribs wrapping the hull at given z stations."""
    thickness = max(thickness, MIN_SEAM)
    out_scale = RELIEF if out_scale is None else max(out_scale, RELIEF)
    parts = []
    for z in stations:
        parts.append(hull_band(sections, z - thickness / 2.0, z + thickness / 2.0,
                               out_scale, mat, group, prismatic=True))
    s.add(parts)
    return parts


def strake_lines(s, sections, ys, thickness, height, mat, group="hull",
                 mat_frac=0.985):
    """Longitudinal hull strakes at several heights (follows the hull taper)."""
    thickness = max(thickness, MIN_STRAKE[0])
    height = max(height, MIN_STRAKE[1])
    mat_frac = min(mat_frac, 0.962)
    parts = []
    for y in ys:
        parts.extend(panel_lines(sections, y, thickness, height, mat, group,
                                 mat_frac=mat_frac))
    s.add(parts)
    return parts


def armour_belt(s, sections, z0, z1, y0, y1, mat, group="hull", out_scale=1.016,
                ribs=True, rib_mat=None):
    """Raised armour belt over a z range, framed by two ribs (reads as inset)."""
    sub = [(z, pts) for (z, pts) in sections if z0 - 1e-6 <= z <= z1 + 1e-6]
    if len(sub) < 2:
        sub = [(z0, section_at(sections, z0)), (z1, section_at(sections, z1))]
    out_scale = max(out_scale, 1.016)
    rib = hull_band(sections, z0 - 1.6, z0 + 1.6, RELIEF, rib_mat or mat, group,
                    smooth=False)
    rib2 = hull_band(sections, z1 - 1.6, z1 + 1.6, RELIEF, rib_mat or mat, group,
                     smooth=False)
    parts = [belt(sub, y0, y1, 12, out_scale, mat, group, smooth=False)]
    if ribs:
        parts += [rib, rib2]
    s.add(parts)
    return parts


def window_row(s, sections, y, z0, z1, count, win=(2.0, 1.2), depth=0.5,
               mat="glass_blue", group="superstructure", proud=0.08, alt=0.0):
    """Evenly spaced emissive windows seated on both hull sides (or one row)."""
    win = (max(win[0], MIN_WINDOW[0]), max(win[1], MIN_WINDOW[1]))
    depth = max(depth, MIN_DEPTH)
    parts = []
    for i in range(count):
        t = (i + 0.5) / count
        z = lerp(z0, z1, t)
        yy = y + (alt if (i % 2) else 0.0)
        x = hx_at(sections, z, yy) - depth / 2.0 + proud
        for sgn in (1.0, -1.0):
            parts.append(box(depth, win[1], win[0], center=(sgn * x, yy, z),
                             mat=mat, group=group))
    s.add(parts)
    return parts


def window_grid(center, axis, width, height, rows, cols, win=(2.4, 1.5), depth=0.6,
                mat="glass_blue", group="superstructure"):
    """Grid of windows on a flat superstructure face.

    ``axis`` is the outward normal: 'x', '-x', 'z' or '-z'.  ``center`` is the
    face centre, so the windows sit on it and protrude outward by ``depth``.
    """
    cx, cy, cz = center
    win = (max(win[0], MIN_GRID[0]), max(win[1], MIN_GRID[1]))
    depth = max(depth, MIN_DEPTH)
    parts = []
    for r in range(rows):
        for c in range(cols):
            u = ((c + 0.5) / cols - 0.5) * width
            v = ((r + 0.5) / rows - 0.5) * height
            if axis in ("z", "-z"):
                sgn = 1.0 if axis == "z" else -1.0
                parts.append(box(win[0], win[1], depth,
                                 center=(cx + u, cy + v, cz + sgn * depth / 2.0),
                                 mat=mat, group=group))
            else:
                sgn = 1.0 if axis == "x" else -1.0
                parts.append(box(depth, win[1], win[0],
                                 center=(cx + sgn * depth / 2.0, cy + v, cz + u),
                                 mat=mat, group=group))
    return parts


def hatch_row(s, z0, z1, count, y, mat="deck_dark", group="hull",
              size=(3.0, 0.6, 4.0), x=0.0):
    """Regular deck hatches down a centreline (or offset) run."""
    size = (max(size[0], 3.6), max(size[1], 0.8), max(size[2], 4.6))
    parts = []
    for i in range(count):
        z = lerp(z0, z1, (i + 0.5) / count)
        parts.append(box(size[0], size[1], size[2], center=(x, y, z), mat=mat,
                         group=group))
    s.add(parts)
    return parts


def vent_bank(s, x, y, z, count, size=(1.6, 1.2, 2.2), spacing=3.0, mat="deck_dark",
              group="superstructure"):
    """Bank of vent boxes in a row (engine rooms, intakes)."""
    parts = []
    for i in range(count):
        parts.append(box(size[0], size[1], size[2],
                         center=(x, y, z + (i - (count - 1) / 2.0) * spacing),
                         mat=mat, group=group))
    s.add(parts)
    return parts


def cable_run(s, sections, y, z0, z1, radius=0.45, segments=5, mat="deck_dark",
              group="hull", count=1, spread=1.2):
    """Thin pipes/cable runs following the hull surface fore-aft."""
    radius = max(radius, 0.8)
    spread = max(spread, 2.0)
    parts = []
    n = max(2, int(abs(z1 - z0) / max(6.0, abs(z1 - z0) / 8.0)))
    for c in range(count):
        off = (c - (count - 1) / 2.0) * spread
        for i in range(n):
            za = lerp(z0, z1, i / float(n))
            zb = lerp(z0, z1, (i + 1) / float(n))
            zm = (za + zb) / 2.0
            x = hx_at(sections, zm, y) - radius * 0.4
            seg = cylinder(radius, abs(zb - za) * 1.02, axis="z",
                           center=(0.0, 0.0, zm), segments=segments, mat=mat,
                           group=group, caps=False, smooth=True)
            seg.translate((x + off, y, 0.0))
            parts.append(seg)
            parts.append(seg.copy().mirror_x())
    s.add(parts)
    return parts


def antenna_cluster(s, base, height, count=3, spread=3.0, radius=0.35,
                    mat="gun_metal", group="bridge"):
    """Cluster of thin whip antennae."""
    parts = []
    for i in range(count):
        h = height * (1.0 - 0.22 * i)
        parts.append(cylinder(radius * (1.0 - 0.15 * i), h, axis="y",
                              center=(0.0, h / 2.0, 0.0), segments=5, mat=mat,
                              group=group, caps=False, smooth=True))
    out = []
    for i, part in enumerate(parts):
        part.translate((base[0] + (i - (count - 1) / 2.0) * spread, base[1], base[2]))
        out.append(part)
    s.add(out)
    return out


def sensor_dome(s, radius, center, mat="hull_grey", group="bridge", squash=(1.0, 1.0)):
    """Radome / sensor dome sitting on a deck."""
    radius = max(radius, 3.0)
    part = dome(radius, radius * 0.62, center=center, segments=14, rings=3, mat=mat,
                group=group, squash=squash)
    s.add(part)
    return part


def deck_crane(s, base, boom_len, mat="gun_metal", group="superstructure",
               rot_y=0.0):
    """Deck crane: pedestal, kingpost and a boom."""
    boom_len = max(boom_len, 10.0)
    parts = [
        cylinder(1.2, 3.0, axis="y", center=(0.0, 1.5, 0.0), segments=8, mat=mat,
                 group=group, smooth=True),
        cylinder(0.6, 6.0, axis="y", center=(0.0, 5.0, 0.0), segments=6, mat=mat,
                 group=group, smooth=True),
        box(0.8, 0.8, boom_len, center=(0.0, 7.0, -boom_len / 2.0 + 1.0), mat=mat,
            group=group),
    ]
    for p in parts:
        if rot_y:
            p.rotate_y(rot_y)
        p.translate(base)
    s.add(parts)
    return parts


def lifeboat_rack(s, sections, y, z0, z1, count, mat="hull_white",
                  group="superstructure", size=(3.0, 2.2, 7.0)):
    """Row of boat/vehicle bays along the hull side."""
    size = (max(size[0], 3.0), max(size[1], 2.2), max(size[2], 7.0))
    parts = []
    for i in range(count):
        z = lerp(z0, z1, (i + 0.5) / count)
        x = hx_at(sections, z, y) - size[0] / 2.0 + 0.4
        for sgn in (1.0, -1.0):
            parts.append(box(size[0], size[1], size[2], center=(sgn * x, y, z),
                             mat=mat, group=group))
            parts.append(box(size[0] * 0.6, size[1] * 0.9, size[2] * 0.9,
                             center=(sgn * (x + 0.35), y, z), mat="deck_dark",
                             group=group))
    s.add(parts)
    return parts


def light_points(s, positions, radius=0.7, mat="engine_glow", group="hull"):
    """Repeated small emissive points (navigation / formation lights)."""
    radius = max(radius, 1.6)
    parts = []
    for (x, y, z) in positions:
        parts.append(disc(radius, radius * 0.6, axis="x", center=(x, y, z),
                          segments=6, mat=mat, group=group))
    s.add(parts)
    return parts


def glow_seam(s, sections, y0, y1, z0, z1, mat="engine_glow", group="hull",
              out_scale=1.020):
    """Thin glowing seam following the hull (Garmillas surface language)."""
    out_scale = max(out_scale, 1.020)
    sub = [(z, pts) for (z, pts) in sections if z0 - 1e-6 <= z <= z1 + 1e-6]
    if len(sub) < 2:
        sub = [(z0, section_at(sections, z0)), (z1, section_at(sections, z1))]
    part = belt(sub, y0, y1, 12, out_scale, mat, group, smooth=False)
    s.add(part)
    return part


def curved_fin(s, length, height, thickness, base, rot_y=0.0, cant=0.0,
               mat="hull_green", group="wing", segments=6):
    """Organic curved Garmillas fin: a swept plate with a rounded leading edge."""
    parts = [frustum_box(length, thickness, height, center=(length / 2.0, 0.0, 0.0),
                         scale_top=(0.30, 0.55), top_offset=(-0.35 * length, 0.0),
                         mat=mat, group=group),
             cylinder(height * 0.42, thickness * 0.96, axis="y",
                      center=(length * 0.30, 0.0, 0.0), segments=segments,
                      radius2=height * 0.30, mat=mat, group=group, smooth=True)]
    for p in parts:
        if cant:
            p.rotate_z(cant)
        if rot_y:
            p.rotate_y(rot_y)
        p.translate(base)
    s.add(parts)
    return parts


def slab_plate(s, center, size, mat="hull_white", group="superstructure", depth=0.8):
    """Raised blocky armour plate (Bolar surface language)."""
    part = box(size[0], size[1], size[2], center=center, mat=mat, group=group)
    s.add(part)
    return part


# --------------------------------------------------------------------------
# Ship builder
# --------------------------------------------------------------------------

class Ship:
    """Accumulates parts + hardpoints for one ship, then serialises it."""

    def __init__(self, spec):
        self.id = spec["id"]
        self.display = spec["displayName"]
        self.L = float(spec["lengthM"])
        self.B = float(spec["beamM"])
        self.faction = spec["faction"]
        self.ship_class = spec["shipClass"]
        self.role = spec["role"]
        self.display_ja = spec["displayNameJa"]
        self.z_bow = -self.L / 2.0
        self.z_stern = self.L / 2.0
        self.parts = []
        self.hardpoints = []
        self.rng = random.Random(spec["seed"])
        self.secs = None        # hull sections, filled in by the builder
        self.deck = 0.0         # main-deck height at midships
        self.station = None     # station fraction -> z
        self.rake = None        # optional bow/stern z-deformation

    # -- geometry ----------------------------------------------------------
    def add(self, objs):
        self.parts.extend(as_list(objs))
        return objs

    def add_at(self, objs, pos=(0.0, 0.0, 0.0), rot_y=0.0):
        """Rotate about the primitive origin, then translate into place."""
        for p in as_list(objs):
            if rot_y:
                p.rotate_y(rot_y)
            p.translate(pos)
        self.parts.extend(as_list(objs))
        return objs

    def add_pair_at(self, objs, pos=(0.0, 0.0, 0.0), rot_y=0.0):
        """Place the part at +x and its mirrored twin at -x."""
        for p in as_list(objs):
            right = p.copy()
            if rot_y:
                right.rotate_y(rot_y)
            right.translate(pos)
            self.parts.append(right)
            left = p.copy()
            if rot_y:
                left.rotate_y(-rot_y)
            left.mirror_x()
            left.translate((-pos[0], pos[1], pos[2]))
            self.parts.append(left)
        return objs

    # -- hardpoints --------------------------------------------------------
    def hp(self, name, kind, pos, direction):
        if kind not in HARDPOINT_KINDS:
            raise ValueError("illegal hardpoint kind: %r" % (kind,))
        d = v_norm((float(direction[0]), float(direction[1]), float(direction[2])))
        if d == (0.0, 0.0, 0.0):
            raise ValueError("zero hardpoint dir for %s" % name)
        self.hardpoints.append({
            "name": name,
            "kind": kind,
            "pos": [round(float(pos[0]), 3), round(float(pos[1]), 3),
                    round(float(pos[2]), 3)],
            "dir": [round(d[0], 6), round(d[1], 6), round(d[2], 6)],
        })

    # -- output ------------------------------------------------------------
    def bbox(self):
        xs = []
        ys = []
        zs = []
        for p in self.parts:
            (x0, y0, z0), (x1, y1, z1) = p.bbox()
            xs += [x0, x1]
            ys += [y0, y1]
            zs += [z0, z1]
        return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))

    def tri_count(self):
        return sum(p.tri_count() for p in self.parts)

    def groups(self):
        """Group names actually emitted, in OBJ order (fixed groups first,
        then the indexed mount groups) - must match emit_obj exactly."""
        present = set(p.group for p in self.parts)
        out = [g for g in GROUPS if g in present]
        out += sorted(g for g in present if g not in GROUPS)
        return out

    def materials(self):
        used = set()
        for p in self.parts:
            used.update(p.mats)
        return [m for m in MATERIAL_ORDER if m in used]


# --------------------------------------------------------------------------
# Serialisation
# --------------------------------------------------------------------------

def emit_obj(ship):
    """Serialise a Ship to ASCII OBJ text with v / vn / g / usemtl / f."""
    by_group = {}
    for p in ship.parts:
        by_group.setdefault(p.group, []).append(p)
    out = [
        "# YAMATO FLEET 2199 - procedurally generated model (do not hand-edit)",
        "# ship: %s (%s)" % (ship.id, ship.display),
        "# units: meters | bow: -Z | up: +Y | origin: hull centre",
        "# generator: tools/gen_models.py",
        "mtllib %s.mtl" % ship.id,
        "o %s" % ship.id,
    ]
    group_order = [g for g in GROUPS if g in by_group]
    group_order += sorted(g for g in by_group if g not in GROUPS)
    order = [p for g in group_order for p in by_group[g]]
    vbase = {}
    idx = 1
    for p in order:
        vbase[id(p)] = idx
        idx += len(p.verts)
    for p in order:
        for (x, y, z) in p.verts:
            out.append("v %s %s %s" % (fmt(x), fmt(y), fmt(z)))
    nbase = {}
    nidx = 1
    for p in order:
        nbase[id(p)] = nidx
        nidx += len(p.verts) if p.smooth else len(p.faces)
    for p in order:
        for n in p.normals():
            out.append("vn %s %s %s" % (fmt(n[0]), fmt(n[1]), fmt(n[2])))
    for g in group_order:
        chunks = by_group[g]
        out.append("g %s" % g)
        for p in chunks:
            vb = vbase[id(p)]
            nb = nbase[id(p)]
            cur = None
            for fi, f in enumerate(p.faces):
                m = p.mats[fi]
                if m != cur:
                    out.append("usemtl %s" % m)
                    cur = m
                if p.smooth:
                    refs = " ".join("%d//%d" % (vb + i, nb + i) for i in f)
                else:
                    refs = " ".join("%d//%d" % (vb + i, nb + fi) for i in f)
                out.append("f " + refs)
    return "\n".join(out) + "\n"


def emit_mtl(ship):
    """Serialise the ship's used palette subset to ASCII MTL."""
    out = [
        "# YAMATO FLEET 2199 - material palette subset for %s" % ship.id,
        "# generated by tools/gen_models.py",
    ]
    pal = resolved_palette(ship.id)
    for name in ship.materials():
        kd, ka, ks, ns, ke, d = pal[name]
        out.append("")
        out.append("newmtl %s" % name)
        out.append("Ka %s %s %s" % (fmt(ka[0]), fmt(ka[1]), fmt(ka[2])))
        out.append("Kd %s %s %s" % (fmt(kd[0]), fmt(kd[1]), fmt(kd[2])))
        out.append("Ks %s %s %s" % (fmt(ks[0]), fmt(ks[1]), fmt(ks[2])))
        out.append("Ke %s %s %s" % (fmt(ke[0]), fmt(ke[1]), fmt(ke[2])))
        out.append("Ns %s" % fmt(ns))
        out.append("d %s" % fmt(d))
        out.append("illum 2")
    return "\n".join(out) + "\n"


def model_entry(ship):
    return {
        "id": ship.id,
        "displayName": ship.display,
        "displayNameJa": ship.display_ja,
        "faction": ship.faction,
        "shipClass": ship.ship_class,
        "role": ship.role,
        "obj": "%s.obj" % ship.id,
        "mtl": "%s.mtl" % ship.id,
        "lengthM": int(round(ship.L)),
        "beamM": int(round(ship.B)),
        "triangles": ship.tri_count(),
        "groups": ship.groups(),
        "hardpoints": ship.hardpoints,
        "materials": ship.materials(),
    }


def emit_readme(entries):
    """Human-facing notes for the asset directory (generated, never hand-edited)."""
    rows = []
    for m in entries:
        rows.append("| `%s` | %s | %s | %s | %s | %d | %d | %d | %d | %d |"
                    % (m["id"], m["displayName"], m["displayNameJa"], m["faction"],
                       m["shipClass"], m["lengthM"], m["beamM"], m["triangles"],
                       len(m["groups"]), len(m["hardpoints"])))
    out = """# YAMATO FLEET 2199 - generated fleet assets

**Do not hand-edit anything in this directory.** Every file here is written by
`tools/gen_models.py` and consumed through `manifest.json` (`src/core/assets.js`).

## Regenerate

```
python3 tools/gen_models.py --out assets/models
```

Regeneration is deterministic - fixed seeds, insertion-ordered data and
4-decimal coordinates - so re-running produces byte-identical files:

```
shasum -a 256 assets/models/*     # run twice, compare
```

`--only <id>` rebuilds one ship and merges it into the existing manifest.
`--selftest` checks the primitive library (face winding, volumes, polygon
clipping) without writing anything.

## Validate

```
python3 tools/validate_models.py assets/models
```

Exit code 0 means the SPEC section 4/5 contract holds: manifest schema, group
names, palette names, triangle/quad faces, `vn` normals, Z extent == `lengthM`,
X extent == `beamM`, the 12 000-triangle budget and the hardpoint rules.

## Contract (docs/SPEC.md sections 4 and 5)

| Item | Value |
|---|---|
| Units | 1 unit = 1 metre |
| Ship local space | bow **-Z**, up **+Y**, origin at the ship's centre (mid-length, centreline, mid-height of the hull) |
| Files | one `<id>.obj` + one `<id>.mtl` per ship, ASCII, no textures |
| Faces | triangles and quads only; `vn` normals written (per face when flat, per vertex when smooth) |
| Groups | fixed: `hull`, `superstructure`, `bridge`, `wave_motion_gun`, `engine_nozzle`, `wing`, `radiator`; merged 2199 parts: `anti_air`, `torpedo_tube`, `missile_launcher`, `third_bridge`, `catapult`, `rocket_anchor`, `aux_engine`, `depth_charge`; indexed mounts: `turret_main_1..N`, `turret_secondary_1..N`, `ciws_1..N` (SPEC §5 rule 3) |
| Mount pivots | an indexed group's name IS its manifest hardpoint name and its geometry is authored **centred on its own pivot** - x = z = 0 on the traverse axis, y = 0 at the deck line where the barbette meets the hull. The renderer does `mesh.position = hardpoint.pos` then `mesh.rotation.y = <traverse>` (0 = trained fore-and-aft), so the turrets traverse individually |
| Merged groups | a part that does NOT rotate takes a merged group, never an indexed one: a torpedo port is a hole in the plating, and naming it `torpedo_tube_3` would drag it into the pivot contract (and correctly fail it). Its direction lives in the hardpoint `dir` |
| Materials | names are the frozen SPEC section 5.5 palette; the *values* are per-ship faction colours taken from `docs/research/01-yamato-ships.md` |
| Budget | under 12 000 triangles per ship |

## Ships

| id | name | JA | faction | class | lengthM | beamM | triangles | groups | hardpoints |
|---|---|---|---|---|---|---|---|---|---|
""" + "\n".join(rows) + """

Lengths are canon per `docs/research/01-yamato-ships.md` section 0.1 and were
accepted by the Lead into docs/SPEC.md section 5: `kirishima` 205 m (was 222),
`garmillas_dessler` 638 m (Deusura II, was 400), `garmillas_kelkapia` 240 m
(was 250), `garmillas_gaiderol` 350 m (was 390), `bolar_carrier` 400 m (was 380).
`yamato` 333 m, `andromeda` 444 m and `yukikaze` 80 m are unchanged.
`lengthM` is what fleet formation spacing reads, so it is the one number every
consumer must take from the manifest rather than hardcoding.

## Hardpoints

`hardpoints[]` are ship-local: `pos` in metres, `dir` normalised. Kinds:

| kind | meaning |
|---|---|
| `wmgun` | bow wave-motion-gun / heavy beam emitter (named `wave_motion_gun`) |
| `turret` | main and secondary gun mounts (`turret_main_*`, `turret_secondary_*`) |
| `thruster` | stern engine bells and the auxiliary engines (`engine_*`, `aux_engine_*`, dir +Z) |
| `anti_air` | pulse-laser mounts (`ciws_*`, individually traversable) |
| `torpedo` | hull torpedo tubes (`torpedo_tube_*`), openings in the plating |
| `missile` | missile launchers (`missile_launcher_*`), ventral tubes and box/funnel cells |

The required mix is **derived from `src/core/config.js`, not asserted**: one
`turret_main` hardpoint per mount a hull's primary beam weapon declares, a
`torpedo_tube` or `missile_launcher` family only if she carries that weapon, one
`ciws_*` per point-defence channel, and a bow `wave_motion_gun` emitter.  Only
Yamato carries a `secondary_battery`, so only Yamato has `turret_secondary_*`.
`anti_air` carries no requirement at all - nothing under `src/` reads that
family; point defence is an aura driven by `CONFIG.ships[*].pdMounts`.

A group family is a **weapon slot**, not a calibre, and an INDEXED name is a
promise: the geometry is authored on its own traverse pivot and a hardpoint of
the same name exists to place it.  Anything that does not turn - a torpedo port,
a fixed bow gun, a ventral beam mount that nothing fires from - ships as merged
geometry under `superstructure` or a merged weapon bucket instead.

### Per-ship armament layout (task-9 rebuild)

All eight hulls are rebuilt against `docs/research/01-yamato-ships.md` (one
section per ship) and `docs/research/05-yamato-armament-layout.md` for the
grammar; `tools/validate_models.py` asserts each hull's canon counts from a
`LAYOUT` entry whose source is named in the table's header.

* **yamato** - 3 triple 48 cm mains, 2 centreline 20 cm secondaries, 40 pulse
  lasers (4 `ciws_*` + 38 merged), 28 torpedo ports (6 fore / 6 aft / 16
  broadside), 12 missile launchers (10 ventral), third bridge, catapult, 2
  rocket anchors, 2 depth-charge racks, 2 auxiliary engines.
* **andromeda** - twin wave-motion-gun muzzles in the bow, 4 triple 40.6 cm
  (A/B forward, C/D aft with D superfiring over C), 3 citadel shock-field guns,
  4 `ciws_*`, 8 torpedo ports, 6 merged launcher meshes (4 graviton spread
  launchers + 2 quad grenade projectors), the two six-barrel lateral beam
  projectors on the flanks, 1 + 4 Kelvin nozzles.
* **kirishima** - the protruding fixed 46 cm bow cannon (its muzzle IS the bow
  plane; the hull's stem is recessed 12 m behind it), 4 triple 36 cm all
  `turret_main_1..4`, 8 torpedo ports in two rows on the bow flanks, two 8-cell
  missile blocks, 3 clustered bells, squat bridge at 0.35.
* **yukikaze** - a destroyer's fit: 2 triple 12.7 cm (one dorsal, one VENTRAL,
  mirrored in Y with its pivot on the keel), 2 fixed bow anti-ship guns as merged
  geometry, 3 torpedo ports, one 8-cell missile block, 1 main bell + 3 verniers,
  the 艦首装甲翼 bow plate with six fins, faired canopy, drop tanks.
* **garmillas_dessler** - Desler cannon in a raked prow, 6 dorsal domed beam
  mounts, 2 ventral domed mounts and 4 `ciws_*` in the merged battery, one flush
  missile block, the separable 3-tier core ship with its docking seam, the dorsal
  launch aperture, 3 large + 2 small bells.
* **garmillas_kelkapia** - slim teardrop, twin bow emitters, 3 dorsal domed beam
  mounts, 2 ventral domed mounts, 2 `ciws_*` + 4 merged mounts as the bridge
  blister's anti-air clusters, dorsal fin ridge, 2 flared bells + 1 vernier.
* **garmillas_gaiderol** - vertical blade hull under a tall citadel, 4 dorsal
  domed beam mounts, 3 ventral domed mounts, the **bridge CIWS ring of 10 domed
  mounts** (4 `ciws_*` + 6 merged), 16 recessed torpedo ports in two rows per
  flank, one flush missile block, 4 bells in 2x2.
* **bolar_carrier** - the wide horizontal Bolar cannon slab, 3 retractable quad
  positron guns, 20 retractable dual-purpose mounts (10 per side in two rows)
  plus 2 at the bridge base as the merged battery, 12 space torpedo tubes (6 per
  side), 3 `ciws_*`, one flush missile block, the full-length red-glowing flight
  deck with its stern landing aperture, island at the very stern, 4 flared bells.

### Yamato armament layout (task-9 rebuild)

`yamato` is rebuilt against `docs/research/05-yamato-armament-layout.md`, and
`tools/validate_models.py` now asserts the counts from the file itself:

* **3** triple 48 cm main turrets - two forward superfiring, one aft.
* **2** triple 20 cm secondary turrets, both on the **centreline**.  The old
  model carried four triple WING mounts, which is what made the ship read as
  the wrong ship.
* **40** pulse-laser mounts of five types plus the two conning-tower firearms:
  4 ship as the traversable `ciws_1..4` (that is `CONFIG.ships.yamato.pdMounts`,
  a balance number) and the other 38 as the merged `anti_air` battery.
* **28** torpedo tubes as hull openings: 6 fore, 6 aft, 8 per side.
* **12** missile launchers: 10 ventral tubes in the keel, the eight-barrel box on
  the aft deckhouse, and the funnel launcher (煙突ミサイル).
* the **third bridge** (第三艦橋) hangs BELOW the hull under the command tower,
  the two auxiliary engines flank the main bells, and the aft aircraft deck
  carries the catapult and its elevator.
* the main wings are modelled **folded** against the flanks: SPEC §5 rule 7 pins
  the model's X extent to `beamM`, so a deployed 60 m delta wing would break the
  contract for every consumer that reads `beamM`.

## Surface detail (task-7 pass)

Each hull carries a detail pass applied after the silhouette is built:

* **Transverse seams** - raised ribs wrapping the hull every ~10-14% of length,
  plus **longitudinal strakes** that follow the hull taper, and a **raised armour
  belt** framed by two ribs so it reads as an inset plate.
* **Window rows** - evenly spaced `glass_blue` windows along both hull sides and
  glazed grids on the bridge tiers, deckhouses and island faces.
* **Fittings** - deck hatches, lifeboat/vehicle bays, deck cranes, sensor domes,
  vent banks, cable runs, antenna clusters and navigation lights.
* **Machinery** - turrets have a barbette ring (so they sit *into* the deck), a
  flared skirt, a sloped gun house, an inset roof plate and a mantlet; barrels
  are stepped with a breech jacket and a muzzle step; engine bells have an inner
  throat, a vane ring, an actuator ring and a glow disc.

**Legibility floor.** The chase camera sits ~355 m behind the ship, where one
pixel is roughly 0.17 m, so the helpers clamp every feature up to a minimum
relief and size (`RELIEF = 1.022`, `MIN_SEAM`, `MIN_WINDOW`, ...).  Enlarging a
box or a ribbon costs no extra triangles, which is why the detail reads without
blowing the 12 000-triangle budget.  The hull loft is inset by `RELIEF` so the
painted band and the raised seams - not the bare hull - land exactly on
`beamM / 2`.

## Faction identity (what to look for)

* **UNCF** - grey hulls with a red waterline band and cyan drive glow. Yamato
  (2199 rebuild): raked clipper bow with the WM-gun muzzle proud of it and
  missile ports flanking it, rocket anchors either side, three triple 48 cm
  turrets (2 fore superfiring / 1 aft), **two centreline 20 cm triples**, a
  pagoda tower whose **third bridge hangs below the hull**, a funnel that is
  itself a missile launcher, 28 torpedo ports flush in the plating, the 40-mount
  pulse-laser battery in sponsons along both flanks, folded delta main wings,
  two auxiliary engine bells and the aft aircraft deck with its catapult.
  Andromeda: broad flat bow
  with **twin** WM-gun muzzles, four triple turrets, one large + four medium
  nozzles. Kirishima: a fixed gun **barrel protruding** from the bow, squat
  bridge at station 0.35. Yukikaze: the 艦首装甲翼 bow armour wing - a flat plate
  with six triangular fins - plus drop tanks, yellow/red/white paint.
* **Garmillas** - green/olive faceted hulls, amber drive glow, domed dorsal gun
  mounts, fin banks. Dessler (Deusura II): wide flattened arrowhead with a
  recessed Desler cannon, separable core ship with a visible docking seam.
  Kelkapia: slim teardrop with a dorsal fin ridge and a pointed stern. Gaiderol:
  the tall one - a vertical blade hull under a very tall citadel ringed by CIWS.
* **Bolar** - purple-blue hulls with white line accents and **red** drive glow.
  Ganonda carrier: spindle hull with large swept lateral fins, a full-length
  red-glowing flight deck with a stern landing aperture, island at the very
  stern, wide horizontal Bolar cannon slab in the bow.

## Provenance

Every file in this directory is named by `manifest.json` (`obj` / `mtl`), except
`manifest.json` itself and this README.
"""
    return out


def emit_manifest(entries):
    manifest = {
        "schema": SCHEMA,
        "units": UNITS,
        "axis": dict(AXIS),
        "models": entries,
    }
    return json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"


# --------------------------------------------------------------------------
# Fleet: shared construction helpers
# --------------------------------------------------------------------------

#: The painted band (and the transverse seams) sit RELIEF out from the hull, so
#: the band - which wraps the whole hull and therefore always contains the widest
#: vertex - is what lands exactly on beamM / 2.  The hull loft itself is inset by
#: the same factor in build_sections().
BELT_SCALE = 1.022


def build_sections(raw, section_fn=hull_section, n_pts=28, belt_scale=BELT_SCALE,
                   hull_hw=None, **kw):
    """Turn (z, half_beam, y_top, y_bottom) rows into loftable sections.

    The widest row is inset by ``belt_scale`` so the painted stripe - which is
    scaled *out* by the same factor - lands exactly on beamM / 2.  ``hull_hw``
    overrides the true half-beam when some other part (a bow plate, a fin bank)
    is the widest feature of the ship.
    """
    widest = max(row[1] for row in raw)
    true_hw = widest if hull_hw is None else hull_hw
    f = (true_hw / widest) / RELIEF
    out = []
    for row in raw:
        z, hw, yt, yb = row[0], row[1], row[2], row[3]
        kw2 = dict(kw)
        if len(row) > 4:
            kw2["deck_frac"] = row[4]          # per-station flare / tumblehome
        pts = section_fn(hw, yt, yb, **kw2)
        out.append((z, resample_keep([(x * f, y) for (x, y) in pts], n_pts)))
    return out


def _surface_finish(s, sections, deck_w, deck_t, panel_y, panel_h, band, band_mat,
                    band_scale=BELT_SCALE, stripe_mat="deck_dark", bands=None):
    """Deck plate + painted bands + hull strakes shared by every hull builder.

    ``bands`` (when given) is a list of (y0, y1, material, relief) painted on in
    order - this is how the 2199 waterline reads: a narrow red lower hull with a
    dark boot stripe above it, rather than a red slab covering half the side.
    """
    if bands is None:
        bands = [(band[0], band[1], band_mat, band_scale)]
    for (y0, y1, mat, sc) in bands:
        s.add(belt(sections, y0, y1, 10, sc, mat, "hull"))
    s.add(slab_along_sections(sections, deck_w, 0.15, deck_t, "deck_dark", "hull"))
    if panel_y is not None:
        s.add(panel_lines(sections, panel_y, 0.6, panel_h, stripe_mat, "hull"))


def uncf_hull(s, raw, n_pts=28, band=None, band_mat="hull_red", deck_w=0.86,
              deck_t=0.9, panel_y=None, panel_h=1.2, bulge_y=0.62, hull_hw=None,
              hull_mat="hull_grey", bilge=0.30, bands=None):
    """UNCF hull: rounded wedge loft, 2199 waterline (narrow red + boot stripe),
    dark deck plating and hull strakes."""
    sections = build_sections(raw, hull_section, n_pts=n_pts, hull_hw=hull_hw,
                              bulge_y=bulge_y, bilge=bilge)
    s.add(loft(sections, hull_mat, "hull", smooth=True))
    if bands is None and band is not None:
        bands = [(band[0], band[1], band_mat, BELT_SCALE)]
    _surface_finish(s, sections, deck_w, deck_t, panel_y, panel_h,
                    band if band else (0.0, 0.0), band_mat, bands=bands)
    return sections


def angular_hull(s, raw, n_pts=26, band=(-3.0, 3.0), band_mat="hull_green",
                 deck_w=0.88, deck_t=1.1, panel_y=None, panel_h=1.3, gold=False,
                 hull_hw=None, hull_mat="hull_olive", shoulder=0.52, chine_y=0.50,
                 keel_frac=0.0, panel_mat="hull_green"):
    """Garmillas hull: faceted angular loft, olive body, green stripe."""
    sections = build_sections(raw, angular_section, n_pts=n_pts, hull_hw=hull_hw,
                              shoulder=shoulder, chine_y=chine_y, keel_frac=keel_frac)
    s.add(loft(sections, hull_mat, "hull", smooth=False))
    _surface_finish(s, sections, deck_w, deck_t, panel_y, panel_h, band, band_mat,
                    stripe_mat=panel_mat)
    if gold:
        s.add(panel_lines(sections, (panel_y or 0.0) + panel_h * 1.5, 0.45, 0.5,
                          "accent_gold", "hull", mat_frac=0.90))
    return sections


def block_hull(s, raw, n_pts=16, band=(-2.0, 2.0), band_mat="hull_white",
               deck_w=0.92, deck_t=1.6, panel_y=None, panel_h=1.4,
               hull_hw=None, hull_mat="bolar_blue"):
    """Bolar hull: blocky loft, white line accents, dark deck."""
    sections = build_sections(raw, block_section, n_pts=n_pts, hull_hw=hull_hw)
    s.add(loft(sections, hull_mat, "hull", smooth=False))
    _surface_finish(s, sections, deck_w, deck_t, panel_y, panel_h, band, band_mat,
                    stripe_mat="hull_white")
    return sections


def loft_split(sections, split, mat_a, mat_b, group, smooth=True):
    """Loft a hull in two material zones sharing one seam ring (no z-fighting)."""
    a = loft(sections[:split + 1], mat_a, group, smooth=smooth,
             cap_start=True, cap_end=False)
    b = loft(sections[split:], mat_b, group, smooth=smooth,
             cap_start=False, cap_end=True)
    return [a, b]


def mount_turret(s, name, group, deck_y, z, barbette_r, barbette_h, body, barrels,
                 barrel_r, barrel_len, aft=False, x=0.0, elev=0.09,
                 body_mat="hull_grey", barbette_mat="gun_metal",
                 barrel_mat="gun_metal", muzzle_ring=None, ventral=False):
    """Author a naval turret CENTRED ON ITS OWN PIVOT + register its hardpoint.

    SPEC 5 rule 3: the indexed group keeps its vertices at the origin - x = z = 0
    on the traverse axis, y = 0 at the deck line where the barbette meets the
    hull - and ``hardpoint.pos`` is that same pivot.  ``group`` here is only the
    family (which decides the detail budget); the emitted group name is ``name``.

    ``ventral`` mirrors the mount in Y and registers its hardpoint at -deck_y:
    the Isokaze-class carries one of her two triple 12.7 cm turrets on the hull's
    UNDERSIDE, directly opposite the dorsal one (research 01 section 1.4), and
    the pivot contract survives the mirror because y = 0 stays the barbette base
    and x = z = 0 stays the traverse axis.
    """
    main = group == "turret_main"
    parts = turret(barbette_r, barbette_h, body, barrels, barrel_r, barrel_len,
                   group=name, body_mat=body_mat, barbette_mat=barbette_mat,
                   barrel_mat=barrel_mat, elev=elev, deck_ring=True,
                   muzzle_ring=main if muzzle_ring is None else muzzle_ring,
                   barbette_seg=12 if main else 10)
    if ventral:
        for part in as_list(parts):
            part.mirror_y()
    if aft:
        # author the rest orientation into the local geometry, so traverse 0
        # means "trained fore-and-aft" for this mount
        for part in as_list(parts):
            part.rotate_y(math.pi)
    s.add(parts)
    s.hp(name, "turret", (x, -deck_y if ventral else deck_y, z),
         (0.0, 0.0, 1.0 if aft else -1.0))
    return parts


def mount_garm_turret(s, name, deck_y, z, radius, height, barrel_r, barrel_len,
                      aft=False, x=0.0, ventral=False, body_mat="gun_metal",
                      dome_mat="hull_green", group="turret_main", kind="turret"):
    """Garmillas low domed mount, authored centred on its own pivot.

    ``kind`` lets the same domed form serve a beam turret (``turret``) and a
    Garmillas close-in mount (``anti_air``): the faction's AA is a small domed
    mount, not a UNCF box, so the two share one form exactly as the pulse-laser
    battery shares AA_FORMS on the UNCF side.

    ``group`` is the FAMILY.  When it is a merged family (``anti_air``) the
    geometry is emitted under that merged name, BAKED at its position, and
    ``name`` is only the hardpoint's; when it is an indexed family the geometry
    takes ``name`` and stays on its own pivot, because an indexed group is a
    promise that the renderer can place and traverse it.  (Baking the merged case
    matters: leaving those meshes at the origin stacks every merged mount of the
    battery on top of every other, which is invisible in the renderer - the
    hardpoints place nothing - but makes the mesh count meaningless.)
    """
    merged = not (_TURRET_RE.match(group) or group in TURRET_GROUPS)
    part_group = group if merged else name
    parts = [ring(radius * 0.80, radius * 1.05, 1.2, axis="y",
                  center=(0.0, 0.6, 0.0), segments=14, mat=body_mat,
                  group=part_group),
             dome(radius * 0.94, height, center=(0.0, 1.2, 0.0), segments=16, rings=3,
                  mat=dome_mat, group=part_group)]
    for ox in (-radius * 0.36, radius * 0.36):
        first = len(parts)
        parts.extend(barrel(barrel_len, barrel_r, segments=8, mat=body_mat,
                            group=part_group))
        # translate EVERY part of this barrel: barrel() returns three primitives
        # (tube, breech sleeve, muzzle step), so parts[-2:] left the tube behind
        # at the origin - it then hid inside the dome and the mount lost its
        # barrels entirely, which is why the domed mounts read as bare domes
        xf_translate(parts[first:], (ox, height * 0.62, -radius * 0.5))
    if ventral:
        xf_mirror_y(parts)
    if aft:
        for part in as_list(parts):
            part.rotate_y(math.pi)
    mount = merge_parts(parts)
    if merged:
        mount.translate((x, -deck_y if ventral else deck_y, z))
    s.add(mount)
    s.hp(name, kind, (x, -deck_y if ventral else deck_y, z),
         (0.0, 0.0, 1.0 if aft else -1.0))
    return parts


def mount_aa(s, name, deck_y, z, x, scale=1.0, group=None):
    """CIWS mount, authored centred on its own pivot (group name == name)."""
    parts = [
        box(3.4 * scale, 1.3 * scale, 3.4 * scale, center=(0.0, 0.65 * scale, 0.0),
            mat="gun_metal", group=name),
        box(2.1 * scale, 1.1 * scale, 2.1 * scale, center=(0.0, 1.85 * scale, 0.0),
            mat="gun_metal", group=name),
    ]
    for ox in (-0.7 * scale, 0.7 * scale):
        parts.append(cylinder(0.30 * scale, 3.8 * scale, axis="z",
                              center=(ox, 2.3 * scale, -1.5 * scale), segments=5,
                              mat="gun_metal", group=name, caps=False, smooth=True))
    s.add(parts)
    s.hp(name, "anti_air", (x, deck_y, z), (0.0, 0.0, -1.0))
    return parts


#: The 2199 pulse-laser battery is 40 mounts of FIVE different types
#: (docs/research/05 section 3), which is only affordable as one shared low-poly
#: form scaled per type.  At the chase camera (~355 m, 1 px ~ 0.17 m) a mount is
#: ~20 px across, so the form stops at pedestal + gun house + barrel cluster: a
#: base ring, a training drum and a mantlet would cost 3x the triangles for
#: detail that never resolves.  Measured cost per mount, 4-sided barrels:
#:   quad_127 56, triple_88 48, twin_127 40, twin_75 28, triple_75 48, tower 28
#: which puts the whole 42-mount battery (40 pulse lasers + the 2 conning-tower
#: firearms) at ~1.6 k triangles - the biggest single line item of the rebuild,
#: and the one the user's "under-armed" read was actually about.
AA_FORMS = {
    #            pedestal (w, h)   house (w, h)   barrels  len   r
    "quad_127":  ((4.4, 1.6), (3.4, 1.5), 4, 4.8, 0.34),
    "triple_88": ((3.6, 1.3), (2.8, 1.2), 3, 4.0, 0.28),
    "twin_127":  ((3.8, 1.4), (3.0, 1.3), 2, 4.4, 0.32),
    "twin_75":   ((3.0, 1.1), None, 2, 3.4, 0.24),
    "triple_75": ((3.2, 1.2), (2.4, 1.1), 3, 3.6, 0.24),
    "tower_gun": ((2.4, 1.0), None, 2, 2.8, 0.22),
}


def pulse_laser_mount(form="twin_75", group="anti_air", scale=1.0,
                      pedestal_mat="gun_metal", house_mat="hull_grey",
                      barrel_mat="gun_metal"):
    """One pulse-laser mount, built at the origin with its base on y=0.

    Authored on its own pivot (pedestal centred on x = z = 0, y = 0 at the deck
    line) so the SAME form serves the four traversable ``ciws_*`` mounts and the
    merged ``anti_air`` battery: the renderer places an indexed one at its
    hardpoint and traverses it, while the merged ones are baked in place by the
    caller.  Barrels point -Z, i.e. trained fore-and-aft at traverse 0.
    """
    pw, ph = AA_FORMS[form][0]
    house = AA_FORMS[form][1]
    barrels, blen, br = AA_FORMS[form][2:]
    pw, ph = pw * scale, ph * scale
    parts = [frustum_box(pw, ph, pw, center=(0.0, ph / 2.0, 0.0),
                         scale_top=(0.88, 0.88), mat=pedestal_mat, group=group)]
    deck = ph
    if house is not None:
        hw, hh = house[0] * scale, house[1] * scale
        parts.append(frustum_box(hw, hh, hw, center=(0.0, deck + hh / 2.0, 0.0),
                                 scale_top=(0.82, 0.86), top_offset=(0.0, hw * 0.06),
                                 mat=house_mat, group=group))
        deck += hh
    # barrel cluster: 4-sided tubes cost 8 triangles each and still read as a
    # cluster of guns at this size, where a 10-sided tube would cost 20 for the
    # same read
    spread = br * 2.6 * scale
    if barrels == 1:
        offs = [0.0]
    elif barrels == 2:
        offs = [-spread, spread]
    elif barrels == 3:
        offs = [-spread * 1.5, 0.0, spread * 1.5]
    else:
        offs = [-spread * 1.6, -spread * 0.55, spread * 0.55, spread * 1.6]
    by = deck + br * 1.1 * scale
    for ox in offs:
        parts.append(cylinder(br * scale, blen * scale, axis="z",
                              center=(ox, by, -blen * scale * 0.42), segments=4,
                              mat=barrel_mat, group=group, caps=False))
    # one Part per mount, so the battery is countable straight off the OBJ
    return merge_parts(parts)


def mount_pulse_laser(s, name, deck_y, z, x, form="twin_75", group=None,
                      scale=1.0, dir_y=0.0):
    """Pulse-laser mount: geometry authored on its pivot + its hardpoint.

    Indexed families keep the geometry on its pivot (the renderer places and
    traverses it); a MERGED family is baked at its position here, because
    nothing places a merged mount and leaving it at the origin would stack the
    whole battery on one spot.
    """
    group = group or name
    # `group` may be an indexed NAME (ciws_1) or a FAMILY (anti_air): only a
    # family that is not in TURRET_GROUPS is a merged group
    merged = not (_TURRET_RE.match(group) or group in TURRET_GROUPS)
    parts = pulse_laser_mount(form, group=group, scale=scale)
    if merged:
        for part in as_list(parts):
            part.translate((x, deck_y, z))
    s.add(parts)
    s.hp(name, "anti_air", (x, deck_y, z), (0.0, dir_y, -1.0))
    return parts


def hull_port(radius, center, axis="z", depth=1.2, group="torpedo_tube",
              mat="hull_black", segments=6):
    """A flush hull opening - a torpedo tube or a ventral missile tube.

    These are HOLES in the plating, not mounts (docs/research/05 section 3), so
    they are authored in the hull surface and never move; the direction lives in
    the hardpoint ``dir``.  The hull loft is opaque, so an opening can only be
    shown as a dark face standing a little proud of the plating: at the chase
    camera a dark hexagon reads as a hole, and a hexagonal tube costs 24
    triangles against 72 for a ringed round one.
    """
    return cylinder(radius, depth, axis=axis, center=center, segments=segments,
                    mat=mat, group=group, caps=True, smooth=False)


def missile_cell_box(rows, cols, cell_r, cell_len, center, group="missile_launcher",
                     body_mat="gun_metal", cell_mat="hull_black", face="-z",
                     scale=(1.0, 1.0)):
    """Box launcher with its tube mouths on one face (the eight-barrel launcher).

    Canon gives one eight-barrel missile launcher without saying where it sits;
    it is mounted on the aft superstructure roof, which is the least implausible
    place for it and keeps it clear of the AA battery's deck space.
    """
    sx, sz = scale
    bw = cols * cell_r * 2.6 * sx
    bh = rows * cell_r * 2.6
    bd = cell_len * 1.5 * sz
    parts = [frustum_box(bw, bh, bd, center=center, scale_top=(0.94, 0.96),
                         mat=body_mat, group=group)]
    sgn = -1.0 if face == "-z" else 1.0
    for r in range(rows):
        for c in range(cols):
            ox = ((c + 0.5) / cols - 0.5) * bw * 0.78
            oy = ((r + 0.5) / rows - 0.5) * bh * 0.78
            # caps=False: the box body closes the far end, so only the mouth
            # needs geometry - 10 triangles per tube instead of 20
            parts.append(cylinder(cell_r, cell_len, axis="z", segments=5,
                                  center=(center[0] + ox, center[1] + oy,
                                          center[2] + sgn * (bd / 2.0
                                                             + cell_len * 0.35)),
                                  mat=cell_mat, group=group, caps=False))
    return merge_parts(parts)


def rocket_anchor(center, scale=1.0, group="rocket_anchor", axis="z"):
    """ロケットアンカー - the bow anchor that can be fired into an enemy hull.

    One each side of the bow (docs/research/05 section 2).  Modelled as the
    stowed fitting - a hawse housing in the plating with the anchor body seated
    in it - because that is the state the ship is in for the whole demo.
    """
    hx, hy, hz = center
    return merge_parts([
        frustum_box(4.6 * scale, 3.4 * scale, 5.4 * scale,
                    center=(hx, hy, hz), scale_top=(0.86, 0.9),
                    mat="hull_grey", group=group),
        cylinder(1.5 * scale, 4.4 * scale, axis=axis,
                 center=(hx, hy - 0.4 * scale, hz), segments=6,
                 mat="gun_metal", group=group, caps=True),
        box(2.6 * scale, 1.2 * scale, 2.6 * scale,
            center=(hx, hy - 2.0 * scale, hz), mat="gun_metal", group=group),
    ])


def depth_charge_rack(center, group="depth_charge", scale=1.0):
    """Type 94 depth-charge launcher: a short rail with a stack of charges."""
    cx, cy, cz = center
    return merge_parts([
        box(3.2 * scale, 0.8 * scale, 7.0 * scale, center=(cx, cy, cz),
            mat="gun_metal", group=group),
        box(2.6 * scale, 2.2 * scale, 2.6 * scale,
            center=(cx, cy + 1.4 * scale, cz - 1.6 * scale), mat="deck_dark",
            group=group),
        box(2.6 * scale, 2.2 * scale, 2.6 * scale,
            center=(cx, cy + 1.4 * scale, cz + 1.6 * scale), mat="deck_dark",
            group=group),
    ])


def stowed_delta_wing(span, root_chord, tip_chord, thickness, base, cant=0.12,
                      sweep=0.45, fold=0.45, group="wing", mat="hull_grey",
                      fold_mat="deck_dark"):
    """A large delta main wing in its RETRACTED (folded) state.

    Canon: 収納式の巨大なデルタ翼型主翼 - huge delta wings that fold, one each
    side (docs/research/05 section 2).  They are modelled FOLDED because SPEC 5
    rule 7 pins the model's X extent to ``beamM`` (48 m): a deployed 60 m wing
    would double the ship's beam and break the contract for every consumer that
    reads ``beamM``.  Folded, the wing still reads in the SIDE view as a big
    angular plate sweeping up and aft off the flank, which is the view the
    silhouette is judged in.  Two panels: the inboard root, and the outboard
    section folded back against it.

    ``cant`` is signed so that a POSITIVE value leans the panel's top edge
    INBOARD: the bottom edge sits on the hull's belt radius (the widest thing on
    the ship) and everything above it tucks back inside beamM.  Getting the sign
    the other way pushes the wing 1.5 m outside the beam and breaks the X
    extent, which is what the first cut of this did.
    """
    bx, by, bz = base
    root_h = span * fold
    outer_h = span * (1.0 - fold)
    root = frustum_box(thickness, root_h, root_chord,
                       center=(0.0, root_h / 2.0, 0.0),
                       scale_top=(0.92, tip_chord / root_chord),
                       top_offset=(0.0, -sweep * root_chord),
                       mat=mat, group=group)
    root.rotate_z(cant)
    root.translate((bx, by, bz))
    # where the root panel's top edge actually ended up, so the folded outer
    # section hinges off it instead of floating in space
    top_x = bx - root_h * math.sin(cant)
    top_y = by + root_h * math.cos(cant)
    outer = frustum_box(thickness * 0.85, outer_h, root_chord * 0.72,
                        center=(0.0, outer_h / 2.0, 0.0),
                        scale_top=(0.9, tip_chord / (root_chord * 0.72) * 0.6),
                        top_offset=(0.0, -sweep * root_chord * 0.8),
                        mat=fold_mat, group=group)
    outer.rotate_z(cant * 2.4)
    outer.translate((top_x, top_y, bz - sweep * root_chord * 0.9))
    return merge_parts([root, outer])


def aux_engine_bell(radius, length, center, group="aux_engine", segments=10,
                    bell_mat="hull_grey", glow=True):
    """A compact auxiliary-engine bell.

    The two auxiliary engines are SEPARATE from the main wave-motion engine, they
    double as secondary thrusters and they are what starts the wave engine
    (docs/research/05 section 2) - so they read as a second, smaller pair of
    bells with their own glow, not as decoration on the main cluster.
    """
    parts = [cylinder(radius * 0.55, length, axis="z", center=center,
                      segments=segments, radius2=radius, mat=bell_mat, group=group,
                      caps=False, smooth=True)]
    if glow:
        # the glow disc sits INSIDE the mouth, not on it: a disc centred on the
        # mouth plane pokes half its thickness past z_mouth, and when the caller
        # puts the mouth on the stern plane (lengthM / 2) that alone breaks the
        # Z extent - SPEC 5 rule 7 pins it exactly
        parts.append(disc(radius * 0.62, 1.2, axis="z",
                          center=(center[0], center[1],
                                  center[2] + length * 0.5 - 0.8),
                          segments=segments, mat="engine_glow", group=group))
    return merge_parts(parts)


def third_bridge_pod(z, y_top, y_bottom, width, length, group="third_bridge",
                     pod_mat="hull_grey", window=True):
    """The ventral third bridge (第三艦橋) - the pod hanging UNDER the hull.

    Canon (JA 艦体解説, docs/research/05 section 2): the command tower stacks
    captain's cabin -> first bridge (10 m below it) -> second bridge -> third
    bridge, and the third bridge protrudes from the BOTTOM of the hull directly
    beneath the tower.  It is the sub-bridge / backup for the first bridge, the
    most distinctive single feature of the ship, and the 2199 Yamato does not
    look like itself without it - which is why it gets its own group and its own
    assertion (it must measure BELOW the hull group's lowest vertex).
    """
    h = y_top - y_bottom
    cy = (y_top + y_bottom) / 2.0
    parts = [frustum_box(width, h, length, center=(0.0, cy, z),
                         scale_bottom=(0.52, 0.68), scale_top=(1.0, 1.0),
                         mat=pod_mat, group=group)]
    # downward sensor blister + the observation band: the pod is a BRIDGE, so it
    # needs glazing on the face that looks where the hull cannot see
    parts.append(cylinder(width * 0.30, 2.4, axis="y",
                          center=(0.0, y_bottom - 0.6, z), segments=8,
                          radius2=width * 0.20, mat="deck_dark", group=group))
    if window:
        for oz in (-length * 0.26, 0.0, length * 0.26):
            parts.append(box(width * 0.62, 1.6, 2.6,
                             center=(0.0, y_bottom + h * 0.30, z + oz),
                             mat="glass_blue", group=group))
        for sgn in (1.0, -1.0):
            parts.append(box(1.4, 1.8, length * 0.44,
                             center=(sgn * width * 0.30, cy, z),
                             mat="glass_blue", group=group))
    # two stabilising fins, so the pod does not read as a dropped box
    for sgn in (1.0, -1.0):
        parts.append(frustum_box(1.2, 2.6, length * 0.55,
                                 center=(sgn * width * 0.46, y_bottom + h * 0.42, z),
                                 scale_top=(0.7, 0.8), mat="deck_dark", group=group))
    return merge_parts(parts)


def engine_cluster(s, positions, radius, length, z_mouth, names=("engine_1",),
                   segments=20, bell_mat="hull_grey", lip_mat="gun_metal"):
    """Place engine bells whose mouths land exactly on z_mouth (= lengthM/2)."""
    parts = []
    for (x, y) in positions:
        big = radius >= 6.0
        parts.extend(nozzle(radius, length, center=(x, y, z_mouth - length / 2.0),
                            segments=segments, bell_mat=bell_mat, lip_mat=lip_mat,
                            trim=(16 if radius >= 12.0 else 12) if big
                            else min(segments, 8),
                            vanes=(4 if radius >= 12.0 else 3) if big else 0,
                            actuator=radius >= 12.0, throat=big,
                            fins=4 if big else 0))
    s.add(parts)
    for i, (x, y) in enumerate(positions):
        if i < len(names):
            s.hp(names[i], "thruster", (x, y, z_mouth - length * 0.5), (0.0, 0.0, 1.0))
    return parts


def swept_fin(width, thickness, length, sweep=0.35, rise=0.0, mat="hull_grey",
              group="wing", tip=(0.35, 0.55)):
    """Swept fin/wing plate built at the origin, extending toward +X."""
    return frustum_box(width, thickness, length,
                       center=(width / 2.0, 0.0, 0.0),
                       scale_top=tip, top_offset=(-sweep * width, rise),
                       mat=mat, group=group)


# --------------------------------------------------------------------------
# Fleet: UNCF
# --------------------------------------------------------------------------

def build_yamato(s):
    """Yamato-class space battleship (BBY-01) - the player ship.

    Rebuilt against docs/research/05-yamato-armament-layout.md.  The four
    corrections that drove the rebuild, in the order the user would notice them:

    1. the secondary battery is TWO triple 20 cm turrets on the CENTRELINE, not
       four triple wing mounts - the wing mounts were the single most obviously
       wrong thing in the old silhouette;
    2. the third bridge (第三艦橋) hangs BELOW the hull, directly under the
       command tower, and it is the ship's most distinctive feature;
    3. the torpedo battery is HULL OPENINGS (6 fore, 6 aft, 8 per side), not
       turrets - they are ports flush with the plating;
    4. the AA battery is 40 pulse-laser mounts of five types plus the two
       conning-tower firearms, not six CIWS boxes.

    2199 hull form: raked clipper bow with the wave-motion-gun muzzle standing
    proud of it and missile ports flanking it in the bow face, rocket anchors
    either side of the bow, a sheer line rising to the forecastle, a hull that
    tapers to a keel, the SUPERFIRING forward pair (turret #1 on the forecastle,
    #2 raised behind and above it) plus #3 aft, and the aft aircraft deck with
    its catapult.  Every weapon except the wave motion gun and the bow/stern
    missiles is concentrated on the UPPER hull (艦体上部に集中配置).
    """
    L, B = s.L, s.B
    S = lambda t: (t - 0.5) * L                       # station -> z
    raw = [
        # z, half-beam, deck y, keel y, deck-edge fraction (flare)
        (S(0.010), 11.5, 18.6, -11.5, 0.62),
        (S(0.060), 13.2, 18.0, -12.2, 0.68),
        (S(0.150), 16.0, 17.3, -13.2, 0.76),
        (S(0.260), 19.2, 16.0, -14.0, 0.83),
        (S(0.380), 22.2, 15.1, -14.4, 0.87),
        (S(0.550), 24.0, 14.5, -14.5, 0.88),          # full beam, minimum freeboard
        (S(0.680), 23.6, 14.6, -14.4, 0.87),
        (S(0.780), 21.8, 15.0, -14.0, 0.85),
        (S(0.880), 19.0, 15.6, -13.2, 0.82),
        (S(0.965), 15.6, 16.4, -12.2, 0.78),
    ]
    keel_mid = -14.5
    depth = 29.0
    secs = uncf_hull(
        s, raw, n_pts=32, deck_w=0.86, panel_y=None, bulge_y=0.42, bilge=0.30,
        bands=[(keel_mid + 0.05 * depth, keel_mid + 0.24 * depth, "hull_red", BELT_SCALE),
               (keel_mid + 0.24 * depth, keel_mid + 0.32 * depth, "hull_black", 1.016)])
    dy = lambda z: ydeck_at(secs, z)                  # noqa: E731
    deck = dy(0.0)
    s.secs, s.deck, s.station = secs, deck, S
    # raked clipper bow + shaped transom (the hull deforms; the bow gun does not)
    s.rake = make_rake(L, -L / 2.0, L / 2.0, 18.6, -11.5, bow_r=20.0, bow_p=1.8,
                       bow_fade=0.24, stern_r=10.0, stern_p=1.8, stern_fade=0.20)

    def raked(p):
        """Author a hull-fitting hardpoint where the rake will actually put it.

        apply_rake() shears every hull-following part, so a port modelled flush
        with the bow plating ends up several metres aft of the station it was
        drawn at.  Registering the hardpoint at the SAME deformed point keeps the
        port and the weapon that fires through it in agreement - without this the
        six forward tubes would aim from a point 5 m off their own openings.
        """
        return (p[0], p[1], p[2] + s.rake(p[1], p[2]))

    # ---- wave motion gun: the bow's defining feature ----------------------
    #  ... plus the two missile ports that flank it IN THE BOW FACE.  They ship
    #  in the wave_motion_gun group because that group is excluded from the rake:
    #  the bow face is shaped by the emitter housing, so a port authored on it
    #  must not be sheared again on top of that.
    #  24 segments, not 28: at 355 m the collar ring is ~145 px across and the
    #  two extra segments per ring cost ~90 triangles for nothing.
    s.add(bow_gun(10.5, 34.0, -L / 2.0, y=1.2, segments=24, collar=12.4,
                  housing_mat="hull_grey", collar_mat="gun_metal"))
    # blast shield / housing shoulders blended into the forecastle
    s.add(frustum_box(30.0, 22.0, 30.0, center=(0.0, 1.0, S(0.055)),
                      scale_top=(0.55, 0.70), top_offset=(0.0, 4.0),
                      mat="hull_grey", group="hull"))
    # the wave motion gun's own hardpoint is registered FIRST in the file, so a
    # reader (and src/weapons/weapons.js, which fires from the first hardpoint of
    # a family) meets the ship's main weapon before its escorts
    s.hp("wave_motion_gun", "wmgun", (0.0, 1.2, S(0.06)), (0.0, 0.0, -1.0))
    for i, sgn in enumerate((1.0, -1.0)):
        # face exactly ON the bow plane: any proudness would push the model's Z
        # extent past lengthM, and SPEC 5 rule 7 pins it exactly
        s.add(hull_port(2.6, (sgn * 8.2, 7.6, -L / 2.0 + 1.5), axis="z", depth=3.0,
                        group="wave_motion_gun", segments=6))
        s.hp("missile_launcher_bow_%d" % (i + 1), "missile",
             (sgn * 8.2, 7.6, -L / 2.0 + 1.5), (sgn * 0.18, 0.0, -1.0))

    # ---- forecastle breakwater + brow ------------------------------------
    s.add(frustum_box(26.0, 5.0, 22.0, center=(0.0, dy(S(0.155)) - 1.6, S(0.155)),
                      scale_top=(0.42, 0.55), top_offset=(0.0, 4.5),
                      mat="deck_dark", group="hull"))
    # ---- rocket anchors (ロケットアンカー): one each side of the bow --------
    for i, sgn in enumerate((1.0, -1.0)):
        az = S(0.088)
        ax = hx_at(secs, az, dy(az) - 2.0) * 0.94
        s.add(rocket_anchor((sgn * ax, dy(az) - 1.4, az)))
        s.hp("rocket_anchor_%d" % (i + 1), "thruster", raked((sgn * ax, dy(az) - 1.4, az)),
             (0.0, 0.0, -1.0))
    for sgn in (1.0, -1.0):
        s.add(box(6.0, 2.2, 9.0, center=(sgn * 12.5, dy(S(0.055)) - 0.5, S(0.055)),
                  mat="hull_white", group="hull"))    # hull-number plates

    # ---- SUPERFIRING FORWARD PAIR + aft turret ----------------------------
    #   #1 on the forecastle, #2 on a raised barbette deckhouse behind/above it,
    #   #3 aft - three triple 48 cm positron shock cannon (research 05 table).
    #   muzzle_ring is off: three barrels x three turrets of muzzle lips cost
    #   ~570 triangles for a 3 m detail the chase camera cannot resolve.
    #
    #   The stations are set so the gun houses CLEAR each other, which the old
    #   layout did not do: turret #2's house ran from -101 to -73 while the
    #   tower's armoured base ran from -78 to -46, so the tower swallowed the
    #   aft third of the turret.  Everything on the foredeck is now laid out
    #   end to end: WM housing, #1, #2's deckhouse, #2, the secondary barbette,
    #   then the tower.
    z1, z2 = -124.0, -94.0
    d1, d2 = dy(z1), dy(z2)
    #   +10.5, not +7.5. The 6.53 m pivot rise cleared #1's gun house at the
    #   barrel AXIS (32.88 vs a 31.14 roof, a 1.74 m margin) but the barrels are
    #   2.97 m-radius cylinders, so their undersides dipped to 29.91 and passed
    #   through the roof by up to 1.23 m (0.75 m still at +9.0). A pivot-rise
    #   proxy cannot see any of that:
    #   the stations were spaced by gun-house pivot and the barrel overhang was
    #   never accounted for. Reported by verifier-2 (YAMATO-BARREL-2).
    fwd_roof = d2 + 10.5
    s.add(frustum_box(42.0, 7.5, 46.0, center=(0.0, d2 + 3.75, z2),
                      scale_top=(0.90, 0.93), mat="hull_grey",
                      group="superstructure"))
    mount_turret(s, "turret_main_1", "turret_main", d1, z1,
                 10.0, 4.0, (26.0, 9.5, 28.0), 3, 2.2, 21.0, elev=0.05,
                 muzzle_ring=False)
    mount_turret(s, "turret_main_2", "turret_main", fwd_roof, z2,
                 10.0, 4.0, (26.0, 9.5, 28.0), 3, 2.2, 21.0, elev=0.05,
                 muzzle_ring=False)
    z3 = S(0.780)
    d3 = dy(z3)
    s.add(frustum_box(36.0, 5.0, 38.0, center=(0.0, d3 + 2.5, z3),
                      scale_top=(0.9, 0.93), mat="hull_grey", group="superstructure"))
    mount_turret(s, "turret_main_3", "turret_main", d3 + 5.0, z3,
                 10.0, 4.0, (26.0, 9.5, 28.0), 3, 2.2, 21.0, aft=True, elev=0.05,
                 muzzle_ring=False)

    # ---- SECONDARY BATTERY: TWO triple 20 cm, both on the CENTRELINE -------
    #  THE headline correction (research 05 section 1): the old model carried
    #  four triple wing mounts, which is what made the ship read as the wrong
    #  ship.  Canon is two centreline triples.  They sit where the published
    #  side profiles put them: #1 superfiring over turret #2 on a barbette
    #  rising off the forward deckhouse (the real Yamato's 15.5 cm #3 position),
    #  #2 aft on the aft deckhouse roof, trained aft.
    #   Barbette 14.5 m, not 10.2. She is abaft turret #2 (z -73 against -94) so
    #   she can only superfire over it if she is HIGHER than its gun house, and
    #   at 10.2 m she was not: her 12 m barrels reach z = -88.6, straight through
    #   #2's house (z -108..-80, top fwd_roof + 13.67). 15.6% of her surface was
    #   inside #2. Her barrels now sit at fwd_roof + 16.4, clearing #2's roof by
    #   1.33 m. The barbette's 5.4 m radius keeps 1.6 m of air to #2's house
    #   rear, so raising it does not create a new clash. (verifier-2,
    #   YAMATO-BARREL-1 — the same root cause as #2 above: stations spaced by
    #   pivot, barrel overhang unaccounted for.)
    mount_turret(s, "turret_secondary_1", "turret_secondary", fwd_roof, -73.0,
                 5.4, 14.5, (11.0, 4.6, 12.0), 3, 1.0, 12.0, elev=0.10)
    s.add(frustum_box(28.0, 5.0, 26.0, center=(0.0, dy(48.0) + 2.5, 48.0),
                      scale_top=(0.9, 0.93), mat="hull_grey",
                      group="superstructure"))
    aft_roof = dy(48.0) + 5.0
    mount_turret(s, "turret_secondary_2", "turret_secondary", aft_roof, 48.0,
                 5.4, 4.0, (11.0, 4.6, 12.0), 3, 1.0, 12.0, aft=True, elev=0.10)

    # ---- aft deckhouse: the base of the aft superstructure -----------------
    #  52 m long, because it carries five rows of AA mounts at 12 m spacing
    #  (the 2199 ship's aft superstructure is a gun platform, not a shed).
    aft_deck_z = 26.0
    s.add(frustum_box(26.0, 6.0, 52.0, center=(0.0, dy(aft_deck_z) + 3.0, aft_deck_z),
                      scale_top=(0.9, 0.93), mat="hull_grey",
                      group="superstructure"))
    aft_deck_roof = dy(aft_deck_z) + 6.0

    # ---- command-tower geometry (shared by the tower and the AA battery) ---
    #  Canon stack, top down (research 05 section 2): captain's cabin at the very
    #  top -> first bridge 10 m below it -> second bridge -> third bridge, and
    #  the third bridge protrudes from the BOTTOM of the hull.  The tiers are
    #  declared here because the AA battery is distributed over their roofs.
    #  bz is placed so the tower's armoured base (32 m long) starts aft of the
    #  secondary barbette: -48 puts its front face at -64, 1.6 m clear of the
    #  barbette's aft edge, and leaves the funnels room between it and the aft
    #  deckhouse.
    bz = -48.0
    base = dy(bz)
    TOWER_TIERS = [
        # width, height, length, platform overhang
        (36.0, 12.0, 32.0, 2.6),      # armoured base
        (30.0, 9.0, 27.0, 2.2),       # second bridge (route planning / navigation)
        (24.0, 8.0, 22.0, 1.9),       # first bridge (main)
    ]
    first_bridge_roof = base + sum(t[1] for t in TOWER_TIERS)

    # ---- PULSE-LASER BATTERY: 40 mounts of five types + 2 tower firearms ---
    #  The battery is what the "under-armed" read was actually about: six CIWS
    #  boxes against canon's forty.  Distribution follows the research rule -
    #  "along both sides of the hull and the superstructure, in sponsons, at
    #  several heights, not in a single row" - with the caveat the research
    #  records in section 5: the sources give no frames, so these STATIONS ARE A
    #  PLAUSIBLE RECONSTRUCTION matched to the published side profiles.
    #
    #  Only four mounts are true point defence (ciws_1..4): CONFIG's pdMounts is
    #  a balance number and 40 fire-control channels would make the ship
    #  immune to missiles, so the battery is MODELLED in full and the game
    #  abstracts it to four channels.  The other 38 ship merged in `anti_air`.
    def aa_on_deck(form, z, x, y):
        """Merged-battery mount standing on its own sponson box."""
        s.add(box(6.4, 2.2, 7.6, center=(x, y - 1.1, z), mat="hull_grey",
                  group="superstructure"))
        parts = pulse_laser_mount(form, group="anti_air")
        xf_translate(parts, (x, y, z))
        s.add(parts)

    def aa_on_flank(form, z, sgn, y_off=0.4):
        """Merged-battery mount on a sponson let into the hull side."""
        y = dy(z) + y_off
        aa_on_deck(form, z, sgn * hx_at(secs, z, y - 0.5) * 0.88, y)

    # eight quadruple 12.7 cm - the four traversable ones on the raised
    # deckhouses, the other four merged.  The forward pair sits just clear of
    # the tower's front face, because the armoured base is 36 m wide and a mount
    # let into it would be swallowed.  ciws_1/2 are the forward pair and
    # ciws_3/4 the aft pair, so the manifest reads in station order.
    for i, sgn in enumerate((1.0, -1.0)):
        zz = bz - 24.0
        s.add(box(7.4, 2.4, 8.8, center=(sgn * 18.5, fwd_roof - 1.2, zz),
                  mat="hull_grey", group="superstructure"))
        mount_pulse_laser(s, "ciws_%d" % (i + 1), fwd_roof, zz, sgn * 18.5,
                          form="quad_127")
    for i, sgn in enumerate((1.0, -1.0)):
        mount_pulse_laser(s, "ciws_%d" % (i + 3), aft_deck_roof,
                          aft_deck_z + 12.0, sgn * 11.5, form="quad_127")
    # Mounts are spaced >= 12 m apart down each deckhouse row.  That is not
    # cosmetic: a mount's barrels project ~4.6 m forward of its pedestal, so
    # closer than that and two mounts read as one blob of guns in the render -
    # and tools/validate_models.py counts mounts by connected geometry, so
    # touching mounts would also stop being countable.
    for sgn in (1.0, -1.0):
        aa_on_deck("quad_127", z2 - 2.0, sgn * 18.5, fwd_roof)
        aa_on_deck("quad_127", 62.0, sgn * 15.0, dy(62.0) + 2.6)
    # two 8.8 cm triples on the tower's forward shoulders
    for sgn in (1.0, -1.0):
        aa_on_deck("triple_88", bz - 4.0, sgn * 17.5, base + 12.0)
    # eight 12.7 cm twins: two rows on the forward deckhouse, one on the tower
    # roof, one on the aft deckhouse.  They are NOT put on the stern deck: the
    # aircraft deckhouse is 26 m wide there and a mount at |x| = 12 would be
    # buried inside it.
    for sgn in (1.0, -1.0):
        aa_on_deck("twin_127", z2 - 14.0, sgn * 18.5, fwd_roof)
        aa_on_deck("twin_127", z2 + 10.0, sgn * 18.5, fwd_roof)
        aa_on_deck("twin_127", bz + 4.0, sgn * 17.5, base + 12.0)
        aa_on_deck("twin_127", aft_deck_z - 12.0, sgn * 11.5, aft_deck_roof)
    # eighteen 7.5 cm twins: ten along both flanks in sponsons at three
    # heights, four on the tower roof, four on the aft deckhouse
    for sgn in (1.0, -1.0):
        for zz in (-146.0, 6.0, 30.0, 58.0, 118.0):
            aa_on_flank("twin_75", zz, sgn)
        for zz in (bz - 12.0, bz + 12.0):
            aa_on_deck("twin_75", zz, sgn * 17.5, base + 12.0)
        for zz in (aft_deck_z - 24.0, aft_deck_z + 24.0):
            aa_on_deck("twin_75", zz, sgn * 11.5, aft_deck_roof)
    # four 7.5 cm triples: two on the funnel platform, two aft
    for sgn in (1.0, -1.0):
        aa_on_deck("triple_75", -24.0, sgn * 10.5, dy(-24.0) + 9.0)
        aa_on_deck("triple_75", aft_deck_z, sgn * 11.5, aft_deck_roof)
    # the two conning-tower close-defence firearms, ON the bridge tower
    for sgn in (1.0, -1.0):
        aa_on_deck("tower_gun", bz + 4.0, sgn * 10.5, first_bridge_roof)

    # ---- COMMAND TOWER: cabin -> first bridge -> second bridge ------------
    #  Window grids are 2-3 per face instead of the old 3-8: the tower is
    #  ~120 px tall from the chase camera, and the wide grids were spending
    #  ~840 triangles to say "windows".
    y = base
    for i, (tw, th, tl, ov) in enumerate(TOWER_TIERS):
        s.add(frustum_box(tw, th, tl, center=(0.0, y + th / 2.0, bz),
                          scale_top=(0.90, 0.92), mat="hull_grey", group="bridge"))
        # platform overhang at the tier's foot (this is what makes it a pagoda)
        s.add(box(tw + 2.0 * ov, 1.4, tl + 2.0 * ov,
                  center=(0.0, y + 0.7, bz), mat="deck_dark", group="bridge"))
        cols = 3 if i < 2 else 4
        s.add(window_grid((0.0, y + th * 0.62, bz - tl / 2.0), "-z",
                          tw * 0.68, 1.8, 1, cols, win=(3.2, 2.0), group="bridge"))
        s.add(window_grid((tw / 2.0, y + th * 0.62, bz), "x", tl * 0.62, 1.8, 1,
                          cols - 1, win=(3.2, 2.0), group="bridge"))
        s.add(window_grid((-tw / 2.0, y + th * 0.62, bz), "-x", tl * 0.62, 1.8, 1,
                          cols - 1, win=(3.2, 2.0), group="bridge"))
        y += th
    # The captain's cabin (艦長室) is at the VERY TOP, on a short trunk, and the
    # first bridge sits exactly 10 m below it - the one stacking rule the
    # research states as a number (docs/research/05 section 2), so the trunk is
    # sized to put the two window bands 10 m apart rather than eyeballed.
    trunk_h = 4.0
    cabin_h = 5.0
    s.add(frustum_box(12.0, trunk_h, 13.0, center=(0.0, y + trunk_h / 2.0, bz),
                      scale_top=(0.95, 0.95), mat="hull_grey", group="bridge"))
    cabin_y = y + trunk_h
    s.add(frustum_box(15.0, cabin_h, 16.0, center=(0.0, cabin_y + cabin_h / 2.0, bz),
                      scale_top=(0.80, 0.84), mat="hull_grey", group="bridge"))
    s.add(window_grid((0.0, cabin_y + cabin_h * 0.58, bz - 8.0), "-z", 10.4, 1.8,
                      1, 3, win=(3.2, 2.0), group="bridge"))
    for sgn in (1.0, -1.0):
        s.add(window_grid((sgn * 7.5, cabin_y + cabin_h * 0.58, bz),
                          "x" if sgn > 0 else "-x", 11.0, 1.8, 1, 3,
                          win=(3.2, 2.0), group="bridge"))
    y = cabin_y + cabin_h
    # rangefinder / director on top
    s.add(frustum_box(9.0, 4.0, 10.0, center=(0.0, y + 2.0, bz - 1.0),
                      scale_top=(0.72, 0.78), mat="hull_grey", group="bridge"))
    s.add(cylinder(3.2, 2.6, axis="y", center=(0.0, y + 5.3, bz - 1.0), segments=14,
                   radius2=2.4, mat="deck_dark", group="bridge"))
    s.add(box(11.0, 1.2, 1.2, center=(0.0, y + 3.4, bz - 6.2), mat="gun_metal",
              group="bridge"))
    # tripod mast with radar arrays
    mast_y = y + 4.0
    for mx in (-3.4, 0.0, 3.4):
        leg = cylinder(0.7, 16.0, axis="y", center=(0.0, 8.0, 0.0), segments=6,
                       radius2=0.45, mat="hull_grey", group="bridge", smooth=True)
        leg.translate((mx * 0.35, mast_y, bz - 1.0))
        s.add(leg)
    s.add(box(12.0, 0.9, 0.9, center=(0.0, mast_y + 16.0, bz - 1.0), mat="gun_metal",
              group="bridge"))
    s.add(cylinder(2.6, 0.8, axis="y", center=(0.0, mast_y + 11.0, bz - 1.0),
                   segments=10, mat="deck_dark", group="bridge"))
    for gz in (-4.0, 4.0):
        s.add(box(7.0, 3.0, 0.8, center=(0.0, mast_y + 13.5, bz - 1.0 + gz),
                  mat="gun_metal", group="bridge"))   # radar arrays
    s.add_at(mast(8.0, 0.9, segments=6, arms=2, dish_r=3.6), (0.0, mast_y + 16.0, bz - 1.0))

    # ---- THIRD BRIDGE (第三艦橋): the pod hanging UNDER the hull -----------
    #  Directly beneath the command tower and protruding from the BOTTOM of the
    #  hull - the sub-bridge / backup for the first bridge, and the single most
    #  distinctive feature of the ship (docs/research/05 section 2).  The 2199
    #  Yamato does not look like itself without it.  It is authored downward
    #  from the keel so tools/validate_models.py can assert it measures BELOW
    #  the hull group's lowest vertex.
    keel_here = min(p[1] for p in section_at(secs, bz))
    s.add(third_bridge_pod(bz, keel_here + 3.0, keel_here - 11.4, 22.0, 30.0))

    # ---- TORPEDO BATTERY: 28 HULL OPENINGS, not turrets -------------------
    #  Canon: 6 forward tubes, 6 aft, and 8 per side broadside - all of them
    #  openings in the plating (docs/research/05 section 3).  They ship merged
    #  in `torpedo_tube` and never rotate, so they must NOT take an indexed
    #  mount name; the firing direction lives in the hardpoint `dir`, and the
    #  fore tubes are registered FIRST so the torpedo weapon - which fires from
    #  the first hardpoint of its family - still launches from the bow.
    def tube(z, sgn, y, direction, name, radius=2.6, depth=1.4):
        """One hull tube, with its FACE landing exactly on the belt radius.

        The belt ribbon - not the bare loft - is what pins the ship's beam, so a
        port is authored outward from the hull surface until its face sits on
        that radius.  Anything proud of it would push the model's X extent past
        beamM and break SPEC 5 rule 7 (X extent == beamM, exactly).
        """
        face_x = hx_at(secs, z, y) * BELT_SCALE
        cx = sgn * (face_x - depth / 2.0)
        s.add(hull_port(radius, (cx, y, z), axis="x", depth=depth,
                        group="torpedo_tube", segments=5))
        s.hp(name, "torpedo", raked((cx, y, z)), direction)

    for i, zz in enumerate((-138.0, -126.0, -114.0)):
        for sgn in (1.0, -1.0):
            tube(zz, sgn, 2.0, (sgn * 0.22, 0.0, -1.0),
                 "torpedo_tube_fore_%d%s" % (i + 1, "" if sgn > 0 else "_s"))
    for i, zz in enumerate((124.0, 134.0, 144.0)):
        for sgn in (1.0, -1.0):
            tube(zz, sgn, 2.0, (sgn * 0.22, 0.0, 1.0),
                 "torpedo_tube_aft_%d%s" % (i + 1, "" if sgn > 0 else "_s"))
    for i, zz in enumerate((-70.0, -50.0, -30.0, 30.0, 52.0, 74.0, 96.0, 118.0)):
        for sgn in (1.0, -1.0):
            tube(zz, sgn, -1.0, (sgn, 0.0, 0.0),
                 "torpedo_tube_%s%d" % ("p" if sgn > 0 else "s", i + 1))

    # ---- MISSILE BATTERY: 10 ventral tubes + the eight-barrel box ---------
    #  Canon also gives a funnel launcher (煙突ミサイル), added with the funnel
    #  below.  The ventral tubes sit in the keel, where nothing can shoot at
    #  them, which is exactly why they are there; their faces hang 0.3 m below
    #  the keel plate so they read as openings rather than being swallowed by
    #  the (opaque) hull loft.
    for i, zz in enumerate((-20.0, 0.0, 20.0, 40.0, 60.0)):
        ky = min(p[1] for p in section_at(secs, zz)) + 0.8
        for j, sgn in enumerate((1.0, -1.0)):
            s.add(hull_port(2.4, (sgn * 6.0, ky, zz), axis="y", depth=2.2,
                            group="missile_launcher", segments=6))
            s.hp("missile_launcher_ventral_%d" % (2 * i + j + 1), "missile",
                 (sgn * 6.0, ky, zz), (0.0, -1.0, 0.0))
    s.add(missile_cell_box(2, 4, 1.1, 3.0, (0.0, aft_deck_roof + 1.5, aft_deck_z - 4.0),
                           face="+z"))
    s.hp("missile_launcher_box", "missile",
         (0.0, aft_deck_roof + 1.5, aft_deck_z - 2.0), (0.0, 0.0, 1.0))

    # ---- angled funnel - which IS a missile launcher (煙突ミサイル) --------
    #  Between the tower (aft face at bz + 16 = -32) and the aft deckhouse
    #  (front face at aft_deck_z - 26 = 0), which is the only space the 2199
    #  profile leaves for it.
    for i, (fz, fr, fl) in enumerate(((-24.0, 7.0, 22.0), (-12.0, 5.0, 15.0))):
        fy = dy(fz)
        fun = cylinder(fr, fl, axis="y", center=(0.0, 0.0, 0.0), segments=16,
                       radius2=fr * 0.86, mat="hull_grey", group="superstructure",
                       smooth=True)
        fun.rotate_x(-0.22)                      # raked aft like the 2199 funnel
        fun.translate((0.0, fy + fl / 2.0 - 1.0, fz))
        s.add(fun)
        cap = ring(fr * 0.80, fr * 1.10, 1.6, axis="y",
                   center=(0.0, fy + fl - 1.0, fz + 0.22 * fl), segments=12,
                   mat="deck_dark", group="superstructure")
        s.add(cap)
        for k in range(3):
            s.add(box(fr * 1.5, 0.6, 1.2,
                      center=(0.0, fy + fl - 2.2 - k * 1.1, fz + 0.22 * fl),
                      mat="hull_black", group="superstructure"))
        s.add(frustum_box(16.0, 4.0, 18.0, center=(0.0, fy + 2.0, fz),
                          scale_top=(0.85, 0.9), mat="hull_grey",
                          group="superstructure"))
    # 煙突ミサイル - canon calls the funnel a missile launcher outright, so its
    # aft face carries a cell block.  Leaving the funnel purely decorative is
    # part of what made the old model read as under-armed.  The block sits far
    # enough aft that its own body clears the funnel's skin: buried in the
    # funnel it would be invisible, and only the tube mouths would read.
    fz0, fr0, fl0 = -24.0, 7.0, 22.0
    s.add(missile_cell_box(2, 3, 1.0, 2.8,
                           (0.0, dy(fz0) + fl0 * 0.62, fz0 + fr0 * 0.55 + 1.6),
                           face="+z"))
    s.hp("missile_launcher_funnel", "missile",
         (0.0, dy(fz0) + fl0 * 0.62, fz0 + fr0 * 0.55 + 4.6), (0.0, 0.0, 1.0))

    # ---- aft aircraft deck: catapult + elevator --------------------------
    #  The real battleship Yamato carried its seaplane catapults aft of turret
    #  #3, and the 2199 ship keeps that deck with an elevator down into the
    #  stern hangar (docs/research/05 section 2).  The rails are the accent_gold
    #  runs the silhouette check measures.
    ac_z = S(0.905)
    ac_y = dy(ac_z)
    s.add(frustum_box(26.0, 5.0, 34.0, center=(0.0, ac_y + 2.5, ac_z),
                      scale_top=(0.88, 0.92), mat="hull_grey",
                      group="superstructure"))
    s.add(box(24.0, 0.8, 36.0, center=(0.0, ac_y + 5.2, ac_z), mat="deck_dark",
              group="superstructure"))                     # flight deck
    # the catapult assembly is one Part, so the validator counts one catapult
    cat = [
        box(1.8, 0.6, 30.0, center=(gx, ac_y + 6.0, ac_z + 2.0),
            mat="accent_gold", group="catapult") for gx in (-3.6, 3.6)]
    cat.append(cylinder(4.2, 1.0, axis="y", center=(0.0, ac_y + 6.2, ac_z - 14.0),
                        segments=10, mat="gun_metal", group="catapult"))
    for gx in (-6.0, 6.0):
        cat.append(box(2.4, 1.2, 3.0, center=(gx, ac_y + 6.2, ac_z + 8.0),
                       mat="gun_metal", group="catapult"))   # catapult trolleys
    cat.append(box(12.0, 0.6, 14.0, center=(0.0, ac_y + 5.4, ac_z + 16.0),
                   mat="hull_black", group="catapult"))      # hangar elevator
    s.add(merge_parts(cat))

    # ---- shaped stern: overhanging transom, nozzles recessed --------------
    s.add(frustum_box(40.0, 24.0, 16.0, center=(0.0, 0.0, S(0.960)),
                      scale_top=(0.86, 0.94), top_offset=(0.0, 3.0),
                      mat="hull_grey", group="engine_nozzle"))
    s.add(frustum_box(30.0, 14.0, 8.0, center=(0.0, 0.0, S(0.975)),
                      scale_top=(0.7, 0.8), mat="deck_dark", group="engine_nozzle"))
    engine_cluster(s, [(-9.6, 0.0), (9.6, 0.0)], 11.6, 20.0, L / 2.0,
                   names=("engine_1", "engine_2"), segments=22, bell_mat="hull_grey")
    # ---- the two AUXILIARY engines (補助エンジン) -------------------------
    #  SEPARATE from the main wave-motion engine: they double as secondary
    #  thrusters and they are what STARTS the wave engine (research 05 section
    #  2), which is why the wave motion gun can be fired more than once.  They
    #  are not decoration on the main cluster, so they get their own group.
    for i, sgn in enumerate((1.0, -1.0)):
        s.add(aux_engine_bell(5.2, 13.0, (sgn * 18.5, 6.0, L / 2.0 - 6.5)))
        s.hp("aux_engine_%d" % (i + 1), "thruster",
             (sgn * 18.5, 6.0, L / 2.0 - 6.5), (0.0, 0.0, 1.0))
    for (vx, vy) in ((-18.5, -7.0), (18.5, -7.0)):
        s.add(aux_engine_bell(3.4, 11.0, (vx, vy, L / 2.0 - 11.0), group="engine_nozzle",
                              segments=8, bell_mat="deck_dark"))

    # ---- Type 94 depth-charge launchers, aft ------------------------------
    for sgn in (1.0, -1.0):
        s.add(depth_charge_rack((sgn * 12.5, dy(116.0) + 1.0, 116.0)))

    # ---- wings: the stowed delta main wings + stern stabilisers -----------
    #  Canon main wings are huge and they FOLD.  SPEC 5 rule 7 pins the model's
    #  X extent to beamM, so they are authored folded against the flanks, which
    #  is also their space-cruise state; the outer face is held just inside the
    #  belt radius so the X extent stays exactly 48.  Deploying them would need
    #  beamM redefined as "hull beam plus wing-span allowance".
    for sgn in (1.0, -1.0):
        wing = stowed_delta_wing(15.0, 32.0, 12.0, 2.6, (22.6, -2.0, 4.0),
                                 cant=0.12, sweep=0.44)
        if sgn < 0:
            wing.mirror_x()
        s.add(wing)
    s.add_pair_at(swept_fin(9.0, 1.2, 8.0, sweep=0.35, rise=1.0, mat="hull_grey",
                            group="wing"), (12.0, 4.0, S(0.925)))

    # ---- radiators -------------------------------------------------------
    s.add_pair_at(box(0.9, 12.0, 36.0, center=(0.0, 3.0, 0.0), mat="deck_dark",
                      group="radiator"), (hx_at(secs, S(0.83), 8.0) * 0.99, 8.0,
                                          S(0.83)))


def build_andromeda(s):
    """Andromeda-class vanguard battleship (AAA-1) - the "bigger, meaner Yamato".

    Rebuilt on the same layout grammar as the Yamato (docs/research/01 section
    1.2 for this hull, 05 for the grammar), keeping the UNCF family resemblance
    so the two read as the same navy: raked bow, twin wave-motion-gun muzzles,
    four triple 40.6 cm turrets ALL on the centreline (A/B superfiring forward,
    C/D aft with D superfiring over C), a blocky slab-sided citadel rather than a
    pagoda, the two six-barrel lateral beam projectors on the flanks, the three
    bridge shock-field guns, hull-port torpedoes and the 1 + 4 Kelvin nozzle
    cluster.

    Deliberate deviations, all documented at the point of use:
    * the citadel sits at station 0.37, not the research's 0.32, so its
      49 m-wide base clears turret B's gun house - on this hull the two cannot
      both be at their published stations;
    * the twin muzzles are at +/-18.5 m, not the research's +/-24 m, because a
      20 m muzzle at +/-24 m would put the collars 6 m outside beamM/2 and break
      SPEC 5 rule 7 (X extent == beamM);
    * CONFIG gives her no `secondary_battery`, so her two quad anti-ship grenade
      projectors (四連装対艦グレネード投射機 x2) ship as merged
      `missile_launcher` geometry rather than as an indexed turret family: an
      indexed mount promises a traverse pivot that nothing fires from.
    """
    L, B = s.L, s.B
    S = lambda t: (t - 0.5) * L                       # noqa: E731
    raw = [
        (S(0.010), 15.0, 18.4, -10.6, 0.66),
        (S(0.070), 17.4, 17.4, -11.6, 0.74),
        (S(0.180), 21.4, 15.9, -12.6, 0.82),
        (S(0.300), 25.6, 13.8, -13.2, 0.88),
        (S(0.450), 31.0, 13.2, -13.5, 0.92),          # full beam
        (S(0.620), 30.6, 13.2, -13.5, 0.92),
        (S(0.760), 28.4, 13.4, -13.2, 0.90),
        (S(0.880), 24.0, 13.9, -12.4, 0.86),
        (S(0.965), 18.6, 14.6, -11.4, 0.80),
    ]
    secs = uncf_hull(
        s, raw, n_pts=32, deck_w=0.92, bulge_y=0.44, bilge=0.28,
        bands=[(-12.6, -7.4, "hull_red", BELT_SCALE),
               (-7.4, -5.2, "hull_black", 1.016)])
    dy = lambda z: ydeck_at(secs, z)                  # noqa: E731
    deck = dy(0.0)
    s.secs, s.deck, s.station = secs, deck, S
    s.rake = make_rake(L, -L / 2.0, L / 2.0, 16.2, -10.6, bow_r=24.0, bow_p=1.7,
                       bow_fade=0.26, stern_r=8.0, stern_p=1.8, stern_fade=0.18)

    def raked(p):
        """Author a hull-fitting hardpoint where the rake will actually put it."""
        return (p[0], p[1], p[2] + s.rake(p[1], p[2]))

    # ---- broad raked bow carrying twin WM muzzles ------------------------
    #  The twin muzzle is this ship's whole identity (research 01 section 1.2),
    #  so both emitters and the raised centre rib between them are modelled even
    #  though it costs two collar rings.
    s.add(frustum_box(50.0, 26.0, 34.0, center=(0.0, 1.0, S(0.06)),
                      scale_top=(0.62, 0.72), top_offset=(0.0, 6.0),
                      mat="hull_grey", group="hull"))
    for i, mx in enumerate((-18.5, 18.5)):
        gun = bow_gun(9.6, 40.0, -L / 2.0, y=1.4, segments=24, collar=11.4,
                      housing_mat="hull_grey", collar_mat="gun_metal")
        xf_translate(gun, (mx, 0.0, 0.0))
        s.add(gun)
        s.hp("wave_motion_gun" if i == 0 else "wave_motion_gun_2", "wmgun",
             (mx, 1.4, S(0.05)), (0.0, 0.0, -1.0))
    s.add(frustum_box(9.0, 20.0, 30.0, center=(0.0, 1.0, S(0.035)),
                      scale_top=(0.5, 0.7), mat="hull_grey", group="hull"))

    # ---- four triple 40.6 cm, ALL centreline: A/B forward, C/D aft --------
    #  Canon stations A 0.13 / B 0.30 / C 0.62 / D 0.80 with D superfiring over
    #  C.  B is pulled to 0.29 so its gun house clears the citadel, and C/D are
    #  the right way round (the old model had C raised and D on the deck).
    for i, (st, raise_) in enumerate(((0.135, 0.0), (0.290, 10.5))):
        zz = S(st)
        d = dy(zz) + raise_
        if raise_:
            s.add(frustum_box(40.0, raise_, 40.0, center=(0.0, dy(zz) + raise_ / 2.0, zz),
                              scale_top=(0.9, 0.93), mat="hull_grey",
                              group="superstructure"))
        mount_turret(s, "turret_main_%d" % (i + 1), "turret_main", d, zz,
                     11.0, 4.2, (28.0, 10.0, 30.0), 3, 2.4, 24.0, elev=0.05,
                     muzzle_ring=False)
    for i, (st, raise_) in enumerate(((0.620, 0.0), (0.800, 6.5))):
        zz = S(st)
        d = dy(zz) + raise_
        if raise_:
            s.add(frustum_box(42.0, raise_, 44.0, center=(0.0, dy(zz) + raise_ / 2.0, zz),
                              scale_top=(0.9, 0.93), mat="hull_grey",
                              group="superstructure"))
        mount_turret(s, "turret_main_%d" % (i + 3), "turret_main", d, zz,
                     11.0, 4.2, (28.0, 10.0, 30.0), 3, 2.4, 24.0, aft=True, elev=0.05,
                     muzzle_ring=False)

    # ---- blocky citadel with shock-field emitters ------------------------
    bz = S(0.320)
    # ---- blocky citadel, ringed by the three shock-field guns ------------
    #  Station 0.37 rather than the research's 0.32: the citadel's base is 49 m
    #  wide and 34 m long, and at 0.32 its forward top corner runs into turret
    #  B's gun house.  The two published stations cannot both hold on this hull,
    #  and the turret is the more visible of the two, so the citadel moves.
    bz = S(0.370)
    base = dy(bz)
    y = base
    for (tw, th, tl) in ((40.0, 12.0, 34.0), (30.0, 9.0, 26.0), (20.0, 7.0, 17.0)):
        s.add(frustum_box(tw, th, tl, center=(0.0, y + th / 2.0, bz),
                          scale_top=(0.92, 0.94), mat="hull_grey", group="bridge"))
        s.add(box(tw + 4.0, 1.4, tl + 4.0, center=(0.0, y + 0.7, bz),
                  mat="deck_dark", group="bridge"))
        s.add(window_grid((0.0, y + th * 0.62, bz - tl / 2.0), "-z", tw * 0.7, 1.8,
                          1, 3, win=(3.4, 2.2), group="bridge"))
        s.add(window_grid((tw / 2.0, y + th * 0.62, bz), "x", tl * 0.64, 1.8, 1,
                          3, win=(3.4, 2.2), group="bridge"))
        s.add(window_grid((-tw / 2.0, y + th * 0.62, bz), "-x", tl * 0.64, 1.8, 1,
                          3, win=(3.4, 2.2), group="bridge"))
        y += th
    s.add(frustum_box(12.0, 4.5, 13.0, center=(0.0, y + 2.25, bz - 1.0),
                      scale_top=(0.75, 0.8), mat="hull_grey", group="bridge"))
    s.add_at(mast(16.0, 1.2, segments=6, arms=2, dish_r=5.0), (0.0, y + 4.0, bz - 1.0))
    # 司令塔防護ショックフィールド砲 x3 - three defensive emitters ringing the
    # citadel, evenly spaced at 120 degrees (research 01 section 1.2 calls them
    # out as "a great detail").  They ship in the merged anti_air battery: they
    # are tower-defence guns, which is exactly what that group is for.
    #  They sit ON the citadel's first roof, on an elliptical ring (21 m across,
    #  15 m fore-and-aft) - a circular ring big enough to clear the 40 x 34 m
    #  base would put two of the three off the roof entirely, and at deck level
    #  all three are inside the base or the deckhouse (checked, not guessed).
    cit_roof = base + 12.0
    for k in range(3):
        ang = math.pi * 2.0 * k / 3.0 + math.pi / 6.0
        ex, ez = 21.0 * math.cos(ang), bz + 15.0 * math.sin(ang)
        s.add(box(5.0, 2.0, 5.6, center=(ex, cit_roof + 1.0, ez), mat="hull_grey",
                  group="superstructure"))
        parts = pulse_laser_mount("tower_gun", group="anti_air", scale=1.25)
        xf_translate(parts, (ex, cit_roof + 2.0, ez))
        s.add(parts)
        s.hp("anti_air_%d" % (k + 1), "anti_air", (ex, cit_roof + 2.0, ez),
             (math.cos(ang) * 0.5, 0.0, math.sin(ang) * 0.5 - 0.5))

    # ---- six-barrel lateral beam projectors ------------------------------
    #  六連装側方光線投射砲 x2 on the flanks at station 0.50 (research 01
    #  section 1.2).  They are fixed outboard-facing clusters, not turrets, so
    #  they stay in `superstructure` and never take an indexed name.
    for sgn in (1.0, -1.0):
        zz = S(0.500)
        x = 0.40 * B
        s.add(box(7.0, 9.0, 14.0, center=(sgn * (x - 2.5), dy(zz) + 1.0, zz),
                  mat="hull_grey", group="superstructure"))
        for k in range(6):
            s.add(cylinder(1.0, 8.0, axis="x", center=(sgn * (x + 2.0),
                                                       dy(zz) + 4.0 - k * 1.5, zz),
                           segments=7, mat="gun_metal", group="superstructure",
                           smooth=True))

    # ---- 四連装対艦グレネード投射機 x2: the two quad grenade projectors ---
    #  Canon gives this hull no 20 cm secondary and CONFIG gives her no
    #  `secondary_battery` weapon, so these must NOT claim the indexed
    #  `turret_secondary` family: an indexed mount promises a traverse pivot that
    #  nothing fires from.  They ship as merged `missile_launcher` geometry - the
    #  vocabulary's bucket for projectile launchers - alongside her four graviton
    #  spread launchers, with a hardpoint each so that adding a missile or
    #  secondary weapon to her CONFIG is all it takes to make them live.
    #  #1 sits at z = -8 on the long deckhouse roof, forward of the funnels (its
    #  barrels train aft to z = +11, and funnel 1's base starts at +18.6).
    for i, (zz, yy, rr) in enumerate(((-8.0, dy(S(0.45)) + 6.0, 0.0),
                                      (S(0.710), dy(S(0.710)) + 0.2, 0.0))):
        parts = turret(4.6, 3.0, (11.0, 4.6, 12.0), 4, 0.9, 10.0,
                       group="missile_launcher", elev=0.10, deck_ring=True,
                       muzzle_ring=False, barbette_seg=10)
        for part in as_list(parts):
            part.rotate_y(math.pi)               # trained aft
        xf_translate(parts, (rr, yy, zz))
        s.add(parts)
        s.hp("missile_launcher_grenade_%d" % (i + 1), "missile",
             (rr, yy, zz), (0.0, 0.0, 1.0))

    # ---- AA: four traversable PD mounts + the three tower guns ------------
    #  Canon lists no pulse-laser battery for this hull, so the only AA mounts
    #  modelled are the four point-defence channels CONFIG gives her
    #  (pdMounts = 4) plus the three citadel shock-field guns above.
    for i, (st, sgn) in enumerate(((0.200, 1.0), (0.200, -1.0), (0.780, 1.0),
                                   (0.780, -1.0))):
        zz = S(st)
        x = hx_at(secs, zz, dy(zz) - 0.5) * 0.88
        s.add(box(7.4, 2.4, 8.8, center=(sgn * x, dy(zz) - 1.2, zz), mat="hull_grey",
                  group="superstructure"))
        mount_pulse_laser(s, "ciws_%d" % (i + 1), dy(zz) + 0.1, zz, sgn * x,
                          form="quad_127")

    # ---- torpedo battery: 8 hull openings --------------------------------
    #  速射魚雷発射管 x4 forward + 亜空間魚雷発射装置 x4 aft (research 01
    #  section 1.2), modelled as ports flush with the plating exactly as the
    #  Yamato's are - they are holes, so they take the merged `torpedo_tube`
    #  group and carry their direction in the hardpoint.
    def tube(z, sgn, y, direction, name, radius=2.8):
        face_x = hx_at(secs, z, y) * BELT_SCALE
        cx = sgn * (face_x - 0.7)
        s.add(hull_port(radius, (cx, y, z), axis="x", depth=1.4,
                        group="torpedo_tube", segments=5))
        s.hp(name, "torpedo", raked((cx, y, z)), direction)

    for i, zz in enumerate((S(0.085), S(0.135))):
        for sgn in (1.0, -1.0):
            tube(zz, sgn, 1.0, (sgn * 0.22, 0.0, -1.0),
                 "torpedo_tube_fore_%d%s" % (i + 1, "" if sgn > 0 else "_s"))
    for i, zz in enumerate((S(0.870), S(0.925))):
        for sgn in (1.0, -1.0):
            tube(zz, sgn, 1.0, (sgn * 0.22, 0.0, 1.0),
                 "torpedo_tube_aft_%d%s" % (i + 1, "" if sgn > 0 else "_s"))

    # ---- 重力子スプレッド発射機 x4: four graviton spread launchers -------
    for i, (st, sgn) in enumerate(((0.430, 1.0), (0.430, -1.0),
                                   (0.545, 1.0), (0.545, -1.0))):
        zz = S(st)
        x = hx_at(secs, zz, dy(zz) + 3.0) * 0.80
        s.add(missile_cell_box(2, 2, 1.0, 2.6, (sgn * x, dy(zz) + 6.6, zz),
                               face="-z"))
        s.hp("missile_launcher_%d" % (i + 1), "missile",
             (sgn * x, dy(zz) + 6.6, zz - 3.0), (0.0, 0.0, -1.0))

    # ---- long flat deckhouse + funnel + aft catapult ---------------------
    s.add(frustum_box(30.0, 6.0, 120.0, center=(0.0, dy(S(0.45)) + 3.0, S(0.45)),
                      scale_top=(0.92, 0.96), mat="hull_grey", group="superstructure"))
    for i, (st, fr, fl) in enumerate(((0.560, 8.0, 24.0), (0.620, 6.0, 17.0))):  # noqa
        fz = S(st)
        fy = dy(fz)
        fun = cylinder(fr, fl, axis="y", center=(0.0, 0.0, 0.0), segments=16,
                       radius2=fr * 0.86, mat="hull_grey", group="superstructure",
                       smooth=True)
        fun.rotate_x(-0.20)
        fun.translate((0.0, fy + fl / 2.0 - 1.0, fz))
        s.add(fun)
        s.add(ring(fr * 0.80, fr * 1.10, 1.6, axis="y",
                   center=(0.0, fy + fl - 1.0, fz + 0.20 * fl), segments=12,
                   mat="deck_dark", group="superstructure"))
    s.add(frustum_box(26.0, 6.0, 32.0, center=(0.0, dy(S(0.915)) + 3.0, S(0.915)),
                      scale_top=(0.88, 0.90), mat="hull_grey", group="superstructure"))
    for gx in (-4.5, 4.5):
        s.add(box(1.8, 0.5, 34.0, center=(gx, dy(S(0.91)) + 0.9, S(0.91)),
                  mat="accent_gold", group="hull"))   # catapult rails only
    s.add(frustum_box(48.0, 26.0, 18.0, center=(0.0, 0.0, S(0.965)),
                      scale_top=(0.88, 0.94), top_offset=(0.0, 3.0),
                      mat="hull_grey", group="engine_nozzle"))
    engine_cluster(s, [(0.0, 0.0)], 20.0, 24.0, L / 2.0, names=("engine_1",),
                   segments=24, bell_mat="hull_grey")
    # the four Kelvin impulse nozzles (ケルビンインパルスエンジン x4, [OFFICIAL]):
    # the auxiliary drive, so they read as smaller bells around the one big one.
    # They use the compact aux bell rather than the full nozzle() stack - at
    # 9.6 m across they are 1/2 the diameter of the main bell and a vane ring,
    # an actuator ring and a throat on each cost ~300 triangles apiece for
    # detail that does not resolve.
    for i, (vx, vy) in enumerate(((-10.0, 9.0), (10.0, 9.0),
                                  (-10.0, -9.0), (10.0, -9.0))):
        s.add(aux_engine_bell(9.6, 18.0, (vx, vy, L / 2.0 - 9.0),
                              group="engine_nozzle", segments=12,
                              bell_mat="deck_dark"))
        s.hp("engine_%d" % (i + 2), "thruster", (vx, vy, L / 2.0 - 9.0), (0.0, 0.0, 1.0))
    s.add_pair_at(swept_fin(16.0, 1.6, 14.0, sweep=0.45, rise=2.4, mat="hull_grey",
                            group="wing"), (7.0, base + 30.0, bz + 8.0))
    s.add_pair_at(swept_fin(11.0, 1.3, 10.0, sweep=0.4, rise=1.2, mat="hull_grey",
                            group="wing"), (14.0, 4.0, S(0.90)))
    for sgn in (1.0, -1.0):
        s.add(box(1.0, 15.0, 74.0, center=(sgn * hx_at(secs, S(0.72), 2.0) * 0.94,
                                           2.0, S(0.72)), mat="deck_dark",
                  group="radiator"))


def build_kirishima(s):
    """Kongo-class space battleship (Kirishima) - the compact one.

    Rebuilt against docs/research/01 section 1.3 (official 2202 Kongo-Kai
    listing).  Her identity is the **protruding fixed bow cannon** - a barrel
    shroud standing ~12 m ahead of the hull's stem, where Yamato has a hole in
    hers - plus a squat aft-shifted bridge at 0.35 and three clustered bells.

    Canon fit: 46 cm fixed bow gun x1, four triple 36 cm turrets (A/B forward
    superfiring, C/D aft with **D superfiring over C**), 8 torpedo tubes as two
    rows of ports on the bow flanks, 16 missile tubes as two 8-cell blocks on
    the flanks at 0.45, and three nozzles.

    She carries NO secondary battery: the Kongo-Kai listing has none, so rather
    than inventing 20 cm guns the LAYOUT entry declares ``secondary=0`` and
    tools/validate_models.py exempts her from the required-mix rule.  Same for
    the AA battery - canon lists none, so the only small mounts are the two
    point-defence channels CONFIG gives her (pdMounts = 2).
    """
    L, B = s.L, s.B
    S = lambda t: (t - 0.5) * L                       # noqa: E731
    raw = [
        (S(0.055), 10.0, 13.6, -9.4, 0.68),
        (S(0.110), 11.6, 13.2, -10.2, 0.74),
        (S(0.200), 14.0, 12.6, -10.8, 0.80),
        (S(0.360), 16.4, 11.8, -11.0, 0.84),
        (S(0.500), 17.0, 11.4, -11.0, 0.86),          # full beam
        (S(0.660), 16.2, 11.6, -10.8, 0.85),
        (S(0.820), 13.8, 12.2, -10.0, 0.82),
        (S(0.930), 11.0, 12.8, -9.0, 0.78),
        (S(0.995),  8.0, 13.4, -8.0, 0.74),
    ]
    secs = uncf_hull(
        s, raw, n_pts=28, deck_w=0.86, bulge_y=0.46, bilge=0.28,
        bands=[(-9.6, -5.6, "hull_red", BELT_SCALE),
               (-5.6, -3.8, "hull_black", 1.016)])
    dy = lambda z: ydeck_at(secs, z)                  # noqa: E731
    deck = dy(0.0)
    s.secs, s.deck, s.station = secs, deck, S
    s.rake = make_rake(L, -L / 2.0, L / 2.0, 13.6, -9.4, bow_r=16.0, bow_p=1.6,
                       bow_fade=0.22, stern_r=6.0, stern_p=1.8, stern_fade=0.18)

    def raked(p):
        """Author a hull-fitting hardpoint where the rake will actually put it."""
        return (p[0], p[1], p[2] + s.rake(p[1], p[2]))

    # ---- protruding fixed bow cannon (46 cm positron shock gun) ----------
    #  The barrel tip IS the bow plane: SPEC 5 rule 7 pins the Z extent to
    #  lengthM, so the shroud's muzzle sits at exactly -L/2 and the hull's stem
    #  is recessed 12 m behind it.  That recess is what makes this read as a
    #  Kongo rather than a small Yamato.
    s.add(frustum_box(16.0, 16.0, 20.0, center=(0.0, 0.6, S(0.075)),
                      scale_top=(0.7, 0.8), top_offset=(0.0, 3.0),
                      mat="hull_grey", group="hull"))
    s.add(cylinder(3.6, 26.0, axis="z", center=(0.0, 1.0, -L / 2.0 + 13.0),
                   segments=16, radius2=3.2, mat="gun_metal",
                   group="wave_motion_gun", smooth=True))
    s.add(ring(3.2, 4.6, 2.6, axis="z", center=(0.0, 1.0, -L / 2.0 + 1.3),
               segments=16, mat="gun_metal", group="wave_motion_gun"))
    s.add(ring(2.2, 3.4, 1.6, axis="z", center=(0.0, 1.0, -L / 2.0 + 6.0),
               segments=12, mat="deck_dark", group="wave_motion_gun"))
    s.hp("wave_motion_gun", "wmgun", (0.0, 1.0, -L / 2.0 + 8.0), (0.0, 0.0, -1.0))

    # ---- four triple 36 cm: A/B forward, C/D aft, D superfiring over C ----
    #  Canon stations A 0.16 / B 0.32 / C 0.66 / D 0.82.  The old model had the
    #  aft pair the wrong way round (C raised, D on the deck).
    #
    #  All four are `turret_main_1..4`: CONFIG.ships.kirishima fires
    #  mounts.uncf_beam = 4 from `turret_main`, and she has NO secondary battery
    #  in her weapons array, so an indexed `turret_secondary` family here would
    #  promise a traverse pivot that nothing fires from (Lead's correction to the
    #  earlier slot ruling).
    for i, (st, raise_) in enumerate(((0.160, 0.0), (0.320, 6.0))):
        zz = S(st)
        d = dy(zz) + raise_
        if raise_:
            s.add(frustum_box(26.0, raise_, 26.0, center=(0.0, dy(zz) + raise_ / 2.0, zz),
                              scale_top=(0.9, 0.93), mat="hull_grey",
                              group="superstructure"))
        mount_turret(s, "turret_main_%d" % (i + 1), "turret_main", d, zz,
                     6.4, 3.0, (17.0, 6.6, 18.0), 3, 1.4, 15.0, elev=0.06,
                     muzzle_ring=False)
    for i, (st, raise_) in enumerate(((0.660, 0.0), (0.820, 4.5))):
        zz = S(st)
        d = dy(zz) + raise_
        if raise_:
            s.add(frustum_box(24.0, raise_, 24.0, center=(0.0, dy(zz) + raise_ / 2.0, zz),
                              scale_top=(0.9, 0.93), mat="hull_grey",
                              group="superstructure"))
        mount_turret(s, "turret_main_%d" % (i + 3), "turret_main", d, zz,
                     6.4, 3.0, (17.0, 6.6, 18.0), 3, 1.4, 15.0, aft=True, elev=0.06,
                     muzzle_ring=False)

    # ---- torpedo battery: 8 ports in two rows on the bow flanks ----------
    #  魚雷発射管 x8, stations 0.08-0.18 (research 01 section 1.3).  Hull
    #  openings, so they take the merged group and carry direction in the
    #  hardpoint - exactly as on Yamato.
    for i, zz in enumerate((S(0.095), S(0.135))):
        for j, (sgn, yy) in enumerate(((1.0, 3.4), (1.0, -1.2),
                                       (-1.0, 3.4), (-1.0, -1.2))):
            face_x = hx_at(secs, zz, yy) * BELT_SCALE
            cx = sgn * (face_x - 0.7)
            s.add(hull_port(2.0, (cx, yy, zz), axis="x", depth=1.4,
                            group="torpedo_tube", segments=5))
            s.hp("torpedo_tube_%s%d_%s" % ("p" if sgn > 0 else "s", i + 1,
                                           "u" if yy > 0 else "l"), "torpedo",
                 raked((cx, yy, zz)), (sgn * 0.28, 0.0, -1.0))

    # ---- 16 missile tubes: two 8-cell blocks on the flanks at 0.45 -------
    #  "two blocks of 8 rectangular cell hatches, offset +/-0.40 x beam, angled
    #  slightly upward" (research 01 section 1.3) - cheap triangles, very
    #  readable, and each block is ONE mesh so the count is checkable.
    #  The blocks are 4 rows x 2 columns and sit LOW on the flank: a 4-wide
    #  block at +/-0.40 x beam reaches x = 19.1, past the 17 m half-beam, and
    #  SPEC 5 rule 7 pins the X extent to beamM exactly.
    for i, sgn in enumerate((1.0, -1.0)):
        zz = S(0.450)
        x = 0.40 * B
        block = missile_cell_box(4, 2, 0.8, 2.4,
                                 (sgn * x, dy(zz) - 3.4, zz), face="-z",
                                 scale=(1.0, 1.0))
        for p in as_list(block):
            p.rotate_x(0.12)                 # angled slightly upward
        s.add(block)
        s.hp("missile_launcher_%d" % (i + 1), "missile",
             (sgn * x, dy(zz) - 3.4, zz - 3.0), (0.0, 0.12, -1.0))

    # ---- squat bridge at station 0.35 + missile blocks -------------------
    bz = S(0.350)
    base = dy(bz)
    y = base
    for (tw, th, tl) in ((22.0, 6.0, 18.0), (17.0, 5.0, 14.0), (12.0, 4.0, 10.0)):
        s.add(frustum_box(tw, th, tl, center=(0.0, y + th / 2.0, bz),
                          scale_top=(0.88, 0.90), mat="hull_grey", group="bridge"))
        s.add(box(tw + 3.0, 1.2, tl + 3.0, center=(0.0, y + 0.6, bz), mat="deck_dark",
                  group="bridge"))
        s.add(window_grid((0.0, y + th * 0.62, bz - tl / 2.0), "-z", tw * 0.7, 1.6, 1,
                          max(3, int(tw / 6.0)), win=(2.6, 1.8), group="bridge"))
        s.add(window_grid((tw / 2.0, y + th * 0.62, bz), "x", tl * 0.64, 1.6, 1,
                          max(3, int(tl / 7.0)), win=(2.6, 1.8), group="bridge"))
        s.add(window_grid((-tw / 2.0, y + th * 0.62, bz), "-x", tl * 0.64, 1.6, 1,
                          max(3, int(tl / 7.0)), win=(2.6, 1.8), group="bridge"))
        y += th
    s.add_at(mast(10.0, 0.9, segments=6, arms=2, dish_r=3.4), (0.0, y, bz))
    # ---- AA: two point-defence mounts, and nothing else ------------------
    #  The Kongo-Kai listing gives her no AA battery at all, so the only small
    #  mounts are the two point-defence channels CONFIG gives her
    #  (pdMounts = 2).  Padding her up to a battleship's battery would be
    #  inventing armament; the four triple 36 cm turrets, the bow gun, the
    #  torpedo rows and the two 8-cell missile blocks ARE her armament.
    for i, (st, sgn) in enumerate(((0.240, 1.0), (0.240, -1.0))):
        zz = S(st)
        x = hx_at(secs, zz, dy(zz) - 0.5) * 0.88
        s.add(box(5.6, 1.8, 6.6, center=(sgn * x, dy(zz) - 0.9, zz), mat="hull_grey",
                  group="superstructure"))
        mount_pulse_laser(s, "ciws_%d" % (i + 1), dy(zz) + 0.1, zz, sgn * x,
                          form="twin_127")
    for sgn in (1.0, -1.0):
        s.add(box(0.8, 10.0, 30.0, center=(sgn * hx_at(secs, S(0.86), 2.0) * 0.94,
                                           2.0, S(0.86)), mat="deck_dark",
                  group="radiator"))
    for gx in (-3.0, 3.0):
        s.add(box(1.2, 0.4, 20.0, center=(gx, dy(S(0.92)) + 0.8, S(0.92)),
                  mat="accent_gold", group="hull"))
    engine_cluster(s, [(-7.4, 0.0), (7.4, 0.0)], 8.0, 15.0, L / 2.0,
                   names=("engine_1", "engine_2"), segments=18, bell_mat="hull_grey")
    engine_cluster(s, [(0.0, 0.0)], 6.4, 13.0, L / 2.0, names=("engine_3",),
                   segments=16, bell_mat="deck_dark")


def build_yukikaze(s):
    """Isokaze-class assault destroyer (Yukikaze) - fighter crossed with a sub.

    Identity (research 01 section 1.4): the 艦首装甲翼 bow armour wing plate with
    six triangular fins, a low faired canopy instead of a tower, tail
    stabilisers above and below, ventral drop tanks, and yellow / red / white
    paint.  She is the one UNCF hull that must NOT look like a naval ship.

    Canon fit, and it is a DESTROYER's fit: two triple 12.7 cm beam turrets -
    one just abaft the canopy, the other directly opposite it on the hull's
    UNDERSIDE (mirrored in Y) - two fixed forward 12.7 cm anti-ship guns on the
    upper bow, three torpedo tubes, and eight missile tubes in a block behind
    the canopy.  She is deliberately NOT padded up to a battleship's battery:
    the only small mount is her single point-defence channel (pdMounts = 1).

    FAMILIES (derived from CONFIG, not asserted): her two triple 12.7 cm turrets
    hold `turret_main_1..2` (CONFIG fires mounts.uncf_beam = 2 from turret_main),
    the bow emitter ring holds the `wave_motion_gun` slot the SPEC mix requires,
    and `ciws_1` is her single point-defence channel.  She has NO
    `secondary_battery` and no `torpedo` weapon in CONFIG, so her two fixed bow
    guns and her three torpedo tubes ship as merged geometry with no hardpoints:
    an indexed mount promises a traverse pivot, and a family CONFIG never reads
    should not be claimed.
    """
    L, B = s.L, s.B
    S = lambda t: (t - 0.5) * L                       # noqa: E731
    hull_hw = 12.0                                    # 24 m fuselage, B = 38 plate
    raw = [
        (S(0.020),  5.6, 8.4, -6.2, 0.90),
        (S(0.100),  8.2, 9.4, -8.0, 0.94),
        (S(0.240), 10.6, 9.8, -8.8, 0.96),
        (S(0.450), 12.0, 9.8, -9.0, 0.96),
        (S(0.620), 11.6, 9.4, -8.6, 0.94),
        (S(0.780),  9.8, 8.4, -7.4, 0.92),
        (S(0.900),  7.0, 7.0, -5.8, 0.90),
        (S(0.995),  4.6, 5.6, -4.6, 0.88),
    ]
    sections = build_sections(raw, hull_section, n_pts=26, hull_hw=hull_hw,
                              bulge_y=0.48, bilge=0.36)
    s.add(loft_split(sections, 2, "hull_white", "accent_gold", "hull", smooth=True))
    s.add(belt(sections, -3.4, 3.4, 10, BELT_SCALE, "hull_red", "hull"))
    s.add(slab_along_sections(sections, 0.80, 0.15, 0.8, "deck_dark", "hull"))
    dy = lambda z: ydeck_at(sections, z)              # noqa: E731
    s.secs, s.deck, s.station = sections, dy(0.0), S
    s.rake = make_rake(L, -L / 2.0, L / 2.0, 9.8, -9.0, bow_r=9.0, bow_p=0.7,
                       bow_fade=0.30, stern_r=0.0)

    # ---- bow armour wing plate + six fins --------------------------------
    wing_z = S(0.16)
    s.add(box(B, 1.6, 0.12 * L, center=(0.0, -0.6, wing_z), mat="hull_red",
              group="wing"))
    for sgn in (1.0, -1.0):
        for (dz, ang) in ((-3.4, 0.55), (0.0, 0.0), (3.4, -0.55)):
            fin = frustum_box(3.6, 0.6, 4.6, center=(0.0, 0.0, 0.0),
                              scale_top=(0.28, 0.40), top_offset=(0.0, -1.6),
                              mat="hull_red", group="wing")
            fin.rotate_z(sgn * ang)
            fin.translate((sgn * 16.6, -0.6, wing_z + dz))
            s.add(fin)
    # blunt nose: the bow emitter ring fills the contract's wmgun slot, and the
    # two fixed anti-ship guns are their own indexed mounts (below)
    s.add(frustum_box(9.0, 8.0, 8.0, center=(0.0, 0.0, S(0.050)),
                      scale_top=(0.6, 0.7), mat="hull_white", group="hull"))
    s.add(ring(1.8, 3.4, 1.4, axis="z", center=(0.0, 1.2, -L / 2.0 + 0.7),
               segments=14, mat="gun_metal", group="wave_motion_gun"))
    s.add(disc(1.6, 0.8, axis="z", center=(0.0, 1.2, -L / 2.0 + 0.5), segments=12,
               mat="engine_glow", group="wave_motion_gun"))
    s.hp("wave_motion_gun", "wmgun", (0.0, 1.2, -L / 2.0 + 2.0), (0.0, 0.0, -1.0))

    # ---- low faired canopy ----------------------------------------------
    bz = S(0.450)
    s.add(dome(4.6, 3.6, center=(0.0, dy(bz) - 0.6, bz), segments=14, rings=3,
               mat="hull_white", group="bridge", squash=(1.0, 2.1)))
    s.add(box(6.6, 1.1, 0.4, center=(0.0, dy(bz) + 1.6, bz - 7.4), mat="glass_blue",
              group="bridge"))
    s.add(box(4.0, 1.6, 3.0, center=(0.0, dy(bz) + 1.2, bz + 6.0), mat="hull_white",
              group="superstructure"))
    for k in range(4):
        s.add(box(1.4, 1.0, 1.4, center=(-2.4 + (k % 2) * 4.8, dy(bz) + 2.2,
                                         bz + 9.0 + (k // 2) * 2.4),
                  mat="deck_dark", group="superstructure"))

    # ---- two triple 12.7 cm: one dorsal, one DIRECTLY OPPOSITE BELOW -------
    #  "one just abaft the bridge (station 0.52) and one directly opposite it on
    #  the hull's underside (station 0.52, mirrored in Y)" [WIKI] - the belly
    #  turret is the detail that makes her read as a submersible fighter rather
    #  than a tiny battleship.  Its pivot is the KEEL at that station, exactly
    #  mirroring the dorsal mount sitting into the deck; anything else leaves the
    #  barbette floating under the hull.
    keel_here = abs(min(p[1] for p in section_at(sections, S(0.52))))
    mount_turret(s, "turret_main_1", "turret_main", dy(S(0.52)), S(0.52),
                 3.0, 2.0, (7.4, 3.2, 8.0), 3, 0.6, 9.0, elev=0.08,
                 muzzle_ring=False)
    mount_turret(s, "turret_main_2", "turret_main", keel_here, S(0.52),
                 3.0, 2.0, (7.4, 3.2, 8.0), 3, 0.6, 9.0, elev=0.08,
                 muzzle_ring=False, ventral=True)

    # ---- two fixed forward 12.7 cm anti-ship guns on the upper bow --------
    #  12.7サンチ対艦砲 x2, "short parallel barrels on the upper surface" of the
    #  blunt nose (research 01 section 1.4).  They do NOT traverse, so by our own
    #  rule they must not be indexed either: they ship as merged `superstructure`
    #  geometry with no hardpoints, exactly like Andromeda's fixed lateral beam
    #  projectors.  CONFIG gives her no secondary battery, so there is no family
    #  for them to occupy (Lead's correction to the earlier slot ruling).
    for ox in (-2.4, 2.4):
        parts = turret(1.0, 1.0, (3.4, 1.6, 4.6), 1, 0.55, 6.0,
                       group="superstructure", elev=0.0, deck_ring=False,
                       muzzle_ring=False, barbette_seg=8)
        xf_translate(parts, (ox, 5.0, -L / 2.0 + 6.0))
        s.add(parts)

    # ---- one point-defence channel (pdMounts = 1) ------------------------
    mount_pulse_laser(s, "ciws_1", dy(S(0.28)), S(0.28), 8.4, form="twin_75")

    # ---- three torpedo tubes, as hull openings ---------------------------
    #  魚雷発射管 x3 - she carried the 試製空間魚雷 experimental torpedo.  One in
    #  the bow face and one each side of it, all flush with the plating.
    #  GEOMETRY ONLY, no `torpedo_tube` hardpoints: CONFIG.ships.yukikaze has no
    #  `torpedo` weapon, and a family CONFIG never reads should not be claimed.
    #  The ports stay because canon gives her the tubes; if the Lead adds the
    #  weapon, restoring the hardpoints is a three-line change.
    for (ox, oy) in ((0.0, -1.2), (6.0, -1.2), (-6.0, -1.2)):
        if ox:
            face_x = hx_at(sections, -L / 2.0 + 12.0, oy) * BELT_SCALE
            cx = (1.0 if ox > 0 else -1.0) * (face_x - 0.6)
            s.add(hull_port(1.4, (cx, oy, -L / 2.0 + 12.0), axis="x", depth=1.2,
                            group="torpedo_tube", segments=5))
        else:
            s.add(hull_port(1.4, (0.0, oy, -L / 2.0 + 2.0), axis="z", depth=1.2,
                            group="torpedo_tube", segments=5))

    # ---- eight missile tubes in one block behind the canopy ---------------
    #  ミサイル発射管 x8, "a block of cells immediately behind the bridge"
    #  (research 01 section 1.4).
    s.add(missile_cell_box(2, 4, 0.9, 2.4, (0.0, dy(bz) + 2.4, bz + 14.0),
                           face="-z"))
    s.hp("missile_launcher_1", "missile", (0.0, dy(bz) + 2.4, bz + 11.0),
         (0.0, 0.0, -1.0))

    s.add_pair_at(swept_fin(6.0, 1.0, 7.0, sweep=0.4, rise=1.0, mat="hull_red",
                            group="wing"), (3.6, 0.0, S(0.82)))
    for (ox, oy) in ((-9.0, 1.6), (9.0, 1.6), (-9.0, -1.6), (9.0, -1.6)):
        s.add(frustum_box(0.9, 3.4, 4.0, center=(ox, oy, S(0.82)),
                          scale_top=(1.0, 0.5), mat="hull_red", group="wing"))
    # 増槽 drop tanks.  The source gives the two stations (0.30 and 0.55) but not
    # their lateral offset, and a CENTRELINE tank at 0.55 runs straight through
    # the belly turret's barrels.  Resolved in favour of the turret - the more
    # distinctive feature - by slinging the tanks as mirrored pairs either side
    # of the keel, clear of the barrels' +/-1.5 m sweep.
    for st in (0.30, 0.55):
        for sgn in (1.0, -1.0):
            s.add(cylinder(2.0, 0.12 * L, axis="z",
                           center=(sgn * 4.6, -10.4, S(st)), segments=12,
                           radius2=1.5, mat="accent_gold", group="hull",
                           smooth=True))
    engine_cluster(s, [(0.0, 0.0)], 3.8, 8.0, L / 2.0, names=("engine_1",),
                   segments=14, bell_mat="accent_gold")
    for i, (vx, vy, vz) in enumerate(((-9.4, 0.0, S(0.24)), (9.4, 0.0, S(0.24)),
                                      (0.0, -8.6, S(0.40)))):
        s.add(aux_engine_bell(1.8, 5.0, (vx, vy, vz - 2.5), group="engine_nozzle",
                              segments=8, bell_mat="deck_dark"))
        s.hp("vernier_%d" % (i + 1), "thruster", (vx, vy, vz + 2.5), (0.0, 0.0, 1.0))
def build_garmillas_dessler(s):
    """Deusura II - Desler flagship (wave-3 boss).

    Wide flattened arrowhead with a raked prow, a recessed Desler cannon, a
    separable core ship standing on the shell with a visible docking seam, a
    dorsal launch aperture, domed dorsal/ventral mount rows, swept tail fins and
    3 large + 2 small bells.
    """
    L, B = s.L, s.B
    S = lambda t: (t - 0.5) * L                       # noqa: E731
    raw = [
        (S(0.005),  34.0, 18.6, -19.0),
        (S(0.060),  58.0, 17.6, -17.0),
        (S(0.160),  94.0, 16.2, -15.4),
        (S(0.250), 109.0, 15.3, -14.9),
        (S(0.350), 122.5, 14.6, -14.6),               # full beam
        (S(0.450), 122.5, 14.3, -14.5),
        (S(0.550), 118.0, 14.2, -14.4),
        (S(0.640), 113.0, 14.3, -14.2),
        (S(0.720), 108.0, 14.4, -14.0),
        (S(0.880),  94.0, 15.0, -13.2),
        (S(0.995),  76.0, 15.8, -12.4),
    ]
    secs = angular_hull(s, raw, n_pts=28, band=(-4.0, 4.0), band_mat="hull_green",
                        deck_w=0.90, deck_t=1.4, panel_y=None, gold=False,
                        hull_mat="hull_green", panel_mat="hull_olive")
    dy = lambda z: ydeck_at(secs, z)                  # noqa: E731
    deck = dy(0.0)
    s.secs, s.deck, s.station = secs, deck, S
    s.rake = make_rake(L, -L / 2.0, L / 2.0, 17.5, -19.0, bow_r=26.0, bow_p=1.2,
                       bow_fade=0.20, stern_r=12.0, stern_p=1.4, stern_fade=0.16)

    # ---- Desler cannon in a raked prow -----------------------------------
    s.add(bow_gun(18.0, 46.0, -L / 2.0, y=0.0, segments=26, collar=21.0,
                  housing_mat="hull_green", collar_mat="gun_metal"))
    s.add(frustum_box(70.0, 40.0, 34.0, center=(0.0, 0.0, S(0.055)),
                      scale_top=(0.55, 0.62), top_offset=(0.0, 6.0),
                      mat="hull_green", group="hull"))
    s.hp("wave_motion_gun", "wmgun", (0.0, 0.0, S(0.07)), (0.0, 0.0, -1.0))

    # ---- separable core ship: 3-tier ziggurat + visible docking seam -----
    cz = S(0.425)
    s.add(frustum_box(96.0, 5.0, 150.0, center=(0.0, deck + 2.5, cz),
                      scale_top=(0.94, 0.96), mat="hull_olive",
                      group="superstructure"))
    s.add(frustum_box(78.0, 10.0, 120.0, center=(0.0, deck + 10.0, cz),
                      scale_top=(0.86, 0.90), mat="hull_olive", group="superstructure"))
    s.add(frustum_box(52.0, 9.0, 78.0, center=(0.0, deck + 19.5, cz),
                      scale_top=(0.82, 0.86), mat="hull_olive", group="superstructure"))
    s.add(frustum_box(28.0, 8.0, 44.0, center=(0.0, deck + 28.0, cz),
                      scale_top=(0.78, 0.82), mat="hull_green", group="bridge"))
    s.add(box(84.0, 2.2, 128.0, center=(0.0, deck + 5.2, cz), mat="deck_dark",
              group="superstructure"))
    s.add(box(50.0, 2.0, 80.0, center=(0.0, deck + 15.2, cz), mat="deck_dark",
              group="superstructure"))
    s.add(box(84.0, 2.4, 4.0, center=(0.0, deck + 3.6, cz - 64.0), mat="accent_gold",
              group="superstructure"))            # core-ship banding (the only gold)
    s.add(box(46.0, 1.6, 0.8, center=(0.0, deck + 24.4, cz - 39.0), mat="glass_blue",
              group="bridge"))
    s.add_pair_at(box(0.8, 1.6, 60.0, mat="glass_blue", group="bridge"),
                  (25.0, deck + 24.4, cz))
    for (tw, th, tl) in ((44.0, 8.0, 60.0), (30.0, 7.0, 40.0)):
        pass
    s.add(frustum_box(7.0, 0.09 * L, 22.0, center=(0.0, deck + 32.0 + 0.045 * L, cz),
                      scale_top=(0.4, 0.5), mat="hull_olive", group="bridge"))
    s.add_at(mast(0.05 * L, 1.8, segments=6, arms=2, dish_r=6.0, mat="hull_green",
                  dish_mat="gun_metal"), (0.0, deck + 32.0 + 0.09 * L, cz))
    # launch aperture
    az = S(0.62)
    s.add(cylinder(26.0, 3.0, axis="y", center=(0.0, deck + 0.4, az), segments=18,
                   radius2=24.0, mat="deck_dark", group="hull"))
    s.add(cylinder(20.0, 2.0, axis="y", center=(0.0, deck + 1.2, az), segments=16,
                   mat="hull_black", group="hull"))
    # domed dorsal + ventral rows.
    # Dorsal: 6 mounts, three stations either side of the core (canon 4-6).
    # CONFIG fires only 4 from turret_main, which the validator reports as a
    # warning for the Lead to settle - canon allows 4, so the alternative fix is
    # to drop the 0.70 pair.
    for i, (st, sgn) in enumerate(((0.200, 1.0), (0.200, -1.0), (0.450, 1.0),
                                   (0.450, -1.0), (0.700, 1.0), (0.700, -1.0))):
        mount_garm_turret(s, "turret_main_%d" % (i + 1), deck, S(st), 11.0, 6.0,
                          1.8, 20.0, x=sgn * 0.22 * B, body_mat="gun_metal",
                          dome_mat="hull_olive")
    # Ventral: canon's two stations, centreline.  CONFIG gives her no
    # secondary_battery, so they cannot be an indexed family; on Garmillas hulls
    # the domed mount form serves beam mounts and close-in mounts alike, so they
    # share the merged `anti_air` bucket - the only home a non-indexed gun mount
    # has in the vocabulary.
    for i, st in enumerate((0.300, 0.600)):
        mount_garm_turret(s, "anti_air_%d" % (i + 1), deck, S(st), 9.0, 5.0,
                          1.5, 16.0, ventral=True, body_mat="gun_metal",
                          dome_mat="hull_green", group="anti_air",
                          kind="anti_air")
    # 4 point-defence channels (pdMounts = 4), in the faction's domed form.
    for i, (st, sgn) in enumerate(((0.150, 1.0), (0.150, -1.0), (0.800, 1.0),
                                   (0.800, -1.0))):
        mount_garm_turret(s, "ciws_%d" % (i + 1), deck, S(st), 4.6, 2.6, 0.5, 7.0,
                          x=sgn * 0.36 * B, body_mat="gun_metal",
                          dome_mat="hull_green", kind="anti_air")
    # CONFIG carries a `missile` weapon for her (mounts.missile = 1) although the
    # research lists no launcher, so one flush 6-cell block is modelled on the
    # dorsal spine aft of the core ship.  Flagged to the Lead as a canon/CONFIG
    # disagreement: either she gets a launcher, or the CONFIG weapon goes.
    s.add(missile_cell_box(2, 3, 1.4, 3.4, (0.0, deck + 1.2, S(0.78)), face="-z"))
    s.hp("missile_launcher_1", "missile", (0.0, deck + 1.2, S(0.78) - 4.0),
         (0.0, 0.0, -1.0))
    fin = swept_fin(46.0, 3.0, 30.0, sweep=0.5, rise=6.0, mat="hull_green",
                    group="wing")
    xf_rotate_z(fin, 0.35)
    s.add_pair_at(fin, (58.0, 6.0, S(0.88)), rot_y=-0.52)
    s.add_pair_at(box(2.0, 22.0, 70.0, center=(0.0, 6.0, 0.0), mat="hull_green",
                      group="radiator"), (0.70 * B / 2.0, 0.0, S(0.72)))
    s.add_pair_at(box(3.0, 6.0, 0.70 * L, center=(0.0, -12.0, 0.0), mat="hull_olive",
                      group="hull"), (0.0, 0.0, S(0.50)))   # keel ridge
    engine_cluster(s, [(-0.28 * B, 0.0), (0.0, 0.0), (0.28 * B, 0.0)], 19.0, 26.0,
                   L / 2.0, names=("engine_1", "engine_2", "engine_3"), segments=20,
                   bell_mat="hull_green")
    engine_cluster(s, [(-0.14 * B, 13.0), (0.14 * B, 13.0)], 8.0, 16.0, L / 2.0,
                   names=("engine_4", "engine_5"), segments=14, bell_mat="hull_olive")


def build_garmillas_kelkapia(s):
    """Kelkapia-class high-speed cruiser - the 'long knife'.

    Elongated teardrop with a raked prow and a pointed stern, a dorsal fin ridge,
    a low bridge blister amidships at station 0.52, twin bow emitters, three
    dorsal domed mounts, two flared bells and a dorsal vernier.
    """
    L, B = s.L, s.B
    S = lambda t: (t - 0.5) * L                       # noqa: E731
    raw = [
        (S(0.010), 10.0, 14.2, -10.6),
        (S(0.060), 14.0, 13.6, -10.8),
        (S(0.180), 20.0, 12.8, -11.0),
        (S(0.450), 24.0, 11.6, -11.0),                # full beam
        (S(0.640), 21.0, 11.8, -10.6),
        (S(0.780), 16.0, 12.6, -9.8),
        (S(0.900), 10.0, 13.4, -8.8),
        (S(0.995),  3.6, 14.0, -7.6),                 # pointed stern
    ]
    secs = angular_hull(s, raw, n_pts=26, band=(-3.4, 3.4), band_mat="hull_green",
                        deck_w=0.88, deck_t=1.2, panel_y=None, gold=False,
                        hull_mat="hull_olive", panel_mat="hull_green")
    dy = lambda z: ydeck_at(secs, z)                  # noqa: E731
    deck = dy(0.0)
    s.secs, s.deck, s.station = secs, deck, S
    s.rake = make_rake(L, -L / 2.0, L / 2.0, 14.2, -10.6, bow_r=22.0, bow_p=1.2,
                       bow_fade=0.22, stern_r=8.0, stern_p=1.4, stern_fade=0.18)
    s.add(frustum_box(26.0, 24.0, 22.0, center=(0.0, 0.0, S(0.060)),
                      scale_top=(0.5, 0.6), top_offset=(0.0, 5.0),
                      mat="hull_olive", group="hull"))
    for i, mx in enumerate((-6.4, 6.4)):
        s.add(bow_gun(5.0, 20.0, -L / 2.0, y=0.6, segments=18, collar=6.2,
                      housing_mat="hull_olive", collar_mat="gun_metal"))
        for p in s.parts[-4:]:
            p.translate((mx, 0.0, 0.0))
        s.hp("wave_motion_gun" if i == 0 else "wave_motion_gun_2", "wmgun",
             (mx, 0.6, S(0.06)), (0.0, 0.0, -1.0))
    s.add(frustum_box(3.0, 0.16 * L, 0.45 * L,
                      center=(0.0, deck + 0.08 * L, S(0.525)),
                      scale_top=(0.5, 0.55), top_offset=(0.0, 0.05 * L),
                      mat="hull_green", group="wing"))
    bz = S(0.52)
    y = dy(bz)
    for (tw, th, tl) in ((24.0, 5.0, 32.0), (18.0, 4.5, 24.0), (12.0, 3.5, 16.0)):
        s.add(frustum_box(tw, th, tl, center=(0.0, y + th / 2.0, bz),
                          scale_top=(0.86, 0.9), mat="hull_olive", group="superstructure"
                          if th > 4.6 else "bridge"))
        s.add(box(tw + 3.0, 1.2, tl + 3.0, center=(0.0, y + 0.6, bz), mat="deck_dark",
                  group="bridge"))
        s.add(window_grid((0.0, y + th * 0.62, bz - tl / 2.0), "-z", tw * 0.7, 1.6, 1,
                          max(3, int(tw / 6.0)), win=(2.6, 1.8), group="bridge"))
        s.add(window_grid((tw / 2.0, y + th * 0.62, bz), "x", tl * 0.64, 1.6, 1,
                          max(3, int(tl / 8.0)), win=(2.6, 1.8), group="bridge"))
        s.add(window_grid((-tw / 2.0, y + th * 0.62, bz), "-x", tl * 0.64, 1.6, 1,
                          max(3, int(tl / 8.0)), win=(2.6, 1.8), group="bridge"))
        y += th
    s.add_at(mast(0.10 * L, 1.1, segments=6, arms=2, dish_r=3.8, mat="hull_green",
                  dish_mat="gun_metal"), (0.0, y, bz))
    for i, st in enumerate((0.25, 0.50, 0.75)):
        mount_garm_turret(s, "turret_main_%d" % (i + 1), deck, S(st), 8.0, 4.6,
                          1.3, 14.0, body_mat="gun_metal", dome_mat="hull_olive")
    # Ventral domed pair: CONFIG gives her no secondary_battery, so they ship in
    # the merged `anti_air` bucket (see the Dessler note on the domed form).
    for i, st in enumerate((0.35, 0.65)):
        mount_garm_turret(s, "anti_air_%d" % (i + 1), deck, S(st), 6.4, 3.6,
                          1.0, 11.0, ventral=True, body_mat="gun_metal",
                          dome_mat="hull_green", group="anti_air",
                          kind="anti_air")
    # small anti-air clusters around the bridge blister (research 01 section
    # 2.2).  Two of them are the traversable point-defence channels CONFIG gives
    # her (pdMounts = 2) and four more ship merged in `anti_air`: canon says
    # "clusters" without a count, so the ring is a reconstruction.
    for i, (st, sgn) in enumerate(((0.42, 1.0), (0.42, -1.0))):
        mount_garm_turret(s, "ciws_%d" % (i + 1), deck, S(st), 4.0, 2.4, 0.45, 6.0,
                          x=sgn * 0.36 * B, body_mat="gun_metal",
                          dome_mat="hull_green", kind="anti_air")
    for i, (st, sgn) in enumerate(((0.50, 1.0), (0.50, -1.0), (0.62, 1.0),
                                   (0.62, -1.0))):
        mount_garm_turret(s, "anti_air_%d" % (i + 3), deck, S(st), 3.6, 2.2, 0.4,
                          5.5, x=sgn * 0.42 * B, body_mat="gun_metal",
                          dome_mat="hull_green", group="anti_air", kind="anti_air")
    s.add_pair_at(swept_fin(9.5, 1.8, 13.0, sweep=0.55, rise=4.0, mat="hull_green",
                            group="wing"), (10.0, 5.0, S(0.40)))
    s.add_pair_at(box(1.4, 12.0, 40.0, center=(0.0, 3.0, 0.0), mat="hull_green",
                      group="radiator"), (0.88 * B / 2.0, 0.0, S(0.70)))
    s.add_pair_at(box(2.4, 5.0, 0.55 * L, center=(0.0, -9.0, 0.0), mat="hull_green",
                      group="hull"), (0.0, 0.0, S(0.48)))
    engine_cluster(s, [(-0.22 * B, 0.0), (0.22 * B, 0.0)], 0.045 * L, 15.0, L / 2.0,
                   names=("engine_1", "engine_2"), segments=18, bell_mat="hull_olive")
    engine_cluster(s, [(0.0, 9.0)], 4.0, 9.0, L / 2.0, names=("engine_3",),
                   segments=12, bell_mat="hull_green")


def build_garmillas_gaiderol(s):
    """Gaiderol-class space battleship - the tall one.

    A vertical blade hull that rakes to a wedge prow, under a very tall citadel
    ringed by ten CIWS mounts, with a dorsal spine aft, four dorsal and three
    ventral domed mounts and a 2x2 bell cluster.
    """
    L, B = s.L, s.B
    S = lambda t: (t - 0.5) * L                       # noqa: E731
    raw = [
        (S(0.005), 10.0, 17.8, -12.0),
        (S(0.060), 16.0, 16.8, -13.4),
        (S(0.130), 19.5, 16.0, -13.4),
        (S(0.200), 23.0, 15.3, -13.5),                # full beam
        (S(0.320), 23.0, 14.6, -13.5),
        (S(0.450), 23.0, 13.8, -13.5),
        (S(0.590), 22.5, 13.9, -13.3),
        (S(0.750), 22.0, 14.0, -13.0),
        (S(0.820), 20.4, 14.4, -12.7),
        (S(0.880), 19.0, 14.8, -12.4),
        (S(0.995), 15.0, 15.6, -11.5),
    ]
    secs = angular_hull(s, raw, n_pts=26, band=(-4.0, 4.0), band_mat="hull_green",
                        deck_w=0.88, deck_t=1.2, panel_y=None, gold=False,
                        hull_mat="hull_green", panel_mat="hull_olive")
    dy = lambda z: ydeck_at(secs, z)                  # noqa: E731
    deck = dy(0.0)
    s.secs, s.deck, s.station = secs, deck, S
    s.rake = make_rake(L, -L / 2.0, L / 2.0, 17.0, -12.0, bow_r=24.0, bow_p=1.2,
                       bow_fade=0.18, stern_r=10.0, stern_p=1.4, stern_fade=0.16)
    s.add(frustum_box(24.0, 26.0, 40.0, center=(0.0, 0.0, S(0.070)),
                      scale_top=(0.35, 0.45), top_offset=(0.0, -8.0),
                      mat="hull_green", group="hull"))
    s.add(bow_gun(9.0, 26.0, -L / 2.0, y=0.5, segments=20, collar=11.0,
                  housing_mat="hull_green", collar_mat="gun_metal"))
    s.hp("wave_motion_gun", "wmgun", (0.0, 0.5, S(0.06)), (0.0, 0.0, -1.0))
    # ---- torpedo banks: 16 recessed ports, two rows per flank ------------
    #  多数の魚雷発射管 - "two rows of 4-6 recessed circular ports on the flank of
    #  the prow, stations 0.06-0.18" (research 01 section 2.3).  Hull openings, so
    #  they take the merged `torpedo_tube` group.  CONFIG gives her no `torpedo`
    #  weapon, so they are GEOMETRY ONLY: a family CONFIG never reads is not
    #  claimed (the same treatment as Yukikaze's three tubes).
    for st in (0.075, 0.105, 0.135, 0.165):
        zz = S(st)
        for yy in (5.4, 1.4):
            for sgn in (1.0, -1.0):
                face_x = hx_at(secs, zz, yy) * BELT_SCALE
                s.add(hull_port(1.7, (sgn * (face_x - 0.6), yy, zz), axis="x",
                                depth=1.2, group="torpedo_tube", segments=5))
    cz = S(0.40)
    s.add(frustum_box(30.0, 10.0, 80.0, center=(0.0, deck + 5.0, cz),
                      scale_top=(0.88, 0.92), mat="hull_olive", group="superstructure"))
    s.add(box(34.0, 2.2, 84.0, center=(0.0, deck + 10.4, cz), mat="accent_gold",
              group="superstructure"))            # citadel trim (the only gold)
    s.add(frustum_box(22.0, 21.5, 34.0, center=(0.0, deck + 20.75, cz),
                      scale_top=(0.72, 0.80), mat="hull_green", group="bridge"))
    s.add(frustum_box(14.0, 10.0, 20.0, center=(0.0, deck + 26.5, cz),
                      scale_top=(0.70, 0.78), mat="hull_green", group="bridge"))
    for (tw, th, tl, yy) in ((30.0, 10.0, 80.0, deck + 5.0),
                             (22.0, 21.5, 34.0, deck + 20.75),
                             (14.0, 10.0, 20.0, deck + 26.5)):
        s.add(window_grid((0.0, yy + th * 0.1, cz - tl / 2.0), "-z", tw * 0.7, 2.0,
                          1, max(3, int(tw / 7.0)), win=(3.0, 2.0), group="bridge"))
        s.add(window_grid((tw / 2.0, yy + th * 0.1, cz), "x", tl * 0.6, 2.0, 1,
                          max(3, int(tl / 9.0)), win=(3.0, 2.0), group="bridge"))
        s.add(window_grid((-tw / 2.0, yy + th * 0.1, cz), "-x", tl * 0.6, 2.0, 1,
                          max(3, int(tl / 9.0)), win=(3.0, 2.0), group="bridge"))
    s.add(box(19.0, 1.6, 0.7, center=(0.0, deck + 21.0, cz - 11.0), mat="glass_blue",
              group="bridge"))
    s.add_at(mast(15.0, 1.4, segments=6, arms=2, dish_r=5.0, mat="hull_green",
                  dish_mat="gun_metal"), (0.0, deck + 31.5, cz))
    # ---- bridge CIWS ring: 10 domed mounts, "do not skip this" -----------
    #  A ring of 8-12 tiny mounts encircling the citadel at its base (research 01
    #  section 2.3), on an elliptical ring so it follows the citadel's 30 x 80 m
    #  footprint.  Four are the traversable channels CONFIG gives her
    #  (pdMounts = 4); the other six ship merged in `anti_air`.  They are domed
    #  Garmillas mounts rather than UNCF boxes, and the ring is a large part of
    #  what reads as "Garmillas battleship".
    for k in range(10):
        ang = 2.0 * math.pi * k / 10.0
        # 19 m across and 38 m fore-and-aft, not 20 x 44: a merged mount is baked
        # at its position and its ring is 3.57 m across, so a 20 m ring reaches
        # x = -23.6 and breaks SPEC 5 rule 7 (X extent == beamM = 46), while a
        # 44 m ring puts the forward mounts at z = -79, inside turret_main_2's
        # barbette (which ends at -78.7).  At 19 x 38 the outermost mount lands
        # on x = 22.6 and the forward pair on z = -77, clear of the turret.
        ex = 19.0 * math.cos(ang)
        ez = cz + 38.0 * math.sin(ang)
        if k < 4:
            mount_garm_turret(s, "ciws_%d" % (k + 1), deck, ez, 3.4, 2.2, 0.4, 5.5,
                              x=ex, body_mat="gun_metal", dome_mat="hull_green",
                              kind="anti_air")
        else:
            mount_garm_turret(s, "anti_air_%d" % (k - 3), deck, ez, 3.4, 2.2, 0.4,
                              5.5, x=ex, body_mat="gun_metal",
                              dome_mat="hull_green", group="anti_air",
                              kind="anti_air")
    s.add(frustum_box(3.4, 0.09 * L, 0.34 * L, center=(0.0, deck + 0.045 * L, S(0.60)),
                      scale_top=(0.45, 0.5), top_offset=(0.0, 0.06 * L),
                      mat="hull_olive", group="wing"))
    # 4 dorsal domed beam mounts.  The second sits at 0.25, not the research's
    # 0.35: the citadel's 80 m footprint covers stations 0.29-0.51, so a mount at
    # 0.35 would stand INSIDE its base (the containment audit caught exactly
    # that).  The citadel is the more visible feature and keeps its station.
    for i, st in enumerate((0.18, 0.25, 0.58, 0.78)):
        mount_garm_turret(s, "turret_main_%d" % (i + 1), deck, S(st), 8.4, 4.8,
                          1.4, 15.0, body_mat="gun_metal", dome_mat="hull_olive")
    for i, st in enumerate((0.25, 0.50, 0.72)):
        mount_garm_turret(s, "anti_air_%d" % (i + 7), deck, S(st), 7.0, 4.0,
                          1.1, 12.0, ventral=True, body_mat="gun_metal",
                          dome_mat="hull_green", group="anti_air", kind="anti_air")
    # CONFIG carries a `missile` weapon for her (mounts.missile = 1) although the
    # research lists no launcher, so one flush 6-cell block is modelled on the
    # dorsal spine abaft the citadel.  Flagged to the Lead as a canon/CONFIG
    # disagreement: either she gets a launcher, or the CONFIG weapon goes.
    s.add(missile_cell_box(2, 3, 1.2, 3.0, (0.0, deck + 1.0, S(0.70)), face="-z"))
    s.hp("missile_launcher_1", "missile", (0.0, deck + 1.0, S(0.70) - 3.6),
         (0.0, 0.0, -1.0))
    s.add_pair_at(swept_fin(14.0, 2.0, 16.0, sweep=0.5, rise=4.0, mat="hull_green",
                            group="wing"), (9.0, 6.0, S(0.30)))
    s.add_pair_at(box(1.6, 16.0, 50.0, center=(0.0, 4.0, 0.0), mat="hull_green",
                      group="radiator"), (0.88 * B / 2.0, 0.0, S(0.74)))
    s.add_pair_at(box(2.6, 5.0, 0.6 * L, center=(0.0, -11.0, 0.0), mat="hull_olive",
                      group="hull"), (0.0, 0.0, S(0.50)))
    engine_cluster(s, [(-0.18 * B, 8.0), (-0.18 * B, -8.0), (0.18 * B, 8.0),
                       (0.18 * B, -8.0)], 0.032 * L, 20.0, L / 2.0,
                   names=("engine_1", "engine_2", "engine_3", "engine_4"),
                   segments=18, bell_mat="hull_olive")


def build_bolar_carrier(s):
    """Ganonda-class space carrier - the glowing red runway.

    Blocky spindle hull with large swept lateral fins, a blunt prow carrying the
    wide horizontal Bolar cannon slab, a full-length red-glowing flight deck with
    white line accents and a stern landing aperture, the island at the very
    stern, three retractable quad mounts forward and four bells in a row.
    """
    L, B = s.L, s.B
    S = lambda t: (t - 0.5) * L                       # noqa: E731
    raw = [
        (S(0.010), 14.0, 14.0, -14.0),
        (S(0.060), 20.0, 14.0, -14.0),
        (S(0.150), 27.0, 14.0, -14.0),
        (S(0.300), 31.5, 14.0, -14.0),
        (S(0.550), 31.5, 14.0, -14.0),
        (S(0.760), 30.0, 14.0, -14.0),
        (S(0.900), 26.0, 14.0, -14.0),
        (S(0.995), 20.0, 14.0, -14.0),
    ]
    secs = block_hull(s, raw, n_pts=16, band=(-2.6, 2.6), band_mat="hull_white",
                      deck_w=0.92, deck_t=1.6, panel_y=None)
    dy = lambda z: ydeck_at(secs, z)                  # noqa: E731
    deck = dy(0.0)
    s.secs, s.deck, s.station = secs, deck, S
    s.rake = make_rake(L, -L / 2.0, L / 2.0, 14.0, -14.0, bow_r=16.0, bow_p=1.0,
                       bow_fade=0.18, stern_r=8.0, stern_p=1.0, stern_fade=0.14)
    s.add(frustum_box(46.0, 28.0, 26.0, center=(0.0, 0.0, S(0.050)),
                      scale_top=(0.55, 0.6), top_offset=(0.0, 4.0),
                      mat="bolar_blue", group="hull"))
    slab = [box(0.19 * L, 0.038 * L, 10.0, center=(0.0, 1.0, -L / 2.0 + 5.0),
                mat="hull_white", group="wave_motion_gun"),
            box(0.15 * L, 0.020 * L, 3.0, center=(0.0, 1.0, -L / 2.0 + 1.5),
                mat="engine_glow", group="wave_motion_gun")]
    s.add(slab)
    s.hp("wave_motion_gun", "wmgun", (0.0, 1.0, S(0.03)), (0.0, 0.0, -1.0))
    deck_y = deck + 1.8
    s.add(box(0.145 * L, 1.4, 0.80 * L, center=(0.0, deck_y, S(0.55)),
              mat="engine_glow", group="hull"))
    s.add(box(0.155 * L, 0.8, 0.82 * L, center=(0.0, deck_y - 0.9, S(0.55)),
              mat="deck_dark", group="hull"))
    for ox in (-0.055 * L, 0.055 * L):
        s.add(box(1.4, 0.5, 0.80 * L, center=(ox, deck_y + 1.0, S(0.55)),
                  mat="hull_white", group="hull"))
    for k in range(11):
        s.add(box(0.12 * L, 0.4, 1.6, center=(0.0, deck_y + 1.0, S(0.16 + k * 0.07)),
                  mat="hull_white", group="hull"))
    s.add(box(0.10 * L, 2.4, 0.05 * L, center=(0.0, deck_y, S(0.955)),
              mat="hull_black", group="hull"))
    iz = S(0.90)
    y = deck
    for (tw, th, tl, grp) in ((34.0, 16.0, 26.0, "superstructure"),
                              (24.0, 10.0, 18.0, "bridge")):
        s.add(frustum_box(tw, th, tl, center=(0.0, y + th / 2.0, iz),
                          scale_top=(0.82, 0.86), mat="bolar_blue" if grp ==
                          "superstructure" else "hull_white", group=grp))
        s.add(box(tw + 3.0, 1.4, tl + 3.0, center=(0.0, y + 0.7, iz), mat="deck_dark",
                  group=grp))
        s.add(window_grid((0.0, y + th * 0.55, iz - tl / 2.0), "-z", tw * 0.7, 2.0,
                          1, max(3, int(tw / 7.0)), win=(3.0, 2.0), group=grp))
        s.add(window_grid((tw / 2.0, y + th * 0.55, iz), "x", tl * 0.6, 2.0, 1,
                          max(3, int(tl / 8.0)), win=(3.0, 2.0), group=grp))
        s.add(window_grid((-tw / 2.0, y + th * 0.55, iz), "-x", tl * 0.6, 2.0, 1,
                          max(3, int(tl / 8.0)), win=(3.0, 2.0), group=grp))
        y += th
    s.add_at(mast(0.055 * L, 1.5, segments=6, arms=2, dish_r=5.0, mat="hull_white",
                  dish_mat="gun_metal"), (0.0, y, iz))
    for sgn in (1.0, -1.0):
        s.add(cylinder(1.6, 4.0, axis="z", center=(sgn * 15.0, deck + 2.0, iz - 6.0),
                       segments=8, mat="gun_metal", group="superstructure"))
    for i, st in enumerate((0.20, 0.30, 0.40)):
        zz = S(st)
        tname = "turret_main_%d" % (i + 1)
        parts = [box(16.0, 3.4, 18.0, center=(0.0, 1.7, 0.0), mat="bolar_blue",
                     group=tname),
                 box(12.0, 2.0, 14.0, center=(0.0, 4.2, 0.0), mat="gun_metal",
                     group=tname)]
        for ox in (-4.0, 4.0):
            for oy in (3.6, 5.4):
                parts.append(cylinder(0.8, 12.0, axis="z", center=(ox, oy, -9.0),
                                      segments=6, mat="gun_metal",
                                      group=tname, caps=False))
        s.add(parts)                          # centred on its own pivot
        s.hp(tname, "turret", (0.0, deck, zz), (0.0, 0.0, -1.0))
    # ---- retractable dual-purpose battery: 10 mounts per side ------------
    #  10 retractable AA/anti-ship mounts per side in two rows along the flanks
    #  at stations 0.15-0.85, offset +/-0.42 x beam (research 01 section 3.1),
    #  plus the two retractable AA machine guns at the bridge base.  They are
    #  the merged battery: nothing in CONFIG fires from `anti_air`, and she has
    #  no secondary_battery, so no indexed family may claim them.
    dp_names = []
    for sgn in (1.0, -1.0):
        for row, (yy, sts) in enumerate(((9.6, (0.16, 0.28, 0.40, 0.52, 0.64)),
                                         (4.6, (0.22, 0.34, 0.46, 0.58, 0.70)))):
            for st in sts:
                zz = S(st)
                x = hx_at(secs, zz, yy) * 0.97
                dp_names.append((sgn * x, yy, zz))
    for i, (mx, my, mz) in enumerate(dp_names):
        mount_pulse_laser(s, "anti_air_%d" % (i + 1), my, mz, mx, form="twin_75",
                          group="anti_air")
    for i, sgn in enumerate((1.0, -1.0)):
        mount_pulse_laser(s, "anti_air_%d" % (len(dp_names) + i + 1), deck + 2.0,
                          S(0.88), sgn * 20.0, form="twin_75", group="anti_air")
    for i, (st, sgn) in enumerate(((0.24, 1.0), (0.24, -1.0), (0.66, 1.0))):
        mount_aa(s, "ciws_%d" % (i + 1), deck, S(st), sgn * 0.40 * B, scale=1.2)
    # ---- 12 space torpedo tubes, 6 per side, as hull openings ------------
    #  宇宙魚雷発射管 x6 per side, stations 0.45-0.75, offset +/-0.38 x beam.
    #  CONFIG gives her no `torpedo` weapon, so these are GEOMETRY ONLY - the
    #  same treatment as Yukikaze's and the Gaiderol's tube banks.
    for sgn in (1.0, -1.0):
        for st in (0.46, 0.52, 0.58, 0.64, 0.70, 0.76):
            zz = S(st)
            x = hx_at(secs, zz, -6.0) * 0.97
            s.add(hull_port(1.8, (sgn * (x - 0.6), -6.0, zz), axis="x", depth=1.2,
                            group="torpedo_tube", segments=5))
        # the flank glow panels are her livery, not a weapon: they stay exactly
        # where they were, one row per side, independent of the tube ports
        for st in (0.30, 0.46, 0.62, 0.78):
            zz = S(st)
            x = hx_at(secs, zz, -2.0)
            s.add(box(3.0, 9.0, 0.045 * L, center=(sgn * (x - 1.2), -2.0, zz),
                      mat="hull_black", group="hull"))
            s.add(box(1.0, 6.0, 0.038 * L, center=(sgn * (x - 2.2), -2.0, zz),
                      mat="engine_glow", group="hull"))
    # CONFIG carries a `missile` weapon for her (mounts.missile = 1) although the
    # research lists no launcher, so one flush 6-cell block is modelled on the bow
    # deck forward of the flight deck.  Flagged to the Lead as a canon/CONFIG
    # disagreement: either she gets a launcher, or the CONFIG weapon goes.
    s.add(missile_cell_box(2, 3, 1.4, 3.2, (0.0, deck + 1.0, S(0.10)), face="-z"))
    s.hp("missile_launcher_1", "missile", (0.0, deck + 1.0, S(0.10) - 4.0),
         (0.0, 0.0, -1.0))
    fin_root = 0.09 * B
    fin_span_z = 0.20 * L
    fin_len = ((0.5 * B - fin_root - math.sin(0.42) * fin_span_z / 2.0)
               / math.cos(0.42))
    fin = swept_fin(fin_len, 3.0, 0.20 * L, sweep=0.55, rise=6.0,
                    mat="bolar_blue", group="wing", tip=(0.30, 0.5))
    s.add_pair_at(fin, (fin_root, 0.0, S(0.475)), rot_y=-0.42)
    s.add_pair_at(box(1.8, 18.0, 60.0, center=(0.0, 6.0, 0.0), mat="hull_white",
                      group="radiator"), (0.70 * B / 2.0, 0.0, S(0.62)))
    s.add_pair_at(box(3.0, 6.0, 0.7 * L, center=(0.0, -12.0, 0.0), mat="bolar_blue",
                      group="hull"), (0.0, 0.0, S(0.50)))
    engine_cluster(s, [(-0.28 * B, -2.0), (-0.10 * B, -2.0), (0.10 * B, -2.0),
                       (0.28 * B, -2.0)], 0.028 * L, 22.0, L / 2.0,
                   names=("engine_1", "engine_2", "engine_3", "engine_4"),
                   segments=18, bell_mat="bolar_blue")


# --------------------------------------------------------------------------
# Detail pass: applied after each builder, once the hull sections are known.
# Everything here is pure surface language - seams, plating, windows, fittings -
# sized so it still reads from the ~355 m chase camera.
# --------------------------------------------------------------------------

def _detail_yamato(s, secs, deck, S):
    """UNCF flagship: dense orderly plating, window rows, deck fittings.

    Sized against the chase camera (~355 m, 1 px ~ 0.17 m): seams are 2.8 m
    bands standing 0.5 m proud, windows 2.8 x 1.9 m, so all of it still reads.

    Thinned for the 2199 rebuild: the armament IS the silhouette now (a
    42-mount pulse-laser battery, 28 torpedo ports, the ventral third bridge),
    and it costs ~2.6 k triangles, so the surface pass gives up ~760 of its own
    - one strake line instead of two, five seams instead of seven, and window
    rows at chase-camera spacing rather than one every 15 m.  Nothing here is
    dropped: it is the same detail language at a lower density.
    """
    # S(0.55) MUST stay in this list: the prismatic seam band is what pins the
    # ship's beam, and 0.55 is the full-beam station.  Dropping it takes the X
    # extent to 47.78 and the model no longer matches beamM exactly.
    frame_rings(s, secs, [S(t) for t in (0.12, 0.28, 0.42, 0.55, 0.70, 0.84)], 1.6,
                "deck_dark")
    strake_lines(s, secs, [deck - 6.5], 0.8, 1.5, "deck_dark")
    armour_belt(s, secs, S(0.30), S(0.62), -12.0, -8.4, "hull_black", ribs=True,
                rib_mat="deck_dark", out_scale=1.016)
    window_row(s, secs, deck - 4.2, S(0.12), S(0.92), 12, win=(2.8, 1.9))
    window_row(s, secs, deck - 1.8, S(0.52), S(0.90), 5, win=(2.8, 1.9))
    s.add(window_grid((17.0, deck + 4.0, S(0.40)), "x", 60.0, 2.6, 1, 5,
                      win=(3.0, 2.0), group="superstructure"))
    s.add(window_grid((-17.0, deck + 4.0, S(0.40)), "-x", 60.0, 2.6, 1, 5,
                      win=(3.0, 2.0), group="superstructure"))
    s.add(window_grid((16.0, deck + 3.0, S(0.90)), "x", 22.0, 2.2, 1, 3,
                      win=(3.0, 2.0), group="superstructure"))
    s.add(window_grid((-16.0, deck + 3.0, S(0.90)), "-x", 22.0, 2.2, 1, 3,
                      win=(3.0, 2.0), group="superstructure"))
    hatch_row(s, S(0.44), S(0.78), 5, deck + 0.6, size=(3.6, 0.7, 4.6))
    lifeboat_rack(s, secs, deck - 4.0, S(0.48), S(0.72), 2)
    deck_crane(s, (0.0, deck + 0.5, S(0.86)), 10.0)
    sensor_dome(s, 3.2, (0.0, deck + 0.4, S(0.825)))
    cable_run(s, secs, deck - 2.4, S(0.18), S(0.86), count=1)
    light_points(s, [(0.0, deck + 1.2, S(0.075)), (0.0, deck + 1.2, S(0.955)),
                     (12.0, deck + 1.2, S(0.60))], radius=1.8)


def _detail_andromeda(s, secs, deck, S):
    """UNCF vanguard: long clean plating runs, window rows, deck fittings."""
    frame_rings(s, secs, [S(t) for t in (0.14, 0.28, 0.45, 0.60, 0.74, 0.88)],
                1.8, "deck_dark")
    strake_lines(s, secs, [deck - 4.6, deck - 7.8], 0.9, 1.6, "deck_dark")
    armour_belt(s, secs, S(0.26), S(0.64), -10.6, -7.6, "hull_black", ribs=True,
                rib_mat="deck_dark", out_scale=1.016)
    window_row(s, secs, deck - 3.6, S(0.10), S(0.94), 16, win=(3.0, 2.0))
    s.add(window_grid((17.5, deck + 4.0, S(0.45)), "x", 100.0, 2.6, 1, 7,
                      win=(3.4, 2.2), group="superstructure"))
    s.add(window_grid((-17.5, deck + 4.0, S(0.45)), "-x", 100.0, 2.6, 1, 7,
                      win=(3.4, 2.2), group="superstructure"))
    hatch_row(s, S(0.40), S(0.80), 7, deck + 0.6, size=(4.0, 0.7, 5.0))
    lifeboat_rack(s, secs, deck - 3.4, S(0.46), S(0.74), 3)
    deck_crane(s, (0.0, deck + 0.5, S(0.88)), 11.0)
    sensor_dome(s, 3.4, (0.0, deck + 0.4, S(0.83)))
    cable_run(s, secs, deck - 2.2, S(0.14), S(0.88), count=1)
    light_points(s, [(0.0, deck + 1.2, S(0.06)), (0.0, deck + 1.2, S(0.96)),
                     (14.0, deck + 1.2, S(0.60)), (-14.0, deck + 1.2, S(0.60))],
                 radius=2.0)


def _detail_kirishima(s, secs, deck, S):
    """UNCF cruiser: compact plating, window rows, boat bays."""
    frame_rings(s, secs, [S(t) for t in (0.14, 0.26, 0.38, 0.50, 0.64, 0.78, 0.90)],
                1.5, "deck_dark")
    strake_lines(s, secs, [deck - 3.8, deck - 6.4], 0.8, 1.4, "deck_dark")
    armour_belt(s, secs, S(0.28), S(0.66), -8.6, -6.0, "hull_black", ribs=True,
                rib_mat="deck_dark", out_scale=1.016)
    window_row(s, secs, deck - 3.2, S(0.14), S(0.92), 14, win=(2.8, 1.9))
    s.add(window_grid((11.5, deck + 3.0, S(0.45)), "x", 40.0, 2.2, 1, 7,
                      win=(2.8, 1.9), group="superstructure"))
    s.add(window_grid((-11.5, deck + 3.0, S(0.45)), "-x", 40.0, 2.2, 1, 7,
                      win=(2.8, 1.9), group="superstructure"))
    hatch_row(s, S(0.44), S(0.78), 7, deck + 0.5, size=(3.2, 0.6, 4.0))
    lifeboat_rack(s, secs, deck - 3.0, S(0.48), S(0.72), 3)
    deck_crane(s, (0.0, deck + 0.4, S(0.86)), 10.0)
    sensor_dome(s, 3.0, (0.0, deck + 0.3, S(0.80)))
    light_points(s, [(0.0, deck + 1.0, S(0.075)), (0.0, deck + 1.0, S(0.95))],
                 radius=1.6)


def _detail_yukikaze(s, secs, deck, S):
    """UNCF destroyer: aircraft-style plating and a few crisp fittings."""
    frame_rings(s, secs, [S(t) for t in (0.16, 0.30, 0.48, 0.66, 0.84)], 1.0,
                "deck_dark")
    strake_lines(s, secs, [deck - 3.0], 0.6, 1.2, "deck_dark")
    window_row(s, secs, deck - 3.0, S(0.22), S(0.86), 7, win=(2.0, 1.4))
    s.add(window_grid((0.0, deck - 2.4, S(0.45) - 7.6), "-z", 6.0, 1.2, 1, 4,
                      win=(2.0, 1.4), group="bridge"))
    hatch_row(s, S(0.32), S(0.66), 4, deck + 0.4, size=(3.6, 0.5, 4.6))
    sensor_dome(s, 3.0, (0.0, deck + 0.3, S(0.70)))
    antenna_cluster(s, (0.0, deck + 1.0, S(0.30)), 5.0, count=2, spread=3.0,
                    group="superstructure")
    light_points(s, [(0.0, deck + 0.6, S(0.09)), (0.0, deck + 0.6, S(0.94))],
                 radius=1.6)


def _detail_dessler(s, secs, deck, S):
    """Garmillas flagship: glowing seams, glazed core tiers, domed fittings."""
    frame_rings(s, secs, [S(t) for t in (0.14, 0.28, 0.46, 0.62, 0.78, 0.90)],
                2.6, "hull_green")
    glow_seam(s, secs, 8.0, 11.0, S(0.10), S(0.90))
    glow_seam(s, secs, -11.0, -8.0, S(0.12), S(0.88))
    glow_seam(s, secs, -2.0, 2.0, S(0.62), S(0.98))
    sensor_dome(s, 5.0, (0.0, deck + 1.0, S(0.72)), mat="hull_olive")
    sensor_dome(s, 4.0, (0.0, deck + 1.0, S(0.20)), mat="hull_olive")
    antenna_cluster(s, (0.0, deck + 1.0, S(0.30)), 12.0, count=3, spread=8.0,
                    mat="hull_green", group="superstructure")
    light_points(s, [(0.0, deck + 2.0, S(0.10)), (0.0, deck + 2.0, S(0.95)),
                     (60.0, deck + 2.0, S(0.40)), (-60.0, deck + 2.0, S(0.40))],
                 radius=2.6)
    for k in range(3):
        curved_fin(s, 18.0, 11.0, 2.6, (0.0, deck + 3.0, S(0.30 + k * 0.07)),
                   mat="hull_green", group="wing")


def _detail_kelkapia(s, secs, deck, S):
    """Garmillas cruiser: long glowing seams along a slim blade hull."""
    frame_rings(s, secs, [S(t) for t in (0.18, 0.32, 0.45, 0.58, 0.72, 0.86)], 2.0,
                "hull_green")
    glow_seam(s, secs, 5.4, 7.6, S(0.12), S(0.92))
    glow_seam(s, secs, -7.6, -5.4, S(0.14), S(0.90))
    window_row(s, secs, deck - 3.6, S(0.16), S(0.88), 9, win=(2.4, 1.6))
    sensor_dome(s, 3.4, (0.0, deck + 0.6, S(0.80)), mat="hull_olive")
    antenna_cluster(s, (0.0, deck + 0.8, S(0.22)), 8.0, count=2, spread=5.0,
                    mat="hull_green", group="superstructure")
    light_points(s, [(0.0, deck + 1.4, S(0.08)), (0.0, deck + 1.4, S(0.95))],
                 radius=1.8)


def _detail_gaiderol(s, secs, deck, S):
    """Garmillas battleship: tall citadel, glowing seams, sensor fittings."""
    frame_rings(s, secs, [S(t) for t in (0.10, 0.22, 0.34, 0.46, 0.58, 0.72, 0.86)],
                2.4, "hull_green")
    glow_seam(s, secs, 6.0, 8.4, S(0.08), S(0.94))
    glow_seam(s, secs, -8.4, -6.0, S(0.10), S(0.92))
    window_row(s, secs, deck - 4.4, S(0.14), S(0.90), 11, win=(2.4, 1.6))
    sensor_dome(s, 3.6, (0.0, deck + 0.8, S(0.86)), mat="hull_olive")
    sensor_dome(s, 3.0, (0.0, deck + 0.8, S(0.16)), mat="hull_olive")
    antenna_cluster(s, (0.0, deck + 1.0, S(0.24)), 10.0, count=3, spread=6.0,
                    mat="hull_green", group="superstructure")
    light_points(s, [(0.0, deck + 1.6, S(0.07)), (0.0, deck + 1.6, S(0.96)),
                     (18.0, deck + 1.6, S(0.50)), (-18.0, deck + 1.6, S(0.50))],
                 radius=1.8)


def _detail_bolar(s, secs, deck, S):
    """Bolar carrier: heavy slab plating, blocky vents, glazed island."""
    frame_rings(s, secs, [S(t) for t in (0.14, 0.28, 0.46, 0.64, 0.80)], 3.0,
                "hull_white")
    for (st, y, hw, th) in ((0.22, 6.0, 9.0, 3.0), (0.34, 6.0, 9.0, 3.0),
                            (0.50, 6.0, 9.0, 3.0), (0.66, 6.0, 9.0, 3.0),
                            (0.30, -6.0, 11.0, 3.0), (0.58, -6.0, 11.0, 3.0)):
        slab_plate(s, (0.0, y, S(st)), (hw, th, 30.0), mat="hull_white")
        slab_plate(s, (0.0, -y, S(st)), (hw, th, 30.0), mat="hull_white")
    hatch_row(s, S(0.60), S(0.84), 6, deck + 0.5, size=(6.0, 0.7, 7.0))
    vent_bank(s, 0.0, deck + 1.6, S(0.30), 4, size=(4.0, 2.2, 3.0), spacing=5.0)
    sensor_dome(s, 3.6, (0.0, deck + 0.6, S(0.74)), mat="hull_white")
    antenna_cluster(s, (0.0, deck + 1.0, S(0.20)), 9.0, count=2, spread=6.0,
                    mat="hull_white", group="superstructure")
    light_points(s, [(0.0, deck + 1.4, S(0.08)), (0.0, deck + 1.4, S(0.97)),
                     (40.0, deck + 1.4, S(0.42)), (-40.0, deck + 1.4, S(0.42))],
                 radius=2.0)


DETAIL_PASSES = {
    "yamato": _detail_yamato,
    "andromeda": _detail_andromeda,
    "kirishima": _detail_kirishima,
    "yukikaze": _detail_yukikaze,
    "garmillas_dessler": _detail_dessler,
    "garmillas_kelkapia": _detail_kelkapia,
    "garmillas_gaiderol": _detail_gaiderol,
    "bolar_carrier": _detail_bolar,
}


def apply_detail(ship):
    """Run this ship's surface-detail pass (needs the builder's hull sections)."""
    fn = DETAIL_PASSES.get(ship.id)
    if fn is None or ship.secs is None or ship.station is None:
        return
    fn(ship, ship.secs, ship.deck, ship.station)


# --------------------------------------------------------------------------
# Fleet table (SPEC section 5 order - keeps the manifest stable)
# --------------------------------------------------------------------------

def fleet_specs():
    return [
        {"id": "yamato", "displayName": "Yamato (BBY-01)",
         "displayNameJa": "\u30e4\u30de\u30c8", "faction": "uncf",
         "shipClass": "Yamato-class", "role": "battleship",
         "lengthM": 333, "beamM": 48, "seed": 2199, "builder": build_yamato},
        {"id": "andromeda", "displayName": "Andromeda (AAA-01)",
         "displayNameJa": "\u30a2\u30f3\u30c9\u30ed\u30e1\u30c0", "faction": "uncf",
         "shipClass": "Andromeda-class", "role": "battleship",
         "lengthM": 444, "beamM": 62, "seed": 2202, "builder": build_andromeda},
        {"id": "kirishima", "displayName": "Kirishima (CCV-05)",
         "displayNameJa": "\u9727\u5cf6", "faction": "uncf",
         "shipClass": "Kongo-class (refit)", "role": "cruiser",
         "lengthM": 205, "beamM": 34, "seed": 2210, "builder": build_kirishima},
        {"id": "yukikaze", "displayName": "Yukikaze (DD-117)",
         "displayNameJa": "\u96ea\u98a8", "faction": "uncf",
         "shipClass": "Isokaze-class", "role": "destroyer",
         "lengthM": 80, "beamM": 38, "seed": 2216, "builder": build_yukikaze},
        {"id": "garmillas_dessler", "displayName": "Desler flagship",
         "displayNameJa": "\u30c7\u30b9\u30e9\u30fc\u65d7\u8266", "faction": "garmillas",
         "shipClass": "Desler flagship", "role": "flagship",
         "lengthM": 638, "beamM": 245, "seed": 3101, "builder": build_garmillas_dessler},
        {"id": "garmillas_kelkapia", "displayName": "Kelkapia-class cruiser",
         "displayNameJa": "\u30b1\u30eb\u30ab\u30d4\u30a2\u578b", "faction": "garmillas",
         "shipClass": "Kelkapia-class", "role": "cruiser",
         "lengthM": 240, "beamM": 48, "seed": 3107, "builder": build_garmillas_kelkapia},
        {"id": "garmillas_gaiderol", "displayName": "Gaiderol-class battleship",
         "displayNameJa": "\u30ac\u30a4\u30c7\u30ed\u30eb\u578b", "faction": "garmillas",
         "shipClass": "Gaiderol-class", "role": "battleship",
         "lengthM": 350, "beamM": 46, "seed": 3113, "builder": build_garmillas_gaiderol},
        {"id": "bolar_carrier", "displayName": "Bolar carrier",
         "displayNameJa": "\u30dc\u30e9\u30fc\u7a7a\u6bcd", "faction": "bolar",
         "shipClass": "Bolar carrier", "role": "carrier",
         "lengthM": 400, "beamM": 110, "seed": 4207, "builder": build_bolar_carrier},
    ]


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def generate(out_dir, only=None, quiet=False):
    specs = fleet_specs()
    if only:
        wanted = set(only)
        specs = [s for s in specs if s["id"] in wanted]
        missing = wanted - set(s["id"] for s in specs)
        if missing:
            raise SystemExit("unknown ship id(s): %s" % ", ".join(sorted(missing)))
    os.makedirs(out_dir, exist_ok=True)
    entries = []
    report = []
    for spec in specs:
        ship = Ship(spec)
        spec["builder"](ship)
        apply_detail(ship)
        if ship.rake is not None:
            apply_rake(ship, ship.rake)
        tris = ship.tri_count()
        if tris > MAX_TRIANGLES:
            raise SystemExit("%s: %d triangles exceeds the %d budget"
                             % (ship.id, tris, MAX_TRIANGLES))
        (x0, y0, z0), (x1, y1, z1) = ship.bbox()
        if abs(z0 - ship.z_bow) > 0.02 or abs(z1 - ship.z_stern) > 0.02:
            raise SystemExit("%s: Z extent [%.3f, %.3f] does not match lengthM %.1f"
                             % (ship.id, z0, z1, ship.L))
        if abs((x0 + x1) / 2.0) > 0.02 * ship.B:
            raise SystemExit("%s: not centred in X (%.3f .. %.3f)" % (ship.id, x0, x1))
        if abs((x1 - x0) - ship.B) > 0.02 * ship.B:
            raise SystemExit("%s: X extent %.2f does not match beamM %.1f"
                             % (ship.id, x1 - x0, ship.B))
        entry = model_entry(ship)
        entries.append(entry)
        with open(os.path.join(out_dir, entry["obj"]), "w", encoding="utf-8") as fh:
            fh.write(emit_obj(ship))
        with open(os.path.join(out_dir, entry["mtl"]), "w", encoding="utf-8") as fh:
            fh.write(emit_mtl(ship))
        report.append((ship.id, tris, entry["groups"], entry["materials"],
                       (x0, y0, z0, x1, y1, z1), len(entry["hardpoints"])))
    if only:
        mpath = os.path.join(out_dir, "manifest.json")
        if os.path.exists(mpath):
            with open(mpath, "r", encoding="utf-8") as fh:
                old = json.load(fh)
            keep = {m["id"]: m for m in old.get("models", [])}
            for e in entries:
                keep[e["id"]] = e
            all_ids = [s["id"] for s in fleet_specs()]
            entries = [keep[i] for i in all_ids if i in keep]
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        fh.write(emit_manifest(entries))
    with open(os.path.join(out_dir, "README.md"), "w", encoding="utf-8") as fh:
        fh.write(emit_readme(entries))
    if not quiet:
        for (sid, tris, groups, mats, bb, nhp) in report:
            print("%-20s %5d tris  %2d groups  %2d materials  %2d hardpoints  "
                  "bbox x[%7.2f %7.2f] y[%7.2f %7.2f] z[%8.2f %8.2f]"
                  % (sid, tris, len(groups), len(mats), nhp,
                     bb[0], bb[3], bb[1], bb[4], bb[2], bb[5]))
        print("wrote %d model(s) + manifest.json + README.md to %s"
              % (len(entries), out_dir))
    return entries


def selftest():
    """Sanity checks on the primitive library (winding, volumes, clipping)."""
    ok = True

    def check(name, cond, detail=""):
        nonlocal ok
        status = "ok  " if cond else "FAIL"
        if not cond:
            ok = False
        print("[%s] %s %s" % (status, name, detail))

    b = box(2.0, 4.0, 6.0, mat="hull_grey", group="hull")
    check("box volume", abs(b.signed_volume() - 48.0) < 1e-6, "%.4f" % b.signed_volume())
    check("box tris", b.tri_count() == 12, str(b.tri_count()))

    c = cylinder(3.0, 10.0, axis="z", segments=64, mat="hull_grey", group="hull")
    vol = c.signed_volume()
    check("cylinder volume", abs(vol - math.pi * 90.0) / (math.pi * 90.0) < 0.01,
          "%.3f" % vol)
    for ax in ("x", "y"):
        cc = cylinder(3.0, 10.0, axis=ax, segments=32, mat="hull_grey", group="hull")
        check("cylinder %s volume" % ax, cc.signed_volume() > 0,
              "%.3f" % cc.signed_volume())

    r = ring(2.0, 4.0, 2.0, segments=32, mat="gun_metal", group="hull")
    check("ring volume", r.signed_volume() > 0, "%.3f" % r.signed_volume())

    d = dome(5.0, 4.0, segments=32, rings=6)
    check("dome volume", d.signed_volume() > 0, "%.3f" % d.signed_volume())

    f = frustum_box(4.0, 2.0, 8.0, scale_top=(0.5, 0.5), mat="hull_grey", group="hull")
    check("frustum volume", f.signed_volume() > 0, "%.3f" % f.signed_volume())

    sec = hull_section(5.0, 4.0, -4.0)
    check("section ccw", poly_area(sec) > 0, "%.3f" % poly_area(sec))
    rs = resample_closed(sec, 24)
    check("resample count", len(rs) == 24 and poly_area(rs) > 0, "%.3f" % poly_area(rs))
    rk = resample_keep(sec, 24)
    check("resample_keep count", len(rk) == 24, "%d pts" % len(rk))
    check("resample_keep extremes", abs(max(q[0] for q in rk) - 5.0) < 1e-9,
          "max x %.4f" % max(q[0] for q in rk))
    check("clip slab", len(clip_polygon_y(sec, -2.0, 2.0)) >= 4,
          "%d pts" % len(clip_polygon_y(sec, -2.0, 2.0)))

    sections = [(z, resample_closed(hull_section(6.0 - abs(z) * 0.1, 3.0, -3.0), 20))
                for z in (-10.0, -5.0, 0.0, 5.0, 10.0)]
    lf = loft(sections, "hull_grey", "hull")
    check("loft volume", lf.signed_volume() > 0, "%.3f" % lf.signed_volume())
    bl = belt(sections, -1.5, 1.5, 8, 1.01, "hull_red", "hull")
    check("belt builds", bl.tri_count() > 0, "%d tris" % bl.tri_count())
    slab = slab_along_sections(sections, 0.86, 0.15, 0.8, "deck_dark", "hull")
    check("deck slab", slab.tri_count() > 0, "%d tris" % slab.tri_count())

    t = turret(6.0, 3.0, (14.0, 6.0, 18.0), 3, 1.2, 24.0)
    check("turret builds", tri_count(t) > 0, "%d tris" % tri_count(t))
    check("nozzle builds", tri_count(nozzle(8.0, 20.0)) > 0,
          "%d tris" % tri_count(nozzle(8.0, 20.0)))
    check("mast builds", tri_count(mast(16.0, 1.4, dish_r=4.0)) > 0,
          "%d tris" % tri_count(mast(16.0, 1.4, dish_r=4.0)))
    check("bow gun builds", tri_count(bow_gun(6.0, 20.0, -100.0)) > 0,
          "%d tris" % tri_count(bow_gun(6.0, 20.0, -100.0)))
    check("panel lines", tri_count(panel_lines(sections, 1.0, 0.5, 0.9, "deck_dark",
                                               "hull")) > 0,
          "%d tris" % tri_count(panel_lines(sections, 1.0, 0.5, 0.9, "deck_dark", "hull")))
    gr = greeble_row(random.Random(1), 6, 4.0, 2.0, -10.0, 10.0, (1.5, 1.0, 2.0),
                     "deck_dark", "hull")
    check("greebles", tri_count(gr) == 72, "%d tris" % tri_count(gr))
    check("swept fin", tri_count(swept_fin(8.0, 1.0, 6.0)) > 0,
          "%d tris" % tri_count(swept_fin(8.0, 1.0, 6.0)))

    print("\nselftest %s" % ("PASSED" if ok else "FAILED"))
    return 0 if ok else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="YAMATO FLEET 2199 procedural modeller")
    ap.add_argument("--out", default="assets/models", help="output directory")
    ap.add_argument("--only", action="append", default=None,
                    help="regenerate only this ship id (repeatable)")
    ap.add_argument("--selftest", action="store_true",
                    help="check the primitive library")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return selftest()
    generate(args.out, only=args.only, quiet=args.quiet)
    return 0


if __name__ == "__main__":
    sys.exit(main())
