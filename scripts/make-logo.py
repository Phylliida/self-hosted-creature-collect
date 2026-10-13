#!/usr/bin/env python3
"""Draw the app logo — two interlocked rings (an infinity) over a low-poly
map — as SVG, from code.

    python3 scripts/make-logo.py            # writes the SVGs below
    python3 scripts/make-logo.py --png      # …and the PNGs, via rsvg-convert

Outputs:
  static/icon.svg            rounded tile (favicon, manifest "any")
  assets/logo-full.svg       full-bleed square (source for the PNGs)
  static/icon.png            512, rounded tile, transparent corners
  static/icon-maskable.png   512, full bleed (maskable + apple-touch-icon)
  assets/icon-only.png       1024, full bleed (@capacitor/assets, CI)

The map is a jittered triangle mesh; each triangle takes a class (deep
water, shallow water, land, ice) from a field of blobs placed like the
old logo's continents, plus a little value noise, and a seeded shade
jitter so the facets read. Everything is seeded: the same script always
draws the same logo.
"""
import math
import random
import shutil
import subprocess
import sys
from pathlib import Path

W = 1024
SEED = 7


def hexmix(a, b, t):
    pa = [int(a[i:i + 2], 16) for i in (1, 3, 5)]
    pb = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    return '#' + ''.join('%02x' % round(x + (y - x) * t) for x, y in zip(pa, pb))


def shade(c, t):
    """t < 0 darkens toward black, t > 0 lightens toward white."""
    return hexmix(c, '#000000', -t) if t < 0 else hexmix(c, '#ffffff', t)


def f(n):
    return ('%.1f' % n).rstrip('0').rstrip('.')


# ── Map ────────────────────────────────────────────────────────────────
# Flat, straight-edged landmasses laid out like the old logo; low-poly
# facets come from one jittered triangle mesh, drawn once per region in
# that region's colour (water everywhere, then each region clipped to its
# polygon), each facet shaded by a soft top-left light plus jitter.
DEEP, SHALLOW, LAND, ICE = '#2c4567', '#4a6a92', '#7fae86', '#b7c4d6'
REGIONS = [
    (LAND, [(0, 176), (64, 168), (150, 186), (176, 170), (246, 206), (268, 244), (250, 292),
            (214, 332), (198, 384), (176, 424), (134, 436), (118, 474), (150, 504), (160, 562),
            (140, 602), (182, 642), (242, 662), (282, 704), (302, 764), (288, 822), (250, 846),
            (228, 902), (204, 950), (178, 924), (176, 862), (150, 800), (106, 760), (52, 724),
            (0, 708)]),                                      # the west coast
    (LAND, [(516, 136), (598, 108), (700, 122), (762, 92), (832, 58), (906, 50), (1024, 36),
            (1024, 282), (962, 300), (904, 360), (862, 420), (818, 382), (776, 330), (716, 302),
            (648, 272), (588, 252), (538, 230), (514, 184)]),  # the northeast
    (LAND, [(876, 604), (948, 586), (1024, 598), (1024, 806), (962, 792), (902, 752), (868, 690)]),
    (SHALLOW, [(902, 236), (1024, 178), (1024, 384), (934, 474), (878, 444), (888, 330)]),
    (ICE, [(206, 30), (300, 0), (432, 0), (442, 62), (420, 122), (382, 152), (352, 204), (312, 190),
           (282, 122), (232, 92)]),
    (ICE, [(478, 862), (560, 840), (684, 852), (764, 882), (822, 904), (842, 1024), (468, 1024),
           (458, 942)]),
]


