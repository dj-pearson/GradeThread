// US-1716: provenance enforcement for brand-KB seeding.
import { assert, assertEquals } from "@std/assert";
import {
  partitionSeedFacts,
  validateBrandFact,
} from "../lib/brand-seed.ts";

Deno.test("a well-sourced fact validates", () => {
  const v = validateBrandFact({ source_url: "https://x", confidence: 0.8 });
  assert(v.ok);
  assertEquals(v.errors.length, 0);
});

Deno.test("unsourced facts are rejected", () => {
  assertEquals(validateBrandFact({ confidence: 0.8 }).ok, false);
  assertEquals(validateBrandFact({ source_url: "", confidence: 0.8 }).ok, false);
  assertEquals(validateBrandFact({ source_url: "   ", confidence: 0.8 }).ok, false);
});

Deno.test("missing or out-of-range confidence is rejected", () => {
  assertEquals(validateBrandFact({ source_url: "https://x" }).ok, false);
  assertEquals(
    validateBrandFact({ source_url: "https://x", confidence: 1.5 }).ok,
    false,
  );
  assertEquals(
    validateBrandFact({ source_url: "https://x", confidence: -0.1 }).ok,
    false,
  );
  // boundaries are allowed
  assert(validateBrandFact({ source_url: "https://x", confidence: 0 }).ok);
  assert(validateBrandFact({ source_url: "https://x", confidence: 1 }).ok);
});

Deno.test("partition seeds only well-sourced facts, surfaces the rest", () => {
  const facts = [
    { styleName: "ABC Pant", source_url: "https://lll", confidence: 0.9 },
    { styleName: "Guess Pant", source_url: "", confidence: 0.9 }, // unsourced
    { styleName: "Commission", source_url: "https://lll", confidence: 2 }, // bad conf
  ];
  const { accepted, rejected } = partitionSeedFacts(facts);
  assertEquals(accepted.length, 1);
  assertEquals(accepted[0].styleName, "ABC Pant");
  assertEquals(rejected.length, 2);
  assert(rejected[0].errors.length > 0);
});
