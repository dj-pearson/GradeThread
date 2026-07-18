// deriveListingOrigin decides whether a listing is a read-only eBay mirror or a
// GradeThread-managed listing. That single boolean gates revise, reprice,
// withdraw, relist, promote and the item canvas's locked-fields banner, and it
// had NO test coverage until US-1968 needed the persisted-column branch to work.

import { describe, expect, it } from "vitest";
import { deriveListingOrigin } from "@/lib/listing-origin";

describe("deriveListingOrigin", () => {
  it("lets the PERSISTED listing_origin win over the provenance signals", () => {
    // The US-1968 case. After bulk_migrate_listing, the row keeps the signals of
    // an eBay-created listing (a platform_listing_id, no batch_id, never
    // synced_to_ebay_at) but IS now GradeThread-managed. If the persisted column
    // didn't win, a migrated listing would stay locked forever.
    expect(
      deriveListingOrigin({
        platform: "ebay",
        listing_origin: "gradethread",
        platform_listing_id: "110001",
        batch_id: null,
        synced_to_ebay_at: null,
      }),
    ).toBe("gradethread");

    // And the reverse: an explicit 'ebay' marker wins even when the signals
    // would otherwise say GradeThread.
    expect(
      deriveListingOrigin({
        platform: "ebay",
        listing_origin: "ebay",
        platform_listing_id: "110002",
        batch_id: "batch-1",
        synced_to_ebay_at: "2026-07-18T00:00:00Z",
      }),
    ).toBe("ebay");
  });

  it("ignores a null/unrecognized marker and falls back to the signals", () => {
    for (const marker of [null, undefined, "", "nonsense"]) {
      expect(
        deriveListingOrigin({
          platform: "ebay",
          listing_origin: marker as string | null,
          platform_listing_id: "110003",
          batch_id: null,
          synced_to_ebay_at: null,
        }),
      ).toBe("ebay");
    }
  });

  it("treats a batch_id or a sync stamp as proof WE published it", () => {
    expect(
      deriveListingOrigin({
        platform: "ebay",
        platform_listing_id: "110004",
        batch_id: "batch-9",
        synced_to_ebay_at: null,
      }),
    ).toBe("gradethread");
    expect(
      deriveListingOrigin({
        platform: "ebay",
        platform_listing_id: "110005",
        batch_id: null,
        synced_to_ebay_at: "2026-07-18T00:00:00Z",
      }),
    ).toBe("gradethread");
  });

  it("only calls a listing eBay-originated when it is live on eBay", () => {
    // No platform_listing_id → nothing exists on eBay to own it. A draft must
    // never read as a locked mirror.
    expect(
      deriveListingOrigin({
        platform: "ebay",
        platform_listing_id: null,
        batch_id: null,
        synced_to_ebay_at: null,
      }),
    ).toBe("gradethread");
  });

  it("defaults non-eBay platforms to GradeThread", () => {
    expect(
      deriveListingOrigin({
        platform: "depop",
        platform_listing_id: "d-1",
        batch_id: null,
        synced_to_ebay_at: null,
      }),
    ).toBe("gradethread");
    // Case-insensitive on the platform name.
    expect(
      deriveListingOrigin({
        platform: "EBAY",
        platform_listing_id: "110006",
        batch_id: null,
        synced_to_ebay_at: null,
      }),
    ).toBe("ebay");
  });
});
