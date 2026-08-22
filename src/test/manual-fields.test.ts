// US-2745 AC4: a declared manual field must be a real field on that platform.
//
// THE FAILURE THIS PREVENTS IS SILENT. listing-kit builds the notice with
//
//   spec.manualFields.map((key) => spec.fields.find((f) => f.key === key)?.label)
//                    .filter(Boolean)
//
// so a key that matches nothing does not throw, does not warn, and does not
// appear. The seller is told they must set three things by hand when the spec
// meant four, and the missing one is the one nobody notices.
//
// cross-post-setup.test.ts covers this by parsing marketplace-specs.ts as text
// and cross-checking `key: "..."` inside the same block. That is a derived scan
// rather than a hard-coded list and it is decent. But the spec is an ordinary
// importable module, so the mapping the component actually performs can just be
// performed here — which also survives the file being reformatted, reordered,
// or split.

import { describe, expect, it } from "vitest";
import { MARKETPLACE_SPECS, SPECCED_PLATFORMS } from "@/lib/marketplace-specs";

/** The exact expression listing-kit uses to build the notice. */
function noticeLabels(platform: (typeof SPECCED_PLATFORMS)[number]): string[] {
  const spec = MARKETPLACE_SPECS[platform];
  return (spec.manualFields ?? [])
    .map((key) => spec.fields.find((f) => f.key === key)?.label)
    .filter((label): label is string => Boolean(label));
}

describe("US-2745: manualFields", () => {
  it("every declared key resolves to a real field with a label", () => {
    const broken: string[] = [];
    for (const platform of SPECCED_PLATFORMS) {
      const spec = MARKETPLACE_SPECS[platform];
      for (const key of spec.manualFields ?? []) {
        const field = spec.fields.find((f) => f.key === key);
        if (!field) broken.push(`${platform}.${key} — no such field`);
        else if (!field.label) broken.push(`${platform}.${key} — field has no label`);
      }
    }
    expect(
      broken,
      "These keys would vanish from the notice instead of failing, so the " +
        "seller is told to set fewer things by hand than the spec intends: " +
        broken.join(", "),
    ).toEqual([]);
  });

  it("nothing is lost between the declaration and the rendered notice", () => {
    // The count is the assertion. A key silently filtered out shows up here as
    // a shorter list than was declared, which is the actual failure mode.
    for (const platform of SPECCED_PLATFORMS) {
      const declared = MARKETPLACE_SPECS[platform].manualFields ?? [];
      expect(
        noticeLabels(platform).length,
        `${platform} declares ${declared.length} manual fields but the notice ` +
          `would render ${noticeLabels(platform).length}`,
      ).toBe(declared.length);
    }
  });

  it("only the platforms VERIFIED on a live form declare anything", () => {
    // AC2. An unset value means "not established", never "the extension fills
    // everything" — so an unchecked platform must stay silent rather than make
    // a promise nobody tested.
    const declaring = SPECCED_PLATFORMS.filter(
      (p) => (MARKETPLACE_SPECS[p].manualFields ?? []).length > 0,
    ).sort();
    expect(declaring).toEqual(["mercari", "poshmark"]);
  });

  it("a platform that declares nothing renders nothing", () => {
    for (const platform of SPECCED_PLATFORMS) {
      if ((MARKETPLACE_SPECS[platform].manualFields ?? []).length > 0) continue;
      expect(noticeLabels(platform)).toEqual([]);
    }
  });

  it("Mercari does not list BRAND, because brand really does fill", () => {
    // AC5. Listing it would tell the seller to redo work already done, which is
    // a different kind of wrong from omitting one.
    //
    // ⚠ THIS CASE USED TO SAY "category or brand, because both fill" and it was
    // half wrong — which is worse than wholly wrong, because the true half made
    // it read as checked. Brand fills: its selector was verified on the live
    // form and runFlow has filled `f.brand` for any channel declaring one since
    // US-2730. Category CANNOT: no channel in lister/selectors.js declares a
    // `category` selector at all, and runFlow has no branch for one.
    //
    // A live run saw a category on the finished listing and the claim was
    // written from that observation. Mercari derives one from the title, or the
    // seller had set it — either way it was never the extension, and the kit was
    // telling sellers the required field they most need to check was handled.
    //
    // The general rule now lives in manual-fields-match-selectors.test.ts, which
    // loads the real selector config and would have caught this. Kept here as
    // well, by name, because this is the case that was actively wrong (US-2743).
    const mercari = MARKETPLACE_SPECS.mercari.manualFields ?? [];
    expect(mercari).not.toContain("brand");
    expect(mercari).toContain("category");
  });

  it("the declared sets are the ones confirmed on the live form", () => {
    // Pinned so a later edit is a decision someone makes, not a drift. Changing
    // these means re-checking the form, which is what AC2 is about.
    expect([...(MARKETPLACE_SPECS.poshmark.manualFields ?? [])].sort())
      .toEqual(["category", "color", "nwt", "size"]);
    // category joined 2026-08-22 (US-2743 AC6): it was never fillable, and the
    // pin above was holding the wrong set steady rather than holding a checked
    // one. A pin is only as good as the check behind it.
    expect([...(MARKETPLACE_SPECS.mercari.manualFields ?? [])].sort())
      .toEqual(["category", "condition", "size"]);
  });
});

describe("US-2739 / US-2744: which platforms price in whole units", () => {
  it("the declaring set is exactly the two confirmed on a live form", () => {
    // PER PLATFORM, not "somebody declares one". cross-post-setup asserts
    // src.toContain('priceStep: 1,'), which Poshmark's declaration satisfies on
    // its own - so Vinted's could be deleted and every test stayed green.
    // Verified by sabotage 2026-08-21.
    const stepping = SPECCED_PLATFORMS
      .filter((p) => (MARKETPLACE_SPECS[p].priceStep ?? 0) > 0)
      .sort();
    expect(stepping).toEqual(["poshmark", "vinted"]);
  });

  it("each declares a step of exactly 1", () => {
    // Both were confirmed as WHOLE units on the live sell form. A step of 5 or
    // 0.5 would be a different claim about a different form.
    expect(MARKETPLACE_SPECS.poshmark.priceStep).toBe(1);
    expect(MARKETPLACE_SPECS.vinted.priceStep).toBe(1);
  });

  it("every other platform keeps its cents", () => {
    // An unset step means "prices in cents", and eBay genuinely does. Stepping a
    // platform nobody checked would round real prices for no reason.
    for (const p of SPECCED_PLATFORMS) {
      if (p === "poshmark" || p === "vinted") continue;
      expect(MARKETPLACE_SPECS[p].priceStep ?? 0, `${p} gained a priceStep`).toBe(0);
    }
  });
});
