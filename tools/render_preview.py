#!/usr/bin/env python3
"""
tools/render_preview.py — offline orthographic preview of the generated ships.

WHY THIS EXISTS
    Inspecting a hull in the browser needs a visible, focused tab (rAF is
    suspended while the page is hidden), and "does the silhouette read?" is
    exactly the question that blocks a modelling change. This renders the OBJ
    directly to a PNG with a tiny numpy z-buffer rasteriser, so a model can be
    reviewed deterministically with no browser, no GPU and no 3D library.

    It is a REVIEW tool, not part of the shipped game — the game never calls it.

USAGE
    python3 tools/render_preview.py assets/models/yamato.obj --out /tmp/yamato.png
    python3 tools/render_preview.py assets/models --all --out /tmp/fleet.png

    Views rendered side by side: SIDE (profile), TOP (plan), BOW (front).
    The bow is toward -Z, up is +Y, so on the SIDE view the bow is on the RIGHT.

Requires numpy + Pillow (both present in the bundled DSH python runtime).
"""

import argparse
import json
import re
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

# --------------------------------------------------------------------------
# OBJ / MTL loading
# --------------------------------------------------------------------------


def load_mtl(path):
    """name -> (r,g,b) 0..1"""
    out = {}
    cur = None
    if not os.path.exists(path):
        return out
    for raw in open(path, "r", encoding="utf-8", errors="replace"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if parts[0] == "newmtl":
            cur = " ".join(parts[1:])
            out[cur] = (0.5, 0.5, 0.5)
        elif parts[0] == "Kd" and cur:
            try:
                out[cur] = tuple(min(1.0, max(0.0, float(x))) for x in parts[1:4])
            except (ValueError, IndexError):
                pass
    return out


#: Indexed mount groups are authored centred on their own pivot (SPEC 5 rule 3),
#: so an as-authored preview shows them stacked at the origin.  --place offsets
#: each one to its manifest hardpoint, which is what the real renderer does with
#: mesh.position = hardpoint.pos.
INDEXED_RE = re.compile(r"^(turret_main|turret_secondary|ciws|missile_launcher|"
                        r"torpedo_tube)_\d+$")


def load_pivots(obj_path):
    """{group: (x, y, z)} for indexed mount groups, from the sibling manifest."""
    man_path = os.path.join(os.path.dirname(obj_path) or ".", "manifest.json")
    if not os.path.exists(man_path):
        return {}
    mid = os.path.basename(obj_path)[:-4]
    try:
        man = json.load(open(man_path, encoding="utf-8"))
    except (ValueError, OSError):
        return {}
    for m in man.get("models", []):
        if m.get("id") == mid:
            return {h["name"]: tuple(h["pos"]) for h in m.get("hardpoints", [])
                    if INDEXED_RE.match(h["name"])}
    return {}


def place_mounts(V, T, tri_grp, pivots):
    """Offset each indexed group's vertices onto its pivot.  Returns (V, count)."""
    if not pivots:
        return V, 0
    vg = {}
    for ti, g in enumerate(tri_grp):
        if g in pivots:
            for vi in T[ti]:
                vg[int(vi)] = g
    for vi, g in vg.items():
        px, py, pz = pivots[g]
        V[vi][0] += px
        V[vi][1] += py
        V[vi][2] += pz
    return V, len(set(vg.values()))


def load_obj(path):
    """Returns (verts Nx3 float64, tris Mx3 int, tri_material list[str], tri_group list[str])."""
    verts = []
    tris = []
    tri_mat = []
    tri_grp = []
    cur_g = "default"
    cur_m = "default"
    for raw in open(path, "r", encoding="utf-8", errors="replace"):
        if not raw:
            continue
        tag = raw[:2]
        if tag == "v ":
            p = raw.split()
            verts.append((float(p[1]), float(p[2]), float(p[3])))
        elif tag == "g ":
            cur_g = raw[2:].strip() or "default"
        elif raw.startswith("usemtl"):
            cur_m = raw.split(None, 1)[1].strip() if len(raw.split()) > 1 else "default"
        elif tag == "f ":
            idx = []
            for tok in raw.split()[1:]:
                idx.append(int(tok.split("/")[0]) - 1)
            for i in range(1, len(idx) - 1):
                tris.append((idx[0], idx[i], idx[i + 1]))
                tri_mat.append(cur_m)
                tri_grp.append(cur_g)
    V = np.asarray(verts, dtype=np.float64)
    T = np.asarray(tris, dtype=np.int32)
    return V, T, tri_mat, tri_grp


# --------------------------------------------------------------------------
# Rasteriser
# --------------------------------------------------------------------------


def shade(normals, light, ambient=0.30, key=0.95):
    """Lambert + ambient, plus a rim term so silhouettes stay readable."""
    ndl = np.clip(normals @ light, 0.0, 1.0)
    return np.clip(ambient + key * ndl, 0.0, 1.35)


def render_view(V, T, cols, res_h, res_v, res_d, flip_h, flip_v, bg=(0.03, 0.035, 0.05),
                light=(0.42, 0.78, 0.46)):
    """
    Orthographic render.
    res_h/res_v/res_d index into the xyz columns (0=x, 1=y, 2=z).
    flip_h/flip_v mirror the axes onto screen space.
    """
    W = res_h and 0  # placeholder to keep linters quiet
    P = V.copy()
    h = P[:, res_h] * (-1.0 if flip_h else 1.0)
    v = P[:, res_v] * (-1.0 if flip_v else 1.0)
    d = P[:, res_d]

    hmin, hmax = float(h.min()), float(h.max())
    vmin, vmax = float(v.min()), float(v.max())
    pad = 0.04 * max(hmax - hmin, vmax - vmin, 1.0)
    hmin -= pad; hmax += pad; vmin -= pad; vmax += pad

    span_h = max(hmax - hmin, 1e-6)
    span_v = max(vmax - vmin, 1e-6)
    aspect = span_h / span_v
    H = int(W_TARGET_H)
    Wpx = int(round(H * aspect))
    Wpx = max(64, min(Wpx, W_TARGET_MAX))
    H = int(round(Wpx / aspect))

    sx = (Wpx - 1) / span_h
    sy = (H - 1) / span_v

    px = (h - hmin) * sx
    py = (v - vmin) * sy

    # Face normals in world space (for lighting), independent of the view.
    a = V[T[:, 0]]; b = V[T[:, 1]]; c = V[T[:, 2]]
    n = np.cross(b - a, c - a)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    ln[ln < 1e-12] = 1.0
    n = n / ln
    # Two-sided lighting: a flat plate must not go black from behind.
    L = np.asarray(light, dtype=np.float64)
    L = L / np.linalg.norm(L)
    s = shade(n, L)
    s2 = shade(-n, L)
    s = np.maximum(s, s2 * 0.72)

    zbuf = np.full((H, Wpx), -1e30, dtype=np.float64)
    img = np.zeros((H, Wpx, 3), dtype=np.float64)
    img[:, :] = bg

    for i in range(T.shape[0]):
        x0, y0 = px[T[i, 0]], py[T[i, 0]]
        x1, y1 = px[T[i, 1]], py[T[i, 1]]
        x2, y2 = px[T[i, 2]], py[T[i, 2]]
        minx = int(math.floor(min(x0, x1, x2))); maxx = int(math.ceil(max(x0, x1, x2)))
        miny = int(math.floor(min(y0, y1, y2))); maxy = int(math.ceil(max(y0, y1, y2)))
        if maxx < 0 or miny < 0 or minx >= Wpx or maxy >= H:
            continue
        minx = max(0, minx); maxx = min(Wpx - 1, maxx)
        miny = max(0, miny); maxy = min(H - 1, maxy)

        area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if abs(area) < 1e-9:
            continue

        xs = np.arange(minx, maxx + 1)
        ys = np.arange(miny, maxy + 1)
        gx, gy = np.meshgrid(xs + 0.5, ys + 0.5)

        w0 = ((x1 - x0) * (gy - y0) - (gx - x0) * (y1 - y0)) / area
        w1 = ((gx - x0) * (y2 - y0) - (x2 - x0) * (gy - y0)) / area
        w2 = 1.0 - w0 - w1
        inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not inside.any():
            continue

        z0, z1, z2 = d[T[i, 0]], d[T[i, 1]], d[T[i, 2]]
        depth = w0 * z0 + w1 * z1 + w2 * z2

        sub_z = zbuf[miny:maxy + 1, minx:maxx + 1]
        # Larger res_d = closer to the viewer.
        upd = inside & (depth > sub_z)
        if not upd.any():
            continue
        sub_z[upd] = depth[upd]

        col = np.asarray(cols[i], dtype=np.float64) * s[i]
        sub_img = img[miny:maxy + 1, minx:maxx + 1]
        sub_img[upd] = col

    out = np.clip(img, 0.0, 1.0)
    return Image.fromarray((out * 255.0 + 0.5).astype(np.uint8), "RGB")


# --------------------------------------------------------------------------
# Views
# --------------------------------------------------------------------------

W_TARGET_H = 460
W_TARGET_MAX = 1600


def make_sheet(obj_path, out_path, title=None, dark_groups=(), place=False):
    base = os.path.splitext(obj_path)[0]
    mtl = load_mtl(base + ".mtl")
    V, T, mats, grps = load_obj(obj_path)

    palette = {}
    cols = np.zeros((T.shape[0], 3), dtype=np.float64)
    for i, m in enumerate(mats):
        if m not in palette:
            palette[m] = mtl.get(m, (0.55, 0.58, 0.62))
        cols[i] = palette[m]

    # SIDE: horizontal = -Z (bow right), vertical = +Y (up), depth = +X.
    # flip_v=True so +Y lands at the TOP of the image, not the bottom.
    side = render_view(V, T, cols, 2, 1, 0, flip_h=True, flip_v=True)
    # TOP: looking down; horizontal = -Z (bow right), vertical = -X, depth = +Y.
    top = render_view(V, T, cols, 2, 0, 1, flip_h=True, flip_v=True)
    # STERN: looking forward from +Z; horizontal = +X, vertical = +Y (up).
    stern = render_view(V, T, cols, 0, 1, 2, flip_h=False, flip_v=True)
    bow = stern  # kept for the sheet layout below

    pad = 14
    label_h = 26
    Wtot = side.width + top.width + bow.width + pad * 4
    Htot = max(side.height, top.height, bow.height) + label_h + pad * 2
    sheet = Image.new("RGB", (Wtot, Htot), (10, 12, 16))
    x = pad
    for im, label in ((side, "SIDE (bow -> right, up -> up)"), (top, "TOP (bow -> right)"), (stern, "STERN (looking forward)")):
        sheet.paste(im, (x, pad + label_h))
        d = ImageDraw.Draw(sheet)
        d.text((x + 2, pad + 6), label, fill=(150, 180, 215))
        d.rectangle([x - 1, pad + label_h - 1, x + im.width, pad + label_h + im.height], outline=(40, 52, 70))
        x += im.width + pad

    d = ImageDraw.Draw(sheet)
    t = title or os.path.basename(obj_path)
    d.text((pad, 2), f"{t}   verts={len(V)} tris={T.shape[0]}", fill=(210, 225, 245))

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    sheet.save(out_path)
    return {
        "obj": obj_path, "out": out_path, "verts": int(len(V)), "tris": int(T.shape[0]),
        "groups": sorted(set(grps)), "materials": sorted(set(mats)),
        "extent": {
            "x": [round(float(V[:, 0].min()), 2), round(float(V[:, 0].max()), 2)],
            "y": [round(float(V[:, 1].min()), 2), round(float(V[:, 1].max()), 2)],
            "z": [round(float(V[:, 2].min()), 2), round(float(V[:, 2].max()), 2)],
        },
    }


def main():
    ap = argparse.ArgumentParser(description="Offline orthographic OBJ preview")
    ap.add_argument("path", help="an .obj file, or a directory containing manifest.json")
    ap.add_argument("--out", default="/tmp/yamato-preview.png")
    ap.add_argument("--all", action="store_true", help="render every ship in the manifest")
    ap.add_argument("--json", action="store_true", help="print a JSON summary")
    ap.add_argument("--place", action="store_true",
                    help="offset indexed mount groups onto their manifest pivots "
                         "(as-authored they sit at the origin)")
    args = ap.parse_args()

    results = []
    if os.path.isdir(args.path):
        man = json.load(open(os.path.join(args.path, "manifest.json"), encoding="utf-8"))
        ids = [m["id"] for m in man["models"]] if not args.all else [m["id"] for m in man["models"]]
        for mid in ids:
            obj = os.path.join(args.path, mid + ".obj")
            if not os.path.exists(obj):
                continue
            out = args.out.replace(".png", f"-{mid}.png") if len(ids) > 1 else args.out
            results.append(make_sheet(obj, out, title=mid, place=args.place))
    else:
        results.append(make_sheet(args.path, args.out, place=args.place))

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        for r in results:
            print(f"{os.path.basename(r['obj']):<26} tris={r['tris']:>6}  ->  {r['out']}")
            print(f"    extent  x{r['extent']['x']}  y{r['extent']['y']}  z{r['extent']['z']}")
            print(f"    groups  {' '.join(r['groups'])}")


if __name__ == "__main__":
    main()
