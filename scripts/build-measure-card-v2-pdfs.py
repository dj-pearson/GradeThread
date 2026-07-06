# Build the v2 (designed) MeasureCard deliverables from the designer raster.
#
# The v2 art is a REDESIGN of the v1 card: SAME ArUco ids {10,11,12,13} and the
# SAME 6x4in center-to-center geometry (verified by --validate). It is therefore
# NOT a new card version in the calibration sense (the marker id set IS the
# version), so geometry-v1.json / lib/measure-card.ts / MEASURE_CARD_VERSIONS
# are untouched. Only the printed/downloaded ARTWORK changes.
#
# Input : assets/measure-card-v2.png  (designer export, 2250x1650 @ 300dpi)
# Output (into assets/measure-card/):
#   measure-card-v2.png          — art + 0.25in white quiet-zone panels + pristine markers
#   measure-card-v2.pdf          — trim-size print master (7.5x5.5in), JPEG bg + VECTOR markers
#   measure-card-letter-v2.pdf   — print-at-home US-Letter w/ scale self-check
# Also copies the letter PDF to public/ for the in-app download.
#
# Why JPEG-bg + vector markers: keeps markers razor-sharp and near-K-black for
# detection/print while compressing the rich dark background (18MB raster -> ~1MB),
# and the white quiet-zone panels (baked into the raster) give every marker the
# spec-required 0.25in paper-white ring.
#
# Run: pip install opencv-python-headless numpy && python scripts/build-measure-card-v2-pdfs.py

import os, zlib, shutil, math
import numpy as np
import cv2

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(REPO, "assets")
OUT = os.path.join(ASSETS, "measure-card")
PUBLIC = os.path.join(REPO, "public")
DESIGN = os.path.join(ASSETS, "measure-card-v2.png")

# ── Canonical geometry (inches) — MUST match generate-measure-card.py v1 ──
DPI = 300
CARD_W, CARD_H = 7.5, 5.5
MARKER_SIZE = 1.0
QUIET_ZONE = 0.25
RECT_W, RECT_H = 6.0, 4.0
IDS = [10, 11, 12, 13]
cx0 = (CARD_W - RECT_W) / 2.0   # 0.75
cy0 = (CARD_H - RECT_H) / 2.0   # 0.75
CENTERS = {
    10: (cx0, cy0),
    11: (cx0 + RECT_W, cy0),
    12: (cx0 + RECT_W, cy0 + RECT_H),
    13: (cx0, cy0 + RECT_H),
}

aruco = cv2.aruco
dic = aruco.getPredefinedDictionary(aruco.DICT_5X5_1000)

def marker_bits(mid):
    img = aruco.generateImageMarker(dic, mid, 7)
    inner = img[1:6, 1:6]
    return [[1 if v > 127 else 0 for v in row] for row in inner]
BITS = {mid: marker_bits(mid) for mid in IDS}

# ── 1. Composite quiet-zone panels + pristine markers onto the design ──
def rounded_rect(img, x0, y0, x1, y1, r, color):
    x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
    cv2.rectangle(img, (x0 + r, y0), (x1 - r, y1), color, -1)
    cv2.rectangle(img, (x0, y0 + r), (x1, y1 - r), color, -1)
    for cx, cy in [(x0 + r, y0 + r), (x1 - r, y0 + r), (x0 + r, y1 - r), (x1 - r, y1 - r)]:
        cv2.circle(img, (cx, cy), r, color, -1)

art = cv2.imread(DESIGN, cv2.IMREAD_COLOR)
assert art is not None, f"cannot read {DESIGN}"
H, W = art.shape[:2]
assert (W, H) == (int(CARD_W * DPI), int(CARD_H * DPI)), \
    f"design is {W}x{H}, expected {int(CARD_W*DPI)}x{int(CARD_H*DPI)} (7.5x5.5in @300dpi)"

marker_px = int(round(MARKER_SIZE * DPI))          # 300
chip_px = int(round((MARKER_SIZE + 2 * QUIET_ZONE) * DPI))  # 450
half_m = marker_px // 2
half_c = chip_px // 2
WHITE = (255, 255, 255)

