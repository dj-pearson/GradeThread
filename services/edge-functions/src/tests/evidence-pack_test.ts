// US-2567: the condition-evidence pack.
//
// The selection rules decide what a marketplace reviewer sees when a buyer files
// "not as described". Three of them are load-bearing and none of them need a
// JPEG decoder to check:
//
//   • WHICH defects get a crop, and in what order the cap bites.
//   • HOW FAR a box is expanded before cropping — too tight and the close-up is
//     an unreadable blur, which invites the argument it was meant to end.
//   • WHAT the stamp says, because the stamp is the whole claim: this flaw was
//     documented under a verifiable grade before you bought it.

import { assert, assertEquals } from "@std/assert";
import type { ImageAnnotations, PhotoAnnotation } from "../lib/disclosure.ts";
import {
  certificateCardCopy,
  returnEvidenceCardCopy,
  DEFAULT_MAX_DEFECT_CROPS,
  evidenceStampLine,
  expandCropBox,
  MIN_CROP_SPAN,
  selectDefectCrops,
} from "../lib/evidence-pack.ts";

function ann(
  n: number,
  severity: PhotoAnnotation["severity"],
  bbox: [number, number, number, number] | null,
): PhotoAnnotation {
  return { n, issue: `issue ${n}`, severity, location: "left cuff", bbox };
}

function group(image_type: string, annotations: PhotoAnnotation[]): ImageAnnotations {
  return { image_type, annotations };
}

// ── Selection ──────────────────────────────────────────────────────────────

Deno.test("only LOCALIZED defects earn a crop", () => {
  // Without a bbox there is no region to zoom to, and inventing one would put a
  // callout over a part of the garment nobody claimed was damaged. Unlocalized
  // flaws still appear in the full shot's legend, which is the honest place.
  const g = group("front", [
    ann(1, "major", [0.4, 0.4, 0.05, 0.05]),
    ann(2, "major", null),
  ]);
  const { crops, truncated } = selectDefectCrops([g], 10);
  assertEquals(crops.length, 1);
  assertEquals(crops[0].annotation.n, 1);
  assertEquals(truncated, 0, "an unlocalized defect is not 'truncated' — it was never eligible");
});

Deno.test("crops are ordered worst-first", () => {
  const g = group("front", [
    ann(1, "minor", [0.1, 0.1, 0.05, 0.05]),
    ann(2, "major", [0.2, 0.2, 0.05, 0.05]),
    ann(3, "moderate", [0.3, 0.3, 0.05, 0.05]),
  ]);
  const { crops } = selectDefectCrops([g], 10);
  assertEquals(crops.map((c) => c.annotation.n), [2, 3, 1]);
});

Deno.test("the cap keeps the WORST defects, not the first ones", () => {
  // When the cap bites, what survives has to be what a buyer would actually have
  // complained about. Dropping the majors and keeping three minors would be a
  // technically-complete pack that documents the wrong things.
  const g = group("front", [
    ann(1, "minor", [0.1, 0.1, 0.05, 0.05]),
    ann(2, "minor", [0.2, 0.2, 0.05, 0.05]),
    ann(3, "major", [0.3, 0.3, 0.05, 0.05]),
  ]);
  const { crops, truncated } = selectDefectCrops([g], 1);
  assertEquals(crops.map((c) => c.annotation.n), [3]);
  assertEquals(truncated, 2);
});

Deno.test("the order is deterministic, so a resumed batch renders the same set", () => {
  const g = group("front", [
    ann(5, "major", [0.5, 0.5, 0.05, 0.05]),
    ann(2, "major", [0.2, 0.2, 0.05, 0.05]),
    ann(9, "major", [0.9, 0.05, 0.05, 0.05]),
  ]);
  assertEquals(
    selectDefectCrops([g], 2).crops.map((c) => c.annotation.n),
    [2, 5],
    "equal severity must tiebreak on the callout number, not on input order",
  );
});

