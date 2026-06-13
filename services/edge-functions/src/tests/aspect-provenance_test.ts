// US-825: aspect provenance + the single source-of-truth required-aspect check.
// Pure functions — no env. These mirror the three provenance WRITE paths:
//   • AI generation  (ai-listing.ts)      → sourcesFor(keys, "ai_extracted")
//   • deterministic derive (flipdesk-ebay) → sourcesFor(keys, "inventory_derived")
//   • the persist merge that combines them → mergeSources(...)
// and assert requiredMissingAspects matches the rule the publish blocker uses.
//   deno test src/tests/aspect-provenance_test.ts
import { assertEquals } from "@std/assert";
import {
  mergeSources,
  type RequiredAspectSpec,
  requiredMissingAspects,
  sourcesFor,
} from "../lib/aspect-provenance.ts";

const req = (name: string, required: boolean): RequiredAspectSpec => ({
  localizedAspectName: name,
  aspectConstraint: { aspectRequired: required },
});

Deno.test("requiredMissingAspects: only required AND unfilled", () => {
  const list = [req("Brand", true), req("Size", true), req("Color", false)];
  // Brand filled, Size empty, Color (optional) empty.
  const map = { Brand: ["Nike"], Size: [] as string[] };
  assertEquals(requiredMissingAspects(list, map), ["Size"]);
});

Deno.test("requiredMissingAspects: empty when all required filled", () => {
  const list = [req("Brand", true)];
  assertEquals(requiredMissingAspects(list, { Brand: ["Nike"] }), []);
});

Deno.test("requiredMissingAspects: ignores unnamed specs", () => {
  const list: RequiredAspectSpec[] = [
    { aspectConstraint: { aspectRequired: true } }, // no name → skipped
    req("Brand", true),
  ];
  assertEquals(requiredMissingAspects(list, {}), ["Brand"]);
});

Deno.test("sourcesFor: AI generation path marks every key ai_extracted", () => {
  // ai-listing.ts writes ebay_aspect_sources from the generated specifics' keys.
  const generated = { Brand: ["Nike"], Department: ["Men"] };
  assertEquals(sourcesFor(Object.keys(generated), "ai_extracted"), {
    Brand: "ai_extracted",
    Department: "ai_extracted",
  });
});

Deno.test("sourcesFor: derive path marks keys inventory_derived; skips empty", () => {
  assertEquals(sourcesFor(["Color", ""], "inventory_derived"), {
    Color: "inventory_derived",
  });
});

Deno.test("mergeSources: derive never downgrades an AI/manual aspect", () => {
  const prior = { Brand: "ai_extracted" as const, Style: "manual" as const };
  const derived = sourcesFor(["Brand", "Style", "Color"], "inventory_derived");
  const map = { Brand: ["Nike"], Style: ["Casual"], Color: ["Blue"] };
  assertEquals(mergeSources(prior, derived, map), {
    Brand: "ai_extracted", // kept (higher precedence)
    Style: "manual", // kept (highest precedence)
    Color: "inventory_derived", // newly derived
  });
});

Deno.test("mergeSources: a stronger source upgrades a weaker one", () => {
  const prior = { Brand: "inventory_derived" as const };
  const manual = sourcesFor(["Brand"], "manual");
  assertEquals(mergeSources(prior, manual, { Brand: ["Nike"] }), {
    Brand: "manual",
  });
});

Deno.test("mergeSources: prunes sources whose value was cleared", () => {
  const prior = { Brand: "manual" as const, Size: "ai_extracted" as const };
  // Size cleared (no value) — its source must not linger.
  const next = mergeSources(prior, {}, { Brand: ["Nike"], Size: [] });
  assertEquals(next, { Brand: "manual" });
});
