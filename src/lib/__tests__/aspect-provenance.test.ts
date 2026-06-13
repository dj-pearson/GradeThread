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
