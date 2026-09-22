import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeBulkCrossPush } from "@/lib/bulk-cross-list-report";
import type { BulkCrossPushSummary } from "@/hooks/use-cross-listing";

// US-3456: the sentence a bulk cross-list reports, and where the button lives.

const summary = (over: Partial<BulkCrossPushSummary>): BulkCrossPushSummary => ({
  rows: 0,
  published: 0,
  queued: 0,
  skipped: 0,
  noSource: 0,
  notFound: 0,
  blocked: 0,
  ...over,
});

describe("describeBulkCrossPush", () => {
  it("names every count that is not zero, in order, and carries the queued sentence", () => {
    const r = describeBulkCrossPush(
      summary({ rows: 120, published: 10, queued: 100, skipped: 8, blocked: 2 }),
      "Sunday drop",
      5,
    );
    expect(r.title).toBe(
      'Cross-list "Sunday drop": 5 published to eBay, 10 published, 100 queued for your browser, 8 already there, 2 blocked.',
    );
    expect(r.tone).toBe("warning");
    expect(r.description).toContain("Nothing happens on the marketplace until then");
  });

  it("is a success when nothing failed, an error when nothing happened", () => {
    expect(describeBulkCrossPush(summary({ rows: 3, queued: 3 }), null, null).tone).toBe("success");
    expect(describeBulkCrossPush(summary({ rows: 3, noSource: 3 }), null, null)).toMatchObject({
      tone: "error",
      title: "Cross-list: 3 with no eBay draft to copy.",
      description: null,
    });
    expect(describeBulkCrossPush(summary({}), null, null).title).toBe("Cross-list: nothing to do.");
  });

  it("is wired from the Listings bulk bar and the AutoLister drafts library, through one dialog", () => {
    const listings = readFileSync("src/pages/flipdesk/listings.tsx", "utf8");
    const actions = readFileSync("src/pages/flipdesk/listings-actions.ts", "utf8");
    const drafts = readFileSync("src/pages/flipdesk/autolister-drafts.tsx", "utf8");
    const dialog = readFileSync("src/components/flipdesk/bulk-cross-list-dialog.tsx", "utf8");
    for (const src of [listings, drafts]) {
      expect(src).toContain("<BulkCrossListDialog");
      expect(src).toContain("useCrossPushBulk()");
    }
    expect(actions).toContain("crossPushBulk.mutateAsync({");
    expect(drafts).toContain("crossPushBulk.mutateAsync({");
    // eBay never goes through the bulk route: it rides the publish this page has.
    expect(actions).toContain('choice.platforms.filter((p) => p !== "ebay")');
    expect(drafts).toContain('choice.platforms.filter((p) => p !== "ebay")');
    // The dialog's rows are the composer's rows, through the shared row head.
    expect(dialog).toContain("listOnRows(");
    expect(dialog).toContain("<ChannelPickHead");
    expect(readFileSync("src/components/flipdesk/composer/list-on-panel.tsx", "utf8")).toContain("<ChannelPickHead");
  });
});
