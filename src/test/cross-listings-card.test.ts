import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// US-3367: the item page names every marketplace, and the delist banner is
// item-scoped where the seller looks after a sale.

describe("CrossListingsCard (US-3367)", () => {
  const card = readFileSync("src/components/flipdesk/cross-listings-card.tsx", "utf8");

  it("renders nothing for an item with only eBay rows", () => {
    expect(card).toContain('r.platform !== "ebay"');
    expect(card).toContain("if (platforms.length === 0) return null;");
  });

  it("reads the channel state from the one derivation and links by platform", () => {
    expect(card).toContain("deriveChannelState(rows, items, p)");
    expect(card).toContain("View on {label}");
  });

  it("is mounted on the item page, and the banner is item-scoped on both pages", () => {
    const item = readFileSync("src/pages/flipdesk/item.tsx", "utf8");
    const composer = readFileSync("src/pages/flipdesk/composer.tsx", "utf8");
    expect(item).toContain("<CrossListingsCard itemId={item.id} />");
    expect(item).toContain("<PendingDelistBanner itemId={item.id} />");
    expect(composer).toContain("<PendingDelistBanner itemId={item.id} />");
  });

  it("the banner filters by item only when asked, so the Listings page still shows everything", () => {
    const banner = readFileSync("src/components/flipdesk/pending-delist-banner.tsx", "utf8");
    expect(banner).toContain("itemId ? all.filter((p) => p.item_id === itemId) : all");
    const listings = readFileSync("src/pages/flipdesk/listings.tsx", "utf8");
    expect(listings).toContain("<PendingDelistBanner />");
  });
});
