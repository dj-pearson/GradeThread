# Build the PRESS deliverables for the v2 MeasureCard: a bleed master and a
# 12x18 4-up imposition.
#
# Why this script exists: the designer only ever produced a PDF at trim size
# (540x396pt = 7.5x5.5in), so measure-card-v2.pdf has NO bleed, and the v2 art
# runs dark to all four edges. Cutting at trim with zero bleed puts a white
# sliver on any card whose sheet feeds a hair off. There is no source file to
# re-export from, so the bleed is manufactured by MIRRORING the outer pixels
# outward (cv2.BORDER_REFLECT), which is safe here because the outer 0.25in of
# the design is soft dark background with no detail to duplicate visibly.
#
# NOTHING about the calibration geometry changes. The four ArUco markers keep
# ids {10,11,12,13} and their centers keep the exact 6.000 x 4.000in rectangle,
# so this is still a v1-geometry card (the id set IS the version). The markers
# are re-drawn as VECTOR over the JPEG background, same as the trim master.
#
# Input : assets/measure-card/measure-card-v2.png  (2250x1650 @300dpi, the
#         already-corrected raster: quiet-zone panels + pristine markers baked)
# Output (into assets/measure-card/):
#   measure-card-v2-bleed.pdf      - single card, 7.75x5.75in media,
#                                    TrimBox 7.5x5.5in, 0.125in bleed all round
#   measure-card-v2-12x18-4up.pdf  - 12x18in press sheet, 4 up, cards rotated
#                                    90deg, 0.25in gutter, trim guides + a
#                                    6.000in ruler for checking press scale
#
# Run: pip install opencv-python-headless numpy && python scripts/build-measure-card-v2-press.py

import os
import zlib
import math
import cv2

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "assets", "measure-card")
SRC = os.path.join(OUT, "measure-card-v2.png")

# ---- Canonical geometry (inches) - MUST match build-measure-card-v2-pdfs.py ----
DPI = 300
CARD_W, CARD_H = 7.5, 5.5
MARKER_SIZE = 1.0
RECT_W, RECT_H = 6.0, 4.0
IDS = [10, 11, 12, 13]
cx0 = (CARD_W - RECT_W) / 2.0   # 0.75
cy0 = (CARD_H - RECT_H) / 2.0   # 0.75
CENTERS = {                      # inches from card TOP-left
    10: (cx0, cy0),
    11: (cx0 + RECT_W, cy0),
    12: (cx0 + RECT_W, cy0 + RECT_H),
    13: (cx0, cy0 + RECT_H),
}

# ---- Press parameters ----
BLEED_IN = 0.125
PAD_PX = 38                      # >= 0.125in at 300dpi (37.5px), integer grid
SHEET_W, SHEET_H = 12.0, 18.0
GUTTER = 0.25                    # two facing 0.125in bleeds meet here

aruco = cv2.aruco
dic = aruco.getPredefinedDictionary(aruco.DICT_5X5_1000)


def marker_bits(mid):
    img = aruco.generateImageMarker(dic, mid, 7)
    inner = img[1:6, 1:6]
    return [[1 if v > 127 else 0 for v in row] for row in inner]


BITS = {mid: marker_bits(mid) for mid in IDS}

# ---- 1. Mirror the edges outward to manufacture bleed ----
art = cv2.imread(SRC, cv2.IMREAD_COLOR)
assert art is not None, "cannot read %s" % SRC
H, W = art.shape[:2]
assert (W, H) == (int(CARD_W * DPI), int(CARD_H * DPI)), \
    "source is %dx%d, expected %dx%d (7.5x5.5in @300dpi)" % (
        W, H, int(CARD_W * DPI), int(CARD_H * DPI))

bleed = cv2.copyMakeBorder(art, PAD_PX, PAD_PX, PAD_PX, PAD_PX, cv2.BORDER_REFLECT)
BH, BW = bleed.shape[:2]
assert (BW, BH) == (W + 2 * PAD_PX, H + 2 * PAD_PX)

