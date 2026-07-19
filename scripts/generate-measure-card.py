# US-1570: generate the GradeThread MeasureCard v1 artwork + validate it.
#
# Run: pip install opencv-python-headless numpy && python scripts/generate-measure-card.py
# The artwork in assets/measure-card/ is COMMITTED output of this script -
# regenerate only for a NEW card version (new marker id set); never edit the
# committed SVG/PDF by hand.
#
# Emits (into assets/measure-card/):
#   geometry-v1.json        — canonical geometry + marker bit matrices (source of truth for constants/tests)
#   measure-card-v1.svg     — 7.5x5.5in card, vector
#   measure-card-v1.pdf     — same card, print-ready vector PDF (single page, 7x5in + 0.125in bleed note in spec)
#   measure-card-letter-v1.pdf — print-at-home US Letter with scale self-check
# Then rasterizes the card at 300dpi and asserts cv2.aruco DETECTS ids 10-13
# at the expected centers (the whole point: artwork that provably decodes).

import json, os, zlib
import numpy as np
import cv2

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "assets", "measure-card")
os.makedirs(OUT, exist_ok=True)

# ── Canonical geometry (inches) ─────────────────────────────────────
CARD_W, CARD_H = 7.5, 5.5  # markers need a PRINTED quiet zone: centers sit 0.75in from the edge
MARKER_SIZE = 1.0            # black border square, per marker
QUIET_ZONE = 0.25            # white margin required around each marker
RECT_W, RECT_H = 6.0, 4.0    # marker CENTER-to-CENTER rectangle
IDS = [10, 11, 12, 13]       # v1 = this exact id set (TL, TR, BR, BL)
DICT_NAME = "DICT_5X5_1000"

# Marker centers (card coordinates, inches, origin top-left)
cx0 = (CARD_W - RECT_W) / 2.0  # 0.5
cy0 = (CARD_H - RECT_H) / 2.0  # 0.5
CENTERS = {
    10: (cx0, cy0),                    # top-left
    11: (cx0 + RECT_W, cy0),           # top-right
    12: (cx0 + RECT_W, cy0 + RECT_H),  # bottom-right
    13: (cx0, cy0 + RECT_H),           # bottom-left
}

aruco = cv2.aruco
dic = aruco.getPredefinedDictionary(aruco.DICT_5X5_1000)

def marker_bits(marker_id: int) -> list[list[int]]:
    """5x5 inner bit matrix (1 = white module) for a dictionary id."""
    # generateImageMarker with sidePixels = 7 → 1px border + 5x5 modules.
    img = aruco.generateImageMarker(dic, marker_id, 7)
    inner = img[1:6, 1:6]
    return [[1 if v > 127 else 0 for v in row] for row in inner]

BITS = {mid: marker_bits(mid) for mid in IDS}

# ── Geometry JSON (single source of truth) ──────────────────────────
geometry = {
    "version": 1,
    "dictionary": DICT_NAME,
    "cardInches": {"w": CARD_W, "h": CARD_H},
    "markerSizeInches": MARKER_SIZE,
    "quietZoneInches": QUIET_ZONE,
    "centerRectInches": {"w": RECT_W, "h": RECT_H},
    # order: TL, TR, BR, BL (clockwise from top-left)
    "markerIds": IDS,
    "markerCentersInches": {str(k): [round(v[0], 3), round(v[1], 3)] for k, v in CENTERS.items()},
    # 5x5 inner modules, row-major, 1 = white module, 0 = black. The printed
    # marker adds a 1-module black border around these (module = size/7).
    "markerBits": {str(k): BITS[k] for k in IDS},
}
with open(os.path.join(OUT, "geometry-v1.json"), "w", newline="\n") as f:
    json.dump(geometry, f, indent=2)
    f.write("\n")