Deno.test("truncated is reported so the cap can never be silent", () => {
  // A pack that quietly documents 6 of 14 flaws still LOOKS complete, and
  // "we documented everything" is exactly the claim a dispute turns on.
  const many = Array.from(
    { length: 14 },
    (_, i) => ann(i + 1, "moderate", [0.1, 0.1, 0.05, 0.05]),
  );
  const { crops, truncated } = selectDefectCrops([group("front", many)], 6);
  assertEquals(crops.length, 6);
  assertEquals(truncated, 8);
});

Deno.test("a cap of zero yields no crops and reports every drop", () => {
  const g = group("front", [ann(1, "major", [0.1, 0.1, 0.05, 0.05])]);
  const { crops, truncated } = selectDefectCrops([g], 0);
  assertEquals(crops.length, 0);
  assertEquals(truncated, 1);
});

Deno.test("crops span multiple source images", () => {
  const front = group("front", [ann(1, "minor", [0.1, 0.1, 0.05, 0.05])]);
  const back = group("back", [ann(2, "major", [0.2, 0.2, 0.05, 0.05])]);
  const { crops } = selectDefectCrops([front, back], 10);
  assertEquals(crops.map((c) => c.imageType), ["back", "front"]);
});

Deno.test("the default cap leaves room for the seller's own photography", () => {
  // eBay allows 24 images total. The pack must not fill the listing.
  assert(DEFAULT_MAX_DEFECT_CROPS > 0 && DEFAULT_MAX_DEFECT_CROPS <= 8);
});

// ── Crop geometry ──────────────────────────────────────────────────────────

Deno.test("a tiny defect box is floored to a legible span", () => {
  // A pinhole cropped tight and upscaled is an abstract blur that proves
  // nothing. There must always be recognisable garment around the flaw.
  const [, , w, h] = expandCropBox([0.5, 0.5, 0.002, 0.002]);
  assertEquals(w, MIN_CROP_SPAN);
  assertEquals(h, MIN_CROP_SPAN);
});

Deno.test("a crop stays inside the frame", () => {
  for (const bbox of [
    [0.0, 0.0, 0.02, 0.02],
    [0.98, 0.98, 0.02, 0.02],
    [0.5, 0.0, 0.4, 0.02],
  ] as Array<[number, number, number, number]>) {
    const [x, y, w, h] = expandCropBox(bbox);
    assert(x >= 0, `x ${x} < 0`);
    assert(y >= 0, `y ${y} < 0`);
    assert(x + w <= 1 + 1e-9, `x+w ${x + w} > 1`);
    assert(y + h <= 1 + 1e-9, `y+h ${y + h} > 1`);
  }
});

Deno.test("a defect at the edge SLIDES inward rather than being clipped thin", () => {
  // Clamping before flooring would return a half-width strip exactly where the
  // flaw is — losing the context on the side that still exists.
  const [x, , w] = expandCropBox([0.0, 0.4, 0.02, 0.02]);
  assertEquals(x, 0);
  assertEquals(w, MIN_CROP_SPAN, "the crop keeps its full width, shifted inward");
});

Deno.test("a defect box larger than the frame is clamped to the frame", () => {
  const [x, y, w, h] = expandCropBox([0.1, 0.1, 0.9, 0.9]);
  assertEquals(w, 1);
  assertEquals(h, 1);
  assertEquals(x, 0);
  assertEquals(y, 0);
});

Deno.test("a degenerate box does not produce a negative span", () => {
  // The model can emit a zero or inverted box. That must read as a point and
  // get the readable floor, not as a crop the decoder will reject.
  const [x, y, w, h] = expandCropBox([0.5, 0.5, 0, -0.1]);
  assert(w >= MIN_CROP_SPAN && h >= MIN_CROP_SPAN);
  assert(x >= 0 && y >= 0);
});