# ---- 2. Validate: the mirror must not disturb or fake a marker ----
det = aruco.ArucoDetector(dic, aruco.DetectorParameters())
gray = cv2.cvtColor(bleed, cv2.COLOR_BGR2GRAY)
corners, ids, _ = det.detectMarkers(gray)
found = sorted(int(i) for i in (ids.flatten() if ids is not None else []))
assert found == sorted(IDS), "detection failed on the bleed raster: %s" % found
cmap = {int(m): c[0].mean(axis=0) for c, m in zip(corners, ids.flatten())}
px_per_in = math.dist(cmap[10], cmap[11]) / RECT_W
for a, b, exp in [(10, 11, RECT_W), (13, 12, RECT_W), (10, 13, RECT_H), (11, 12, RECT_H)]:
    d = math.dist(cmap[a], cmap[b]) / px_per_in
    assert abs(d - exp) < 0.05, "edge %d->%d=%.3fin expected %sin" % (a, b, d, exp)
print("OK: bleed raster %dx%d validated - ids %s, geometry within 0.05in" % (BW, BH, found))

ok, buf = cv2.imencode(".jpg", bleed, [cv2.IMWRITE_JPEG_QUALITY, 95])
assert ok
jpeg = buf.tobytes()

# Image extent in points, and how far it overhangs the card trim on every side.
IMG_W_PT = BW / DPI * 72.0
IMG_H_PT = BH / DPI * 72.0
OVER_PT = PAD_PX / DPI * 72.0            # 9.12pt (0.1267in) of mirrored margin
CARD_W_PT, CARD_H_PT = CARD_W * 72.0, CARD_H * 72.0
BLEED_PT = BLEED_IN * 72.0               # 9.00pt declared bleed


