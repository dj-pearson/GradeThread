import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  charStatus,
  getMarketplaceSpec,
  gradeToConditionBucket,
  manualKitPlatforms,
  mapCondition,
  MARKETPLACE_SPECS,
  SPECCED_PLATFORMS,
  validateListingForPlatform,
  type DraftFields,
  type MarketplacePlatform,
} from "../marketplace-specs";

const here = dirname(fileURLToPath(import.meta.url));
const CANONICAL = resolve(here, "../marketplace-specs.ts");
const EDGE_MIRROR = resolve(
  here,
  "../../../services/edge-functions/src/lib/marketplace-specs.ts",
);

describe("edge mirror stays in sync", () => {
  it("services/edge-functions copy is byte-identical to the canonical file", () => {
    const canonical = readFileSync(CANONICAL, "utf8");
    const mirror = readFileSync(EDGE_MIRROR, "utf8");
    expect(mirror).toBe(canonical);
  });
});

describe("registry integrity", () => {
  it("every specced platform has a non-empty field list and a source note", () => {
    for (const p of SPECCED_PLATFORMS) {
      const spec = MARKETPLACE_SPECS[p];
      expect(spec.fields.length).toBeGreaterThan(0);
      expect(spec.sourceNote).toMatch(/VERIFY/);
      expect(spec.maxPhotos).toBeGreaterThan(0);
    }
  });

  it("a title field's maxLength matches the spec's titleMaxLength", () => {
    for (const p of SPECCED_PLATFORMS) {
      const spec = MARKETPLACE_SPECS[p];
      const title = spec.fields.find((f) => f.key === "title");
      if (spec.titleMaxLength == null) {
        // Depop has no title field.
        expect(title).toBeUndefined();
      } else {
        expect(title?.maxLength).toBe(spec.titleMaxLength);
      }
    }
  });

  it("getMarketplaceSpec returns undefined for unspecced platforms", () => {
    expect(getMarketplaceSpec("facebook")).toBeUndefined();
    expect(getMarketplaceSpec("ebay")?.platform).toBe("ebay");
  });

  it("manualKitPlatforms are the non-API platforms", () => {
    expect(manualKitPlatforms().sort()).toEqual(
      ["grailed", "mercari", "poshmark"].sort(),
    );
  });
});

describe("gradeToConditionBucket", () => {
  it("treats NWT label as new-with-tags but not NWOT", () => {
    expect(gradeToConditionBucket(8, "NWT")).toBe("NEW_WITH_TAGS");
    // NWOT must NOT match the NWT check
    expect(gradeToConditionBucket(null, "NWOT")).toBe("EXCELLENT");
  });

  it("buckets by grade thresholds", () => {
    expect(gradeToConditionBucket(9.8, null)).toBe("NEW_WITH_TAGS");
    expect(gradeToConditionBucket(9.0, null)).toBe("NEW_WITHOUT_TAGS");
    expect(gradeToConditionBucket(7.5, null)).toBe("EXCELLENT");
    expect(gradeToConditionBucket(6.0, null)).toBe("VERY_GOOD");
    expect(gradeToConditionBucket(4.5, null)).toBe("GOOD");
    expect(gradeToConditionBucket(3.0, null)).toBe("ACCEPTABLE");
    expect(gradeToConditionBucket(1.5, null)).toBe("POOR");
  });

  it("falls back without a grade", () => {
    expect(gradeToConditionBucket(null, null)).toBe("EXCELLENT");
    expect(gradeToConditionBucket(null, "NWT")).toBe("NEW_WITH_TAGS");
  });
});

// Reproduces the legacy mapEbayCondition in flipdesk-ebay.ts so the eBay path
// is provably a no-op when that function adopts mapCondition().
function legacyMapEbayCondition(grade: number | null, label: string | null): string {
  const isNwt = (label ?? "").toUpperCase().includes("NWT");
  if (grade != null) {
    if (grade >= 9.75 || isNwt) return "NEW";
    if (grade >= 9.0) return "LIKE_NEW";
    if (grade >= 7.5) return "USED_EXCELLENT";
    if (grade >= 6.0) return "USED_VERY_GOOD";
    if (grade >= 4.5) return "USED_GOOD";
    return "USED_ACCEPTABLE";
  }
  return isNwt ? "NEW" : "USED_EXCELLENT";
}

describe("mapCondition: eBay matches the legacy mapper exactly", () => {
  const grades: (number | null)[] = [
    null, 10, 9.75, 9.5, 9.0, 8.0, 7.5, 7.0, 6.0, 5.0, 4.5, 4.0, 3.0, 2.0, 1.0,
  ];
  const labels: (string | null)[] = [null, "NWT", "NWOT", "Excellent"];
  for (const g of grades) {
    for (const l of labels) {
      it(`grade=${g} label=${l}`, () => {
        expect(mapCondition("ebay", g, l)?.value).toBe(legacyMapEbayCondition(g, l));
      });
    }
  }
});

