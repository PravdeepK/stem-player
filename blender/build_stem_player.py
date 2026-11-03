# Procedural model of the Stem Player, built from reference photos.
#
#   blender -b -P blender/build_stem_player.py
#
# writes assets/models/stem-player.glb. Everything is generated here, so the
# model can be regenerated or re-tuned by editing the constants below.
#
# The shell is one height field over a single seamless domain: a disc whose
# polar coordinates are (meridian arc length from the top pole, azimuth). A
# constrained Delaunay triangulation of that disc lets every pill edge, grille
# hole and port outline land exactly on mesh edges, which is what keeps those
# details crisp at a low triangle count. Normals are evaluated analytically and
# ambient occlusion is ray-cast into COLOR_0, so no textures are needed.
#
# Axes: Z up (top face), +Y north groove, +X east groove. Origin at mid-height.
# Lengths are millimetres until the mesh is created, then metres.

import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector, kdtree
from mathutils.bvhtree import BVHTree
from mathutils.geometry import delaunay_2d_cdt

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_GLB = os.path.join(REPO, "assets", "models", "stem-player.glb")

# --- shape ---------------------------------------------------------------
RADIUS = 35.0          # 70 mm diameter (Wikipedia)
THICKNESS = 31.8       # fitted to the silhouettes of photos 06 and 07
EQUATOR_Z = 14.6       # height of the widest point above the base
TOP_P = 3.7            # superellipse exponents of the dome ...
TOP_Q = 1.65
BOTTOM_P = 2.3         # ... and of the underside
BOTTOM_Q = 2.3

# --- grooves (plan distances from the centre) ----------------------------
# Each groove is a long soft oval dimple. FCC external photo 2 reads r = 10..29.5
# and about 9.5 mm wide at the visible edge; the slope carries on a little past it.
GROOVE_FROM = 14.65    # ends of the oval's centreline, plan distance from the centre
GROOVE_TO = 24.4
GROOVE_R = 3.0
GROOVE_SOFT = 2.7      # half width of the soft shoulder around GROOVE_R
GROOVE_DEPTH = 1.4
LED_RADII = (12.4, 16.8, 21.2, 25.6)  # Stem_Player.png and the bare shell in FCC photo 4
LED_SIZE = 7.6
ARMS = {"E": 0.0, "N": 90.0, "W": 180.0, "S": 270.0}

# --- centre button -------------------------------------------------------
CENTER_R = 4.7   # 9.8 mm on FCC photo 2, less about 4% for the top sitting nearer the lens
CENTER_GAP = 0.02

# --- edge features -------------------------------------------------------
# Azimuths are counter-clockwise from +X seen from above. Walking the rim that
# way passes Dots, Volume, Load, grille, jack, then USB-C (photos 06/07, and FCC
# internal photo 4 read from the back).
CLUSTER_SHIFT = 7.85    # the Volume pill is pinned to the SE azimuth; set 7.85 for
                       # the position measured from the shell's plunger nubs
BELT_M_OFFSET = -1.4   # pill centreline, measured up the surface from the equator
PILL_H = 3.6           # half height of every pill
PILL_PROUD = 0.38
POCKET_DEPTH = 1.7
POCKET_GAP = 0.02

AZ_VOLUME = -45.0 + CLUSTER_SHIFT
AZ_LOAD = AZ_VOLUME + 35.0
AZ_DOTS = AZ_VOLUME - 42.5
VOLUME_L = 10.75
LOAD_L = 6.8
DOTS_L = 10.9

AZ_GRILLE = 47.0
GRILLE_L = 11.7
GRILLE_H = 4.2
GRILLE_HOLE_R = 1.0
GRILLE_HOLE_DEPTH = 1.5
GRILLE_PITCH = 3.45
GRILLE_ROW = 2.25

AZ_PANEL = 135.0       # outline running from the jack to the USB-C slot
PANEL_L = 12.5
PANEL_H = 3.5
AZ_JACK = 126.5
JACK_R = 2.3
JACK_COLLAR_R = 3.9
JACK_DEPTH = 7.0
AZ_USB = 143.5         # 10.4 mm from the jack on the FCC board, axes parallel
USB_L = 4.3
USB_H = 1.35
USB_DEPTH = 5.0

# --- printed block on the back -------------------------------------------
# Set BACK_TEXT_ENABLED to False to leave the brand and regulatory marks off.
BACK_TEXT_ENABLED = False
BACK_LINES = (
    "YEEZY TECH \u00d7 KANO",
    "MODEL 1016",
    "CE  IC:25240-1016",
    "FCC ID:2ATYD-1016",
    "STEMPLAYER.COM",
)
BACK_FONTS = (
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
)
BACK_TEXT_SIZE = 2.85      # 25 x 15 mm block, FCC external photo 3
BACK_TEXT_PITCH = 3.35
BACK_TEXT_TRACKING = 1.05
BACK_TEXT_RIGHT_AZ = 135.0   # reading direction, seen from underneath
BACK_TEXT_SRGB = (126, 100, 86)

# --- skin ----------------------------------------------------------------
SKIN_SRGB = (205, 168, 142)  # brightest unlit patch of photo 06 is (197, 165, 143)

# --- mesh density --------------------------------------------------------
GRID_TOP = 0.8
GRID_BELOW = 1.7
RING_DS = 0.42
AO_RAYS = 48
AO_RANGE = 9.0


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def smootherstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)


def srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


# --- meridian ------------------------------------------------------------
def build_meridian():
    """Top pole to bottom pole: arc length M against plan radius and height."""
    t = np.linspace(0.0, math.pi / 2, 6000)
    top_r = RADIUS * np.sin(t) ** (2 / TOP_P)
    top_z = (THICKNESS - EQUATOR_Z) * np.cos(t) ** (2 / TOP_Q)
    bot_r = RADIUS * np.sin(t[::-1]) ** (2 / BOTTOM_P)
    bot_z = -EQUATOR_Z * np.cos(t[::-1]) ** (2 / BOTTOM_Q)
    r = np.concatenate([top_r, bot_r[1:]])
    z = np.concatenate([top_z, bot_z[1:]]) + EQUATOR_Z - THICKNESS / 2

    seg = np.hypot(np.diff(r), np.diff(z))
    keep = np.concatenate([[True], seg > 1e-9])
    r, z = r[keep], z[keep]
    m = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(r), np.diff(z)))])

    # Uniform resample, then a light blur to hide the curvature step at the
    # equator where the two superellipses meet.
    grid = np.linspace(0.0, m[-1], 4000)
    r, z = np.interp(grid, m, r), np.interp(grid, m, z)
    kernel = np.exp(-0.5 * (np.arange(-60, 61) / 26.0) ** 2)
    kernel /= kernel.sum()
    pad = 120
    r_blur = np.convolve(np.pad(r, pad, mode="reflect", reflect_type="odd"), kernel, "same")[pad:-pad]
    z_blur = np.convolve(np.pad(z, pad, mode="edge"), kernel, "same")[pad:-pad]
    r_blur = np.clip(r_blur, 0.0, None)
    r_blur[0], r_blur[-1] = 0.0, 0.0

    dr, dz = np.gradient(r_blur, grid), np.gradient(z_blur, grid)
    length = np.hypot(dr, dz)
    # Walking from the top pole, the outward normal is the tangent turned 90 deg.
    nr, nz = -dz / length, dr / length
    return grid, r_blur, z_blur, nr, nz


M, MR, MZ, MNR, MNZ = build_meridian()
M_MAX = M[-1]
M_EQUATOR = M[int(np.argmax(MR))]
M_TOP_END = int(np.argmax(MR)) + 1
M_BELT = M_EQUATOR + BELT_M_OFFSET
R_BELT = float(np.interp(M_BELT, M, MR))


def base_surface(m, th):
    r = np.interp(m, M, MR)
    z = np.interp(m, M, MZ)
    nr = np.interp(m, M, MNR)
    nz = np.interp(m, M, MNZ)
    c, s = np.cos(th), np.sin(th)
    return np.stack([r * c, r * s, z], -1), np.stack([nr * c, nr * s, nz], -1)


def plan_to_m(r):
    return np.interp(r, MR[:M_TOP_END], M[:M_TOP_END])


# --- edge feature coordinates --------------------------------------------
def sd_stadium(u, v, half_len, half_h):
    return np.hypot(np.maximum(np.abs(u) - (half_len - half_h), 0.0), v) - half_h


def belt_uv(m, th, az_deg):
    d = (th - math.radians(az_deg) + math.pi) % (2 * math.pi) - math.pi
    return d * R_BELT, m - M_BELT


def belt_to_domain(u, v, az_deg):
    th = math.radians(az_deg) + u / R_BELT
    m = M_BELT + v
    return m * math.cos(th), m * math.sin(th)


def stadium_outline(half_len, half_h, offset, ds=RING_DS):
    """Closed outline at a signed offset. Sample counts ignore the offset, so
    neighbouring levels stay in step and the rings stitch without slivers."""
    straight = half_len - half_h
    n_line = max(2, int(2 * straight / ds))
    n_arc = max(10, int(math.pi * half_h / ds))
    rad = half_h + offset
    pts = []
    for i in range(n_line):
        pts.append((-straight + 2 * straight * i / n_line, -rad))
    for i in range(n_arc):
        a = -math.pi / 2 + math.pi * i / n_arc
        pts.append((straight + rad * math.cos(a), rad * math.sin(a)))
    for i in range(n_line):
        pts.append((straight - 2 * straight * i / n_line, rad))
    for i in range(n_arc):
        a = math.pi / 2 + math.pi * i / n_arc
        pts.append((-straight + rad * math.cos(a), rad * math.sin(a)))
    return pts


def circle_outline(cx, cy, rad, count):
    return [(cx + rad * math.cos(2 * math.pi * i / count),
             cy + rad * math.sin(2 * math.pi * i / count)) for i in range(count)]


def grille_holes():
    holes = []
    for v, count in ((-GRILLE_ROW, 5), (0.0, 6), (GRILLE_ROW, 5)):
        for i in range(count):
            holes.append(((i - (count - 1) / 2) * GRILLE_PITCH, v))
    return holes


GRILLE_HOLES = grille_holes()
JACK_U = (AZ_JACK - AZ_PANEL) / 180 * math.pi * R_BELT
USB_U = (AZ_USB - AZ_PANEL) / 180 * math.pi * R_BELT
PILLS = ((AZ_VOLUME, VOLUME_L), (AZ_LOAD, LOAD_L), (AZ_DOTS, DOTS_L))


