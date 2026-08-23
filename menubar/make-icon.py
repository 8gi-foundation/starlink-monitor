#!/usr/bin/env python3
"""Generate the app icon: a dish throwing a signal arc.

Drawn rather than downloaded so the repo stays self-contained and the icon
matches the dashboard palette exactly (same teal, same near-black ground).
Emits icon.iconset/ for iconutil.
"""
import math
import os
import sys
from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else "icon.iconset"
S = 1024
GROUND = (14, 22, 25, 255)
TEAL = (47, 212, 193, 255)
TEAL_DIM = (29, 108, 101, 255)
INK = (231, 239, 239, 255)


def squircle_mask(size: int, radius_ratio: float = 0.225) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return m


def render(size: int) -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=GROUND)

    cx, cy = S * 0.5, S * 0.63

    # three signal arcs opening upward, widest at the top
    for i, (rad, col, w) in enumerate(
        [(S * 0.34, TEAL_DIM, 26), (S * 0.25, TEAL, 30), (S * 0.16, TEAL, 34)]
    ):
        box = [cx - rad, cy - rad, cx + rad, cy + rad]
        d.arc(box, start=203, end=337, fill=col, width=w)

    # the dish itself: a filled dot with a short mast
    d.ellipse([cx - S * 0.052, cy - S * 0.052, cx + S * 0.052, cy + S * 0.052], fill=INK)
    d.line([cx, cy + S * 0.04, cx, cy + S * 0.145], fill=INK, width=26)
    d.line(
        [cx - S * 0.075, cy + S * 0.145, cx + S * 0.075, cy + S * 0.145],
        fill=INK,
        width=26,
    )

    img.putalpha(squircle_mask(S))
    return img.resize((size, size), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)
for base in (16, 32, 128, 256, 512):
    render(base).save(f"{OUT}/icon_{base}x{base}.png")
    render(base * 2).save(f"{OUT}/icon_{base}x{base}@2x.png")
print(f"wrote {OUT}")