describe("mapCondition: other platforms", () => {
  it("maps to each platform's own wording", () => {
    expect(mapCondition("mercari", 9.8, null)?.value).toBe("New");
    expect(mapCondition("mercari", 1.0, null)?.value).toBe("Poor");
    expect(mapCondition("grailed", 8.0, null)?.value).toBe("Gently used");
    expect(mapCondition("grailed", 1.0, null)?.value).toBe("Very worn");
    expect(mapCondition("depop", 9.0, null)?.value).toBe("Like new");
    expect(mapCondition("poshmark", 10, "NWT")?.value).toBe("NWT");
  });

  it("returns a value that exists in the platform's conditions[] list", () => {
    const platforms: MarketplacePlatform[] = [
      "ebay", "poshmark", "mercari", "depop", "grailed",
    ];
    for (const p of platforms) {
      const opt = mapCondition(p, 7.0, null);
      expect(opt).not.toBeNull();
      expect(MARKETPLACE_SPECS[p].conditions.some((c) => c.value === opt!.value)).toBe(true);
    }
  });

  it("returns null for Shopify (no condition field)", () => {
    expect(mapCondition("shopify", 7.0, null)).toBeNull();
  });
});

describe("validateListingForPlatform", () => {
  // A Mercari draft that satisfies every required field.
  const goodMercari: DraftFields = {
    title: "Nike Tech Fleece Hoodie Men's M Black",
    description: "Great condition hoodie.",
    category: "Men > Tops > Hoodies",
    condition: "Good",
    price: "45",
    brand: "Nike",
    tags: ["#nike", "#hoodie"],
  };

  it("passes a complete, in-limit draft", () => {
    const r = validateListingForPlatform("mercari", goodMercari, { photoCount: 5 });
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("errors on a missing required field", () => {
    const r = validateListingForPlatform("mercari", { ...goodMercari, title: "" });
    expect(r.ok).toBe(false);
    expect(r.issues).toContainEqual({ field: "title", level: "error", message: "Title is required" });
  });

  it("errors on an over-limit title with a trim hint", () => {
    const r = validateListingForPlatform("mercari", { ...goodMercari, title: "x".repeat(84) });
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.field === "title");
    expect(issue?.level).toBe("error");
    expect(issue?.message).toContain("84/80");
    expect(issue?.message).toContain("trim 4");
  });

  it("errors on an invalid condition value", () => {
    const r = validateListingForPlatform("mercari", { ...goodMercari, condition: "USED_GOOD" });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.field === "condition" && i.level === "error")).toBe(true);
  });

  it("errors on too many photos", () => {
    const r = validateListingForPlatform("mercari", goodMercari, { photoCount: 13 });
    expect(r.issues).toContainEqual({ field: "photos", level: "error", message: "Too many photos (13/12)" });
  });

  it("errors on too many tags", () => {
    const r = validateListingForPlatform("mercari", { ...goodMercari, tags: ["a", "b", "c", "d"] });
    expect(r.issues.some((i) => i.field === "tags" && i.level === "error")).toBe(true);
  });

  it("errors when a Grailed designer is off the allow-list", () => {
    const draft: DraftFields = {
      title: "Vintage jacket",
      description: "Nice jacket",
      department: "Menswear",
      category: "Outerwear",
      designer: "No-Name Brand",
      size: "M",
      condition: "Used",
      price: "120",
    };
    const ok = validateListingForPlatform("grailed", draft, { brandAllowed: true });
    expect(ok.ok).toBe(true);
    const bad = validateListingForPlatform("grailed", draft, { brandAllowed: false });
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => i.field === "designer" && i.level === "error")).toBe(true);
  });

  it("warns (not errors) on empty optional brand/tags", () => {
    const r = validateListingForPlatform("mercari", { ...goodMercari, brand: "", tags: [] });
    expect(r.ok).toBe(true); // warnings don't block
    expect(r.issues.some((i) => i.field === "brand" && i.level === "warning")).toBe(true);
    expect(r.issues.some((i) => i.field === "tags" && i.level === "warning")).toBe(true);
  });
});

describe("charStatus", () => {
  it("flags over-limit values", () => {
    expect(charStatus("abc", 5)).toEqual({ length: 3, max: 5, over: false, remaining: 2 });
    expect(charStatus("abcdef", 5)).toEqual({ length: 6, max: 5, over: true, remaining: -1 });
  });
  it("treats null/undefined limit as unbounded", () => {
    expect(charStatus("anything", null)).toEqual({ length: 8, max: null, over: false, remaining: null });
    expect(charStatus("anything", undefined).over).toBe(false);
  });
});