def body_height(X, Y):
    """Offset from the base surface, along its normal, over the disc domain."""
    m = np.hypot(X, Y)
    th = np.arctan2(Y, X)
    d = np.zeros_like(m)

    r = np.interp(m, M, MR)
    top = m < M_EQUATOR
    x, y = r * np.cos(th), r * np.sin(th)

    for deg in ARMS.values():
        a = math.radians(deg)
        along = x * math.cos(a) + y * math.sin(a)
        across = -x * math.sin(a) + y * math.cos(a)
        sd = np.hypot(along - np.clip(along, GROOVE_FROM, GROOVE_TO), across) - GROOVE_R
        d -= top * GROOVE_DEPTH * (1.0 - smootherstep(-GROOVE_SOFT, GROOVE_SOFT, sd))

    # Centre button seat: a pocket, a soft crease, then a faint raised ring.
    rim = CENTER_R + CENTER_GAP
    d -= top * POCKET_DEPTH * (1.0 - smoothstep(rim, rim + 0.04, r))
    d -= top * 0.13 * (1.0 - smoothstep(rim + 0.04, rim + 0.6, r))
    d += top * 0.05 * np.exp(-((r - (rim + 0.85)) / 0.45) ** 2)

    for az, half_len in PILLS:
        u, v = belt_uv(m, th, az)
        sd = sd_stadium(u, v, half_len, PILL_H)
        d -= POCKET_DEPTH * (1.0 - smoothstep(POCKET_GAP, POCKET_GAP + 0.04, sd))
        d -= 0.24 * (1.0 - smoothstep(POCKET_GAP + 0.04, 0.95, sd))

    u, v = belt_uv(m, th, AZ_GRILLE)
    sd = sd_stadium(u, v, GRILLE_L, GRILLE_H)
    d -= 0.16 * (1.0 - smoothstep(-0.2, 0.0, sd))
    d += 0.2 * np.exp(-(sd / 0.3) ** 2)
    for hu, hv in GRILLE_HOLES:
        dist = np.hypot(u - hu, v - hv) - GRILLE_HOLE_R
        d -= GRILLE_HOLE_DEPTH * (1.0 - smoothstep(-0.14, 0.0, dist))
        d -= 0.12 * (1.0 - smoothstep(0.0, 0.3, dist))

    u, v = belt_uv(m, th, AZ_PANEL)
    sd = sd_stadium(u, v, PANEL_L, PANEL_H)
    d -= 0.1 * (1.0 - smoothstep(-0.2, 0.0, sd))
    d += 0.15 * np.exp(-(sd / 0.26) ** 2)

    dist = np.hypot(u - JACK_U, v)
    d += 0.3 * (1.0 - smoothstep(JACK_R + 0.15, JACK_COLLAR_R, dist))
    d -= JACK_DEPTH * (1.0 - smoothstep(JACK_R - 0.12, JACK_R, dist))

    sd_usb = sd_stadium(u - USB_U, v, USB_L, USB_H)
    d -= USB_DEPTH * (1.0 - smoothstep(-0.12, 0.0, sd_usb))
    return d


def body_point(X, Y, lift=0.0):
    m = np.hypot(X, Y)
    th = np.arctan2(Y, X)
    p, n = base_surface(m, th)
    return p + n * (body_height(X, Y) + lift)[..., None]


def body_normals(X, Y, eps=0.018):
    du = body_point(X + eps, Y) - body_point(X - eps, Y)
    dv = body_point(X, Y + eps) - body_point(X, Y - eps)
    n = np.cross(du, dv)
    length = np.linalg.norm(n, axis=-1, keepdims=True)
    fallback = base_surface(np.hypot(X, Y), np.arctan2(Y, X))[1]
    return np.where(length > 1e-12, n / np.maximum(length, 1e-12), fallback)


def plan_domain(x, y):
    r = np.hypot(x, y)
    m = plan_to_m(r)
    scale = np.where(r > 1e-9, m / np.maximum(r, 1e-9), 1.0)
    return x * scale, y * scale


# --- body mesh -----------------------------------------------------------
def body_constraints():
    rings = []

    def belt_ring(outline, az):
        rings.append([belt_to_domain(u, v, az) for u, v in outline])

    for az, half_len in PILLS:
        for off in (POCKET_GAP, POCKET_GAP + 0.04, 0.3, 0.55, 0.95, 1.5):
            belt_ring(stadium_outline(half_len, PILL_H, off), az)

    for off in (-1.0, -0.55, -0.2, -0.08, 0.0, 0.14, 0.3, 0.55, 0.95):
        belt_ring(stadium_outline(GRILLE_L, GRILLE_H, off), AZ_GRILLE)
    for hu, hv in GRILLE_HOLES:
        for rad in (GRILLE_HOLE_R - 0.14, GRILLE_HOLE_R, GRILLE_HOLE_R + 0.12, GRILLE_HOLE_R + 0.3):
            belt_ring(circle_outline(hu, hv, rad, 20), AZ_GRILLE)

    for off in (-0.2, -0.08, 0.0, 0.14, 0.3, 0.55):
        belt_ring(stadium_outline(PANEL_L, PANEL_H, off), AZ_PANEL)
    for rad in (JACK_R - 0.12, JACK_R, JACK_R + 0.15, JACK_R + 0.6, JACK_COLLAR_R - 0.4):
        belt_ring(circle_outline(JACK_U, 0.0, rad, 44), AZ_PANEL)
    for off in (-0.12, 0.0, 0.12, 0.3):
        belt_ring([(u + USB_U, v) for u, v in stadium_outline(USB_L, USB_H, off, 0.3)], AZ_PANEL)

    rim = CENTER_R + CENTER_GAP
    for rad in (rim, rim + 0.04, rim + 0.25, rim + 0.65, rim + 0.95, rim + 1.4):
        count = 96
        xy = np.array(circle_outline(0.0, 0.0, rad, count))
        X, Y = plan_domain(xy[:, 0], xy[:, 1])
        rings.append(list(zip(X.tolist(), Y.tolist())))
    return rings


