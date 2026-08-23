---
title: Measurement accuracy
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/measurements.ts
  - services/edge-functions/src/lib/measurements.ts
reviewed: 2026-08-23
tags: [measurement, contract]
summary: Tolerances the measurement pipeline must hold and how accuracy is validated.
---

> **Re-reviewed 2026-08-23.** Drift flagged the edge `measurements.ts` for
> `89febbb5b` — US-2796's shoe-scale rule. `resolveMeasurementAspects` gained an
> optional shoe-size scale, and a UK/EU/JP number is now refused entry to a
> US-named aspect ("US Shoe Size") and falls through to the scale-neutral one.
> **The contract here is unaffected**: this changes which aspect NAME a shoe
> number may fill, never the number, never a tolerance, and nothing on the
> length-measurement path. `size_us` is a `kind: "shoe"` spec and carries no
> tolerance on this page — the tolerances, the delta methodology and the
> percentile validation are all defined over flat LENGTH measurements. The change
> to watch for remains the one named below: stored values ceasing to be flat.

> **Re-reviewed 2026-08-17.** Drift flagged both `measurements.ts` copies again,
> for `96835f80` — flat-vs-worn doubling (US-2630). A garment measured flat gives
> ONE layer, so anything that goes around the body is twice the flat number, and
> an 11in flat waist was reaching eBay's "Waist Size" aspect verbatim as an 11.
> **STORED VALUES STAY FLAT**, which is why this note is unaffected: the
> tolerances, the delta methodology and the percentile validation here are all
> defined over the flat measurement, and the doubling happens only where a number
> is *presented* as the garment's size. If stored values ever became worn, every
> tolerance on this page would need re-deriving — so that is the change to watch
> for, not this one.

> **Re-reviewed 2026-08-01.** Drift flagged both `measurements.ts` copies. The
> change tightened which aspects the Measurements → item-specifics projection
> owns (value-shape, not just free-text — see [[sync-source-of-truth]]). It is a
> sync-ownership rule and touches neither the tolerances, the delta methodology,
> nor the percentile validation specified here. Contract unaffected.

> **Re-reviewed 2026-07-19 (US-2052).** The drift guard flagged this note on
> its first run: `measurements.ts` changed 2026-07-15, after the doc was last
> edited. Checked the change — commit `a213de6d` added live bidirectional sync
> between Measurements and eBay item specifics. That is a new consumer of the
> measurement values; it does not alter the tolerances, the delta methodology,
> or the percentile validation this note specifies. Contract unaffected, date
> bumped deliberately rather than to silence CI.
# Measurement accuracy — earning the word "accurate" (US-1580)

Same philosophy as the grading golden set: **never claim accuracy you haven't
measured.** Until the release gate passes, every UI surface says the values
are **"estimated from the photo — review before listing."** Flipping that copy
is a recorded human decision (see §5), never automatic.

## 1. The release gate

Over the golden set (§2), absolute error vs tape-measured truth must hit:

| metric | threshold |
|---|---|
| p50 | ≤ **0.25 in** |
| p95 | ≤ **0.5 in** |
| misses (calibrated photo but no prediction) | **0** |

Implemented in `services/edge-functions/src/lib/measure-eval-stats.ts`
(`releaseGate`) and enforced by the eval script's exit code.

## 2. Golden-set capture protocol (operator task — ≥ 20 garments)

Spread across the class schema (top / bottom / dress / outerwear at minimum;
aim for ≥ 4 per class):

1. Lay the garment flat on a matte surface; place a **production MeasureCard
   v1 beside it** (never on top), all four squares visible.
2. Shoot top-down, phone camera, normal room lighting — deliberately
   *realistic*, not studio-perfect. Include a few 10–20° tilts.
3. Tape-measure every length field the class schema lists
   (`src/lib/measurement-templates.ts`), garment flat, to the nearest ⅛".
   Record in **inches, decimal**.
