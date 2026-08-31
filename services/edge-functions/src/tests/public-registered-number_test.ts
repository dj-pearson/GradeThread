// US-9030: the public RN payload, and the two rules it may never bend.
//
//   deno test --allow-read src/tests/public-registered-number_test.ts

import { assertEquals } from "@std/assert";
import {
  indexableNumbers,
  productLinesFromNotes,
  publicRegisteredNumber,
} from "../lib/public-registered-number.ts";

const resolved = {
  registry_key: "RN:56323",
  kind: "RN" as const,
  digits: "56323",
  company_name: "NIKE, INC.",
  brand_keys: ["nike"],
  source_url: "https://www.ftc.gov/rn-database/search?search=56323",
  notes: null,
};

Deno.test("a resolved number carries the company and is indexable", () => {
  const p = publicRegisteredNumber({
    requested: "56323",
    registry: resolved,
    brandNames: ["Nike"],
    sightings: 12,
  })!;
  assertEquals(p.key, "RN:56323");
  assertEquals(p.companyName, "NIKE, INC.");
  assertEquals(p.brands, ["Nike"]);
  assertEquals(p.sightings, 12);
  assertEquals(p.indexable, true);
});

Deno.test("an unresolved number renders but is NEVER indexable", () => {
  const p = publicRegisteredNumber({ requested: "999999", registry: null, sightings: 3 })!;
  assertEquals(p.digits, "999999");
  assertEquals(p.companyName, null);
  assertEquals(p.brands, []);
  assertEquals(p.sourceUrl, null);
  assertEquals(p.indexable, false);
});

Deno.test("a registry row with a blank company is not indexable", () => {
  for (const blank of [null, "", "   "]) {
    const p = publicRegisteredNumber({
      requested: "56323",
      registry: { ...resolved, company_name: blank },
      sightings: 0,
    })!;
    assertEquals(p.indexable, false, JSON.stringify(blank));
    assertEquals(p.companyName, null);
  }
});

Deno.test("every spelling off a tag resolves to one canonical number", () => {
  for (const raw of ["RN56323", "rn 56323", "RN# 56323", "056323", " 56323 "]) {
    const p = publicRegisteredNumber({ requested: raw, registry: resolved, sightings: 0 })!;
    assertEquals(p.digits, "56323", raw);
    assertEquals(p.canonical, false, raw);
  }
  const exact = publicRegisteredNumber({ requested: "56323", registry: resolved, sightings: 0 })!;
  assertEquals(exact.canonical, true);
});

Deno.test("a shared registrant names every brand and picks none", () => {
  // URBN's RN 66170 covers three brands (00466). An answer is "one of these".
  const p = publicRegisteredNumber({
    requested: "66170",
    registry: { ...resolved, registry_key: "RN:66170", digits: "66170", company_name: "URBN" },
    brandNames: ["Urban Outfitters", "Anthropologie", "Free People"],
    sightings: 4,
  })!;
  assertEquals(p.brands.length, 3);
});

Deno.test("a CA number is answered, and keeps its kind", () => {
  const p = publicRegisteredNumber({
    requested: "CA 32054",
    registry: { ...resolved, registry_key: "CA:32054", kind: "CA", digits: "32054" },
    sightings: null,
  })!;
  assertEquals(p.kind, "CA");
  assertEquals(p.key, "CA:32054");
});

Deno.test("something that is not a registry number at all is null", () => {
  for (const junk of ["", "  ", "not-a-number", "12345678901", "abc"]) {
    assertEquals(publicRegisteredNumber({ requested: junk, registry: null, sightings: null }), null, junk);
  }
});

Deno.test("product lines come back off the seeder's notes line", () => {
  assertEquals(productLinesFromNotes("FTC product lines: Women's apparel, Men's apparel"), [
    "Women's apparel",
    "Men's apparel",
  ]);
  assertEquals(productLinesFromNotes(null), []);
  assertEquals(productLinesFromNotes("an operator note"), []);
});

// ── The sitemap set uses the SAME predicate as the page ────────────────────

Deno.test("only numbers with a company reach the sitemap", () => {
  const rows = [
    { registry_key: "RN:56323", kind: "RN", digits: "56323", company_name: "NIKE, INC.", updated_at: "2026-08-31" },
    { registry_key: "RN:999999", kind: "RN", digits: "999999", company_name: null, updated_at: "2026-08-31" },
    { registry_key: "RN:1", kind: "RN", digits: "1", company_name: "   ", updated_at: null },
  ];
  assertEquals(indexableNumbers(rows).map((r) => r.digits), ["56323"]);
});

Deno.test("a CA row never reaches the sitemap even when resolved", () => {
  const rows = [
    { registry_key: "CA:32054", kind: "CA", digits: "32054", company_name: "A Canadian Co.", updated_at: null },
  ];
  assertEquals(indexableNumbers(rows), []);
});

Deno.test("the page and the sitemap agree on the same fixtures", () => {
  // The point of driving both from one set: neither half can drift alone.
  const rows = [
    { registry_key: "RN:56323", kind: "RN", digits: "56323", company_name: "NIKE, INC.", updated_at: null },
    { registry_key: "RN:999999", kind: "RN", digits: "999999", company_name: null, updated_at: null },
  ];
  const inSitemap = new Set(indexableNumbers(rows).map((r) => r.digits));
  for (const row of rows) {
    const page = publicRegisteredNumber({
      requested: row.digits,
      registry: { ...row, kind: "RN" as const },
      sightings: null,
    })!;
    assertEquals(page.indexable, inSitemap.has(row.digits), row.digits);
  }
});
