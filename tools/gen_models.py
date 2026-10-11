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

HARDPOINT_KINDS = ("wmgun", "turret", "thruster", "anti_air")

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
| Groups | fixed: `hull`, `superstructure`, `bridge`, `wave_motion_gun`, `engine_nozzle`, `wing`, `radiator`; indexed mounts: `turret_main_1..N`, `turret_secondary_1..N`, `ciws_1..N` (SPEC §5 rule 3) |
| Mount pivots | an indexed group's name IS its manifest hardpoint name and its geometry is authored **centred on its own pivot** - x = z = 0 on the traverse axis, y = 0 at the deck line where the barbette meets the hull. The renderer does `mesh.position = hardpoint.pos` then `mesh.rotation.y = <traverse>` (0 = trained fore-and-aft), so the turrets traverse individually |
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
| `thruster` | stern engine bells (`engine_*`, dir +Z) |
| `anti_air` | close-in pulse-laser mounts (`anti_air_*`) |

Every ship carries a bow `wave_motion_gun` emitter, centreline `turret_main`
mounts, at least two `turret_secondary` and two `anti_air` mounts, and stern
`engine_*` bells.

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

* **UNCF** - grey hulls with a red waterline band and cyan drive glow. Yamato:
  flat blunt bow face with a recessed circular WM-gun muzzle, pagoda bridge at
  station 0.30, three triple turrets (2 fore / 1 aft). Andromeda: broad flat bow
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
                 barrel_mat="gun_metal"):
    """Author a naval turret CENTRED ON ITS OWN PIVOT + register its hardpoint.

    SPEC 5 rule 3: the indexed group keeps its vertices at the origin - x = z = 0
    on the traverse axis, y = 0 at the deck line where the barbette meets the
    hull - and ``hardpoint.pos`` is that same pivot.  ``group`` here is only the
    family (which decides the detail budget); the emitted group name is ``name``.
    """
    main = group == "turret_main"
    parts = turret(barbette_r, barbette_h, body, barrels, barrel_r, barrel_len,
                   group=name, body_mat=body_mat, barbette_mat=barbette_mat,
                   barrel_mat=barrel_mat, elev=elev, deck_ring=True,
                   muzzle_ring=main, barbette_seg=12 if main else 10)
    if aft:
        # author the rest orientation into the local geometry, so traverse 0
        # means "trained fore-and-aft" for this mount
        for part in as_list(parts):
            part.rotate_y(math.pi)
    s.add(parts)
    s.hp(name, "turret", (x, deck_y, z), (0.0, 0.0, 1.0 if aft else -1.0))
    return parts