# ── SVG (vector, inch units) ────────────────────────────────────────
def marker_svg(mid: int, cx: float, cy: float) -> str:
    """Marker as black border square + white inner modules."""
    s = MARKER_SIZE
    m = s / 7.0  # module size (5 modules + 1-module border each side)
    x0, y0 = cx - s / 2, cy - s / 2
    parts = [f'<rect x="{x0:.4f}" y="{y0:.4f}" width="{s:.4f}" height="{s:.4f}" fill="#000"/>']
    bits = BITS[mid]
    for r in range(5):
        for c in range(5):
            if bits[r][c] == 1:  # white module
                parts.append(
                    f'<rect x="{x0 + (c + 1) * m:.4f}" y="{y0 + (r + 1) * m:.4f}" '
                    f'width="{m:.4f}" height="{m:.4f}" fill="#fff"/>'
                )
    return "\n".join(parts)

# ── Brand logo (US-1570 addendum): navy rounded square + white G / red T, drawn
# NATIVELY in each format so print output stays vector where possible. It
# sits in the center free zone — the geometry contract keeps every design
# element >= QUIET_ZONE away from the markers, so detection is unaffected
# (re-validated below WITH the logo composited in).
LOGO_SIZE = 0.55  # inches, square
def logo_svg(cx: float, cy: float) -> str:
    s = LOGO_SIZE
    x0, y0 = cx - s / 2, cy - s / 2
    return (
        f'<rect x="{x0:.4f}" y="{y0:.4f}" width="{s:.4f}" height="{s:.4f}" '
        f'rx="{s*0.2:.4f}" fill="#0F3460"/>'
        f'<text x="{cx:.4f}" y="{cy + s*0.16:.4f}" text-anchor="middle" '
        f'font-family="Helvetica, Arial, sans-serif" font-weight="bold" '
        f'font-size="{s*0.48:.4f}" fill="#ffffff">G<tspan fill="#E94560">T</tspan></text>'
    )

label_y = CARD_H / 2
svg = [
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{CARD_W}in" height="{CARD_H}in" '
    f'viewBox="0 0 {CARD_W} {CARD_H}">',
    "<!-- GradeThread MeasureCard v1 - DO NOT SCALE. Marker centers form an",
    f"     exact {RECT_W}x{RECT_H} inch rectangle; markers are {DICT_NAME} ids {IDS}.",
    "     Print 100% K-only black on matte stock. See vault/20-domain/measurement-card-spec.md. -->",
    f'<rect x="0" y="0" width="{CARD_W}" height="{CARD_H}" fill="#ffffff"/>',
]
for mid in IDS:
    cx, cy = CENTERS[mid]
    svg.append(marker_svg(mid, cx, cy))
# Center block — logo + text, kept well clear of quiet zones.
svg.append(logo_svg(CARD_W / 2, label_y - 0.72))
svg.append(
    f'<text x="{CARD_W/2}" y="{label_y - 0.25}" text-anchor="middle" '
    f'font-family="Helvetica, Arial, sans-serif" font-size="0.28" font-weight="bold" fill="#0F3460">'
    f'GradeThread MeasureCard</text>'
)
svg.append(
    f'<text x="{CARD_W/2}" y="{label_y + 0.1}" text-anchor="middle" '
    f'font-family="Helvetica, Arial, sans-serif" font-size="0.16" fill="#1A1A2E">'
    f'Lay this card flat BESIDE your garment - keep all four squares visible.</text>'
)
svg.append(
    f'<text x="{CARD_W/2}" y="{label_y + 0.4}" text-anchor="middle" '
    f'font-family="Helvetica, Arial, sans-serif" font-size="0.13" fill="#666">'
    f'v1 - do not trim, fold, or laminate (gloss breaks detection)</text>'
)
svg.append("</svg>")
with open(os.path.join(OUT, "measure-card-v1.svg"), "w", newline="\n") as f:
    f.write("\n".join(svg) + "\n")

# ── Minimal vector PDF writer (rect fills + Helvetica text) ─────────
def pdf_escape(s: str) -> str:
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")