def inside(pt, poly):
    x, y = pt
    hit = False
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def facet_mesh(rng, n=13):
    cell = W / n
    pts = {}
    for j in range(-1, n + 2):
        for i in range(-1, n + 2):
            pts[i, j] = (i * cell + (rng.random() - 0.5) * 0.7 * cell,
                         j * cell + (rng.random() - 0.5) * 0.7 * cell)
    tris = []
    for j in range(-1, n + 1):
        for i in range(-1, n + 1):
            a, b, c, d = pts[i, j], pts[i + 1, j], pts[i + 1, j + 1], pts[i, j + 1]
            tris += [(a, b, c), (a, c, d)] if rng.random() < 0.5 else [(a, b, d), (b, c, d)]
    # One jitter per facet, shared by every layer, so a facet keeps its
    # light across a coastline.
    return [(t, (rng.random() - 0.5) * 0.09) for t in tris]


def facets(mesh, base, keep=None):
    out = []
    for t, jit in mesh:
        if keep and not keep(t):
            continue
        cx = sum(p[0] for p in t) / 3 / W
        cy = sum(p[1] for p in t) / 3 / W
        col = shade(base, (0.5 - cx) * 0.06 + (0.5 - cy) * 0.06 + jit)
        d_ = 'M' + ' L'.join(f'{f(x)} {f(y)}' for x, y in t) + 'Z'
        # Stroke in the fill colour hides the anti-aliasing seams (width
        # and join come from the enclosing group).
        out.append(f"<path d='{d_}' fill='{col}' stroke='{col}'/>")
    return ''.join(out)


def map_svg(rng):
    mesh = facet_mesh(rng)
    out = ["<g stroke-width='1.2' stroke-linejoin='round'>", facets(mesh, DEEP)]
    for k, (col, poly) in enumerate(REGIONS):
        xs, ys = [p[0] for p in poly], [p[1] for p in poly]
        bx0, bx1, by0, by1 = min(xs) - 90, max(xs) + 90, min(ys) - 90, max(ys) + 90
        # Facets near the polygon (by bounding box) — the clip trims them.
        keep = lambda t: any(bx0 <= x <= bx1 and by0 <= y <= by1 for x, y in t)
        pts = ' '.join(f'{x},{y}' for x, y in poly)
        out.append(f"<clipPath id='r{k}'><polygon points='{pts}'/></clipPath>"
                   f"<g clip-path='url(#r{k})'>{facets(mesh, col, keep)}</g>")
    out.append('</g>')
    return ''.join(out)


def graticule_svg():
    g = []
    for k in range(1, 6):
        p = k * W / 6
        g.append(f"M{f(p)} 0V{W}M0 {f(p)}H{W}")
    lines = f"<path d='{''.join(g)}' fill='none' stroke='#e8f1fb' stroke-width='3.5' opacity='0.26'/>"
    diag = f"<path d='M0 0L{W} {W}M{W} 0L0 {W}' fill='none' stroke='#e8f1fb' stroke-width='3' opacity='0.18'/>"
    rings = (f"<circle cx='512' cy='512' r='438' fill='none' stroke='#e8f1fb' stroke-width='5' opacity='0.55'/>"
             f"<circle cx='512' cy='512' r='300' fill='none' stroke='#e8f1fb' stroke-width='3.5' opacity='0.28'/>")
    return lines + diag + rings


# ── Rings ──────────────────────────────────────────────────────────────
# The two crossings must not touch: on the line through the centres the
# bands may not overlap, i.e. d / 2 < M - BAND / 2 (d = centre distance).
# Then the interlock split along that line never cuts an overlap.
M, BAND = 176, 104               # mid radius, band width
BLUE = dict(c=(394, 512), hi='#dff7ff', mid='#6cc4f4', lo='#3584dc', line='#f2fbff', glow='#5cc0ff', turn=1)
ORANGE = dict(c=(630, 494), hi='#fff0c6', mid='#ffae6e', lo='#f26e43', line='#fff6e4', glow='#ff9a58', turn=1)


