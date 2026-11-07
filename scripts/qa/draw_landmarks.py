"""Draws the landmarks of a fixture over its frames, to check by eye what MediaPipe saw.

    python -I scripts/qa/draw_landmarks.py <frames_dir> <fixture.json> <out_dir> [name ...]
"""
import json
import os
import sys

from PIL import Image, ImageDraw

BONES = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11), (11, 12),
         (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (17, 18), (18, 19), (19, 20), (0, 17)]


def main():
    frames_dir, fixture, out = sys.argv[1:4]
    only = set(sys.argv[4:])
    os.makedirs(out, exist_ok=True)
    data = json.load(open(fixture, encoding="utf-8"))
    for fr in data["frames"]:
        if only and fr["name"] not in only:
            continue
        im = Image.open(os.path.join(frames_dir, fr["name"] + ".jpg")).convert("RGB")
        d = ImageDraw.Draw(im)
        w, h = im.size
        for hand in fr["hands"]["landmarks"]:
            pts = [(p["x"] * w, p["y"] * h) for p in hand]
            for a, b in BONES:
                d.line([pts[a], pts[b]], fill=(40, 255, 120), width=2)
            for i, (x, y) in enumerate(pts):
                tip = i in (4, 8, 12, 16, 20)
                r = 6 if tip else 3
                d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 60, 60) if i == 4 else (60, 140, 255) if i == 8 else (255, 255, 255), outline=(0, 0, 0))
        for f in fr["faces"]:
            d.rectangle([f["x"] * w, f["y"] * h, (f["x"] + f["w"]) * w, (f["y"] + f["h"]) * h], outline=(255, 220, 0), width=2)
        im.save(os.path.join(out, fr["name"] + ".jpg"), "JPEG", quality=85)


if __name__ == "__main__":
    main()
