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

  it("Mercari does not list category or brand, because both fill", () => {
    // AC5. Listing them would tell the seller to redo work already done, which
    // is a different kind of wrong from omitting one.
    const mercari = MARKETPLACE_SPECS.mercari.manualFields ?? [];
    expect(mercari).not.toContain("category");
    expect(mercari).not.toContain("brand");
  });

  it("the declared sets are the ones confirmed on the live form", () => {
    // Pinned so a later edit is a decision someone makes, not a drift. Changing
    // these means re-checking the form, which is what AC2 is about.
    expect([...(MARKETPLACE_SPECS.poshmark.manualFields ?? [])].sort())
      .toEqual(["category", "color", "nwt", "size"]);
    expect([...(MARKETPLACE_SPECS.mercari.manualFields ?? [])].sort())
      .toEqual(["condition", "size"]);
  });
});