def clear_of(rings, pts, keep_away):
    tree = kdtree.KDTree(sum(len(r) for r in rings))
    i = 0
    for ring in rings:
        for x, y in ring:
            tree.insert((x, y, 0.0), i)
            i += 1
    tree.balance()
    return [p for p in pts if tree.find((p[0], p[1], 0.0))[2] > keep_away]


def body_grid():
    pts = [(0.0, 0.0)]
    m = 0.0
    stagger = 0
    m_end = float(np.interp(-1.0, -MR[M_TOP_END:], M[M_TOP_END:]))
    while True:
        m += (GRID_TOP if m < M_EQUATOR + 3.0 else GRID_BELOW) * 0.87
        if m >= m_end:
            break
        r = float(np.interp(m, M, MR))
        spacing = GRID_TOP if m < M_EQUATOR + 3.0 else GRID_BELOW
        count = max(6, math.ceil(2 * math.pi * r / spacing))
        if m > M_EQUATOR:
            count = max(count, 120)
        stagger += 1
        for i in range(count):
            a = 2 * math.pi * (i + 0.5 * (stagger % 2)) / count
            pts.append((m * math.cos(a), m * math.sin(a)))
    count = 120
    last = [(m_end * math.cos(2 * math.pi * i / count), m_end * math.sin(2 * math.pi * i / count))
            for i in range(count)]
    return pts, last


def build_body_mesh():
    rings = body_constraints()
    grid, last = body_grid()
    grid = clear_of(rings, grid, 0.38)

    coords, edges = [], []
    for ring in rings:
        start = len(coords)
        coords.extend(ring)
        edges.extend((start + i, start + (i + 1) % len(ring)) for i in range(len(ring)))
    coords.extend(grid)
    coords.extend(last)

    out_verts, _, out_faces, *_ = delaunay_2d_cdt(
        [Vector(c) for c in coords], edges, [], 0, 1e-6)
    xy = np.array([tuple(v) for v in out_verts], dtype=np.float64)
    faces = [tuple(f) for f in out_faces]

    use = {}
    for f in faces:
        for i in range(len(f)):
            key = (f[i], f[(i + 1) % len(f)])
            use[key] = True
    boundary = [e for e in use if (e[1], e[0]) not in use]

    P = body_point(xy[:, 0], xy[:, 1])
    N = body_normals(xy[:, 0], xy[:, 1])
    UV = xy / (2.0 * M_MAX) + 0.5

    # Close the bottom pole with a fan.
    pole = len(P)
    P = np.vstack([P, [0.0, 0.0, MZ[-1]]])
    N = np.vstack([N, [0.0, 0.0, -1.0]])
    UV = np.vstack([UV, [1.0, 0.5]])
    faces.extend((b, a, pole) for a, b in boundary)
    return P, N, UV, faces


# --- buttons -------------------------------------------------------------
def pill_height(sd, u, v, half_h):
    """Pillowed cap with a rolled edge; `sd` is negative inside the pill."""
    crown = 0.1 * (1.0 - np.clip(v / half_h, -1.0, 1.0) ** 2)
    roll = np.sqrt(np.clip(1.0 - (1.0 - np.clip(-sd / 0.85, 0.0, 1.0)) ** 2, 0.0, 1.0))
    return -0.3 + (PILL_PROUD + 0.3 + crown) * roll


def glyph_sd(u, v, hu, hv, half_w, half_h):
    return np.maximum(np.abs(u - hu) - half_w, np.abs(v - hv) - half_h)


def plus_sd(u, v, cu):
    return np.minimum(glyph_sd(u, v, cu, 0.0, 1.2, 0.3), glyph_sd(u, v, cu, 0.0, 0.3, 1.2))


def rect_outline(cu, cv, half_w, half_h, grow, step=0.3):
    hw, hh = half_w + grow, half_h + grow
    pts = []
    corners = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
    for i, (ax, ay) in enumerate(corners):
        bx, by = corners[(i + 1) % 4]
        n = max(2, int(math.hypot(bx - ax, by - ay) / step))
        pts.extend((ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n))
    return [(cu + x, cv + y) for x, y in pts]


def plus_outline(cu, grow):
    w, t = 1.2 + grow, 0.3 + grow
    corners = [(-w, -t), (-t, -t), (-t, -w), (t, -w), (t, -t), (w, -t),
               (w, t), (t, t), (t, w), (-t, w), (-t, t), (-w, t)]
    pts = []
    for i, (ax, ay) in enumerate(corners):
        bx, by = corners[(i + 1) % len(corners)]
        n = max(1, int(math.hypot(bx - ax, by - ay) / 0.3))
        pts.extend((ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n))
    return [(cu + x, y) for x, y in pts]


