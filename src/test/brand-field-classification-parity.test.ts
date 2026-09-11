// US-3307 AC4: the edge cannot import the shared classification, so scan it.
//
// src/lib/brand-field-classification.json is the single source of truth for what
// an inventory_items.brand value actually is. The frontend imports it and
// scripts/lib/brand-field-classification.mjs reads it. The edge service cannot:
// its Docker build context is services/edge-functions/ only (see its Dockerfile,
// `COPY . .` from that directory), so an import reaching up into src/ would pass
// `deno check` on a dev box and fail the container build.
//
// A source scan is the weaker instrument and it is the one available. What it
// pins is narrow and load-bearing: the edge's own idea of which brand strings are
// ANSWERS rather than placeholders must be exactly the set the shared file marks
// `unbranded`. That set is what keeps "this garment carries no label" from being
// thrown away as noise and then re-manufactured at publish time, where
// flipdesk-ebay.ts defaults an EMPTY brand to the literal string "Unbranded" to
// satisfy eBay's Brand+MPN requirement.
//
// ⚠ A scan can only fail one way. It proves the two lists match; it cannot prove
// the edge CALLS the field-scoped check at every site. The Deno tests in
// services/edge-functions/src/tests/ai-placeholder-values_test.ts do that part.
// See vault/70-agent/guards-that-do-not-guard.md.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND_FIELD_VALUES } from "@/lib/brand-field-classification";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const AI_EXTRACT = "services/edge-functions/src/lib/ai-extract.ts";

/** The keys the shared file says are real "no label" answers. */
const sharedAnswers = BRAND_FIELD_VALUES.filter((v) => v.class === "unbranded")
  .map((v) => v.key)
  .sort();

describe("the edge agrees with the shared brand-field classification", () => {
  const source = read(AI_EXTRACT);

  it("declares BRAND_FIELD_ANSWERS", () => {
    // If this disappears, the rename or the deletion is the thing to look at,
    // not this test. Deleting it silently restores the old conflation.
    expect(source).toContain("export const BRAND_FIELD_ANSWERS");
  });

  it("holds exactly the values the shared file classes as unbranded", () => {
    const m = /export const BRAND_FIELD_ANSWERS = new Set\(\[([^\]]*)\]\)/.exec(
      source,
    );
    expect(m, `BRAND_FIELD_ANSWERS not parseable in ${AI_EXTRACT}`).toBeTruthy();
    const edgeAnswers = [...m![1]!.matchAll(/"([^"]+)"/g)]
      .map((x) => x[1]!)
      .sort();
    expect(edgeAnswers).toEqual(sharedAnswers);
  });

  it("keeps the field-scoped signature rather than deleting the placeholders", () => {
    // The fix is NOT "drop unbranded from PLACEHOLDER_VALUES": on every field
    // except brand it really is a placeholder. If this signature loses its
    // second parameter the scoping is gone.
    expect(source).toMatch(
      /export function isPlaceholderValue\(value: unknown, field\?: string\)/,
    );
    expect(source).toMatch(/"unbranded",/);
  });

  it("passes the field through at the decode sites", () => {
    // Two call sites see a brand: the core-field decode (keyed by field name)
    // and the aspect-refine pass (keyed by eBay aspect name).
    expect(source).toContain("isPlaceholderValue(f.value, key)");
    expect(source).toContain("isPlaceholderValue(v, a.name)");
  });
});

describe("the frontend's older placeholder list still agrees on Unbranded", () => {
  it("placeholder-brand.ts does not treat Unbranded as a placeholder", () => {
    // This file predates the shared classification and deliberately excludes
    // Unbranded. Pinning it means a later tidy-up that "completes" the list
    // fails here instead of quietly deleting the distinction from reporting.
    const source = read("src/lib/placeholder-brand.ts");
    const m = /PLACEHOLDER_BRAND_VALUES: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/
      .exec(source);
    expect(m).toBeTruthy();
    const values = [...m![1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
    expect(values).not.toContain("unbranded");
    expect(values).not.toContain("handmade");
  });
});