# ---- 3. Minimal PDF writer (one shared image XObject, N placements) ----
def pdf_escape(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def build_pdf(path, w_pt, h_pt, ops, boxes=""):
    comp = zlib.compress(ops.encode("latin-1"))
    page = ("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.2f %.2f] %s"
            "/Resources << /Font << /F1 5 0 R >> /XObject << /Im0 6 0 R >> >> "
            "/Contents 4 0 R >>") % (w_pt, h_pt, boxes)
    img = ("<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB "
           "/BitsPerComponent 8 /Filter /DCTDecode /Length %d >>") % (BW, BH, len(jpeg))
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        page.encode(),
        ("<< /Length %d /Filter /FlateDecode >>" % len(comp)).encode()
        + b"\nstream\n" + comp + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        img.encode() + b"\nstream\n" + jpeg + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offs = []
    for i, body in enumerate(objs, 1):
        offs.append(len(out))
        out += ("%d 0 obj\n" % i).encode() + body + b"\nendobj\n"
    xref = len(out)
    out += ("xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)).encode()
    for o in offs:
        out += ("%010d 00000 n \n" % o).encode()
    out += ("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
            % (len(objs) + 1, xref)).encode()
    with open(path, "wb") as f:
        f.write(out)


def rect(x, y, w, h, g="0"):
    """Filled rect in points, origin bottom-left."""
    return "%s g %.3f %.3f %.3f %.3f re f\n" % (g, x, y, w, h)


def line(x0, y0, x1, y1):
    return "%.3f %.3f m %.3f %.3f l S\n" % (x0, y0, x1, y1)


def card_ops():
    """One card drawn in CARD-LOCAL points: origin = trim bottom-left, y up.
    The mirrored background overhangs the trim by OVER_PT on every side."""
    s = "q %.3f 0 0 %.3f %.3f %.3f cm /Im0 Do Q\n" % (
        IMG_W_PT, IMG_H_PT, -OVER_PT, -OVER_PT)
    m = MARKER_SIZE * 72.0 / 7.0
    for mid in IDS:
        cxi, cyi = CENTERS[mid]
        cx, cy = cxi * 72.0, (CARD_H - cyi) * 72.0      # to bottom-left origin
        x0, y0 = cx - 36.0, cy - 36.0
        s += rect(x0, y0, 72.0, 72.0, "0")              # K-only marker square
        for r in range(5):
            for c in range(5):
                if BITS[mid][r][c] == 1:
                    s += rect(x0 + (c + 1) * m, y0 + 72.0 - (r + 2) * m, m, m, "1")
    return s


def place(x, y, rotated):
    """Wrap card_ops so the card TRIM box lands at (x,y) points on the sheet.
    rotated=True turns the card 90deg CCW: 5.5in across, 7.5in up."""
    if rotated:
        cm = "0 1 -1 0 %.3f %.3f cm" % (x + CARD_H_PT, y)
    else:
        cm = "1 0 0 1 %.3f %.3f cm" % (x, y)
    return "q " + cm + "\n" + card_ops() + "Q\n"


# ---- 4a. Single-card bleed master ----
pw, ph = CARD_W_PT + 2 * BLEED_PT, CARD_H_PT + 2 * BLEED_PT     # 558 x 414
boxes = ("/TrimBox [%.2f %.2f %.2f %.2f] /BleedBox [0 0 %.2f %.2f] "
         % (BLEED_PT, BLEED_PT, BLEED_PT + CARD_W_PT, BLEED_PT + CARD_H_PT, pw, ph))
build_pdf(os.path.join(OUT, "measure-card-v2-bleed.pdf"), pw, ph,
          place(BLEED_PT, BLEED_PT, False), boxes)

# ---- 4b. 12x18 four-up press sheet ----
SW, SH = SHEET_W * 72.0, SHEET_H * 72.0
block_w = 2 * CARD_H_PT + GUTTER * 72.0     # 11.25in across (cards rotated)
block_h = 2 * CARD_W_PT + GUTTER * 72.0     # 15.25in up
mx = (SW - block_w) / 2.0                   # 0.375in side margin
my = (SH - block_h) / 2.0                   # 1.375in head/tail margin
col_x = [mx, mx + CARD_H_PT + GUTTER * 72.0]
row_y = [my, my + CARD_W_PT + GUTTER * 72.0]

ops = ""
for x in col_x:
    for y in row_y:
        ops += place(x, y, True)

# Trim guides. Only in the OUTER margins - the 0.25in gutter is entirely
# consumed by the two facing bleeds, so a mark there would print on a card.
TICK, GAP = 0.15 * 72, 0.04 * 72
ops += "0 G 0.25 w\n"
for x in [col_x[0], col_x[0] + CARD_H_PT, col_x[1], col_x[1] + CARD_H_PT]:
    y0 = my - BLEED_PT - GAP
    ops += line(x, y0, x, y0 - TICK)
    y1 = my + block_h + BLEED_PT + GAP
    ops += line(x, y1, x, y1 + TICK)
for y in [row_y[0], row_y[0] + CARD_W_PT, row_y[1], row_y[1] + CARD_W_PT]:
    x0 = mx - BLEED_PT - GAP
    ops += line(x0, y, x0 - TICK, y)
    x1 = mx + block_w + BLEED_PT + GAP
    ops += line(x1, y, x1 + TICK, y)

# 6.000in press-scale ruler in the tail margin: measure this on a printed
# sheet. If it is not 6.000in the press is scaling and every card is wrong.
rx, ry = (SW - 6.0 * 72) / 2.0, 0.72 * 72
ops += rect(rx, ry, 6.0 * 72, 0.02 * 72, "0")
for i in range(7):
    tx = rx + i * 72.0 - (0.008 * 72 if i else 0)
    ops += rect(tx, ry - 0.1 * 72, 0.016 * 72, 0.1 * 72, "0")
slug = ("GradeThread MeasureCard v2  |  12x18 4-up  |  trim 7.5 x 5.5 in  |  "
        "bleed 0.125 in  |  PRINT AT 100 PERCENT, DO NOT SCALE  |  "
        "the bar below must measure 6.000 in")
ops += "BT /F1 7 Tf 0 g %.2f %.2f Td (%s) Tj ET\n" % (
    0.32 * 72, 0.42 * 72, pdf_escape(slug))

# Feed label. The DC-618 tops out at a 13in WIDTH, so a 12x18 sheet can only
# run 12in-edge-first - and that edge has to be this one, because the tail
# margin carries the ruler and slug. Sits 0.9in down from the lead edge so it
# stays clear of the 4-16mm band where the registration mark goes.
feed = "FEED THIS EDGE FIRST  (12 in lead edge - DC-618 max width is 13 in)"
ops += "BT /F1 9 Tf 0 g %.2f %.2f Td (%s) Tj ET\n" % (
    2.55 * 72, (SHEET_H - 0.9) * 72, pdf_escape(feed))
build_pdf(os.path.join(OUT, "measure-card-v2-12x18-4up.pdf"), SW, SH, ops)

for p in ["measure-card-v2-bleed.pdf", "measure-card-v2-12x18-4up.pdf"]:
    f = os.path.join(OUT, p)
    print("  assets/measure-card/%s  (%.0f KB)" % (p, os.path.getsize(f) / 1024))
print("  sheet margins: %.3fin sides, %.3fin head/tail, %sin gutter"
      % (mx / 72, my / 72, GUTTER))
print("done.")