for mid in IDS:
    cxi, cyi = CENTERS[mid]
    cx, cy = int(round(cxi * DPI)), int(round(cyi * DPI))
    # 0.25in white quiet-zone panel (rounded), clamped to card
    rounded_rect(art, max(cx - half_c, 0), max(cy - half_c, 0),
                 min(cx + half_c, W), min(cy + half_c, H), 50, WHITE)
    # pristine marker on top
    m = aruco.generateImageMarker(dic, mid, marker_px)
    m3 = cv2.cvtColor(m, cv2.COLOR_GRAY2BGR)
    art[cy - half_m:cy - half_m + marker_px, cx - half_m:cx - half_m + marker_px] = m3

corrected_png = os.path.join(OUT, "measure-card-v2.png")
cv2.imwrite(corrected_png, art)

# ── 2. Validate the corrected raster (the gate) ──
det = aruco.ArucoDetector(dic, aruco.DetectorParameters())
gray = cv2.cvtColor(art, cv2.COLOR_BGR2GRAY)
corners, ids, _ = det.detectMarkers(gray)
found = sorted(int(i) for i in (ids.flatten() if ids is not None else []))
assert found == sorted(IDS), f"detection failed after compositing: {found}"
cmap = {int(m): c[0].mean(axis=0) for c, m in zip(corners, ids.flatten())}
px_per_in = math.dist(cmap[10], cmap[11]) / RECT_W
for a, b, exp in [(10, 11, RECT_W), (13, 12, RECT_W), (10, 13, RECT_H), (11, 12, RECT_H)]:
    d = math.dist(cmap[a], cmap[b]) / px_per_in
    assert abs(d - exp) < 0.05, f"edge {a}->{b}={d:.3f}in expected {exp}in"
# confirm the quiet zone is now really white
for mid in IDS:
    cxi, cyi = CENTERS[mid]
    cx, cy = int(cxi * DPI), int(cyi * DPI)
    outward = -1 if cx < W / 2 else 1
    probe_x = cx + outward * (half_m + int(0.12 * DPI))  # 0.12in outside marker
    val = int(gray[cy, min(max(probe_x, 0), W - 1)])
    assert val >= 240, f"id {mid}: quiet zone not white ({val})"
print(f"OK: corrected raster validated — ids {found}, geometry within 0.05in, quiet zones white")

# ── 3. Minimal PDF writer with one JPEG image XObject + vector ops ──
def pdf_escape(s):
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")

def build_pdf(path, page_w_in, page_h_in, jpeg, img_wh, place, ops):
    W_pt, H_pt = page_w_in * 72, page_h_in * 72
    iw, ih = img_wh
    px, py_top, pw, ph = place  # inches, top-left origin
    py_bottom = page_h_in - py_top - ph
    content = (
        f"q\n{pw*72:.2f} 0 0 {ph*72:.2f} {px*72:.2f} {py_bottom*72:.2f} cm\n/Im0 Do\nQ\n" + ops
    ).encode("latin-1")
    comp = zlib.compress(content)
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W_pt:.2f} {H_pt:.2f}] "
         f"/Resources << /Font << /F1 5 0 R >> /XObject << /Im0 6 0 R >> >> "
         f"/Contents 4 0 R >>").encode(),
        (f"<< /Length {len(comp)} /Filter /FlateDecode >>").encode() + b"\nstream\n" + comp + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
        (f"<< /Type /XObject /Subtype /Image /Width {iw} /Height {ih} /ColorSpace /DeviceRGB "
         f"/BitsPerComponent 8 /Filter /DCTDecode /Length {len(jpeg)} >>").encode()
        + b"\nstream\n" + jpeg + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offs = []
    for i, body in enumerate(objs, 1):
        offs.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs)+1}\n0000000000 65535 f \n".encode()
    for o in offs:
        out += f"{o:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    with open(path, "wb") as f:
        f.write(out)