def build_pill(az, half_len, marks):
    """Returns (P, N, faces, centre, rotation). `marks` engraves the cap."""
    rings = []
    for off in (0.0, -0.05, -0.15, -0.3, -0.5, -0.85):
        rings.append(stadium_outline(half_len, PILL_H, off, 0.34))
    outer = rings[0]
    rings.extend(marks["rings"])

    straight = half_len - PILL_H
    grid = []
    for iv in range(-5, 6):
        for iu in range(-int(half_len / 0.8), int(half_len / 0.8) + 1):
            grid.append((iu * 0.8 + 0.4 * (iv % 2), iv * 0.5))
    u, v = np.array(grid).T
    sd = sd_stadium(u, v, half_len, PILL_H)
    grid = [p for p, s in zip(grid, sd) if s < -1.05]
    grid = clear_of(rings, grid, 0.3) if grid else grid

    coords, edges = [], []
    for ring in rings:
        start = len(coords)
        coords.extend(ring)
        edges.extend((start + i, start + (i + 1) % len(ring)) for i in range(len(ring)))
    coords.extend(grid)
    out_verts, _, out_faces, *_ = delaunay_2d_cdt([Vector(c) for c in coords], edges, [], 0, 1e-6)
    uv = np.array([tuple(p) for p in out_verts], dtype=np.float64)
    faces = [tuple(f) for f in out_faces]

    def point(u, v):
        sd = sd_stadium(u, v, half_len, PILL_H)
        h = pill_height(sd, u, v, PILL_H) + marks["height"](u, v)
        m = M_BELT + v
        th = math.radians(az) + u / R_BELT
        p, n = base_surface(m, th)
        return p + n * h[..., None]

    def normals(u, v, eps=0.015):
        a = point(u + eps, v) - point(u - eps, v)
        b = point(u, v + eps) - point(u, v - eps)
        # +u runs counter-clockwise and +v runs down the surface.
        n = np.cross(b, a)
        return n / np.linalg.norm(n, axis=-1, keepdims=True)

    P = point(uv[:, 0], uv[:, 1])
    N = normals(uv[:, 0], uv[:, 1])

    # Skirt: the cap's outer ring extruded inwards, deep enough for a full press.
    ring_ids = []
    outer_arr = np.array(outer)
    for ou, ov in outer_arr:
        ring_ids.append(int(np.argmin((uv[:, 0] - ou) ** 2 + (uv[:, 1] - ov) ** 2)))
    m = M_BELT + outer_arr[:, 1]
    th = math.radians(az) + outer_arr[:, 0] / R_BELT
    base_p, base_n = base_surface(m, th)
    skirt = base_p - base_n * 2.4
    side_u = outer_arr[:, 0] - np.clip(outer_arr[:, 0], -straight, straight)
    side_v = outer_arr[:, 1]
    side = np.stack([side_u, side_v], -1)
    side /= np.linalg.norm(side, axis=-1, keepdims=True)
    tangent_u = np.stack([-np.sin(th), np.cos(th), np.zeros_like(th)], -1)
    tangent_v = np.cross(tangent_u, base_n)  # +v runs down the surface
    out_dir = tangent_u * side[:, :1] + tangent_v * side[:, 1:]
    start = len(P)
    P = np.vstack([P, skirt])
    N = np.vstack([N, out_dir])
    count = len(outer)
    for i in range(count):
        j = (i + 1) % count
        faces.append((ring_ids[i], ring_ids[j], start + j, start + i))

    faces = [f[::-1] if len(f) == 3 else f for f in faces]
    centre_p, centre_n = base_surface(np.array(M_BELT), np.array(math.radians(az)))
    rot = frame_from_normal(centre_n, np.array([-math.sin(math.radians(az)), math.cos(math.radians(az)), 0.0]))
    ink = np.concatenate([np.clip(marks["height"](uv[:, 0], uv[:, 1]) / -0.2, 0.0, 1.0), np.zeros(count)])
    return P, N, faces, centre_p + centre_n * PILL_PROUD, rot, ink


def frame_from_normal(normal, tangent):
    z = Vector(normal).normalized()
    x = (Vector(tangent) - z * Vector(tangent).dot(z)).normalized()
    y = z.cross(x)
    return Matrix((x, y, z)).transposed().to_4x4()


def build_center_button():
    radii = [CENTER_R * t for t in (0.0, 0.22, 0.45, 0.66, 0.8, 0.88, 0.94, 0.98, 1.0)]
    count = 72

    def height(r):
        roll = np.sqrt(np.clip(1.0 - (1.0 - np.clip((CENTER_R - r) / 0.8, 0.0, 1.0)) ** 2, 0.0, 1.0))
        return -0.26 + 0.44 * roll

    pts, nrm = [], []
    rows = []
    for rad in radii:
        n = 1 if rad == 0.0 else count
        row = []
        for i in range(n):
            a = 2 * math.pi * i / n
            eps = 0.02
            sample = np.array([rad, rad + eps, max(rad - eps, 0.0)])
            m = plan_to_m(sample)
            p, nn = base_surface(m, np.full(3, a))
            q = p + nn * height(sample)[:, None]
            row.append(len(pts))
            pts.append(q[0])
            nrm.append(nn[0])
        rows.append(row)
    wall = []
    outer_m = float(plan_to_m(np.array(CENTER_R)))
    for i in range(count):
        a = 2 * math.pi * i / count
        p, nn = base_surface(np.array(outer_m), np.array(a))
        wall.append(len(pts))
        pts.append(p - nn * 2.4)
        nrm.append(np.array([math.cos(a), math.sin(a), 0.0]))

    faces = []
    for i in range(count):
        faces.append((rows[0][0], rows[1][i], rows[1][(i + 1) % count]))
    for a, b in zip(rows[1:], rows[2:] + [wall]):
        for i in range(count):
            j = (i + 1) % count
            faces.append((a[i], b[i], b[j], a[j]))

    P = np.array(pts)
    # Analytic-enough normals: the cap's own facets, averaged per vertex.
    N = vertex_normals(P, faces)
    for i, k in enumerate(wall):
        a = 2 * math.pi * i / count
        N[k] = (math.cos(a), math.sin(a), 0.0)
    top = float(MZ[0]) + height(np.array(0.0))
    centre = Vector((0.0, 0.0, top))
    return P, N, faces, centre, Matrix.Identity(4)


