#!/usr/bin/env python3
"""Rasterise the icon SVGs to the PNGs the web app manifest needs.

    pip install cairosvg
    python3 tools/rasterise.py

The PNGs are committed, so this only needs running when tools/make_icon.py
changes the artwork. Any other SVG rasteriser produces the same three files —
headless Chromium was tried first and rejected: its --screenshot only paints
the visible viewport, which is shorter than the window it is asked for, so the
bottom of a 512 px icon came out blank.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(os.path.dirname(HERE), "icons")

TARGETS = [
    ("icon.svg", "icon-512.png", 512),
    ("icon.svg", "icon-192.png", 192),
    ("icon-maskable.svg", "icon-maskable-512.png", 512),
]


def main():
    try:
        import cairosvg
    except ImportError:
        raise SystemExit("cairosvg is needed to rasterise the icons: pip install cairosvg")

    for svg, png, size in TARGETS:
        cairosvg.svg2png(
            url=os.path.join(ICONS, svg),
            write_to=os.path.join(ICONS, png),
            output_width=size,
            output_height=size,
        )
        print("wrote icons/%s (%d px)" % (png, size))


if __name__ == "__main__":
    main()
