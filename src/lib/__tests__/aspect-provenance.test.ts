// US-825: aspect provenance (web). Mirrors the edge aspect-provenance tests so
// the composer's pre-publish required-aspect check and source badges use the
// SAME rules as the server.
import { describe, it, expect } from "vitest";
import {
  pruneSources,
  requiredMissingAspectNames,
  strongerSource,
  type AspectSourceMap,
} from "@/lib/aspect-provenance";
import type { EbayAspect } from "@/hooks/use-ebay";

const req = (name: string, required: boolean): EbayAspect => ({
  localizedAspectName: name,
  aspectConstraint: { aspectRequired: required, aspectMode: "FREE_TEXT" },
});

describe("requiredMissingAspectNames", () => {
  it("lists only required AND unfilled aspects", () => {
    const list = [req("Brand", true), req("Size", true), req("Color", false)];
    const values = { Brand: ["Nike"], Size: [] as string[] };
    expect(requiredMissingAspectNames(list, values)).toEqual(["Size"]);
  });

  it("is empty when every required aspect is filled", () => {
    const list = [req("Brand", true)];
    expect(requiredMissingAspectNames(list, { Brand: ["Nike"] })).toEqual([]);
  });
});

describe("pruneSources", () => {
  it("drops source entries whose value was cleared", () => {
    const sources: AspectSourceMap = { Brand: "manual", Size: "ai_extracted" };
    const values = { Brand: ["Nike"], Size: [] as string[] };
    expect(pruneSources(sources, values)).toEqual({ Brand: "manual" });
  });
});

describe("strongerSource (precedence manual > ai > derived)", () => {
  it("keeps the higher-precedence source", () => {
    expect(strongerSource("ai_extracted", "inventory_derived")).toBe(
      "ai_extracted",
    );
    expect(strongerSource("inventory_derived", "manual")).toBe("manual");
    expect(strongerSource(undefined, "inventory_derived")).toBe(
      "inventory_derived",
    );
  });
});

// US-2389 — the web half of the shared required-aspect guard.
//
// This rule exists TWICE and cannot be imported across: the edge copy
// (requiredMissingAspects) is the publish BLOCKER that returns the 422 and
// names what is missing; this copy is the pre-publish CHECKLIST the seller
// reads in the composer. The vault note used to say they were "the same
// helper, so the UI warning and the server blocker cannot disagree". They are
// two copies. They can.
//
// The failure that makes it worth a fixture rather than a comment: if the
// checklist says a listing is ready and the blocker refuses it, the seller has
// no way to find out what is wrong -- the one surface that would tell them is
// the surface asserting nothing is missing. Both suites now assert this table,
// the same remedy US-2034 used for the weighted-overall mirrors.
describe("required-aspect completeness (shared fixture, US-2389)", () => {
  it("matches every case in the cross-project fixture", async () => {
    const fixture = (await import(
      "../../test/fixtures/required-aspects-cases.json"
    )).default;
    expect(fixture.cases.length).toBeGreaterThan(8);
    for (const c of fixture.cases) {
      expect(
        requiredMissingAspectNames(
          c.aspects as unknown as EbayAspect[],
          c.values as Record<string, string[]>,
        ),
        `case: ${c.why}`,
      ).toEqual(c.expected_missing);
    }
  });

  it("covers the shapes that actually differ between the two copies", async () => {
    // A fixture of ten happy cases would pass on both copies while proving
    // nothing about the ways they could drift. Assert the awkward inputs are
    // present by name, so a future trim cannot quietly remove the coverage and
    // leave a green suite behind.
    const fixture = (await import(
      "../../test/fixtures/required-aspects-cases.json"
    )).default;
    const whys = fixture.cases.map((c) => c.why).join(" | ");
    expect(whys).toMatch(/missing-constraint-object/);
    expect(whys).toMatch(/EMPTY ARRAY/);
    expect(whys).toMatch(/BLANK NAME/);
    expect(whys).toMatch(/ORDER/);
  });
});