def mount_garm_turret(s, name, deck_y, z, radius, height, barrel_r, barrel_len,
                      aft=False, x=0.0, ventral=False, body_mat="gun_metal",
                      dome_mat="hull_green", group="turret_main"):
    """Garmillas low domed mount, authored centred on its own pivot."""
    parts = [ring(radius * 0.80, radius * 1.05, 1.2, axis="y",
                  center=(0.0, 0.6, 0.0), segments=14, mat=body_mat, group=name),
             dome(radius * 0.94, height, center=(0.0, 1.2, 0.0), segments=16, rings=3,
                  mat=dome_mat, group=name)]
    for ox in (-radius * 0.36, radius * 0.36):
        parts.extend(barrel(barrel_len, barrel_r, segments=8, mat=body_mat,
                            group=name))
        xf_translate(parts[-2:], (ox, height * 0.62, -radius * 0.5))
    if ventral:
        xf_mirror_y(parts)
    if aft:
        for part in as_list(parts):
            part.rotate_y(math.pi)
    s.add(parts)
    s.hp(name, "turret", (x, -deck_y if ventral else deck_y, z),
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

    2199 silhouette: raked clipper bow with the wave-motion-gun muzzle standing
    proud of it, a sheer line rising to the forecastle, a hull that tapers to a
    keel, a multi-tier pagoda bridge with the angled funnel abaft it, and the
    signature SUPERFIRING forward pair - turret #1 on the forecastle, turret #2
    raised on a barbette behind and above it - plus turret #3 aft.
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

    # ---- wave motion gun: the bow's defining feature ----------------------
    s.add(bow_gun(10.5, 34.0, -L / 2.0, y=1.2, segments=28, collar=12.4,
                  housing_mat="hull_grey", collar_mat="gun_metal"))
    # blast shield / housing shoulders blended into the forecastle
    s.add(frustum_box(30.0, 22.0, 30.0, center=(0.0, 1.0, S(0.055)),
                      scale_top=(0.55, 0.70), top_offset=(0.0, 4.0),
                      mat="hull_grey", group="hull"))
    s.hp("wave_motion_gun", "wmgun", (0.0, 1.2, S(0.06)), (0.0, 0.0, -1.0))

    # ---- forecastle breakwater + brow ------------------------------------
    s.add(frustum_box(26.0, 5.0, 22.0, center=(0.0, dy(S(0.155)) - 1.6, S(0.155)),
                      scale_top=(0.42, 0.55), top_offset=(0.0, 4.5),
                      mat="deck_dark", group="hull"))
    for sgn in (1.0, -1.0):
        s.add(box(4.0, 4.2, 9.0, center=(sgn * 11.0, dy(S(0.10)) - 3.0, S(0.10)),
                  mat="deck_dark", group="hull"))     # anchor recesses
        s.add(box(6.0, 2.2, 9.0, center=(sgn * 12.5, dy(S(0.055)) - 0.5, S(0.055)),
                  mat="hull_white", group="hull"))    # hull-number plates

    # ---- SUPERFIRING FORWARD PAIR + aft turret ----------------------------
    #   #1 on the forecastle, #2 on a raised barbette deckhouse behind/above it
    z1, z2 = S(0.145), S(0.275)
    d1, d2 = dy(z1), dy(z2)
    s.add(frustum_box(40.0, 7.5, 44.0, center=(0.0, d2 + 3.75, z2),
                      scale_top=(0.90, 0.93), mat="hull_grey",
                      group="superstructure"))
    mount_turret(s, "turret_main_1", "turret_main", d1, z1,
                 10.0, 4.0, (26.0, 9.5, 28.0), 3, 2.2, 21.0, elev=0.05)
    mount_turret(s, "turret_main_2", "turret_main", d2 + 7.5, z2,
                 10.0, 4.0, (26.0, 9.5, 28.0), 3, 2.2, 21.0, elev=0.05)
    z3 = S(0.800)
    d3 = dy(z3)
    s.add(frustum_box(36.0, 5.0, 38.0, center=(0.0, d3 + 2.5, z3),
                      scale_top=(0.9, 0.93), mat="hull_grey", group="superstructure"))
    mount_turret(s, "turret_main_3", "turret_main", d3 + 5.0, z3,
                 10.0, 4.0, (26.0, 9.5, 28.0), 3, 2.2, 21.0, aft=True, elev=0.05)

    # ---- WING secondaries (2 forward, 2 aft) on side sponsons -------------
    for i, st in enumerate((0.415, 0.645)):
        zz = S(st)
        x = hx_at(secs, zz, dy(zz) - 1.0) * 0.80
        for sgn in (1.0, -1.0):
            s.add(box(11.0, 3.0, 15.0, center=(sgn * x, dy(zz) - 1.5, zz),
                      mat="hull_grey", group="superstructure"))
            mount_turret(s, "turret_secondary_%d" % (2 * i + (1 if sgn > 0 else 2)),
                         "turret_secondary", dy(zz) + 0.2, zz, 4.6, 2.8,
                         (10.0, 4.6, 11.0), 2, 1.0, 12.0, x=sgn * x, elev=0.10)

    # ---- AA / CIWS on sponsons distributed along the hull -----------------
    for i, (st, sgn) in enumerate(((0.195, 1.0), (0.195, -1.0), (0.500, 1.0),
                                   (0.500, -1.0), (0.845, 1.0), (0.845, -1.0))):
        zz = S(st)
        x = hx_at(secs, zz, dy(zz) - 0.5) * 0.88
        s.add(box(6.0, 2.0, 7.0, center=(sgn * x, dy(zz) - 1.0, zz),
                  mat="hull_grey", group="superstructure"))
        mount_aa(s, "ciws_%d" % (i + 1), dy(zz) + 0.1, zz, sgn * x, scale=1.05)

    # ---- PAGODA BRIDGE: armoured base + 5 tiers with platform overhangs ---
    bz = S(0.300)
    base = dy(bz)
    tiers = [
        # width, height, length, platform overhang
        (36.0, 11.0, 32.0, 2.6),
        (30.0, 8.0, 27.0, 2.2),
        (24.0, 7.0, 22.0, 1.9),
        (18.0, 6.0, 17.0, 1.6),
        (12.5, 5.0, 12.0, 1.3),
    ]
    y = base
    for i, (tw, th, tl, ov) in enumerate(tiers):
        s.add(frustum_box(tw, th, tl, center=(0.0, y + th / 2.0, bz),
                          scale_top=(0.90, 0.92), mat="hull_grey", group="bridge"))
        # platform overhang at the tier's foot (this is what makes it a pagoda)
        s.add(box(tw + 2.0 * ov, 1.4, tl + 2.0 * ov,
                  center=(0.0, y + 0.7, bz), mat="deck_dark", group="bridge"))
        # window row on the tier face
        s.add(window_grid((0.0, y + th * 0.62, bz - tl / 2.0), "-z",
                          tw * 0.68, 1.6, 1, max(3, int(tw / 6.0)),
                          win=(3.0, 1.9), group="bridge"))
        s.add(window_grid((tw / 2.0, y + th * 0.62, bz), "x", tl * 0.62, 1.6, 1,
                          max(3, int(tl / 8.0)), win=(3.0, 1.9), group="bridge"))
        s.add(window_grid((-tw / 2.0, y + th * 0.62, bz), "-x", tl * 0.62, 1.6, 1,
                          max(3, int(tl / 8.0)), win=(3.0, 1.9), group="bridge"))
        y += th
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
        leg = cylinder(0.7, 19.0, axis="y", center=(0.0, 9.5, 0.0), segments=6,
                       radius2=0.45, mat="hull_grey", group="bridge", smooth=True)
        leg.rotate_x(0.0)
        leg.translate((mx * 0.35, mast_y, bz - 1.0 + (0.0 if mx else 0.0)))
        s.add(leg)
    s.add(box(12.0, 0.9, 0.9, center=(0.0, mast_y + 19.0, bz - 1.0), mat="gun_metal",
              group="bridge"))
    s.add(cylinder(2.6, 0.8, axis="y", center=(0.0, mast_y + 13.0, bz - 1.0),
                   segments=10, mat="deck_dark", group="bridge"))
    for gz in (-4.0, 4.0):
        s.add(box(7.0, 3.0, 0.8, center=(0.0, mast_y + 16.0, bz - 1.0 + gz),
                  mat="gun_metal", group="bridge"))   # radar arrays
    s.add_at(mast(9.0, 0.9, segments=6, arms=2, dish_r=3.6), (0.0, mast_y + 19.0, bz - 1.0))

    # ---- angled funnel abaft the bridge ----------------------------------
    for i, (st, fr, fl) in enumerate(((0.395, 7.0, 22.0), (0.445, 5.0, 15.0))):
        fz = S(st)
        fy = dy(fz)
        fun = cylinder(fr, fl, axis="y", center=(0.0, 0.0, 0.0), segments=16,
                       radius2=fr * 0.86, mat="hull_grey", group="superstructure",
                       smooth=True)
        fun.rotate_x(-0.22)                      # raked aft like the 2199 funnel
        fun.translate((0.0, fy + fl / 2.0 - 1.0, fz))
        s.add(fun)
        cap = ring(fr * 0.80, fr * 1.10, 1.6, axis="y",
                   center=(0.0, fy + fl - 1.0, fz + 0.22 * fl), segments=16,
                   mat="deck_dark", group="superstructure")
        s.add(cap)
        for k in range(3):
            s.add(box(fr * 1.5, 0.6, 1.2,
                      center=(0.0, fy + fl - 2.2 - k * 1.1, fz + 0.22 * fl),
                      mat="hull_black", group="superstructure"))
        s.add(frustum_box(16.0, 4.0, 18.0, center=(0.0, fy + 2.0, fz),
                          scale_top=(0.85, 0.9), mat="hull_grey",
                          group="superstructure"))

    # ---- aft deckhouse + catapult deck -----------------------------------
    s.add(frustum_box(24.0, 6.0, 30.0, center=(0.0, dy(S(0.905)) + 3.0, S(0.905)),
                      scale_top=(0.88, 0.90), mat="hull_grey", group="superstructure"))
    for gx in (-4.0, 4.0):
        s.add(box(1.6, 0.5, 30.0, center=(gx, dy(S(0.90)) + 0.9, S(0.90)),
                  mat="accent_gold", group="hull"))   # catapult rails

    # ---- shaped stern: overhanging transom, nozzles recessed --------------
    s.add(frustum_box(40.0, 24.0, 16.0, center=(0.0, 0.0, S(0.960)),
                      scale_top=(0.86, 0.94), top_offset=(0.0, 3.0),
                      mat="hull_grey", group="engine_nozzle"))
    s.add(frustum_box(30.0, 14.0, 8.0, center=(0.0, 0.0, S(0.975)),
                      scale_top=(0.7, 0.8), mat="deck_dark", group="engine_nozzle"))
    engine_cluster(s, [(-9.6, 0.0), (9.6, 0.0)], 11.6, 20.0, L / 2.0,
                   names=("engine_1", "engine_2"), segments=22, bell_mat="hull_grey")
    for (vx, vy) in ((-18.5, 7.0), (18.5, 7.0), (-18.5, -7.0), (18.5, -7.0)):
        s.add(nozzle(3.6, 11.0, center=(vx, vy, L / 2.0 - 11.0), segments=12,
                     fins=0, bell_mat="deck_dark", trim=8, vanes=0,
                     actuator=False, throat=False))

    # ---- wings: bridge side platforms + stern stabilisers ----------------
    s.add_pair_at(swept_fin(14.0, 1.6, 12.0, sweep=0.45, rise=2.2, mat="hull_grey",
                            group="wing"), (6.5, base + 26.0, bz + 6.0))
    s.add_pair_at(swept_fin(9.0, 1.2, 8.0, sweep=0.35, rise=1.0, mat="hull_grey",
                            group="wing"), (12.0, 4.0, S(0.925)))

    # ---- radiators -------------------------------------------------------
    s.add_pair_at(box(0.9, 12.0, 36.0, center=(0.0, 3.0, 0.0), mat="deck_dark",
                      group="radiator"), (hx_at(secs, S(0.83), 2.0) * 0.94, 0.0,
                                          S(0.83)))


def build_andromeda(s):
    """Andromeda-class vanguard battleship (AAA-1).

    Same UNCF language as Yamato but longer, sleeker and squarer: raked bow with
    TWIN wave-motion-gun muzzles, two superfiring triple turrets forward and two
    aft, a blocky citadel ringed by shock-field emitters, 1 large + 4 medium
    Kelvin nozzles.
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

    # ---- broad raked bow carrying twin WM muzzles ------------------------
    s.add(frustum_box(50.0, 26.0, 34.0, center=(0.0, 1.0, S(0.06)),
                      scale_top=(0.62, 0.72), top_offset=(0.0, 6.0),
                      mat="hull_grey", group="hull"))
    for i, mx in enumerate((-13.0, 13.0)):
        s.add(bow_gun(10.5, 38.0, -L / 2.0, y=1.4, segments=26, collar=12.4,
                      housing_mat="hull_grey", collar_mat="gun_metal"))
        for p in s.parts[-4:]:
            p.translate((mx, 0.0, 0.0))
        s.hp("wave_motion_gun" if i == 0 else "wave_motion_gun_2", "wmgun",
             (mx, 1.4, S(0.05)), (0.0, 0.0, -1.0))
    s.add(frustum_box(9.0, 20.0, 30.0, center=(0.0, 1.0, S(0.035)),
                      scale_top=(0.5, 0.7), mat="hull_grey", group="hull"))

    # ---- superfiring forward pair + raised aft pair ----------------------
    for i, (st, raise_) in enumerate(((0.135, 0.0), (0.275, 9.5))):
        zz = S(st)
        d = dy(zz) + raise_
        if raise_:
            s.add(frustum_box(46.0, raise_, 48.0, center=(0.0, dy(zz) + raise_ / 2.0, zz),
                              scale_top=(0.9, 0.93), mat="hull_grey",
                              group="superstructure"))
        mount_turret(s, "turret_main_%d" % (i + 1), "turret_main", d, zz,
                     11.0, 4.2, (28.0, 10.0, 30.0), 3, 2.4, 24.0, elev=0.05)
    for i, (st, raise_) in enumerate(((0.720, 6.0), (0.860, 0.0))):
        zz = S(st)
        d = dy(zz) + raise_
        if raise_:
            s.add(frustum_box(42.0, raise_, 44.0, center=(0.0, dy(zz) + raise_ / 2.0, zz),
                              scale_top=(0.9, 0.93), mat="hull_grey",
                              group="superstructure"))
        mount_turret(s, "turret_main_%d" % (i + 3), "turret_main", d, zz,
                     11.0, 4.2, (28.0, 10.0, 30.0), 3, 2.4, 24.0, aft=True, elev=0.05)

    # ---- blocky citadel with shock-field emitters ------------------------
    bz = S(0.320)
    base = dy(bz)
    y = base
    for (tw, th, tl) in ((40.0, 12.0, 34.0), (30.0, 9.0, 26.0), (20.0, 7.0, 17.0)):
        s.add(frustum_box(tw, th, tl, center=(0.0, y + th / 2.0, bz),
                          scale_top=(0.92, 0.94), mat="hull_grey", group="bridge"))
        s.add(box(tw + 4.0, 1.4, tl + 4.0, center=(0.0, y + 0.7, bz),
                  mat="deck_dark", group="bridge"))
        s.add(window_grid((0.0, y + th * 0.62, bz - tl / 2.0), "-z", tw * 0.7, 1.8,
                          1, max(3, int(tw / 9.0)), win=(3.4, 2.2), group="bridge"))
        s.add(window_grid((tw / 2.0, y + th * 0.62, bz), "x", tl * 0.64, 1.8, 1,
                          max(3, int(tl / 12.0)), win=(3.4, 2.2), group="bridge"))
        s.add(window_grid((-tw / 2.0, y + th * 0.62, bz), "-x", tl * 0.64, 1.8, 1,
                          max(3, int(tl / 12.0)), win=(3.4, 2.2), group="bridge"))
        y += th
    s.add(frustum_box(12.0, 4.5, 13.0, center=(0.0, y + 2.25, bz - 1.0),
                      scale_top=(0.75, 0.8), mat="hull_grey", group="bridge"))
    s.add_at(mast(16.0, 1.2, segments=6, arms=2, dish_r=5.0), (0.0, y + 4.0, bz - 1.0))
    for k in range(3):
        ang = math.pi * 2.0 * k / 3.0 + math.pi / 6.0
        em = [ring(1.8, 3.0, 1.6, axis="y", center=(0.0, 1.4, 0.0), segments=12,
                   mat="gun_metal", group="bridge"),
              cylinder(1.7, 6.0, axis="y", center=(0.0, 3.4, 0.0), segments=12,
                       mat="deck_dark", group="bridge")]
        s.add_at(em, (17.0 * math.cos(ang), base + 2.0, bz + 17.0 * math.sin(ang)))

    # ---- six-barrel lateral beam projectors ------------------------------
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
    # wing secondaries + sponson AA
    for i, st in enumerate((0.400, 0.680)):
        zz = S(st)
        x = hx_at(secs, zz, dy(zz) - 1.0) * 0.78
        for sgn in (1.0, -1.0):
            s.add(box(12.0, 3.2, 16.0, center=(sgn * x, dy(zz) - 1.6, zz),
                      mat="hull_grey", group="superstructure"))
            mount_turret(s, "turret_secondary_%d" % (2 * i + (1 if sgn > 0 else 2)),
                         "turret_secondary", dy(zz) + 0.2, zz, 5.0, 3.0,
                         (11.0, 5.0, 12.0), 2, 1.1, 13.0, x=sgn * x, elev=0.10)
    for i, (st, sgn) in enumerate(((0.200, 1.0), (0.200, -1.0), (0.520, 1.0),
                                   (0.520, -1.0), (0.820, 1.0), (0.820, -1.0))):
        zz = S(st)
        x = hx_at(secs, zz, dy(zz) - 0.5) * 0.88
        s.add(box(6.5, 2.0, 7.5, center=(sgn * x, dy(zz) - 1.0, zz), mat="hull_grey",
                  group="superstructure"))
        mount_aa(s, "ciws_%d" % (i + 1), dy(zz) + 0.1, zz, sgn * x, scale=1.05)

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
    engine_cluster(s, [(-10.0, 9.0), (10.0, 9.0), (-10.0, -9.0), (10.0, -9.0)],
                   9.6, 18.0, L / 2.0,
                   names=("engine_2", "engine_3", "engine_4", "engine_5"),
                   segments=12, bell_mat="deck_dark")
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

    A protruding fixed bow cannon (not a hole in the bow), a squat aft-shifted
    bridge, superfiring forward turrets, four triple mounts, missile-cell blocks
    and three clustered bells.
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

    # ---- protruding fixed bow cannon -------------------------------------
    s.add(frustum_box(16.0, 16.0, 20.0, center=(0.0, 0.6, S(0.075)),
                      scale_top=(0.7, 0.8), top_offset=(0.0, 3.0),
                      mat="hull_grey", group="hull"))
    s.add(cylinder(4.6, 30.0, axis="z", center=(0.0, 1.0, -L / 2.0 + 15.0),
                   segments=18, radius2=4.0, mat="gun_metal",
                   group="wave_motion_gun", smooth=True))
    s.add(ring(4.0, 6.4, 3.0, axis="z", center=(0.0, 1.0, -L / 2.0 + 1.6),
               segments=18, mat="gun_metal", group="wave_motion_gun"))
    s.hp("wave_motion_gun", "wmgun", (0.0, 1.0, -L / 2.0 + 8.0), (0.0, 0.0, -1.0))

    # ---- superfiring forward pair + two aft ------------------------------
    for i, (st, raise_) in enumerate(((0.180, 0.0), (0.300, 6.0))):
        zz = S(st)
        d = dy(zz) + raise_
        if raise_:
            s.add(frustum_box(26.0, raise_, 26.0, center=(0.0, dy(zz) + raise_ / 2.0, zz),
                              scale_top=(0.9, 0.93), mat="hull_grey",
                              group="superstructure"))
        mount_turret(s, "turret_main_%d" % (i + 1), "turret_main", d, zz,
                     6.4, 3.0, (17.0, 6.6, 18.0), 3, 1.4, 15.0, elev=0.06)
    for i, (st, raise_) in enumerate(((0.680, 4.0), (0.830, 0.0))):
        zz = S(st)
        d = dy(zz) + raise_
        if raise_:
            s.add(frustum_box(24.0, raise_, 24.0, center=(0.0, dy(zz) + raise_ / 2.0, zz),
                              scale_top=(0.9, 0.93), mat="hull_grey",
                              group="superstructure"))
        mount_turret(s, "turret_main_%d" % (i + 3), "turret_main", d, zz,
                     6.4, 3.0, (17.0, 6.6, 18.0), 3, 1.4, 15.0, aft=True, elev=0.06)

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
    for sgn in (1.0, -1.0):
        zz = S(0.450)
        x = hx_at(secs, zz, dy(zz) - 1.0) * 0.88
        s.add(box(3.4, 5.0, 18.0, center=(sgn * x, dy(zz) - 2.0, zz), mat="hull_grey",
                  group="superstructure"))
        for k in range(4):
            s.add(box(1.3, 1.8, 2.6, center=(sgn * (x + 1.1), dy(zz) - 1.2,
                                             zz - 6.0 + k * 4.0),
                      mat="deck_dark", group="superstructure"))
    for i, st in enumerate((0.420, 0.640)):
        zz = S(st)
        x = hx_at(secs, zz, dy(zz) - 1.0) * 0.80
        for sgn in (1.0, -1.0):
            s.add(box(8.0, 2.4, 11.0, center=(sgn * x, dy(zz) - 1.2, zz),
                      mat="hull_grey", group="superstructure"))
            mount_turret(s, "turret_secondary_%d" % (2 * i + (1 if sgn > 0 else 2)),
                         "turret_secondary", dy(zz) + 0.2, zz, 3.2, 2.0,
                         (7.0, 3.4, 8.0), 2, 0.75, 9.0, x=sgn * x, elev=0.10)
    for i, (st, sgn) in enumerate(((0.240, 1.0), (0.240, -1.0), (0.560, 1.0),
                                   (0.560, -1.0), (0.880, 1.0), (0.880, -1.0))):
        zz = S(st)
        x = hx_at(secs, zz, dy(zz) - 0.5) * 0.88
        s.add(box(5.0, 1.6, 6.0, center=(sgn * x, dy(zz) - 0.8, zz), mat="hull_grey",
                  group="superstructure"))
        mount_aa(s, "ciws_%d" % (i + 1), dy(zz) + 0.1, zz, sgn * x, scale=0.85)
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

    Identity: the bow armour wing plate with six triangular fins, a low faired
    canopy, tail stabilisers above and below, ventral drop tanks, a mirrored
    belly turret, and yellow / red / white paint (research section 1.4).
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
    # blunt nose carrying the fixed guns + a small emitter ring
    s.add(frustum_box(9.0, 8.0, 8.0, center=(0.0, 0.0, S(0.050)),
                      scale_top=(0.6, 0.7), mat="hull_white", group="hull"))
    for ox in (-2.0, 2.0):
        s.add(cylinder(0.8, 8.0, axis="z", center=(ox, 5.0, S(0.055)), segments=8,
                       mat="gun_metal", group="wave_motion_gun", smooth=True))
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
    mount_turret(s, "turret_main_1", "turret_main", dy(S(0.52)), S(0.52),
                 3.0, 2.0, (7.4, 3.2, 8.0), 3, 0.6, 9.0, elev=0.08)
    mount_turret(s, "turret_main_2", "turret_main", dy(S(0.34)), S(0.34),
                 3.0, 2.0, (7.4, 3.2, 8.0), 3, 0.6, 9.0, aft=True, elev=0.08)
    for i, (st, sgn) in enumerate(((0.600, 1.0), (0.600, -1.0))):
        mount_turret(s, "turret_secondary_%d" % (i + 1), "turret_secondary",
                     dy(S(st)), S(st), 1.6, 1.2, (3.6, 1.8, 4.2), 2, 0.35, 5.0,
                     x=sgn * 7.0, elev=0.12)
    for i, (st, sgn) in enumerate(((0.280, 1.0), (0.280, -1.0))):
        mount_aa(s, "ciws_%d" % (i + 1), dy(S(st)), S(st), sgn * 8.4, scale=0.5)
    s.add_pair_at(swept_fin(6.0, 1.0, 7.0, sweep=0.4, rise=1.0, mat="hull_red",
                            group="wing"), (3.6, 0.0, S(0.82)))
    for (ox, oy) in ((-9.0, 1.6), (9.0, 1.6), (-9.0, -1.6), (9.0, -1.6)):
        s.add(frustum_box(0.9, 3.4, 4.0, center=(ox, oy, S(0.82)),
                          scale_top=(1.0, 0.5), mat="hull_red", group="wing"))
    for st in (0.30, 0.55):
        s.add(cylinder(2.0, 0.12 * L, axis="z", center=(0.0, -10.4, S(st)),
                       segments=12, radius2=1.5, mat="accent_gold", group="hull",
                       smooth=True))
    engine_cluster(s, [(0.0, 0.0)], 3.8, 8.0, L / 2.0, names=("engine_1",),
                   segments=14, bell_mat="accent_gold")
    for i, (vx, vy, vz) in enumerate(((-9.4, 0.0, S(0.24)), (9.4, 0.0, S(0.24)),
                                      (0.0, -8.6, S(0.40)))):
        s.add(nozzle(1.8, 5.0, center=(vx, vy, vz - 2.5), segments=10, fins=0,
                     bell_mat="deck_dark", trim=8, vanes=0, actuator=False,
                     throat=False))
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
    # domed dorsal + ventral rows
    for i, (st, sgn) in enumerate(((0.200, 1.0), (0.200, -1.0), (0.450, 1.0),
                                   (0.450, -1.0), (0.700, 1.0), (0.700, -1.0))):
        mount_garm_turret(s, "turret_main_%d" % (i + 1), deck, S(st), 11.0, 6.0,
                          1.8, 20.0, x=sgn * 0.22 * B, body_mat="gun_metal",
                          dome_mat="hull_olive")
    for i, (st, sgn) in enumerate(((0.300, 1.0), (0.300, -1.0), (0.600, 1.0),
                                   (0.600, -1.0))):
        mount_garm_turret(s, "turret_secondary_%d" % (i + 1), deck, S(st), 9.0, 5.0,
                          1.5, 16.0, x=sgn * 0.44 * B, ventral=True,
                          body_mat="gun_metal", dome_mat="hull_green",
                          group="turret_secondary")
    for i, (st, sgn) in enumerate(((0.150, 1.0), (0.150, -1.0), (0.800, 1.0),
                                   (0.800, -1.0))):
        mount_aa(s, "ciws_%d" % (i + 1), deck, S(st), sgn * 0.36 * B, scale=1.4)
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
    for i, st in enumerate((0.35, 0.65)):
        mount_garm_turret(s, "turret_secondary_%d" % (i + 1), deck, S(st), 6.4, 3.6,
                          1.0, 11.0, ventral=True, body_mat="gun_metal",
                          dome_mat="hull_green", group="turret_secondary")
    for i, (st, sgn) in enumerate(((0.42, 1.0), (0.42, -1.0), (0.62, 1.0),
                                   (0.62, -1.0))):
        mount_aa(s, "ciws_%d" % (i + 1), deck, S(st), sgn * 0.36 * B, scale=1.0)
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
    for st in (0.07, 0.10, 0.13, 0.16):
        zz = S(st)
        x = hx_at(secs, zz, 2.0) * 0.94
        for sgn in (1.0, -1.0):
            s.add(box(2.0, 2.0, 2.6, center=(sgn * x, 2.0, zz), mat="deck_dark",
                      group="hull"))
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
    for k in range(10):
        ang = 2.0 * math.pi * k / 10.0
        cw = [cylinder(1.5, 2.6, axis="y", center=(0.0, 1.3, 0.0), segments=8,
                       mat="gun_metal", group="superstructure"),
              cylinder(0.5, 3.0, axis="z", center=(0.0, 3.0, -1.4), segments=6,
                       mat="gun_metal", group="superstructure", caps=False)]
        s.add_at(cw, (16.0 * math.cos(ang), deck, cz + 20.0 * math.sin(ang)))
    s.add(frustum_box(3.4, 0.09 * L, 0.34 * L, center=(0.0, deck + 0.045 * L, S(0.60)),
                      scale_top=(0.45, 0.5), top_offset=(0.0, 0.06 * L),
                      mat="hull_olive", group="wing"))
    for i, st in enumerate((0.18, 0.35, 0.58, 0.78)):
        mount_garm_turret(s, "turret_main_%d" % (i + 1), deck, S(st), 8.4, 4.8,
                          1.4, 15.0, body_mat="gun_metal", dome_mat="hull_olive")
    for i, st in enumerate((0.25, 0.50, 0.72)):
        mount_garm_turret(s, "turret_secondary_%d" % (i + 1), deck, S(st), 7.0, 4.0,
                          1.1, 12.0, ventral=True, body_mat="gun_metal",
                          dome_mat="hull_green", group="turret_secondary")
    for i, (st, sgn) in enumerate(((0.30, 1.0), (0.30, -1.0), (0.68, 1.0),
                                   (0.68, -1.0))):
        mount_aa(s, "ciws_%d" % (i + 1), deck, S(st), sgn * 0.40 * B, scale=1.1)
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
    for sgn in (1.0, -1.0):
        for st in (0.18, 0.30, 0.44, 0.58, 0.70, 0.82):
            zz = S(st)
            x = hx_at(secs, zz, 8.0) * 0.96
            s.add(box(2.6, 2.4, 5.0, center=(sgn * x, 8.0, zz), mat="gun_metal",
                      group="superstructure"))
            if st == 0.18:
                s.hp("turret_secondary_%d" % (1 if sgn > 0 else 2), "turret",
                     (sgn * x, 9.2, zz), (0.0, 0.0, -1.0))
        for st in (0.48, 0.56, 0.64, 0.72):
            zz = S(st)
            x = hx_at(secs, zz, -4.0) * 0.97
            s.add(box(2.4, 2.4, 3.0, center=(sgn * x, -4.0, zz), mat="hull_black",
                      group="hull"))
        for st in (0.30, 0.46, 0.62, 0.78):
            zz = S(st)
            x = hx_at(secs, zz, -2.0)
            s.add(box(3.0, 9.0, 0.045 * L, center=(sgn * (x - 1.2), -2.0, zz),
                      mat="hull_black", group="hull"))
            s.add(box(1.0, 6.0, 0.038 * L, center=(sgn * (x - 2.2), -2.0, zz),
                      mat="engine_glow", group="hull"))
    for i, (st, sgn) in enumerate(((0.24, 1.0), (0.24, -1.0), (0.66, 1.0),
                                   (0.66, -1.0))):
        mount_aa(s, "ciws_%d" % (i + 1), deck, S(st), sgn * 0.40 * B, scale=1.2)
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
    """
    frame_rings(s, secs, [S(t) for t in (0.12, 0.22, 0.32, 0.44, 0.55, 0.68,
                                         0.82)], 1.6, "deck_dark")
    strake_lines(s, secs, [deck - 5.5, deck - 9.0], 0.8, 1.5, "deck_dark")
    armour_belt(s, secs, S(0.30), S(0.62), -12.0, -8.4, "hull_black", ribs=True,
                rib_mat="deck_dark", out_scale=1.016)
    window_row(s, secs, deck - 4.2, S(0.12), S(0.92), 18, win=(2.8, 1.9))
    window_row(s, secs, deck - 1.8, S(0.52), S(0.90), 8, win=(2.8, 1.9))
    s.add(window_grid((17.0, deck + 4.0, S(0.40)), "x", 60.0, 2.6, 1, 8,
                      win=(3.0, 2.0), group="superstructure"))
    s.add(window_grid((-17.0, deck + 4.0, S(0.40)), "-x", 60.0, 2.6, 1, 8,
                      win=(3.0, 2.0), group="superstructure"))
    s.add(window_grid((16.0, deck + 3.0, S(0.90)), "x", 22.0, 2.2, 1, 4,
                      win=(3.0, 2.0), group="superstructure"))
    s.add(window_grid((-16.0, deck + 3.0, S(0.90)), "-x", 22.0, 2.2, 1, 4,
                      win=(3.0, 2.0), group="superstructure"))
    hatch_row(s, S(0.44), S(0.78), 8, deck + 0.6, size=(3.6, 0.7, 4.6))
    lifeboat_rack(s, secs, deck - 4.0, S(0.48), S(0.72), 3)
    deck_crane(s, (0.0, deck + 0.5, S(0.86)), 10.0)
    sensor_dome(s, 3.2, (0.0, deck + 0.4, S(0.825)))
    cable_run(s, secs, deck - 2.4, S(0.18), S(0.86), count=1)
    light_points(s, [(0.0, deck + 1.2, S(0.075)), (0.0, deck + 1.2, S(0.955)),
                     (12.0, deck + 1.2, S(0.60)), (-12.0, deck + 1.2, S(0.60))],
                 radius=1.8)


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
