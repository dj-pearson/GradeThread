// Unit tests for the canonical GT Grade field (US-1284). Pure module, no deps:
//   deno test src/tests/gt-grade-standard_test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildGtGradeField,
  embedGtGradeBlock,
  formatGtGrade,
  GT_GRADE_FIELD_NAME,
  GT_GRADE_PROPERTY_ID,
  GT_GRADE_SPEC_URL,
  GT_GRADE_STANDARD_VERSION,
  gtGradeCitation,
  gtGradeMarker,
  gtGradePropertyValue,
} from "../lib/gt-grade-standard.ts";

Deno.test("formatGtGrade always renders one decimal", () => {
  assertEquals(formatGtGrade(8), "8.0");
  assertEquals(formatGtGrade(9.5), "9.5");
});

Deno.test("buildGtGradeField resolves a canonical, versioned field", () => {
  const f = buildGtGradeField({
    grade: 8,
    tier: "Excellent",
    certNumber: "GT-ABC123",
    certUrl: "https://gradethread.com/cert/xyz",
  });
  assertEquals(f.standard, "gradethread");
  assertEquals(f.version, GT_GRADE_STANDARD_VERSION);
  assertEquals(f.grade, "8.0");
  assertEquals(f.gradeValue, 8);
  assertEquals(f.scaleMin, 1);
  assertEquals(f.scaleMax, 10);
  assertEquals(f.tier, "Excellent");
  assertEquals(f.certNumber, "GT-ABC123");
  assertEquals(f.specUrl, GT_GRADE_SPEC_URL);
});

Deno.test("blank optional fields collapse to null", () => {
  const f = buildGtGradeField({ grade: 6.5, tier: "  ", certNumber: "" });
  assertEquals(f.tier, null);
  assertEquals(f.certNumber, null);
  assertEquals(f.certUrl, null);
});

Deno.test("citation is the documented one-liner; cert URL is opt-in", () => {
  const f = buildGtGradeField({
    grade: 8,
    tier: "Excellent",
    certNumber: "GT-ABC123",
    certUrl: "https://gradethread.com/cert/xyz",
  });
  const ebay = gtGradeCitation(f, { includeCertUrl: false });
  assertStringIncludes(ebay, `${GT_GRADE_FIELD_NAME} 8.0/10 (Excellent)`);
  assertStringIncludes(ebay, "Cert #GT-ABC123");
  // eBay must NOT carry the off-site verify URL.
  assert(!ebay.includes("Verify: https://gradethread.com/cert/xyz"));

  const offEbay = gtGradeCitation(f, { includeCertUrl: true });
  assertStringIncludes(offEbay, "Verify: https://gradethread.com/cert/xyz");
});

Deno.test("PropertyValue is the schema.org additionalProperty partners ingest", () => {
  const f = buildGtGradeField({ grade: 8, tier: "Excellent", certNumber: "GT-ABC123" });
  const pv = gtGradePropertyValue(f);
  assertEquals(pv["@type"], "PropertyValue");
  assertEquals(pv.propertyID, GT_GRADE_PROPERTY_ID);
  assertEquals(pv.name, GT_GRADE_FIELD_NAME);
  assertEquals(pv.value, 8);
  assertEquals(pv.minValue, 1);
  assertEquals(pv.maxValue, 10);
  assertEquals(pv.alternateName, "Excellent");
  assertEquals(pv.identifier, "GT-ABC123");
});

Deno.test("marker round-trips as parseable JSON", () => {
  const f = buildGtGradeField({ grade: 9.5, tier: "NWOT", certNumber: "GT-9" });
  const marker = gtGradeMarker(f);
  const m = marker.match(/^\[gradethread-grade\](.+)\[\/gradethread-grade\]$/);
  assert(m, "marker is wrapped in stable delimiters");
  const parsed = JSON.parse(m![1]);
  assertEquals(parsed.standard, "gradethread");
  assertEquals(parsed.grade, 9.5);
  assertEquals(parsed.tier, "NWOT");
  assertEquals(parsed.spec, GT_GRADE_SPEC_URL);
  // Single line so it survives whitespace-collapsing platforms.
  assert(!marker.includes("\n"));
});

Deno.test("embedGtGradeBlock appends once and is idempotent", () => {
  const f = buildGtGradeField({ grade: 7, tier: "Very Good" });
  const desc = "Great vintage tee.";
  const once = embedGtGradeBlock(desc, f, { includeCertUrl: true });
  assertStringIncludes(once, "Great vintage tee.");
  assertStringIncludes(once, "[gradethread-grade]");
  const twice = embedGtGradeBlock(once, f, { includeCertUrl: true });
  assertEquals(twice, once);
});
