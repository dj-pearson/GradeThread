import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { caseItemKey, ebayOrderUrl, ebayReturnUrl } from "@/hooks/use-case-items";

// US-2521. A return row read "Return 5###### · opened 12 Mar" and a
// cancellation read "Order 14-######". Both carry buttons that refund a buyer,
// and neither said which garment — so deciding one meant opening eBay in another
// tab to find out what it was about.

const PAGE = "src/pages/flipdesk/post-sale.tsx";
const SUMMARY = "src/components/flipdesk/case-item-summary.tsx";
const HOOK = "src/hooks/use-case-items.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("a money decision names its garment (US-2521)", () => {
  it("both returns and cancellations render the item summary", () => {
    const src = read(PAGE);
    const uses = src.match(/<CaseItemSummary/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    // Resolved from the case's own identifiers, not typed in.
    expect(src).toMatch(/useCaseItems\(/);
    expect(src).toMatch(/caseItemKey\(\{ orderId: r\.orderId, itemId: r\.itemId \}\)/);
  });

  it("the summary carries a title, a thumbnail and the price", () => {
    const src = read(SUMMARY);
    expect(src).toMatch(/item\.thumbnailUrl/);
    expect(src).toMatch(/item\.title \|\| "Untitled item"/);
    expect(src).toMatch(/usd\.format\(item\.salePrice\)/);
  });

  it("each row links to the eBay case AND to the local item", () => {
    const src = read(SUMMARY);
    expect(src).toMatch(/to=\{`\/dashboard\/flipdesk\/items\/\$\{item\.inventoryItemId\}`\}/);
    expect(src).toMatch(/href=\{caseUrl\}/);
    // An external link that opens a new tab has to be safe about it.
    expect(src).toContain('rel="noopener noreferrer"');
  });

  it("an unmatched case says so instead of guessing", () => {
    const src = read(SUMMARY);
    expect(src).toContain("No matching item in your inventory");
  });

  it("the row no longer leads with a bare id", () => {
    const src = read(PAGE);
    // The old copy. The ids are still reachable — they are the link text now.
    expect(src).not.toMatch(/Return \{r\.returnId\} · opened/);
    expect(src).not.toMatch(/Order \{ca\.orderId \?\? "—"\} ·/);
  });
});

describe("the resolver reads both identifiers (US-2521)", () => {
  it("prefers the order id, which is the stronger signal", () => {
    expect(caseItemKey({ orderId: "14-001", itemId: "9900" })).toBe("14-001");
    expect(caseItemKey({ orderId: null, itemId: "9900" })).toBe("9900");
    expect(caseItemKey({ orderId: null, itemId: null })).toBeNull();
  });

  it("resolves through the sale and through the listing", () => {
    const src = read(HOOK);
    // A sale carries the price actually paid; a listing covers a case whose
    // sale row has not landed yet.
    expect(src).toMatch(/\.eq\("platform", "ebay"\)[\s\S]*?\.in\("platform_listing_id"/);
    expect(src).toMatch(/\.in\("platform_order_id", chunk\)/);
  });

  it("chunks its IN lists, so a busy month cannot blow the URL length", () => {
    const src = read(HOOK);
    expect(src).toMatch(/chunked\(orderIds, 50/);
    expect(src).toMatch(/chunked\(ids, 50/);
  });

  it("the case links point at eBay's own pages", () => {
    expect(ebayReturnUrl("5555")).toContain("returns.ebay.com");
    expect(ebayReturnUrl("5555")).toContain("returnId=5555");
    expect(ebayOrderUrl("14-001")).toContain("ebay.com");
    expect(ebayOrderUrl("14-001")).toContain("orderid=14-001");
    // Ids are encoded — an eBay order id carries a dash and can carry more.
    expect(ebayReturnUrl("a b")).toContain("a%20b");
  });
});
