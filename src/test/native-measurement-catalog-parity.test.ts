import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MEASUREMENT_TEMPLATES } from "@/lib/measurement-templates";

// US-2812: the iOS and Android measurement catalogs against the web templates.
//
// NOTHING HELD THESE TOGETHER and they had drifted badly.
// `MeasurementCatalogTest.kt` asserts the Kotlin catalog's own hardcoded list
// back to itself, which is self-consistency rather than parity — it passes
// whatever the catalog says. `measurement-template-parity.test.ts` compares the
// web to the EDGE and says nothing about Swift or Kotlin.
//
// What that cost, found by an owner-requested listing dive:
//   bags        native offered length+width; the web asks for width, height,
//               depth and two drops, and marks the first three REQUIRED because
//               depth is what separates a tote from a clutch (US-2225).
//   accessories native dropped `hole_span`, the belt's first-to-last-hole span
//               and the third number a belt is sold on (US-2224).
//   headwear    NO BRANCH AT ALL, so a hat fell through to the clothing default
//               and was offered a chest, a sleeve and an inseam. Harmless until
//               US-2797 made `headwear` a producible item_category — before
//               that, no item could carry the value.
//
// Eight keys the web templates use were also absent from both native catalogs
// entirely, so even a server-sent value rendered with an auto-derived label:
// "Hole Span" instead of "First to last hole (belts)".
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY CLOTHING IS NOT CHECKED, and it is a real asymmetry rather than a gap
//
// The web resolves clothing FIVE ways — top / bottom / dress / outerwear / suit
// — by ranking a GARMENT word off the row (`garmentDescriptorFor`). The native
// `suggestedKeys` takes only the coarse `item_category`, and `clothing` cannot
// tell a blazer from jeans. Offering the union of garment fields is the honest
// answer there, and a guard demanding the web's five groups would be demanding
// information the caller does not have. Asserted below as an explicit skip so
// the exemption is visible rather than silently absent.

const ROOT = process.cwd();
const IOS = "ios/GradeThread/Inventory/ItemCanvas/MeasurementCatalog.swift";
const ANDROID =
  "android/app/src/main/java/com/gradethread/app/inventory/MeasurementCatalog.kt";

const read = (rel: string) =>
  readFileSync(resolve(ROOT, rel), "utf8").replace(/\r\n?/g, "\n");

/**
 * item_category → the web MEASUREMENT_TEMPLATES group it must match.
 *
 * Only the categories where the mapping is 1:1. `clothing` is deliberately
 * absent (see the header) and `other` maps to `generic`, which the native
 * catalogs spell as length+width.
 */
const CATEGORY_TO_GROUP: Record<string, keyof typeof MEASUREMENT_TEMPLATES> = {
  shoes: "shoes",
  watches: "watch",
  bags: "bag",
  accessories: "accessory",
  headwear: "headwear",
  other: "generic",
};

/** Keys the native switch returns for one `case "<category>"`. */
function nativeKeys(src: string, category: string, lang: "swift" | "kotlin"): string[] {
  const re = lang === "swift"
    ? new RegExp(`case[^\\n]*"${category}"[^\\n]*:\\s*\\n\\s*return \\[([^\\]]*)\\]`)
    : new RegExp(`"${category}"[^\\n]*->\\s*listOf\\(([^)]*)\\)`);
  const m = re.exec(src);
  const body = m?.[1];
  if (!body) return [];
  return [...body.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!);
}

/** Every key the native catalog defines a Spec for. */
function nativeSpecKeys(src: string, lang: "swift" | "kotlin"): Set<string> {
  const re = lang === "swift"
    ? /Spec\(key: "([a-z_]+)"/g
    : /Spec\("([a-z_]+)"/g;
  return new Set([...src.matchAll(re)].map((m) => m[1]!));
}

describe("US-2812: the native measurement catalogs match the web templates", () => {
  const cases: Array<[string, string, "swift" | "kotlin"]> = [
    ["iOS", IOS, "swift"],
    ["Android", ANDROID, "kotlin"],
  ];

  it.each(cases)("%s offers the right keys per category", (_name, rel, lang) => {
    const src = read(rel);

    // Guards the guard: a renamed switch or Spec constructor would make every
    // assertion below vacuous by returning empty arrays that "match" nothing.
    expect(nativeSpecKeys(src, lang).size, "no Spec entries parsed").toBeGreaterThan(10);
    expect(nativeKeys(src, "shoes", lang), "the shoes branch did not parse").toEqual([
      "size_us",
      "insole",
    ]);

    for (const [category, group] of Object.entries(CATEGORY_TO_GROUP)) {
      const want = MEASUREMENT_TEMPLATES[group].map((f) => f.key);
      const got = nativeKeys(src, category, lang);
      expect(
        got,
        `${category}: the web '${group}' template has [${want.join(", ")}] and this ` +
          `catalog offers [${got.join(", ")}]. Mirror the web list — these are the ` +
          `fields a buyer asks for, and a category with no branch falls through to ` +
          `the clothing default, which is how a hat came to be offered an inseam.`,
      ).toEqual(want);
    }
  });

  it.each(cases)("%s defines a Spec for every key it offers", (_name, rel, lang) => {
    // A key with no Spec still renders — label() de-underscores and kind()
    // defaults to length — so this never crashes and never looks broken. It
    // just loses the curated label, and "Hole Span" does not tell a seller what
    // to measure the way "First to last hole (belts)" does.
    const src = read(rel);
    const specs = nativeSpecKeys(src, lang);
    const offered = new Set(
      Object.keys(CATEGORY_TO_GROUP).flatMap((c) => nativeKeys(src, c, lang)),
    );
    const missing = [...offered].filter((k) => !specs.has(k));
    expect(missing, `offered with no Spec entry: ${missing.join(", ")}`).toEqual([]);
  });

  it("clothing is exempt on purpose, not by omission", () => {
    // If someone adds a clothing branch to CATEGORY_TO_GROUP, this fails and
    // makes them read the header first. The web's five clothing groups need a
    // garment word; suggestedKeys only has the coarse item_category.
    expect(Object.keys(CATEGORY_TO_GROUP)).not.toContain("clothing");
    expect(Object.keys(MEASUREMENT_TEMPLATES)).toEqual(
      expect.arrayContaining(["top", "bottom", "dress", "outerwear", "suit"]),
    );
  });
});
