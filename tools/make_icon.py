#!/usr/bin/env python3
"""Build the app icon: an uploaded route climbing a hill, part of it walked.

Writes icons/icon.svg and icons/icon-maskable.svg. The PNGs beside them are
rasterised from these with headless Chromium at 512 and 192 px; any SVG
rasteriser will do, as the artwork uses nothing exotic.

The icon says what the app is in one glance: a route line that somebody brought
with them, drawn over ground, with the walked part of it in the same green the
map uses and the rest in the same orange. The pin at the top is the finish, and
the dot at the bottom is where the file said to start.

Run:  python3 tools/make_icon.py && python3 tools/rasterise.py
"""
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(os.path.dirname(HERE), "icons")

BG_TOP, BG_BOT = "#16392f", "#091512"
FAR = "#2c7259"
RIDGE = "#1b5744"
HILL = "#0b2a22"
ROUTE = "#ff5a3c"
DONE = "#35d39a"
INK = "#062018"

# The route runs from low-left to high-right with two switchbacks, which is what
# makes it read as a path over ground rather than as a squiggle.
START = (150.0, 430.0)
END = (352.0, 138.0)


def centreline(t):
    """t = 0 at the start dot, 1 at the finish pin."""
    x = START[0] + (END[0] - START[0]) * t
    y = START[1] + (END[1] - START[1]) * t
    # two switchbacks, tightening as the route climbs
    x += 86 * math.sin(t * 2.0 * math.pi) * (1 - 0.45 * t)
    return x, y


def path_d(t0, t1, steps=48):
    pts = [centreline(t0 + (t1 - t0) * i / steps) for i in range(steps + 1)]
    d = "M%.1f %.1f" % pts[0]
    for x, y in pts[1:]:
        d += " L%.1f %.1f" % (x, y)
    return d


# How much of the route is drawn as already walked. Just over a third: enough to
# read as progress, little enough that the orange is plainly the main colour.
WALKED = 0.38


def scene(rounded):
    clip = ' clip-path="url(#r)"' if rounded else ""
    corner = '<clipPath id="r"><rect width="512" height="512" rx="114"/></clipPath>' if rounded else ""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{BG_TOP}"/><stop offset="1" stop-color="{BG_BOT}"/>
    </linearGradient>
    {corner}
  </defs>
  <g{clip}>
    <rect width="512" height="512" fill="url(#sky)"/>

    <!-- ground: three ridges, far to near, so the route has something to climb -->
    <path d="M-40 250 L110 176 L214 232 L330 150 L430 206 L552 158 L552 512 L-40 512 Z" fill="{FAR}" opacity=".55"/>
    <path d="M-40 316 L96 244 L226 306 L352 224 L470 288 L552 250 L552 512 L-40 512 Z" fill="{RIDGE}"/>
    <path d="M-40 398 L128 332 L268 392 L404 330 L552 386 L552 512 L-40 512 Z" fill="{HILL}"/>

    <!-- the route: a dark bed under it, so it reads on any ridge it crosses -->
    <path d="{path_d(0, 1)}" fill="none" stroke="{INK}" stroke-width="46"
          stroke-linecap="round" stroke-linejoin="round" opacity=".55"/>
    <path d="{path_d(0, 1)}" fill="none" stroke="{ROUTE}" stroke-width="28"
          stroke-linecap="round" stroke-linejoin="round"/>
    <path d="{path_d(0, WALKED)}" fill="none" stroke="{DONE}" stroke-width="28"
          stroke-linecap="round" stroke-linejoin="round"/>

    <!-- the finish, where the file's last point is -->
    <g transform="translate({END[0] - 46:.1f} {END[1] - 122:.1f}) scale(3.9)">
      <path d="M12 29.2C12 29.2 21.6 18.4 21.6 11.6A9.6 9.6 0 002.4 11.6C2.4 18.4 12 29.2 12 29.2Z"
            fill="{DONE}" stroke="{INK}" stroke-width="1.2"/>
      <circle cx="12" cy="11.4" r="4.1" fill="{INK}"/>
    </g>

    <!-- the start, where the file's first point is -->
    <circle cx="{START[0]:.1f}" cy="{START[1]:.1f}" r="30" fill="{INK}" opacity=".55"/>
    <circle cx="{START[0]:.1f}" cy="{START[1]:.1f}" r="21" fill="#f4fbf8"/>
    <circle cx="{START[0]:.1f}" cy="{START[1]:.1f}" r="12" fill="{DONE}"/>
  </g>
</svg>
"""


def main():
    os.makedirs(ICONS, exist_ok=True)
    with open(os.path.join(ICONS, "icon.svg"), "w", encoding="utf-8") as f:
        f.write(scene(rounded=True))
    # Maskable icons are cropped to whatever shape the launcher likes, so the
    # artwork runs to the edges and nothing important sits outside the safe
    # circle (40% radius from the centre).
    with open(os.path.join(ICONS, "icon-maskable.svg"), "w", encoding="utf-8") as f:
        f.write(scene(rounded=False))
    print("wrote icons/icon.svg, icons/icon-maskable.svg")


if __name__ == "__main__":
    main()
