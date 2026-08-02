// US-825: aspect provenance + the single source-of-truth required-aspect check.
// Pure functions — no env. These mirror the three provenance WRITE paths:
//   • AI generation  (ai-listing.ts)      → sourcesFor(keys, "ai_extracted")
//   • deterministic derive (flipdesk-ebay) → sourcesFor(keys, "inventory_derived")
//   • the persist merge that combines them → mergeSources(...)
// and assert requiredMissingAspects matches the rule the publish blocker uses.
//   deno test src/tests/aspect-provenance_test.ts
import { assert, assertEquals } from "@std/assert";
import {
  type AspectCoverage,
  mergeSources,
  type RankedAspectSpec,
  recommendedAspectCoverage,
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

// ── US-1895: recommended-aspect coverage ───────────────────────────

const rec = (
  name: string,
  usage: "REQUIRED" | "RECOMMENDED" | "OPTIONAL",
  searchCount?: number,
): RankedAspectSpec => ({
  localizedAspectName: name,
  aspectConstraint: { aspectUsage: usage, aspectRequired: usage === "REQUIRED" },
  ...(searchCount != null ? { relevanceIndicator: { searchCount } } : {}),
});

Deno.test("coverage counts only RECOMMENDED aspects, filled vs total", () => {
  const list = [
    rec("Brand", "REQUIRED"),
    rec("Department", "RECOMMENDED", 900),
    rec("Type", "RECOMMENDED", 500),
    rec("Occasion", "OPTIONAL", 100),
  ];
  const cov: AspectCoverage = recommendedAspectCoverage(list, { Department: ["Men"] });
  assertEquals(cov.total, 2); // only the two RECOMMENDED
  assertEquals(cov.filled, 1); // Department filled
  assertEquals(cov.missing, ["Type"]); // Occasion is OPTIONAL, Brand REQUIRED
});

Deno.test("missing recommended are ranked by search volume (desc)", () => {
  const list = [
    rec("Style", "RECOMMENDED", 200),
    rec("Color", "RECOMMENDED", 1500),
    rec("Material", "RECOMMENDED", 800),
  ];
  const cov = recommendedAspectCoverage(list, {});
  assertEquals(cov.missing, ["Color", "Material", "Style"]);
  assertEquals(cov.filled, 0);
  assertEquals(cov.total, 3);
});

Deno.test("empty-string values do not count as filled", () => {
  const list = [rec("Type", "RECOMMENDED", 100)];
  assertEquals(recommendedAspectCoverage(list, { Type: ["", "  "] }).filled, 0);
  assertEquals(recommendedAspectCoverage(list, { Type: ["Tee"] }).filled, 1);
});

Deno.test("no recommended aspects → zeroed coverage", () => {
  const cov = recommendedAspectCoverage([rec("Brand", "REQUIRED")], {});
  assertEquals(cov, { filled: 0, total: 0, missing: [] });
});

Deno.test("ties on search volume are name-ordered (deterministic)", () => {
  const list = [rec("Zeta", "RECOMMENDED", 0), rec("Alpha", "RECOMMENDED", 0)];
  assertEquals(recommendedAspectCoverage(list, {}).missing, ["Alpha", "Zeta"]);
});

Deno.test("coverage aligns with the required rule (no overlap double-count)", () => {
  const list = [
    rec("Brand", "REQUIRED"),
    rec("Size", "REQUIRED"),
    rec("Color", "RECOMMENDED", 300),
  ];
  const map = { Brand: ["Nike"] };
  // required still flags Size; recommended coverage is independent (Color).
  assert(requiredMissingAspects(list, map).includes("Size"));
  const cov = recommendedAspectCoverage(list, map);
  assertEquals(cov.total, 1);
  assertEquals(cov.missing, ["Color"]);
});

// US-2389 — the EDGE half of the shared required-aspect guard.
//
// This copy is the publish BLOCKER: it decides the 422 that stops a publish or
// revise and names the aspects the seller has to fill. The web copy is the
// checklist that seller reads beforehand. The vault note claimed they were "the
// same helper, so the UI warning and the server blocker cannot disagree" -- they
// are two copies, and when this fixture was first run they DID disagree: the web
// copy threw a TypeError on an aspect spec with no aspectConstraint object,
// which this copy has always handled. That was a live crash in the composer's
// checklist, sitting behind a type that promised the field was always present.
const requiredAspectFixture = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../../../src/test/fixtures/required-aspects-cases.json",
      import.meta.url,
    ),
  ),
) as {
  cases: Array<{
    why: string;
    aspects: RequiredAspectSpec[];
    values: Record<string, string[]>;
    expected_missing: string[];
  }>;
};

Deno.test("edge required-aspect check matches the cross-project fixture", () => {
  assertEquals(
    requiredAspectFixture.cases.length > 8,
    true,
    "fixture looks truncated",
  );
  for (const c of requiredAspectFixture.cases) {
    assertEquals(
      requiredMissingAspects(c.aspects, c.values),
      c.expected_missing,
      `case: ${c.why}`,
    );
  }
});

Deno.test("the fixture still covers the shapes the two copies differ on", () => {
  // Ten happy cases would pass on both copies and prove nothing about drift.
  // Assert the awkward inputs by name so a future trim cannot silently remove
  // the coverage and leave a green suite behind.
  const whys = requiredAspectFixture.cases.map((c) => c.why).join(" | ");
  for (const needle of ["missing-constraint-object", "EMPTY ARRAY", "BLANK NAME", "ORDER"]) {
    assertEquals(whys.includes(needle), true, `fixture lost the ${needle} case`);
  }
});