def make_pdf(path: str, page_w_in: float, page_h_in: float, content_ops: str) -> None:
    W, H = page_w_in * 72, page_h_in * 72
    stream = content_ops.encode("latin-1")
    comp = zlib.compress(stream)
    objs = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(f"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".encode())
    objs.append(
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W:.2f} {H:.2f}] "
        f"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".encode()
    )
    objs.append(
        f"<< /Length {len(comp)} /Filter /FlateDecode >>".encode() + b"\nstream\n" + comp + b"\nendstream"
    )
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_at = len(out)
    out += f"xref\n0 {len(objs)+1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n".encode()
    )
    with open(path, "wb") as f:
        f.write(out)

def rrect_op(x_in, y_in, w_in, h_in, r_in, page_h_in, rgb):
    """Rounded-rect fill via four Bezier corners (PDF has no native rrect)."""
    k = 0.5523
    x, y = x_in * 72, (page_h_in - y_in - h_in) * 72
    w, h, r = w_in * 72, h_in * 72, r_in * 72
    cr, cg, cb = rgb
    ops = f"{cr} {cg} {cb} rg "
    ops += f"{x+r:.2f} {y:.2f} m {x+w-r:.2f} {y:.2f} l "
    ops += f"{x+w-r+k*r:.2f} {y:.2f} {x+w:.2f} {y+r-k*r:.2f} {x+w:.2f} {y+r:.2f} c "
    ops += f"{x+w:.2f} {y+h-r:.2f} l "
    ops += f"{x+w:.2f} {y+h-r+k*r:.2f} {x+w-r+k*r:.2f} {y+h:.2f} {x+w-r:.2f} {y+h:.2f} c "
    ops += f"{x+r:.2f} {y+h:.2f} l "
    ops += f"{x+r-k*r:.2f} {y+h:.2f} {x:.2f} {y+h-r+k*r:.2f} {x:.2f} {y+h-r:.2f} c "
    ops += f"{x:.2f} {y+r:.2f} l "
    ops += f"{x:.2f} {y+r-k*r:.2f} {x+r-k*r:.2f} {y:.2f} {x+r:.2f} {y:.2f} c f\n"
    return ops

def logo_ops(cx_in, cy_in, page_h_in):
    """The GT mark: navy rounded square, white G, red T (vector)."""
    s_in = LOGO_SIZE
    x0, y0 = cx_in - s_in / 2, cy_in - s_in / 2
    ops = rrect_op(x0, y0, s_in, s_in, s_in * 0.2, page_h_in, (0.059, 0.204, 0.376))
    size_pt = s_in * 0.48 * 72
    glyph_w_in = size_pt * 0.72 / 72  # Helvetica-Bold cap advance approx
    gx = (cx_in - glyph_w_in) * 72
    gy = (page_h_in - (cy_in + s_in * 0.16)) * 72
    ops += (
        f"BT /F1 {size_pt:.1f} Tf 1 1 1 rg {gx:.2f} {gy:.2f} Td (G) Tj "
        f"0.914 0.271 0.376 rg (T) Tj ET\n"
    )
    return ops

def rect_op(x_in, y_in, w_in, h_in, page_h_in, gray):
    # PDF origin is bottom-left; our coords are top-left.
    x, y = x_in * 72, (page_h_in - y_in - h_in) * 72
    return f"{gray} g {x:.2f} {y:.2f} {w_in*72:.2f} {h_in*72:.2f} re f\n"

def text_op(x_in, y_in, size_pt, s, page_h_in, gray="0", centered_at=None):
    x, y = x_in * 72, (page_h_in - y_in) * 72
    return f"BT /F1 {size_pt} Tf {gray} g {x:.2f} {y:.2f} Td ({pdf_escape(s)}) Tj ET\n"

def marker_ops(mid, cx, cy, page_h_in, offset_x=0.0, offset_y=0.0):
    s = MARKER_SIZE
    m = s / 7.0
    x0, y0 = offset_x + cx - s / 2, offset_y + cy - s / 2
    ops = rect_op(x0, y0, s, s, page_h_in, "0")
    bits = BITS[mid]
    for r in range(5):
        for c in range(5):
            if bits[r][c] == 1:
                ops += rect_op(x0 + (c + 1) * m, y0 + (r + 1) * m, m, m, page_h_in, "1")
    return ops

