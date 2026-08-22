// US-2743 AC6: the kit may not imply the extension fills a field it cannot.
//
// THE BUG THIS COMES FROM. marketplace-specs.ts carried, for Mercari:
//
//     // Category and brand DO fill, so they are deliberately not here.
//     manualFields: ["condition", "size"],
//
// Brand does. Category cannot — no channel in lister/selectors.js declares a
// `category` selector, runFlow fills only title, description, brand, price and
// photos, and common.js says so outright. A live run saw a category on the
// finished listing and the claim was written from that, but the extension was
// never what put it there: Mercari derives one from the title, or the seller
// had already set it.
//
// WHY THAT IS EXPENSIVE RATHER THAN UNTIDY. listing-kit.tsx renders this array
// as "You'll set these on Mercari yourself: …". A field ABSENT from it is
// therefore claimed as handled. Category is REQUIRED on Mercari, so the one
// field that decides whether a garment is findable at all was the field the
// seller had no reason to check.
//
// This drives the REAL selector config — loaded the way depth.test.cjs loads
// it, through `new Function("self", …)` — against the REAL spec objects. A scan
// would be the wrong instrument twice over: the property is about what two
// sources AGREE on, and the answer lives in object values, not in source text.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MARKETPLACE_SPECS } from "@/lib/marketplace-specs";

/** The real selector config, evaluated exactly as the extension loads it. */
function loadSelectors(): Record<string, { fields?: Record<string, unknown> }> {
  const src = readFileSync(
    resolve(process.cwd(), "extension-unified/lister/selectors.js"),
    "utf8",
  );
  const scope: Record<string, unknown> = {};
  new Function("self", `${src}; return self.GT_LISTER_SELECTORS;`)(scope);
  const out = scope.GT_LISTER_SELECTORS;
  if (!out || typeof out !== "object") {
    throw new Error("GT_LISTER_SELECTORS did not load");
  }
  return out as Record<string, { fields?: Record<string, unknown> }>;
}

const selectors = loadSelectors();

/**
 * Fields the extension can actually fill on a channel.
 *
 * `photoInput` is excluded: it is the file input, not a listing field, and no
 * spec has a "photoInput" key for it to collide with.
 */
function fillable(platform: string): Set<string> {
  const channel = selectors[platform];
  if (!channel?.fields) return new Set();
  return new Set(Object.keys(channel.fields).filter((k) => k !== "photoInput"));
}

describe("US-2743: the config loads at all", () => {
  it("evaluates to channels with fields", () => {
    // An empty load would make every assertion below vacuously true — the
    // classic way a cross-source guard passes by checking nothing.
    expect(Object.keys(selectors).length).toBeGreaterThanOrEqual(5);
    expect(fillable("mercari").size).toBeGreaterThanOrEqual(4);
  });

  it("brand really is declared on Mercari, so the split is real", () => {
    // The half of the old comment that was TRUE. If this ever fails, the
    // expectation below stops being about category specifically.
    expect(fillable("mercari").has("brand")).toBe(true);
  });

  it("NO channel declares a category selector", () => {
    // The fact the old comment contradicted. Stated as its own case so that a
    // future channel gaining one fails here — loudly, in the place that
    // explains why — rather than quietly weakening the rule below.
    for (const [platform, channel] of Object.entries(selectors)) {
      expect(
        Object.keys(channel?.fields ?? {}),
        `${platform} gained a category selector — update US-2743's premise`,
      ).not.toContain("category");
    }
  });
});

describe("US-2743: manualFields cannot omit a field the extension can't fill", () => {
  // NOT filtered on pushMechanism, and that mattered: Mercari and Poshmark are
  // both "manual" there — the field describes how a listing is PUSHED, and
  // neither has a write API — while the Lister still fills their forms. Keying
  // off it found zero platforms, and the self-check above is the only reason
  // that showed up as a failure instead of six vacuous passes.
  //
  // The real question is "does the extension have a flow for this platform",
  // and the honest answer to that is whether a channel exists in the config.
  const extensionPlatforms = Object.entries(MARKETPLACE_SPECS).filter(
    ([platform, spec]) =>
      Array.isArray(spec.manualFields) && selectors[platform] !== undefined,
  );

  it("there are platforms to check", () => {
    expect(extensionPlatforms.length).toBeGreaterThan(0);
  });

  for (const [platform, spec] of extensionPlatforms) {
    it(`${platform}: every required field is either fillable or named as manual`, () => {
      const canFill = fillable(platform);
      const manual = new Set(spec.manualFields ?? []);
      const claimed = (spec.fields ?? [])
        .filter((f) => f.required)
        .map((f) => f.key)
        // Title/description/price are the fill flow's core and are covered by
        // the selector check; this is about the fields nobody verified.
        .filter((key) => !canFill.has(key) && !manual.has(key));

      expect(
        claimed,
        `${platform} claims these required fields are handled, but the extension ` +
          `has no selector for them and manualFields does not name them. The kit ` +
          `renders manualFields as "you'll set these yourself", so anything absent ` +
          `reads to the seller as filled.`,
      ).toEqual([]);
    });
  }
});

describe("US-2743: the specific regression", () => {
  it("Mercari names category as manual", () => {
    // Pinned by name as well as by rule. The rule above is the general guard;
    // this case is the one that failed, so it fails first and reads plainly.
    expect(MARKETPLACE_SPECS.mercari?.manualFields).toContain("category");
  });

  it("and category is required there, which is why it matters", () => {
    const category = MARKETPLACE_SPECS.mercari?.fields.find((f) => f.key === "category");
    expect(category?.required).toBe(true);
  });
});