def ring_defs(key, r):
    cx, cy = r['c']
    return (
        f"<radialGradient id='{key}g' gradientUnits='userSpaceOnUse' cx='{cx - 120}' cy='{cy - 140}' r='{M + BAND * 2.2}'>"
        f"<stop offset='0' stop-color='{r['hi']}'/><stop offset='0.55' stop-color='{r['mid']}'/>"
        f"<stop offset='1' stop-color='{r['lo']}'/></radialGradient>"
        f"<mask id='{key}m' maskUnits='userSpaceOnUse' x='0' y='0' width='{W}' height='{W}'>"
        f"<circle cx='{cx}' cy='{cy}' r='{M}' fill='none' stroke='#fff' stroke-width='{BAND}'/></mask>"
    )


def ring_body(key, r, swirl):
    """The band, its swirl striations (eccentric circles cut to the band,
    so each crosses it as a crescent), and glassy highlights."""
    cx, cy = r['c']
    out = [f"<circle cx='{cx}' cy='{cy}' r='{M}' fill='none' stroke='url(#{key}g)' stroke-width='{BAND}'/>"]
    # Swirl: strokes that spiral from the outer rim to the inner one over
    # ~150°, so the band reads as a twisted ribbon.
    ro0, ri0 = M + BAND / 2 - 4, M - BAND / 2 + 4
    arcs = []
    for k in range(8):
        a0 = swirl + k * 2 * math.pi / 8
        pts = []
        for i in range(25):
            t = i / 24
            a = a0 + r['turn'] * t * math.radians(150)
            rad = ro0 - (ro0 - ri0) * t
            pts.append(f'{f(cx + rad * math.cos(a))} {f(cy + rad * math.sin(a))}')
        arcs.append(f"<path d='M{' L'.join(pts)}' fill='none' stroke='{r['line']}' stroke-linecap='round' "
                    f"stroke-width='{6 if k % 2 else 3.5}' opacity='{0.55 if k % 2 else 0.36}'/>")
    out.append(f"<g mask='url(#{key}m)'>{''.join(arcs)}</g>")
    ro, ri = M + BAND / 2, M - BAND / 2
    # Outer rim highlight (top left) and inner rim glint (bottom right).
    out.append(arc_path(cx, cy, ro - 7, 200, 290, '#ffffff', 6, 0.75))
    out.append(arc_path(cx, cy, ri + 6, 20, 95, '#ffffff', 4, 0.4))
    out.append(f"<circle cx='{cx}' cy='{cy}' r='{ro}' fill='none' stroke='{r['lo']}' stroke-width='2.5' opacity='0.55'/>")
    out.append(f"<circle cx='{cx}' cy='{cy}' r='{ri}' fill='none' stroke='{r['lo']}' stroke-width='2' opacity='0.45'/>")
    return ''.join(out)


def arc_path(cx, cy, rad, a0, a1, color, width, op):
    p0 = (cx + rad * math.cos(math.radians(a0)), cy + rad * math.sin(math.radians(a0)))
    p1 = (cx + rad * math.cos(math.radians(a1)), cy + rad * math.sin(math.radians(a1)))
    large = 1 if (a1 - a0) % 360 > 180 else 0
    return (f"<path d='M{f(p0[0])} {f(p0[1])} A{f(rad)} {f(rad)} 0 {large} 1 {f(p1[0])} {f(p1[1])}' "
            f"fill='none' stroke='{color}' stroke-width='{width}' stroke-linecap='round' opacity='{op}'/>")


def crossings():
    (x1, y1), (x2, y2) = BLUE['c'], ORANGE['c']
    dx, dy = x2 - x1, y2 - y1
    d = math.hypot(dx, dy)
    a = d / 2
    h = math.sqrt(M * M - a * a)
    mx, my = x1 + dx / 2, y1 + dy / 2
    ux, uy = -dy / d, dx / d
    p, q = (mx + ux * h, my + uy * h), (mx - ux * h, my - uy * h)
    return sorted([p, q], key=lambda t: t[1])      # (upper, lower)


