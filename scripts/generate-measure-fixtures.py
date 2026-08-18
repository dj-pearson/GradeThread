# US-1572: deterministic MeasureCard calibration fixtures.
#
# Renders the v1 card into photo-like scenes (straight-on, tilted 15/30 deg,
# small-in-frame, one marker occluded, blurred), then runs REAL OpenCV ArUco
# detection on each and records its detections as ground truth. The edge's
# pure-TS detector (lib/measure-detect.ts) is asserted against these outputs
# in src/tests/measure-detect_test.ts — so the TS port cannot silently drift
# from OpenCV.
#
# Run: pip install opencv-python-headless numpy && python scripts/generate-measure-fixtures.py
# Output: services/edge-functions/src/tests/fixtures/measure-card/*.png + manifest.json
# Deterministic: fixed sizes, fixed warps, fixed blur kernel — no randomness.

import json
import os

import cv2
import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(
    REPO, "services", "edge-functions", "src", "tests", "fixtures", "measure-card"
)
os.makedirs(OUT, exist_ok=True)

GEOM = json.load(open(os.path.join(REPO, "assets", "measure-card", "geometry-v1.json")))
CARD_W = GEOM["cardInches"]["w"]
CARD_H = GEOM["cardInches"]["h"]
IDS = GEOM["markerIds"]
CENTERS = {int(k): v for k, v in GEOM["markerCentersInches"].items()}
MARKER = GEOM["markerSizeInches"]

aruco = cv2.aruco
dic = aruco.getPredefinedDictionary(aruco.DICT_5X5_1000)
detector = aruco.ArucoDetector(dic, aruco.DetectorParameters())


def render_card(dpi: int) -> np.ndarray:
    """Flat top-down card render at `dpi`, white background."""
    img = np.full((round(CARD_H * dpi), round(CARD_W * dpi)), 255, np.uint8)
    for mid in IDS:
        cx, cy = CENTERS[mid]
        side = round(MARKER * dpi)
        px = round((cx - MARKER / 2) * dpi)
        py = round((cy - MARKER / 2) * dpi)
        img[py : py + side, px : px + side] = aruco.generateImageMarker(dic, mid, side)
    return img


def scene(card: np.ndarray, canvas_wh, offset_xy, bg=170) -> np.ndarray:
    """Place the card on a mid-gray 'table' canvas (photo-like)."""
    W, H = canvas_wh
    ox, oy = offset_xy
    out = np.full((H, W), bg, np.uint8)
    ch, cw = card.shape
    out[oy : oy + ch, ox : ox + cw] = card
    return out


def tilt(img: np.ndarray, deg: float) -> np.ndarray:
    """Perspective 'tilt' about the horizontal axis by shrinking the top edge."""
    h, w = img.shape
    k = np.sin(np.radians(deg)) * 0.5
    dx = w * k / 2
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32([[dx, 0], [w - dx, 0], [w, h], [0, h]])
    M = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(img, M, (w, h), borderValue=170)


def detect(img: np.ndarray):
    corners, ids, _ = detector.detectMarkers(img)
    out = []
    if ids is None:
        return out
    for c, mid in zip(corners, ids.flatten()):
        pts = c[0]
        out.append(
            {
                "id": int(mid),
                "center": [float(pts[:, 0].mean()), float(pts[:, 1].mean())],
                "corners": [[float(x), float(y)] for x, y in pts],
            }
        )
    return sorted(out, key=lambda m: m["id"])


fixtures = []


def emit(name: str, img: np.ndarray, expect: str, note: str):
    path = os.path.join(OUT, f"{name}.png")
    cv2.imwrite(path, img)
    det = detect(img)
    fixtures.append(
        {
            "name": name,
            "file": f"{name}.png",
            "expect": expect,  # 'calibrates' | 'fails'
            "note": note,
            "width": int(img.shape[1]),
            "height": int(img.shape[0]),
            "opencv": det,
        }
    )
    print(f"{name}: opencv found {[m['id'] for m in det]}")


# 1) Straight-on, generous resolution (marker ~110px).
card = render_card(110)
emit(
    "straight-on",
    scene(card, (1100, 850), (120, 100)),
    "calibrates",
    "flat top-down, markers ~110px",
)

# 2) 15-degree tilt.
emit(
    "tilt-15",
    tilt(scene(card, (1100, 850), (120, 100)), 15),
    "calibrates",
    "mild perspective — homography must absorb it",
)

# 3) 30-degree tilt.
emit(
    "tilt-30",
    tilt(scene(card, (1100, 850), (120, 100)), 30),
    "calibrates",
    "strong perspective — still within tolerance",
)

# 4) Small in frame: markers ~45px (just above the 40px gate).
small = render_card(45)
emit(
    "small-in-frame",
    scene(small, (1000, 700), (300, 180)),
    "calibrates",
    "card far from camera; markers just above MIN_MARKER_SIDE_PX",
)

# 4b) US-2672: the large-garment shot. The card is 24px-per-inch and sits in the
# corner of a wide, mostly FLAT frame - which is what a pair of pants laid out on
# a floor actually looks like. Two separate gates used to reject this: a 40px
# minimum marker side (a proxy for accuracy that really measured how much of the
# frame the card filled) and a frame-wide blur score that the flat fabric dragged
# under its threshold. Both are properties of the garment, not the photograph.
tiny = render_card(24)
tiny_scene = scene(tiny, (1600, 1200), (90, 840))
emit(
    "tiny-in-frame-large-garment",
    tiny_scene,
    "calibrates",
    "24px markers in a wide flat frame - the big-garment case",
)

# 5) One marker occluded (a 'sleeve' covers the bottom-left marker).
occluded_scene = scene(card, (1100, 850), (120, 100))
mx, my = CENTERS[13]
x0 = int((120 + (mx - 0.9) * 110))
y0 = int((100 + (my - 0.9) * 110))
cv2.rectangle(occluded_scene, (x0, y0), (x0 + 220, y0 + 220), 120, -1)
emit(
    "occluded-marker",
    occluded_scene,
    "fails",
    "bottom-left marker covered -> card_not_fully_visible",
)

# 6) Blurred: heavy gaussian on the straight-on scene.
blurred = cv2.GaussianBlur(scene(card, (1100, 850), (120, 100)), (31, 31), 8)
emit(
    "blurred",
    blurred,
    "fails",
    "heavy blur -> photo_too_blurry (or detection failure)",
)

manifest = {
    "geometry": "assets/measure-card/geometry-v1.json",
    "generator": "scripts/generate-measure-fixtures.py",
    "opencv": cv2.__version__,
    "fixtures": fixtures,
}
with open(os.path.join(OUT, "manifest.json"), "w", newline="\n") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print(f"manifest written ({len(fixtures)} fixtures), opencv {cv2.__version__}")