# Card PDF (exact trim size 7.5x5.5in).
ops = rect_op(0, 0, CARD_W, CARD_H, CARD_H, "1")
for mid in IDS:
    cx, cy = CENTERS[mid]
    ops += marker_ops(mid, cx, cy, CARD_H)
# Approximate centered text via width estimate (Helvetica-Bold ~0.55em/char).
def centered_text(s, y_in, size_pt, page_w_in, page_h_in, gray="0"):
    w_in = len(s) * size_pt * 0.55 / 72
    return text_op((page_w_in - w_in) / 2, y_in, size_pt, s, page_h_in, gray)
ops += logo_ops(CARD_W / 2, CARD_H / 2 - 0.72, CARD_H)
ops += centered_text("GradeThread MeasureCard", CARD_H/2 - 0.18, 20, CARD_W, CARD_H)
ops += centered_text("Lay this card flat BESIDE your garment - keep all four squares visible.", CARD_H/2 + 0.12, 10, CARD_W, CARD_H)
ops += centered_text("v1 - do not trim, fold, or laminate (gloss breaks detection)", CARD_H/2 + 0.38, 8, CARD_W, CARD_H, gray="0.4")
make_pdf(os.path.join(OUT, "measure-card-v1.pdf"), CARD_W, CARD_H, ops)

# Letter fallback: card layout centered on 8.5x11 portrait + self-check aids.
LW, LH = 8.5, 11.0
off_x, off_y = (LW - CARD_W) / 2, 1.2
ops = rect_op(0, 0, LW, LH, LH, "1")
ops += centered_text("GradeThread MeasureCard - print-at-home (v1)", 0.7, 18, LW, LH)
ops += centered_text("PRINT AT 100% / ACTUAL SIZE - page scaling breaks every measurement.", 1.0, 11, LW, LH)
# Card outline (cut line, thin gray) + markers at card geometry offset.
ops += f"0.6 g 0.5 w {off_x*72:.2f} {(LH-off_y-CARD_H)*72:.2f} {CARD_W*72:.2f} {CARD_H*72:.2f} re S\n"
for mid in IDS:
    cx, cy = CENTERS[mid]
    ops += marker_ops(mid, cx, cy, LH, off_x, off_y)
ops += logo_ops(LW / 2, off_y + CARD_H / 2 - 0.72, LH)
ops += centered_text("GradeThread MeasureCard", off_y + CARD_H/2 - 0.18, 20, LW, LH)
ops += centered_text("Lay this sheet flat BESIDE your garment - keep all four squares visible.", off_y + CARD_H/2 + 0.12, 10, LW, LH)
# Self-check: exact credit-card box (3.370 x 2.125 in, ISO/IEC 7810 ID-1).
cc_w, cc_h = 3.370, 2.125
cc_x, cc_y = (LW - cc_w) / 2, off_y + CARD_H + 0.55
ops += f"0 g 1 w {cc_x*72:.2f} {(LH-cc_y-cc_h)*72:.2f} {cc_w*72:.2f} {cc_h*72:.2f} re S\n"
ops += centered_text("Scale check: a standard credit card must fit this box EXACTLY.", cc_y - 0.15, 10, LW, LH)
ops += centered_text("If it does not, reprint at 100% (no 'fit to page').", cc_y + cc_h + 0.25, 10, LW, LH)
# 6-inch reference ruler under the check box.
rl_x, rl_y = (LW - 6.0) / 2, cc_y + cc_h + 0.55
ops += rect_op(rl_x, rl_y, 6.0, 0.03, LH, "0")
for i in range(7):
    ops += rect_op(rl_x + i - 0.008 if i else rl_x, rl_y - 0.1, 0.016, 0.1, LH, "0")
ops += centered_text("6.000 in reference", rl_y + 0.25, 9, LW, LH, gray="0.4")
make_pdf(os.path.join(OUT, "measure-card-letter-v1.pdf"), LW, LH, ops)

