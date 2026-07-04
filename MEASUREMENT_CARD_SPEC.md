# GradeThread MeasureCard v1 — Commercial Print Specification

The MeasureCard is a fiducial reference card subscribers lay **beside** a
garment in one photo. Four ArUco markers give the CV pipeline absolute scale
and perspective correction, so the geometry below is **functional, not
decorative** — a card printed out of tolerance produces wrong measurements on
every listing it touches.

Files (in `assets/measure-card/`, all generated + detection-validated by
`scripts/generate-measure-card.py` — never hand-edited):

| File | Purpose |
| --- | --- |
| `measure-card-v1.pdf` | Print-ready vector master (trim size) — send THIS to the printer |
| `measure-card-v1.svg` | Same artwork as SVG (design-tool reference) |
| `measure-card-letter-v1.pdf` | Print-at-home US-Letter fallback with scale self-check |
| `geometry-v1.json` | Canonical geometry consumed by code + tests |

## Geometry (v1 — invariant)

- **Trim size:** 7.5 in × 5.5 in (190.5 × 139.7 mm), landscape.
- **Fiducials:** four ArUco markers, dictionary **DICT_5X5_1000**, ids
  **10 (top-left), 11 (top-right), 12 (bottom-right), 13 (bottom-left)**.
  The id set *is* the card version — v2 artwork will use different ids.
- **Marker size:** 1.000 in square (black border square), 5×5 inner modules,
  module = 1/7 in.
- **Marker centers** form an **exact 6.000 in × 4.000 in rectangle**, centered
  on the card (centers sit 0.75 in from each trim edge).
- **Quiet zone:** ≥ 0.25 in of clean white around every marker. Nothing may
  print inside it — no branding, no varnish marks, no score lines. (Edge-flush
  markers fail detection on dark surfaces; the 0.75 in center inset exists to
  guarantee this printed white margin.)
- **Center text block** is decorative and may be restyled, but must stay
  ≥ 0.25 in clear of every marker.

## Print requirements

- **Tolerance:** the 6.000 × 4.000 in marker-center rectangle must hold to
  **±0.02 in** after trimming. Distortion (stretch, skew, moisture warp)
  matters more than trim drift — the four centers are the ruler.
- **Do not scale.** Impose at 100%. Any "fit to media" step voids the card.
- **Color:** markers and their borders are **100% process black (K only)** —
  no rich black, no RGB conversion (registration error on a rich-black marker
  blurs module edges). The navy title text may print CMYK.
- **Stock:** rigid matte cardstock, **≥ 14 pt** (16–18 pt preferred). The card
  must lie flat — curl or bend changes the recovered homography.
- **Finish:** **MATTE, uncoated or matte-AQ only. No gloss, no UV, no
  lamination.** Glare across a marker is the #1 detection killer.
- **Bleed / marks:** artwork is white-background; supply 0.125 in bleed by
  extending the white, with standard crop/registration marks outside trim.
  No content sits within 0.25 in of trim, so bleed is safe.
- **Proof check (require from printer):** on the first proof, measure the
  horizontal and vertical distances between marker centers with a steel rule —
  accept only at 6.00 in / 4.00 in (±0.02).

## Print-at-home fallback (`measure-card-letter-v1.pdf`)

US-Letter page carrying the identical marker geometry plus two self-checks the
user runs after printing at **100% / Actual Size**:

1. a printed box a standard credit card (ISO ID-1, 3.370 × 2.125 in) must fit
   **exactly**;
2. a 6.000 in reference ruler.

If either check fails, the print is scaled and must be redone. The sheet is
used flat (not trimmed) — the marker geometry, not the paper edge, is what the
CV reads.

## Versioning rules

- v1 = ids {10, 11, 12, 13} with the geometry above. **Never** reprint these
  ids with different geometry.
- A revised card (size, marker layout, stock learnings) gets NEW ids and a new
  `geometry-vN.json` + constants entry (`MEASURE_CARD_VERSIONS` in
  `lib/measure-card.ts`, mirrored web/edge), so the calibration service can
  identify every card ever shipped from the photo alone.
- Regenerate artwork only via `scripts/generate-measure-card.py` (requires
  `pip install opencv-python-headless numpy`) — it refuses to emit artwork the
  OpenCV detector can't decode at the declared centers.

## Branding & custom designs (US-1570 addendum)

The card is brandable — detection only constrains the markers, not the art.
The v1 artwork now carries the GT logo mark; a richer designed card (for the
mailed edition) is welcome under these rules:

- **Free design zone**: the interior more than **0.25 in (the quiet zone)**
  away from every marker's black border. Anything goes there — logos, color,
  pattern. The four markers, their sizes, and their center positions are
  INVARIANT (see Geometry above).
- **Quiet zones stay paper-white.** No tints, watermarks, or borders touching
  the 0.25 in ring around any marker — that ring is what lets the detector
  find the marker edge on any garment background.
- **Avoid marker-look-alikes**: no high-contrast black squares ~1 in with
  white inner patterning elsewhere on the card (false-positive risk; the
  validator will catch it, but don't make it try).
- **Matte only** — gloss laminate breaks detection (see Print requirements).
- **No recalibration is needed** for a redesign that keeps the geometry: the
  calibration math reads only the marker centers. What IS required is
  re-validation of the finished artwork:

  ```bash
  python scripts/generate-measure-card.py --validate path/to/final-artwork.png
  ```

  This asserts exactly ids 10–13 detect (a design element that swallows a
  marker or false-positives fails loudly) and that the centers still form the
  6×4 in rectangle within 0.05 in at any export DPI. If a design NEEDS the
  geometry to move, that's a v2 card: new id set, new `geometry-v2.json`,
  never a silent edit (see Versioning rules).

The print-at-home Letter PDF self-documents its accuracy requirements ON the
sheet: the "PRINT AT 100% / ACTUAL SIZE" banner, the ISO ID-1 credit-card
scale-check box, and a 6.000 in reference ruler are all part of the printed
page, so the instructions survive the download.
