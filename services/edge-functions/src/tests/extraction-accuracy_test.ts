// US-1531: per-field extraction accuracy aggregation — pure unit tests.
import { assertEquals } from "@std/assert";
import {
  type ExtractionLogRow,
  summarizeExtractionAccuracy,
} from "../lib/extraction-accuracy.ts";

Deno.test("summarizeExtractionAccuracy: per-field accepted/corrected/rate", () => {
  const rows: ExtractionLogRow[] = [
    // style accepted-as-is, brand corrected
    {
      accepted_fields: { style: "Bomber", brand: "Nike" },
      corrected_fields: { brand: { suggested: "Nikee", final: "Nike" } },
    },
    // style corrected, brand accepted-as-is
    {
      accepted_fields: { style: "Puffer", brand: "Nike" },
      corrected_fields: { style: { suggested: "Bomber", final: "Puffer" } },
    },
    // only size accepted, nothing corrected
    { accepted_fields: { size: "M" }, corrected_fields: {} },
  ];
  const out = summarizeExtractionAccuracy(rows);
  const byField = Object.fromEntries(out.map((f) => [f.field, f]));

  assertEquals(byField.style, { field: "style", accepted: 2, corrected: 1, correctionRate: 0.5 });
  assertEquals(byField.brand, { field: "brand", accepted: 2, corrected: 1, correctionRate: 0.5 });
  assertEquals(byField.size, { field: "size", accepted: 1, corrected: 0, correctionRate: 0 });
});

Deno.test("summarizeExtractionAccuracy: sorted worst-first (rate, then sample size)", () => {
  const rows: ExtractionLogRow[] = [
    { accepted_fields: { a: "x", b: "y" }, corrected_fields: { a: { suggested: "1", final: "x" } } },
    { accepted_fields: { a: "x", b: "y" }, corrected_fields: {} },
    { accepted_fields: { c: "z" }, corrected_fields: { c: { suggested: "0", final: "z" } } },
  ];
  const out = summarizeExtractionAccuracy(rows);
  // c: 1/1 = 1.0 (worst) first; a: 1/2 = 0.5; b: 0/2 = 0 last
  assertEquals(out.map((f) => f.field), ["c", "a", "b"]);
});

Deno.test("summarizeExtractionAccuracy: tolerates null field maps + counts edited-not-accepted", () => {
  const rows: ExtractionLogRow[] = [
    { accepted_fields: null, corrected_fields: null },
    { accepted_fields: {}, corrected_fields: { color: { suggested: "Blue", final: "Navy" } } },
  ];
  const out = summarizeExtractionAccuracy(rows);
  assertEquals(out, [{ field: "color", accepted: 1, corrected: 1, correctionRate: 1 }]);
});

Deno.test("summarizeExtractionAccuracy: empty input → []", () => {
  assertEquals(summarizeExtractionAccuracy([]), []);
});