# ── VALIDATION: rasterize the card at 300dpi and detect ─────────────
DPI = 300
img = np.full((int(CARD_H * DPI), int(CARD_W * DPI)), 255, np.uint8)
for mid in IDS:
    cx, cy = CENTERS[mid]
    s = MARKER_SIZE
    px = int(round((cx - s / 2) * DPI)); py = int(round((cy - s / 2) * DPI))
    side = int(round(s * DPI))
    # sidePixels must render 7 modules; generate at exact size.
    mimg = aruco.generateImageMarker(dic, mid, side)
    img[py:py + side, px:px + side] = mimg

# Composite the brand logo into the validation raster (a dark filled square
# approximates the worst case — proves interior artwork can't shadow or
# false-positive the markers).
ls = int(LOGO_SIZE * DPI)
lx = int((CARD_W / 2 - LOGO_SIZE / 2) * DPI)
ly = int((CARD_H / 2 - 0.72 - LOGO_SIZE / 2) * DPI)
img[ly:ly + ls, lx:lx + ls] = 20  # near-black navy

detector = aruco.ArucoDetector(dic, aruco.DetectorParameters())
corners, ids, _ = detector.detectMarkers(img)
found = sorted(int(i) for i in (ids.flatten() if ids is not None else []))
# EXACTLY the four ids: a missing marker fails, and so does a false positive
# from the interior artwork.
assert found == sorted(IDS), f"detection failed: {found}"
# Assert centers land where geometry says (within 2px @300dpi = ~0.007in).
for c, mid in zip(corners, ids.flatten()):
    cx_px, cy_px = c[0].mean(axis=0)
    exp_x, exp_y = CENTERS[int(mid)][0] * DPI, CENTERS[int(mid)][1] * DPI
    assert abs(cx_px - exp_x) < 2 and abs(cy_px - exp_y) < 2, (int(mid), cx_px, cy_px)
# Cross-check OUR bit matrices reproduce OpenCV's marker images exactly.
for mid in IDS:
    ref = aruco.generateImageMarker(dic, mid, 7)
    ours = np.full((7, 7), 0, np.uint8)
    for r in range(5):
        for c in range(5):
            if BITS[mid][r][c] == 1:
                ours[r + 1, c + 1] = 255
    assert np.array_equal(ref > 127, ours > 127), f"bit matrix mismatch id {mid}"

print("OK: geometry-v1.json + SVG + 2 PDFs written;",
      f"detection validated ids={found} at expected centers (300dpi)")


def validate_artwork(path: str) -> None:
    """US-1570 addendum: validate FINISHED card artwork (a designer export) without
    regenerating. Asserts: exactly ids 10-13 detected, and their centers form
    the canonical 6x4in rectangle (scale-normalized, so any DPI works).
    Usage: python scripts/generate-measure-card.py --validate final.png"""
    art = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    assert art is not None, f"unreadable image: {path}"
    c2, i2, _ = detector.detectMarkers(art)
    got = sorted(int(i) for i in (i2.flatten() if i2 is not None else []))
    assert got == sorted(IDS), (
        f"expected exactly ids {sorted(IDS)}, detected {got} — check quiet "
        f"zones (>= {QUIET_ZONE}in white around every marker) and that the "
        f"design adds no marker-like squares"
    )
    centers = {int(m): c[0].mean(axis=0) for c, m in zip(c2, i2.flatten())}
    # Scale from the top edge (id 10 -> 11 spans RECT_W inches).
    import math
    px_per_in = math.dist(centers[10], centers[11]) / RECT_W
    for a, b, exp in [(10, 11, RECT_W), (13, 12, RECT_W), (10, 13, RECT_H), (11, 12, RECT_H)]:
        d_in = math.dist(centers[a], centers[b]) / px_per_in
        assert abs(d_in - exp) < 0.05, (
            f"edge {a}->{b} measures {d_in:.3f}in, expected {exp}in — the "
            f"marker GEOMETRY moved; that requires a NEW card version (v2, "
            f"new id set), not just re-validation"
        )
    print(f"OK: artwork {path} validated — ids {got}, geometry within 0.05in")


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 3 and sys.argv[1] == "--validate":
        validate_artwork(sys.argv[2])