def rect_op(x, y, w, h, page_h, gray):
    return f"{gray} g {x*72:.2f} {(page_h-y-h)*72:.2f} {w*72:.2f} {h*72:.2f} re f\n"

def marker_ops(mid, cx, cy, page_h, ox=0.0, oy=0.0):
    s = MARKER_SIZE; m = s / 7.0
    x0, y0 = ox + cx - s / 2, oy + cy - s / 2
    ops = rect_op(x0, y0, s, s, page_h, "0")
    for r in range(5):
        for c in range(5):
            if BITS[mid][r][c] == 1:
                ops += rect_op(x0 + (c + 1) * m, y0 + (r + 1) * m, m, m, page_h, "1")
    return ops

def text_c(s, y, size, page_w, page_h, gray="0"):
    w = len(s) * size * 0.55 / 72
    x = (page_w - w) / 2
    return f"BT /F1 {size} Tf {gray} g {x*72:.2f} {(page_h-y)*72:.2f} Td ({pdf_escape(s)}) Tj ET\n"

# JPEG of the corrected card (RGB); markers get redrawn crisp on top in vector.
rgb = cv2.cvtColor(art, cv2.COLOR_BGR2RGB)
ok, buf = cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
jpeg = buf.tobytes()

# 3a. Trim master (full-bleed card).
ops = "".join(marker_ops(mid, *CENTERS[mid], CARD_H) for mid in IDS)
build_pdf(os.path.join(OUT, "measure-card-v2.pdf"), CARD_W, CARD_H, jpeg,
          (W, H), (0.0, 0.0, CARD_W, CARD_H), ops)

# 3b. Letter print-at-home (card centered on 8.5x11 + scale self-checks).
LW, LH = 8.5, 11.0
ox, oy = (LW - CARD_W) / 2, 1.2
ops = text_c("GradeThread MeasureCard - print-at-home", 0.7, 18, LW, LH)
ops += text_c("PRINT AT 100% / ACTUAL SIZE - page scaling breaks every measurement.", 1.0, 11, LW, LH)
ops += "".join(marker_ops(mid, *CENTERS[mid], LH, ox, oy) for mid in IDS)
# credit-card scale check
cc_w, cc_h = 3.370, 2.125
cc_x, cc_y = (LW - cc_w) / 2, oy + CARD_H + 0.55
ops += f"0 g 1 w {cc_x*72:.2f} {(LH-cc_y-cc_h)*72:.2f} {cc_w*72:.2f} {cc_h*72:.2f} re S\n"
ops += text_c("Scale check: a standard credit card must fit this box EXACTLY.", cc_y - 0.15, 10, LW, LH)
ops += text_c("If it does not, reprint at 100% (no 'fit to page').", cc_y + cc_h + 0.25, 10, LW, LH)
# 6in ruler
rl_x, rl_y = (LW - 6.0) / 2, cc_y + cc_h + 0.55
ops += rect_op(rl_x, rl_y, 6.0, 0.03, LH, "0")
for i in range(7):
    ops += rect_op(rl_x + (i or 0) - (0.008 if i else 0), rl_y - 0.1, 0.016, 0.1, LH, "0")
ops += text_c("6.000 in reference", rl_y + 0.25, 9, LW, LH, gray="0.4")
letter = os.path.join(OUT, "measure-card-letter-v2.pdf")
build_pdf(letter, LW, LH, jpeg, (W, H), (ox, oy, CARD_W, CARD_H), ops)

# ── 4. Serve the letter PDF for the in-app download ──
os.makedirs(PUBLIC, exist_ok=True)
shutil.copyfile(letter, os.path.join(PUBLIC, "measure-card-letter-v2.pdf"))

for p in [corrected_png, os.path.join(OUT, "measure-card-v2.pdf"), letter,
          os.path.join(PUBLIC, "measure-card-letter-v2.pdf")]:
    print(f"  {os.path.relpath(p, REPO)}  ({os.path.getsize(p)/1024:.0f} KB)")
print("done.")