4. Add the garment to the manifest. Photos + manifest live in **private
   storage / a local folder — NEVER a public bucket and never the repo**
   (they're real garments, potentially identifying).

Manifest format (`manifest.json` beside the photos):

```json
{
  "garments": [
    {
      "id": "g001-levis-501",
      "class": "bottom",
      "photo": "g001.jpg",
      "truth": { "waist": 17.0, "inseam": 30.25, "rise": 11.0, "leg_opening": 8.0 }
    }
  ]
}
```

## 3. Running the eval

```bash
cd services/edge-functions
# needs ANTHROPIC_API_KEY in the env (one vision call per garment; not tenant-billed)
deno run --allow-read --allow-env --allow-net scripts/measure-eval.ts /path/to/golden-set
```

Prints per-class/per-key stats (n, misses, p50, p95, max, signed bias) and the
gate verdict; exits non-zero on failure. Re-run after any change to
`measure-detect.ts`, `measure-extract.ts`, the extraction prompt, or a new
card version.

## 3b. What the card has to look like in frame (US-2672)

How small the card may be is a question about **detection**, not about how much
of the frame it fills. The two got confused, and on a large garment they point
opposite ways: a pair of pants laid flat fills roughly 50in of frame, so the
card's 1in squares are small *because the garment is big*, and there is no
photograph a seller can take that fixes it.

The measured curve, from `services/edge-functions/src/tests/measure-resolution_test.ts`:

| marker side | recovered ppi error | reprojection residual | verdict |
|---|---|---|---|
| 110 px | < 0.01% | 0.0002 in | fine |
| 40 px | < 0.01% | 0.0007 in | fine |
| 24 px | 0.02% | 0.011 in | fine, flagged `lowResolution` |
| 20 px | 0.01% | 0.016 in | the floor |
| 16 px and under | — | — | detection stops; fails closed |

Scale recovery is **flat** across that whole range. What ends at ~20px is the
detector's ability to find and decode the squares at all, and that failure is
already reported honestly as `card_not_found` / `card_not_fully_visible`. So:

- `MIN_MARKER_SIDE_PX` is **18** — the measured floor with enough margin that a
  card sitting exactly on it is not rejected by frame-to-frame noise.
- `MAX_REPROJ_RESIDUAL_IN` (0.06in) is the gate that actually decides. It is in
  INCHES, so it is a statement about accuracy rather than a proxy for one.
- Under `SOFT_MARKER_SIDE_PX` (40) the calibration carries
  `quality.lowResolution` and `quality.inchesPerPx`. Not a refusal — the number
  a seller measuring to a quarter inch needs, and at 20px it is 0.05in.

One thing that sounds like it should be a problem is not. The homography is fit
from four markers spanning 6x4in and then used to measure a garment several
times that size, so it is an extrapolation. Measured on a 24in span sitting 20in
away from the card, with 40px markers: 0.002in of error top-down, and under
0.06in at every tilt from 5 to 30 degrees. Card size is the constraint that
matters, not distance from it.

Two other things measured the garment when they meant to measure the photo, and
both are fixed:

- **Blur was scored over the whole frame.** The bigger the garment, the more of
  that frame is flat fabric and flat floor with nothing to be sharp about, so a
  sharp card next to pants scored 55 against a threshold of 60 while the same
  card next to a t-shirt scored 92. Sharpness is now measured over the marker
  region.
- **The resolution ladder never climbed.** `Image.resize` in ImageScript mutates
  its receiver, so rung one permanently shrank the photo and rung two re-scaled
  that copy *up*. Downsampling now writes straight into the gray buffer.

Re-run the §3 eval after touching any of this.

## 4. Production telemetry (correction deltas)

Every overlay-editor save posts proposal-vs-final deltas for auto-measured
keys to `POST /api/flipdesk/measure/correction` → `measure_corrections`
(deny-all operator table; deltas/class/confidence only, no photo content) and
fires the `measure_correction_saved` PostHog event.

**Correction-delta distribution per class/key** (run against prod as
service-role):

```sql
SELECT garment_class,
       measurement_key,
       count(*)                                                    AS n,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY abs(delta_inches)) AS p50_abs,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY abs(delta_inches)) AS p95_abs,
       round(avg(delta_inches), 2)                                 AS signed_bias,
       round(avg(confidence), 2)                                   AS avg_conf
FROM measure_corrections
WHERE created_at > now() - interval '30 days'
GROUP BY 1, 2
ORDER BY 1, 2;
```

Caveat: sellers only *save* what they touched, so untouched-but-correct
proposals never appear here — treat these numbers as a **pessimistic** bound
on error (an accepted proposal is a 0-delta that goes unlogged).

## 5. Threshold review (the recorded human decision)

When **30 days** of telemetry shows `p95_abs <= 0.5` for a garment class with
meaningful volume (n ≥ 50 corrections **or** a fresh golden-set run passing
the gate for that class):

1. Run the §4 query and the §3 eval; attach both outputs.
2. Record the decision in `progress.txt` (date, class, numbers, who decided).
3. Only then may that class's UI copy drop "estimated". The copy strings live
   in `measurement-photo-editor.tsx`, `measure-card.tsx`, and the extract
   toast — grep for `estimated`.

No entry in `progress.txt` → the copy stays. This document is the contract.

## Related

- [[measurement-card-spec]] — the physical card these measurements are taken against
- [[sync-source-of-truth]] — who owns a measurement field once it is synced
- [[INDEX]]
