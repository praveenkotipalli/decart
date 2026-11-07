"""Turns still photos of hands into 1280x720 "camera frames" and fake-webcam clips.

    python -I scripts/qa/make_frames.py <photos_dir> <out_dir>

The photos are stock images that are NOT part of this repository (see README, "Testing
on real hands"). Outputs, all in <out_dir>:
  frames/<name>.jpg   one 1280x720 frame per scenario (what the camera would see, unmirrored)
  clips/<name>.mjpeg  the same scenario as a short clip Chrome can use as a fake webcam:
                      chrome --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<clip>

Run with -I: the photos directory is untrusted input and must not be on the import path.
"""
import io
import math
import os
import sys

from PIL import Image, ImageFilter

W, H = 1280, 720
FPS = 30


def load(path):
    im = Image.open(path)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (150, 156, 168, 255))
        im = Image.alpha_composite(bg, im)
    return im.convert("RGB")


def cover(im, ax=0.5, ay=0.5):
    """Scale to cover 1280x720 and crop; (ax, ay) is where the crop sits (0 = left/top)."""
    s = max(W / im.width, H / im.height)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    x = round((im.width - W) * ax)
    y = round((im.height - H) * ay)
    return im.crop((x, y, x + W, y + H))


def corner_colour(im):
    px = [im.getpixel(p) for p in ((4, 4), (im.width - 5, 4), (4, im.height // 2), (im.width - 5, im.height // 2))]
    return tuple(sum(c[i] for c in px) // len(px) for i in range(3))


def fit(im, scale=1.0):
    """Scale to fit inside 1280x720 (times `scale`) on a background of the photo's own corner colour."""
    s = min(W / im.width, H / im.height) * scale
    small = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    out = Image.new("RGB", (W, H), corner_colour(im))
    out.paste(small, ((W - small.width) // 2, (H - small.height) // 2))
    return out


def matte(im, tolerance=42):
    """Soft mask of everything that is not the plain backdrop (used to cut one hand out)."""
    bg = corner_colour(im)
    px = im.load()
    m = Image.new("L", im.size, 0)
    mp = m.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b = px[x, y]
            d = math.sqrt((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2)
            mp[x, y] = 255 if d > tolerance else 0
    return m.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1.6))


class Hand:
    """One cut-out hand that can be pasted mirrored / turned at a chosen place."""

    def __init__(self, photo, box, height):
        im = photo.crop(box)
        s = height / im.height
        self.im = im.resize((round(im.width * s), height), Image.LANCZOS)
        self.mask = matte(self.im)
        self.bg = corner_colour(photo)

    def paste(self, canvas, cx, top, mirror=False, vflip=False, rotate=0.0):
        im, mask = self.im, self.mask
        if mirror:
            im, mask = im.transpose(Image.FLIP_LEFT_RIGHT), mask.transpose(Image.FLIP_LEFT_RIGHT)
        if vflip:
            im, mask = im.transpose(Image.FLIP_TOP_BOTTOM), mask.transpose(Image.FLIP_TOP_BOTTOM)
        if rotate:
            im = im.rotate(rotate, resample=Image.BICUBIC, expand=True)
            mask = mask.rotate(rotate, resample=Image.BICUBIC, expand=True)
        canvas.paste(im, (round(cx - im.width / 2), round(top)), mask)


def write_clip(path, frames, seconds_each):
    """frames: list of PIL images shown in order; each is held for `seconds_each` seconds."""
    with open(path, "wb") as f:
        for im in frames:
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=88)
            data = buf.getvalue()
            for _ in range(max(1, round(seconds_each * FPS))):
                f.write(data)


def main():
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(os.path.join(out, "frames"), exist_ok=True)
    os.makedirs(os.path.join(out, "clips"), exist_ok=True)
    p = lambda name: load(os.path.join(src, name))
    frames = {}

    # ── Photos of real people ────────────────────────────────────────────────
    frames["a1_twoL_face"] = cover(p("a1_twoL-palms-out_face_pexels-6564416.jpg"), 0.5, 0.45)
    frames["a2_director_landscape"] = cover(p("a2_director-frame_landscape_unsplash-IDZwaNAZEW8.jpg"))
    frames["a3_director_portrait"] = cover(p("a3_director-frame_portrait_unsplash-ot508H6h0hE.jpg"), 0.5, 0.33)
    frames["a4_director_outdoor"] = cover(p("a4_director-frame_outdoor_pexels-33515543.jpg"), 0.5, 0.31)
    frames["a5_director_apart"] = cover(p("a5_director-frame_hands-apart_unsplash-9ti935hA3Es.jpg"), 0.5, 0.12)
    frames["b1_L_right_palm"] = fit(p("b1_L-right-palm_pexels-9017429.jpg"))
    frames["b2_L_right_palm_loose"] = fit(p("b2_L-right-palm-variant_pexels-9017567.jpg"))
    frames["b3_L_left_rotated"] = cover(p("b3_L-left-palm-rotated90_commons-Action-Unsplash.jpg"))
    frames["b4_L_with_face"] = cover(p("b4_L-with-face_commons-Loser-Sign-Engaged.jpg"), 0.5, 0.0)
    frames["c1_ok_right_palm"] = fit(p("c1_ok-right-palm_pexels-9017748.jpg"))
    frames["c2_ok_with_face"] = cover(p("c2_ok-with-face_commons-OK-Hand-Gesture.jpg"), 0.5, 0.15)
    frames["c3_ok_over_eye"] = cover(p("c3_ok-over-eye_pexels-3760741.jpg"))
    frames["c4_ok_left_back"] = cover(p("c4_ok-left-back_greenscreen_pexels-18148279.jpg"))
    frames["c5_ok_left_palm"] = cover(p("c5_ok-left-palm_dark-skin_pexels-7886753.jpg"))
    frames["d1_open_palm"] = fit(p("d1_open-palm-left_commons-Boys-palm.png"))
    frames["d2_open_back"] = fit(p("d2_open-back-left_commons-Hand-Fingers.jpg"))
    frames["n1_two_index_up"] = cover(p("n1_negative_two-index-up_thumbs-in_pexels-8637959.jpg"))
    for name in ("fist", "left_hands", "pointing_up", "right_hands", "thumb_up", "victory", "woman_hands"):
        frames[f"mp_{name}"] = fit(p(f"mediapipe_{name}.jpg"))

    # ── Two real L hands, composed: the reference pose and one hand turned over ─
    b1 = p("b1_L-right-palm_pexels-9017429.jpg")
    hand = Hand(b1, (240, 300, 1180, 1920), 640)      # the hand and forearm, about 370 px wide
    blank = lambda: Image.new("RGB", (W, H), hand.bg)

    def two(right=None):
        """Camera view (unmirrored): the user's right hand is on the left of the image, thumbs point inward."""
        c = blank()
        hand.paste(c, 330, 110)
        if right is None:
            hand.paste(c, 950, 110, mirror=True)
        else:
            right(c)
        return c

    frames["s_twoL"] = two()
    # Turned over about the forearm: same silhouette, mirrored — the back of the hand faces the camera.
    frames["s_twoL_B_facing_flipped"] = two(lambda c: hand.paste(c, 950, 110))
    # Tipped over: index pointing down, thumb on top — the frame's right side is upside down (a bow-tie).
    frames["s_twoL_B_tipped"] = two(lambda c: hand.paste(c, 950, -30, mirror=True, vflip=True))
    frames["s_oneL"] = (lambda c: (hand.paste(c, 330, 110), c)[1])(blank())
    frames["s_empty"] = blank()

    for name, im in frames.items():
        im.save(os.path.join(out, "frames", f"{name}.jpg"), "JPEG", quality=92)

    # ── Clips ────────────────────────────────────────────────────────────────
    clip = lambda name, seq, secs: write_clip(os.path.join(out, "clips", f"{name}.mjpeg"), [frames[n] for n in seq], secs)
    for name in frames:
        clip(name, [name], 2)
    # The whole story: nothing, one L, two Ls, hand B turned over and back, tipped over and back, hands gone.
    clip("story_flip", ["s_empty", "s_oneL", "s_twoL", "s_twoL_B_facing_flipped", "s_twoL", "s_twoL_B_tipped", "s_twoL", "s_empty"], 2.5)
    print(f"{len(frames)} frames and {len(frames) + 1} clips written to {out}")


if __name__ == "__main__":
    main()