Deno.test("the crop keeps context around the defect", () => {
  const [x, y, w, h] = expandCropBox([0.4, 0.4, 0.2, 0.2]);
  assert(w > 0.2 && h > 0.2, "the box must be expanded, not merely copied");
  assert(x < 0.4 && y < 0.4, "expansion is centred, so the origin moves back");
});

// ── The stamp ──────────────────────────────────────────────────────────────

Deno.test("the stamp names the certificate, the score and where to check it", () => {
  const line = evidenceStampLine({
    certificateNumber: "GT-A1B2C3D",
    overallScore: 8.5,
    gradeTier: "Excellent",
  });
  assert(line);
  assert(line.includes("GT-A1B2C3D"));
  assert(line.includes("8.5 / 10"));
  assert(line.includes("Excellent"));
  assert(line.includes("gradethread.com/verify"));
});

Deno.test("an uncertified grade prints NO stamp", () => {
  // A stamp implying a certificate that does not exist is worse than none: the
  // artifact's only claim is that the number can be checked.
  assertEquals(
    evidenceStampLine({ certificateNumber: null, overallScore: 8.5, gradeTier: "Excellent" }),
    null,
  );
});

Deno.test("a missing tier does not leave a dangling separator", () => {
  const line = evidenceStampLine({
    certificateNumber: "GT-A1B2C3D",
    overallScore: 7,
    gradeTier: "   ",
  });
  assert(line);
  assert(!line.includes("·  ·"), `dangling separator in: ${line}`);
  assert(line.includes("7.0 / 10"));
});

// ── The certificate card ───────────────────────────────────────────────────

Deno.test("the card counts flaws rather than describing them", () => {
  // "3 flaws documented" is checkable against the rest of the pack.
  // "some wear" is not, and the card is the artifact a reviewer reads first.
  const copy = certificateCardCopy(
    { certificateNumber: "GT-A1B2C3D", overallScore: 8.5, gradeTier: "Excellent" },
    3,
  );
  assertEquals(copy.defects, "3 flaws documented");
  assertEquals(copy.score, "8.5 / 10");
  assertEquals(copy.certificate, "GT-A1B2C3D");
});

Deno.test("the card singularises one flaw and states zero plainly", () => {
  const stamp = { certificateNumber: "GT-X", overallScore: 9, gradeTier: "Near mint" };
  assertEquals(certificateCardCopy(stamp, 1).defects, "1 flaw documented");
  assertEquals(certificateCardCopy(stamp, 0).defects, "No flaws documented");
});

// ── Orchestration wiring ───────────────────────────────────────────────────

Deno.test("the worker renders crops and a card, and logs a capped run", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/defect-annotations.ts", import.meta.url),
  );
  assert(src.includes("compositeDefectCrop("), "per-defect crops must be rendered");
  assert(src.includes("compositeCertificateCard("), "the certificate card must be rendered");
  assert(
    src.includes("selection.truncated > 0") && src.includes("console.warn"),
    "AC4: a capped run must LOG what it dropped — a silent cap reads as " +
      "'we documented everything' when it did not",
  );
  assert(
    src.includes('transform: "defect_crop"') && src.includes('transform: "certificate_card"'),
    "both new asset kinds must carry their own derived_transform",
  );
  assert(
    src.includes("derived_bbox: target.cropBox"),
    "a crop must record the region it ACTUALLY cropped, not the raw defect box",
  );
});

Deno.test("the private label shot is still excluded from every asset", async () => {
  // US-276 forbids grading label imagery in the public item-photos bucket, and
  // the crop selector runs on groups that selectAnnotatableImages already
  // filtered — so the guarantee has to still be upstream of it.
  const src = await Deno.readTextFile(
    new URL("../lib/defect-annotations.ts", import.meta.url),
  );
  const selectorIdx = src.indexOf("export function selectAnnotatableImages");
  assert(selectorIdx > -1, "selectAnnotatableImages must still exist");
  assert(
    src.slice(selectorIdx, selectorIdx + 400).includes('g.image_type !== "label"'),
    "the label exclusion must remain in the selector every asset path reads from",
  );
  const cropCall = src.indexOf("selectDefectCrops(groups");
  assert(cropCall > -1, "crops must be selected from the already-filtered groups");
});