def vertex_normals(P, faces):
    N = np.zeros_like(P)
    for f in faces:
        a, b, c = P[f[0]], P[f[1]], P[f[2]]
        n = np.cross(b - a, c - a)
        for i in f:
            N[i] += n
    return N / np.maximum(np.linalg.norm(N, axis=-1, keepdims=True), 1e-12)


# --- small parts ---------------------------------------------------------
def build_led(arm_deg, radius):
    """Grid conforming to the groove; UV spans 0..1 across the quad."""
    a = math.radians(arm_deg)
    steps = 6
    half = LED_SIZE / 2
    verts, uvs, normals = [], [], []
    for iy in range(steps + 1):
        for ix in range(steps + 1):
            s, t = ix / steps, iy / steps
            along = radius + (t - 0.5) * LED_SIZE
            across = (s - 0.5) * LED_SIZE
            x = along * math.cos(a) - across * math.sin(a)
            y = along * math.sin(a) + across * math.cos(a)
            X, Y = plan_domain(np.array(x), np.array(y))
            verts.append(body_point(X, Y, 0.05))
            normals.append(body_normals(np.atleast_1d(X), np.atleast_1d(Y))[0])
            uvs.append((s, t))
    faces = []
    w = steps + 1
    for iy in range(steps):
        for ix in range(steps):
            i = iy * w + ix
            faces.append((i, i + 1, i + w + 1, i + w))
    X, Y = plan_domain(np.array(radius * math.cos(a)), np.array(radius * math.sin(a)))
    return np.array(verts), np.array(normals), np.array(uvs), faces, Vector(body_point(X, Y, 0.05))


def build_hit(arm_deg):
    a = math.radians(arm_deg)
    start, end = LED_RADII[0] - 3.0, LED_RADII[-1] + 3.0
    rows, cols = 8, 3
    verts = []
    for iy in range(rows + 1):
        for ix in range(cols + 1):
            along = start + (end - start) * iy / rows
            across = -7.0 + 14.0 * ix / cols
            x = along * math.cos(a) - across * math.sin(a)
            y = along * math.sin(a) + across * math.cos(a)
            m = plan_to_m(np.array(math.hypot(x, y)))
            p, n = base_surface(m, np.array(math.atan2(y, x)))
            verts.append(p + n * 0.4)
    w = cols + 1
    faces = [(iy * w + ix, iy * w + ix + 1, (iy + 1) * w + ix + 1, (iy + 1) * w + ix)
             for iy in range(rows) for ix in range(cols)]
    return np.array(verts), faces


def plan_to_m_bottom(r):
    rr = MR[M_TOP_END:][::-1]
    mm = M[M_TOP_END:][::-1]
    return np.interp(r, rr, mm)


def build_back_text():
    """The label as flat glyph polygons laid on the underside of the shell."""
    font = None
    for path in BACK_FONTS:
        if os.path.exists(path):
            font = bpy.data.fonts.load(path)
            break

    verts, faces = [], []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for i, line in enumerate(BACK_LINES):
        curve = bpy.data.curves.new(f"label{i}", "FONT")
        curve.body = line
        curve.size = BACK_TEXT_SIZE
        curve.align_x = "CENTER"
        curve.space_character = BACK_TEXT_TRACKING
        curve.resolution_u = 3
        if font is not None:
            curve.font = font
        obj = bpy.data.objects.new(f"label{i}", curve)
        bpy.context.scene.collection.objects.link(obj)
        depsgraph.update()
        mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
        offset = (len(BACK_LINES) - 1) / 2 - i
        base = len(verts)
        verts.extend((v.co.x, v.co.y + offset * BACK_TEXT_PITCH - BACK_TEXT_SIZE * 0.36) for v in mesh.vertices)
        faces.extend(tuple(base + k for k in p.vertices) for p in mesh.polygons)
        bpy.data.objects.remove(obj)
        bpy.data.curves.remove(curve)
        bpy.data.meshes.remove(mesh)

    xy = np.array(verts)
    az = math.radians(BACK_TEXT_RIGHT_AZ)
    right = np.array([math.cos(az), math.sin(az)])
    up = np.array([math.sin(az), -math.cos(az)])
    plan = xy[:, 0:1] * right + xy[:, 1:2] * up
    p, n = base_surface(plan_to_m_bottom(np.hypot(plan[:, 0], plan[:, 1])),
                        np.arctan2(plan[:, 1], plan[:, 0]))
    return p + n * 0.035, n, faces


