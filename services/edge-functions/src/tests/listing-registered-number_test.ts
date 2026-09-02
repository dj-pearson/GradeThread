// 2026-09-02: what the AutoLister does with the RN the tag OCR reads.
//   deno test --allow-env --allow-read src/tests/listing-registered-number_test.ts
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { planListingRegisteredNumber, RN_CONTRADICTION_BRAND_CONFIDENCE } = await import(
  "../lib/listing-registered-number.ts"
);
const { assessRegisteredNumber } = await import("../lib/registered-numbers.ts");

const index = new Map([
  ["RN:106259", [{ brandKey: "lululemon", canonicalBrand: "Lululemon" }]],
  ["RN:66170", [
    { brandKey: "urbanoutfitters", canonicalBrand: "Urban Outfitters" },
    { brandKey: "freepeople", canonicalBrand: "Free People" },
  ]],
]);
const registrants = new Map([["RN:106259", "lululemon athletica canada inc."]]);

function plan(
  rn: string | null,
  brand: string | null,
  existing: Record<string, unknown> = {},
) {
  return planListingRegisteredNumber({
    rn,
    declaredBrand: brand,
    existingAttributes: existing,
    assessment: assessRegisteredNumber(rn, brand, index, registrants),
  });
}

Deno.test("corroborates: stores the number and registrant, no cap, no sighting", () => {
  const p = plan("RN 106259", "Lululemon");
  assertEquals(p.outcome, "corroborates");
  assertEquals(p.attributes, {
    rn: "RN 106259",
    rn_registrant: "lululemon athletica canada inc.",
  });
  assertEquals(p.brandConfidenceCap, null);
  assertEquals(p.recordSighting, false);
});

Deno.test("ambiguous (shared registrant): consistent, stored, no cap", () => {
  const p = plan("66170", "Free People");
  assertEquals(p.outcome, "ambiguous");
  assertEquals(p.attributes.rn, "66170");
  assertEquals(p.brandConfidenceCap, null);
});

Deno.test("contradicts: caps brand confidence for review, never writes a brand, still stores the number", () => {
  const p = plan("RN 106259", "Nike");
  assertEquals(p.outcome, "contradicts");
  assertEquals(p.brandConfidenceCap, RN_CONTRADICTION_BRAND_CONFIDENCE);
  assertEquals(p.attributes.rn, "RN 106259");
  assertEquals("brand" in p.attributes, false);
  assertEquals(p.recordSighting, false);
});

Deno.test("no_reference: stores the number and asks for a sighting; never a cap", () => {
  const p = plan("RN 999999", "Nike");
  assertEquals(p.outcome, "no_reference");
  assertEquals(p.recordSighting, true);
  assertEquals(p.brandConfidenceCap, null);
  assertEquals(p.attributes, { rn: "RN 999999" });
});

Deno.test("unparsed or empty: nothing", () => {
  assertEquals(plan("LW3CWDS", "Lululemon").attributes, {});
  assertEquals(plan("LW3CWDS", "Lululemon").recordSighting, false);
  assertEquals(plan(null, "Lululemon").recordSighting, false);
});

Deno.test("fill-only: an rn the seller already stored is kept", () => {
  const p = plan("RN 106259", "Lululemon", { rn: "RN 12345" });
  assertEquals("rn" in p.attributes, false);
  assertEquals(p.attributes.rn_registrant, "lululemon athletica canada inc.");
});
