// US-2135 AC3, the reader. 00613 recorded the delivered pixel dimensions and its
// own header called the missing half what it was — a column with no consumer.
// This is the consumer, and most of what is pinned here is what it REFUSES to
// conclude.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const {
  DEFAULT_UPLOAD_MAX_WIDTH_PX,
  MACRO_THIN_EVIDENCE_RATIO,
  MACRO_UPLOAD_MAX_WIDTH_PX,
  THIN_MACRO_CONFIDENCE_CAP,
  assessMacroDensity,
  capForSlot,
  deliveredRatio,
  isMacroSlot,
} = await import("../lib/macro-evidence-density.ts");

// ── The mirror ──────────────────────────────────────────────────────────────

Deno.test("US-2135: the cap table matches the web compressor, via the shared fixture", async () => {
  // The web compressor is the authority — it is what actually resizes the
  // bytes. This copy exists only because the edge cannot import from src/, so
  // the fixture is what stops the two drifting. Same arrangement as
  // rubric-factors.json (US-1997 AC4), asserted by both suites.
  const fixture = JSON.parse(
    await Deno.readTextFile("../../src/test/fixtures/macro-upload-caps.json"),
  ) as { defaultMaxWidthPx: number; slots: Record<string, number> };

  assertEquals(DEFAULT_UPLOAD_MAX_WIDTH_PX, fixture.defaultMaxWidthPx);
  assertEquals(MACRO_UPLOAD_MAX_WIDTH_PX, fixture.slots);
  assert(Object.keys(fixture.slots).length >= 12, "the fixture lost slots");
});

// ── Slot resolution ─────────────────────────────────────────────────────────

Deno.test("US-2135: a suffixed image_type resolves to its base slot", () => {
  // Real values carry suffixes: detail_1, measurement_chest, defect_2.
  assertEquals(capForSlot("serial"), 3600);
  assertEquals(capForSlot("measurement_chest"), 3600);
  assertEquals(capForSlot("detail_1"), 3000);
  assertEquals(capForSlot("DEFECT_2"), 3000);
  // Not a macro slot — the global default, never a guess.
  assertEquals(capForSlot("front"), DEFAULT_UPLOAD_MAX_WIDTH_PX);
  assertEquals(capForSlot("something_new"), DEFAULT_UPLOAD_MAX_WIDTH_PX);
  assertEquals(capForSlot(null), DEFAULT_UPLOAD_MAX_WIDTH_PX);
});

Deno.test("US-2135: only the close-up slots are held to a macro bar", () => {
  // A front shot is not trying to resolve stitch pitch. Holding it to a macro
  // bar would cap almost every grade in the system.
  assert(isMacroSlot("serial"));
  assert(isMacroSlot("tag"));
  assert(isMacroSlot("detail_3"));
  assert(!isMacroSlot("front"));
  assert(!isMacroSlot("back"));
  assert(!isMacroSlot(null));
});

// ── The refusals ────────────────────────────────────────────────────────────

Deno.test("US-2135: an unmeasured image is UNKNOWN, never zero", () => {
  // The trap 00613's own header names: Number(null) is 0 and finite, so a naive
  // reader turns "we never measured this" into "worst possible evidence" and
  // caps every row written before the column existed.
  assertEquals(deliveredRatio({ image_type: "serial", width: null, height: null }), null);
  assertEquals(deliveredRatio({ image_type: "serial", width: 1200, height: null }), null);
  assertEquals(deliveredRatio({ image_type: "serial", width: 0, height: 900 }), null);
  assertEquals(deliveredRatio({ image_type: "serial", width: -5, height: 900 }), null);
  assertEquals(deliveredRatio({ image_type: "serial", width: NaN, height: 900 }), null);
});

Deno.test("US-2135: a submission with nothing measurable produces NO cap", () => {
  // Every image predates 00613. The honest answer is silence, not a confident
  // one — and this is the case that would have capped historical regrades.
  const v = assessMacroDensity([
    { image_type: "serial", width: null, height: null },
    { image_type: "tag", width: null, height: null },
  ]);
  assertEquals(v.measured, 0);
  assertEquals(v.confidenceCap, null);
  assertEquals(v.note, "");
});

Deno.test("US-2135: a thin NON-macro slot is not a finding", () => {
  const v = assessMacroDensity([{ image_type: "front", width: 400, height: 300 }]);
  assertEquals(v.measured, 0);
  assertEquals(v.confidenceCap, null);
});

// ── The signal ──────────────────────────────────────────────────────────────

Deno.test("US-2135: the ratio is the LONG edge against the slot's own cap", () => {
  // Portrait or landscape must not change the answer.
  assertEquals(deliveredRatio({ image_type: "serial", width: 3600, height: 2400 }), 1);
  assertEquals(deliveredRatio({ image_type: "serial", width: 2400, height: 3600 }), 1);
  assertEquals(deliveredRatio({ image_type: "tag", width: 1500, height: 1000 }), 0.5);
});

Deno.test("US-2135: an old client's 1600px default into a 3600 slot is thin", () => {
  // The case this exists for. 1600/3600 is 0.44 — under half the long edge, so
  // barely a fifth of the pixels the slot asked for.
  const v = assessMacroDensity([{ image_type: "serial", width: 1600, height: 1200 }]);
  assertEquals(v.measured, 1);
  assertEquals(v.thin, 1);
  assertEquals(v.confidenceCap, THIN_MACRO_CONFIDENCE_CAP);
  assertStringIncludes(v.note, "serial");
  assertStringIncludes(v.note, "44%");
  assertStringIncludes(v.note, "confidence-capped");
});

Deno.test("US-2135: a phone delivering the web default into a 3600 slot is NOT thin", () => {
  // 2400/3600 is 0.67. That is the web default arriving in an authenticity slot
  // — ordinary variation, not a defect, and capping it would fire constantly.
  const v = assessMacroDensity([{ image_type: "surface", width: 2400, height: 1800 }]);
  assertEquals(v.thin, 0);
  assertEquals(v.confidenceCap, null);
  assertEquals(v.measured, 1, "it was measured, it just passed");
});

Deno.test("US-2135: the threshold boundary is exclusive", () => {
  // Exactly at the threshold is acceptable; a hair under is not.
  const at = assessMacroDensity([{ image_type: "tag", width: 3000 * MACRO_THIN_EVIDENCE_RATIO, height: 1 }]);
  assertEquals(at.thin, 0, "exactly at the threshold passes");
  const under = assessMacroDensity([{ image_type: "tag", width: 1499, height: 1 }]);
  assertEquals(under.thin, 1);
});

Deno.test("US-2135: one thin slot among good ones still caps, and names only the thin one", () => {
  const v = assessMacroDensity([
    { image_type: "serial", width: 3600, height: 2700 },
    { image_type: "tag", width: 900, height: 700 },
    { image_type: "front", width: 100, height: 100 },
  ]);
  assertEquals(v.measured, 2, "the front shot is not a macro slot");
  assertEquals(v.thin, 1);
  assertStringIncludes(v.note, "tag");
  assert(!v.note.includes("serial"), `only the thin slot should be named: ${v.note}`);
});

Deno.test("US-2135: the cap is below the review threshold, so it actually routes", () => {
  assert(
    THIN_MACRO_CONFIDENCE_CAP < 0.75,
    "a cap at or above the review threshold would lower a number and change nothing",
  );
});