def below_centre_line():
    (x1, y1), (x2, y2) = BLUE['c'], ORANGE['c']
    d = math.hypot(x2 - x1, y2 - y1)
    assert d / 2 < M - BAND / 2, 'the crossings touch: the interlock would show a seam'
    ux, uy = (x2 - x1) / d, (y2 - y1) / d          # along the line
    nx, ny = -uy, ux                                 # its downward normal
    L = 3 * W
    pts = [(x1 - ux * L, y1 - uy * L), (x1 + ux * L, y1 + uy * L),
           (x1 + ux * L + nx * L, y1 + uy * L + ny * L), (x1 - ux * L + nx * L, y1 - uy * L + ny * L)]
    return ' '.join(f'{f(x)},{f(y)}' for x, y in pts)


def rings_svg():
    upper, lower = crossings()
    glow = ''.join(
        f"<circle cx='{r['c'][0]}' cy='{r['c'][1]}' r='{M}' fill='none' stroke='{r['glow']}' "
        f"stroke-width='{BAND + 34}' opacity='0.7' filter='url(#glow)'/>" for r in (BLUE, ORANGE))
    blue, orange = ring_body('b', BLUE, 0.35), ring_body('o', ORANGE, 2.2)
    # Interlock: orange crosses over blue at the top (drawn last), blue
    # over orange at the bottom: blue is redrawn clipped to the half-plane
    # below the line through both centres, which holds the whole lower
    # overlap and none of the upper one.
    return (glow + blue + orange
            + f"<g clip-path='url(#lowx)'>{blue}</g>")


def logo_svg(rounded):
    rng = random.Random(SEED)
    defs = ("<defs>"
            "<filter id='glow' x='-30%' y='-30%' width='160%' height='160%'><feGaussianBlur stdDeviation='24'/></filter>"
            f"<clipPath id='lowx'><polygon points='{below_centre_line()}'/></clipPath>"
            + ring_defs('b', BLUE) + ring_defs('o', ORANGE)
            + (f"<clipPath id='tile'><rect width='{W}' height='{W}' rx='{W * 0.2}'/></clipPath>" if rounded else '')
            + "<radialGradient id='vig' cx='50%' cy='48%' r='72%'><stop offset='0.55' stop-color='#000' stop-opacity='0'/>"
              "<stop offset='1' stop-color='#000' stop-opacity='0.32'/></radialGradient>"
            "</defs>")
    body = (map_svg(rng) + graticule_svg()
            + f"<rect width='{W}' height='{W}' fill='url(#vig)'/>"
            + rings_svg())
    if rounded:
        body = f"<g clip-path='url(#tile)'>{body}</g>"
    return (f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {W} {W}' width='{W}' height='{W}'>"
            + defs + body + "</svg>\n")


def main():
    root = Path(__file__).resolve().parent.parent
    out_icon = root / 'static' / 'icon.svg'
    out_full = root / 'assets' / 'logo-full.svg'
    if '--out' in sys.argv:           # preview: write both next to a path
        base = Path(sys.argv[sys.argv.index('--out') + 1])
        out_icon, out_full = base / 'icon.svg', base / 'logo-full.svg'
    out_icon.write_text(logo_svg(rounded=True))
    out_full.write_text(logo_svg(rounded=False))
    print('wrote', out_icon, out_full)
    if '--png' in sys.argv:
        rsvg = shutil.which('rsvg-convert')
        if not rsvg:
            sys.exit('--png needs rsvg-convert (librsvg); or render the SVGs with any SVG renderer')
        for src, dst, size in ((out_icon, root / 'static' / 'icon.png', 512),
                               (out_full, root / 'static' / 'icon-maskable.png', 512),
                               (out_full, root / 'assets' / 'icon-only.png', 1024)):
            subprocess.run([rsvg, '-w', str(size), '-h', str(size), '-o', str(dst), str(src)], check=True)
            print('wrote', dst)


if __name__ == '__main__':
    main()