def build_port_cup(outline_uv, az, depth_top, depth_bottom):
    """Dark liner for a port: a tube following `outline_uv`, closed at the end."""
    pts = np.array(outline_uv)
    m = M_BELT + pts[:, 1]
    th = math.radians(az) + pts[:, 0] / R_BELT
    p, n = base_surface(m, th)
    top = p - n * depth_top
    bottom = p - n * depth_bottom
    centre = bottom.mean(0)
    P = np.vstack([top, bottom, centre])
    count = len(pts)
    faces = []
    for i in range(count):
        j = (i + 1) % count
        faces.append((i + count, j + count, j, i))
        faces.append((j + count, i + count, 2 * count))
    return P, vertex_normals(P, faces), faces


# --- blender objects -----------------------------------------------------
def material(name, make):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    make(mat, bsdf)
    return mat


def make_materials():
    def silicone(mat, bsdf):
        attr = mat.node_tree.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "Col"
        mat.node_tree.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
        bsdf.inputs["Roughness"].default_value = 0.72
        bsdf.inputs["Specular IOR Level"].default_value = 0.36
        bsdf.inputs["Sheen Weight"].default_value = 0.12
        bsdf.inputs["Sheen Roughness"].default_value = 0.45

    def invisible(mat, bsdf):
        # Off until the viewer drives it; alpha 0 means nothing shows by default.
        bsdf.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1.0)
        bsdf.inputs["Alpha"].default_value = 0.0
        bsdf.inputs["Roughness"].default_value = 1.0
        mat.surface_render_method = "BLENDED"

    def port(mat, bsdf):
        bsdf.inputs["Base Color"].default_value = (0.012, 0.012, 0.014, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.38

    def back_print(mat, bsdf):
        bsdf.inputs["Base Color"].default_value = (*[srgb_to_linear(c) for c in BACK_TEXT_SRGB], 1.0)
        bsdf.inputs["Roughness"].default_value = 0.7

    return {
        "Silicone": material("Silicone", silicone),
        "LED": material("LED", invisible),
        "Hit": material("Hit", invisible),
        "Port": material("Port", port),
        "BackPrint": material("BackPrint", back_print),
    }


def add_object(name, P, faces, mat, N=None, UV=None, location=None, rotation=None, uv_loops=False):
    """`P` is in millimetres; `location` and `rotation` set the object's frame."""
    loc = Vector((0.0, 0.0, 0.0)) if location is None else Vector(location)
    rot = Matrix.Identity(4) if rotation is None else rotation
    inv = rot.to_3x3().inverted()
    world = np.asarray(P, dtype=np.float64) - np.array(loc)
    local = np.asarray(world @ np.array(inv).T) * 0.001

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(local.tolist(), [], [tuple(int(i) for i in f) for f in faces])
    mesh.update()
    mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
    mesh.materials.append(mat)

    if UV is not None:
        layer = mesh.uv_layers.new(name="UVMap")
        uv = np.asarray(UV)
        for loop in mesh.loops:
            layer.data[loop.index].uv = uv[loop.vertex_index]

    if N is not None:
        rotated = np.asarray(np.asarray(N, dtype=np.float64) @ np.array(inv).T)
        mesh.normals_split_custom_set_from_vertices(rotated.tolist())

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.matrix_world = Matrix.Translation(loc * 0.001) @ rot
    return obj


def bake_ao(objects, ink):
    """Ray-cast hemisphere occlusion per vertex and store skin * AO in COLOR_0."""
    verts, polys = [], []
    for obj in objects:
        mesh = obj.data
        mat = obj.matrix_world
        base = len(verts)
        verts.extend((mat @ v.co) * 1000.0 for v in mesh.vertices)
        polys.extend([base + i for i in p.vertices] for p in mesh.polygons)
    bvh = BVHTree.FromPolygons(verts, polys, all_triangles=False, epsilon=1e-6)

    rng = np.random.default_rng(7)
    u1 = (np.arange(AO_RAYS) + 0.5) / AO_RAYS
    u2 = (np.arange(AO_RAYS) * 0.61803398875) % 1.0
    rad = np.sqrt(u1)
    phi = 2 * math.pi * u2
    hemi = np.stack([rad * np.cos(phi), rad * np.sin(phi), np.sqrt(1 - u1)], -1)

    skin = np.array([srgb_to_linear(c) for c in SKIN_SRGB])
    for obj in objects:
        mesh = obj.data
        mesh.calc_loop_triangles()
        split = np.zeros((len(mesh.loops), 3))
        mesh.corner_normals.foreach_get("vector", split.ravel())
        normal = np.zeros((len(mesh.vertices), 3))
        for loop in mesh.loops:
            normal[loop.vertex_index] = split[loop.index]
        mat = obj.matrix_world.to_3x3().normalized()
        wm = np.array(mat)
        origin_mat = obj.matrix_world
        attr = mesh.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        colors = np.ones((len(mesh.vertices), 4))
        for i, v in enumerate(mesh.vertices):
            n = Vector(wm @ normal[i])
            p = (origin_mat @ v.co) * 1000.0 + n * 0.2
            t = n.orthogonal().normalized()
            b = n.cross(t)
            jitter = rng.random() * 2 * math.pi
            cj, sj = math.cos(jitter), math.sin(jitter)
            open_rays = 0.0
            for h in hemi:
                hx = h[0] * cj - h[1] * sj
                hy = h[0] * sj + h[1] * cj
                d = t * hx + b * hy + n * h[2]
                hit, _, _, dist = bvh.ray_cast(p, d, AO_RANGE)
                open_rays += 1.0 if hit is None else min(dist / AO_RANGE, 1.0) ** 0.6
            ao = open_rays / AO_RAYS
            colors[i, :3] = skin * (0.3 + 0.7 * ao)
        if obj.name in ink:
            colors[:, :3] *= 1.0 - 0.5 * ink[obj.name][:, None]
        attr.data.foreach_set("color", colors.ravel())
        mesh.color_attributes.active_color = attr
        mesh.color_attributes.render_color_index = 0


def export_glb():
    os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB,
        export_format="GLB",
        export_yup=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_vertex_color="ACTIVE",
        export_extras=True,
        export_draco_mesh_compression_enable=False,
        export_animations=False,
        export_lights=False,
        export_cameras=False,
    )


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = make_materials()

    P, N, UV, faces = build_body_mesh()
    body = add_object("Body", P, faces, mats["Silicone"], N=N, UV=UV)
    shaded = [body]

    P, N, faces, centre, rot = build_center_button()
    shaded.append(add_object("Btn_Center", P, faces, mats["Silicone"], N=N, location=centre, rotation=rot))

    def no_marks():
        return {"rings": [], "height": lambda u, v: np.zeros_like(u)}

    def dot_marks():
        centres = (-7.0, 7.0)
        rings = []
        for cu in centres:
            for rad in (0.28, 0.42, 0.72, 0.86):
                rings.append(circle_outline(cu, 0.0, rad, 18))

        def height(u, v):
            h = np.zeros_like(u)
            for cu in centres:
                dist = np.hypot(u - cu, v)
                h -= 0.2 * smoothstep(0.28, 0.42, dist) * (1.0 - smoothstep(0.72, 0.86, dist))
            return h

        return {"rings": rings, "height": height}

    def volume_marks():
        minus_u, plus_u = -(VOLUME_L - 3.3), VOLUME_L - 3.3
        rings = [
            rect_outline(minus_u, 0.0, 0.95, 0.28, 0.0),
            rect_outline(minus_u, 0.0, 0.95, 0.28, 0.14),
            plus_outline(plus_u, 0.0),
            plus_outline(plus_u, 0.14),
        ]

        def height(u, v):
            sd = np.minimum(glyph_sd(u, v, minus_u, 0.0, 0.95, 0.28), plus_sd(u, v, plus_u))
            return -0.2 * (1.0 - smoothstep(0.0, 0.14, sd))

        return {"rings": rings, "height": height}

    ink = {}
    for name, az, half_len, marks in (
        ("Btn_Volume", AZ_VOLUME, VOLUME_L, volume_marks()),
        ("Btn_Load", AZ_LOAD, LOAD_L, no_marks()),
        ("Btn_Dots", AZ_DOTS, DOTS_L, dot_marks()),
    ):
        P, N, faces, centre, rot, ink[name] = build_pill(az, half_len, marks)
        obj = add_object(name, P, faces, mats["Silicone"], N=N, location=centre, rotation=rot)
        press = (rot.to_3x3() @ Vector((0.0, 0.0, -1.0))).normalized()
        # Three.js space: Blender (x, y, z) becomes (x, z, -y).
        obj["press_dir"] = [round(press.x, 5), round(press.z, 5), round(-press.y, 5)]
        shaded.append(obj)

    bake_ao(shaded, ink)

    for arm, deg in ARMS.items():
        for index, radius in enumerate(LED_RADII, 1):
            P, N, uv, faces, centre = build_led(deg, radius)
            add_object(f"LED_{arm}_{index}", P, faces, mats["LED"], N=N, UV=uv, location=centre)
        P, faces = build_hit(deg)
        add_object(f"Hit_{arm}", P, faces, mats["Hit"])

    jack = [(JACK_U + (JACK_R - 0.1) * math.cos(a), (JACK_R - 0.1) * math.sin(a))
            for a in np.linspace(0, 2 * math.pi, 32, endpoint=False)]
    P, N, faces = build_port_cup(jack, AZ_PANEL, 0.7, JACK_DEPTH - 0.2)
    add_object("Port_Jack", P, faces, mats["Port"], N=N)

    usb = [(u + USB_U, v) for u, v in stadium_outline(USB_L, USB_H, -0.08, 0.5)]
    P, N, faces = build_port_cup(usb, AZ_PANEL, 0.5, USB_DEPTH - 0.2)
    add_object("Port_USB", P, faces, mats["Port"], N=N)

    if BACK_TEXT_ENABLED:
        P, N, faces = build_back_text()
        add_object("Back_Text", P, faces, mats["BackPrint"], N=N)

    export_glb()
    tris = 0
    for obj in bpy.data.objects:
        obj.data.calc_loop_triangles()
        tris += len(obj.data.loop_triangles)
    print(f"[stem-player] {OUT_GLB}: {os.path.getsize(OUT_GLB) / 1e6:.2f} MB, {tris} triangles, "
          f"{len(bpy.data.objects)} objects, belt radius {R_BELT:.2f} mm")


main()
