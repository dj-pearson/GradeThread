// US-1995: the orchestration around backwards title sync.
import { describe, expect, it } from "vitest";

import { buildTitleSyncPatch, type TitleSyncPatchInput } from "@/lib/title-sync-patch";
import type { FieldChange } from "@/lib/title-sync";
// US-2817: the edge grew its own copy of this orchestration (bulk re-identify
// is the first edge writer that REPLACES a field value rather than filling a
// blank). Both suites read this fixture; add a case here, never to one suite.
import fixture from "../../test/fixtures/title-sync-patch-cases.json";

describe("shared behavioural fixture (edge ⇄ web lockstep)", () => {
  it("buildTitleSyncPatch matches the edge copy's expectations", () => {
    expect(fixture.buildTitleSyncPatch.length).toBeGreaterThan(0);
    for (const c of fixture.buildTitleSyncPatch) {
      expect(
        buildTitleSyncPatch(c.input as TitleSyncPatchInput),
        `fixture case: ${c.name}`,
      ).toEqual(c.expected);
    }
  });
});

const BRAND_CHANGE: FieldChange[] = [{ field: "brand", from: "Patagonia", to: "Arc'teryx" }];

describe("buildTitleSyncPatch", () => {
  it("substitutes the changed field into the title", () => {
    const patch = buildTitleSyncPatch({
      baseTitle: "Patagonia Better Sweater Fleece Jacket",
      changes: BRAND_CHANGE,
    });
    expect(patch.listing_title).toBe("Arc'teryx Better Sweater Fleece Jacket");
    expect(patch.needs_review).toBeUndefined();
  });

  it("REFUSES to touch an ebay-origin listing", () => {
    // eBay owns that listing's title — writing it would break the sync contract
    // in SYNC_SOURCE_OF_TRUTH.md, and eBay would re-assert it on the next pull
    // anyway, so the write is both wrong and futile.
    const patch = buildTitleSyncPatch({
      baseTitle: "Patagonia Better Sweater Fleece Jacket",
      changes: BRAND_CHANGE,
      listingOrigin: "ebay",
    });
    expect(patch).toEqual({});
  });

  it("moves BOTH A/B variants", () => {
    // A stale brand in variant B is the same bug, just less visible.
    const patch = buildTitleSyncPatch({
      baseTitle: "Patagonia Fleece Jacket",
      variants: [
        { label: "a", title: "Patagonia Fleece Jacket" },
        { label: "b", title: "Patagonia Fleece Jacket Navy Medium" },
      ],
      changes: BRAND_CHANGE,
    });
    expect(patch.title_variants).toEqual([
      { label: "a", title: "Arc'teryx Fleece Jacket" },
      { label: "b", title: "Arc'teryx Fleece Jacket Navy Medium" },
    ]);
  });

  it("leaves a non-string variant entry untouched instead of crashing", () => {
    const patch = buildTitleSyncPatch({
      baseTitle: "Patagonia Fleece Jacket",
      variants: [null, { label: "b" }, { label: "c", title: "Patagonia Tee" }],
      changes: BRAND_CHANGE,
    });
    expect(patch.title_variants).toEqual([null, { label: "b" }, { label: "c", title: "Arc'teryx Tee" }]);
  });

  it("flags a HAND-EDITED title for review rather than silently rewriting it", () => {
    // The seller chose those words. Substitute, but surface the diff.
    const patch = buildTitleSyncPatch({
      baseTitle: "Patagonia Fleece Jacket — RARE vintage colourway",
      snapshotTitle: "Patagonia Better Sweater Fleece Jacket",
      changes: BRAND_CHANGE,
    });
    expect(patch.listing_title).toContain("Arc'teryx");
    expect(patch.needs_review).toBe(true);
  });

  it("does NOT flag when the title still matches the AI snapshot", () => {
    const patch = buildTitleSyncPatch({
      baseTitle: "Patagonia Better Sweater Fleece Jacket",
      snapshotTitle: "Patagonia Better Sweater Fleece Jacket",
      changes: BRAND_CHANGE,
    });
    expect(patch.listing_title).toContain("Arc'teryx");
    expect(patch.needs_review).toBeUndefined();
  });

  it("flags a LIVE listing — buyers are already seeing that title", () => {
    const patch = buildTitleSyncPatch({
      baseTitle: "Patagonia Better Sweater Fleece Jacket",
      snapshotTitle: "Patagonia Better Sweater Fleece Jacket",
      isLive: true,
      changes: BRAND_CHANGE,
    });
    expect(patch.needs_review).toBe(true);
  });

  it("returns an EMPTY patch when nothing would change", () => {
    // Callers skip the write entirely on an empty patch, so these must not
    // produce a no-op UPDATE that dirties updated_at on every bulk save.
    expect(buildTitleSyncPatch({ baseTitle: "Nike Tee", changes: BRAND_CHANGE })).toEqual({});
    expect(buildTitleSyncPatch({ baseTitle: "Patagonia Tee", changes: [] })).toEqual({});
    expect(buildTitleSyncPatch({ baseTitle: "", changes: BRAND_CHANGE })).toEqual({});
    expect(buildTitleSyncPatch({ baseTitle: null, changes: BRAND_CHANGE })).toEqual({});
  });

  it("does not mistake a pure re-trim for a substitution", () => {
    // syncTitle re-trims to eBay's 80-char cap. An over-long title whose only
    // change is losing its tail must not be written back as if a field moved —
    // that would silently truncate titles on unrelated bulk saves.
    const long = "Nike " + "x".repeat(120);
    expect(buildTitleSyncPatch({ baseTitle: long, changes: BRAND_CHANGE })).toEqual({});
  });
});