// ── US-2706: the sheet that goes to an eBay return case ────────────────────

Deno.test("US-2706: the return sheet carries the grade DATE", () => {
  // The whole argument is that the flaw was documented BEFORE the sale. A card
  // naming the certificate and not the date says the documentation exists
  // without saying it predates anything, which is the half carrying no weight.
  const copy = returnEvidenceCardCopy(
    { certificateNumber: "GT-000123", overallScore: 8.5, gradeTier: "Excellent" },
    2,
    "2026-07-04T10:22:00.000Z",
  );
  assert(copy.verify.includes("2026-07-04"), `no grade date in: ${copy.verify}`);
  assertEquals(copy.certificate, "GT-000123");
  assertEquals(copy.defects, "2 flaws documented");
});

Deno.test("US-2706: the return sheet carries NO off-eBay link", () => {
  // certificateCardCopy prints gradethread.com/verify, which is right on a
  // listing image and wrong here: eBay is deciding a case, and a domain on the
  // evidence is an off-site link into the middle of it. The instruction
  // survives without the address - a certificate number IS the lookup.
  const stamp = { certificateNumber: "GT-000123", overallScore: 8.5, gradeTier: "Excellent" };
  const listing = certificateCardCopy(stamp, 2);
  assert(listing.verify.includes("gradethread.com"), "harness check: the listing card does link");

  const sheet = returnEvidenceCardCopy(stamp, 2, "2026-07-04T10:22:00.000Z");
  for (const line of Object.values(sheet)) {
    assertEquals(
      /https?:\/\/|www\.|\.com|\.co\b/i.test(line),
      false,
      `the return sheet carries an off-eBay link: ${line}`,
    );
  }
});

Deno.test("US-2706: no grade date still produces an instruction, not a blank", () => {
  const copy = returnEvidenceCardCopy(
    { certificateNumber: "GT-000123", overallScore: 8.5, gradeTier: "Excellent" },
    1,
    null,
  );
  assertEquals(copy.verify, "Verify by certificate number");
});

Deno.test("US-2706: an unparseable date says so rather than printing garbage", () => {
  const copy = returnEvidenceCardCopy(
    { certificateNumber: "GT-000123", overallScore: 8.5, gradeTier: "Excellent" },
    1,
    "not-a-date",
  );
  assert(copy.verify.includes("date unavailable"), copy.verify);
  assertEquals(/NaN|Invalid/.test(copy.verify), false);
});

Deno.test("US-2706: the sheet never says the seller wins", () => {
  // The epic's standing honesty constraint, on the one asset eBay actually
  // reads. Checked over EVERY line, not just the one that was edited.
  const copy = returnEvidenceCardCopy(
    { certificateNumber: "GT-000123", overallScore: 9.0, gradeTier: "Near Mint" },
    0,
    "2026-07-04T10:22:00.000Z",
  );
  for (const line of Object.values(copy)) {
    assertEquals(
      /\bwin\b|guarantee|dispute (will|should)/i.test(line),
      false,
      `the sheet asserts an outcome we do not control: ${line}`,
    );
  }
});

Deno.test("US-2706: one compositor draws both cards", () => {
  // Two renderers would drift, and the one that drifted would be the one
  // nobody looks at until a case is open.
  const src = Deno.readTextFileSync(
    new URL("../lib/defect-annotations.ts", import.meta.url),
  );
  assert(src.includes("compositeReturnEvidenceSheet"), "the return sheet has no renderer");
  assert(
    src.includes("drawCertificateCard"),
    "the drawing is no longer shared between the listing card and the return sheet",
  );
});
