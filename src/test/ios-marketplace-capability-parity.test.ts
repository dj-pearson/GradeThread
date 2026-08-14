import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MARKETPLACE_MECHANISM } from "@/lib/constants";

// US-2531. Shopify connects on the web and not on iOS, and the risk the story
// names is that a client advertises a capability it cannot deliver.
//
// Reading the Swift (which this checkout can do — it is COMPILING it that it
// cannot), most of that is already handled: the iOS Marketplaces screen badges
// Shopify "Live · manage on web" and says in prose that it connects on the web
// dashboard, and the iOS paywall never mentions marketplaces at all. What was
// missing is anything stopping that from silently regressing, which is what
// this file is.
//
// It follows the existing ios-*-parity guards: scan the Swift as TEXT from the
// web suite, so a Windows checkout can still enforce a cross-client contract.

const MARKETPLACES = "ios/GradeThread/Marketplaces/MarketplacesView.swift";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("iOS never claims a marketplace it cannot connect (US-2531 AC3)", () => {
  const swift = () => read(MARKETPLACES);

  it("Shopify is present, and marked as managed on the web", () => {
    // AC2's second branch. Silently dropping Shopify from the list would also
    // satisfy "never implies a capability", by hiding a product the seller pays
    // for — so the presence is asserted too, not just the honesty.
    const s = swift();
    expect(s).toContain('id: "shopify"');
    expect(s).toContain("Live · manage on web");
    expect(s).toMatch(/Shopify connects via API on the web dashboard/);
  });

  it("no in-app Shopify connect affordance exists", () => {
    // The `.api` tier's badge is the ONLY treatment Shopify gets. A connect
    // button would be the regression this guard is for.
    const s = swift();
    const shopifyLine = s
      .split("\n")
      .find((l) => l.includes('id: "shopify"'));
    expect(shopifyLine, "the shopify channel row vanished").toBeTruthy();
    expect(shopifyLine!).toContain("tier: .api");
    // connectionCard is eBay's in-app OAuth surface; Shopify must not reach it.
    const connectShopify = /connect(Shopify|_shopify)|shopifyOAuth|startShopify/i;
    expect(
      connectShopify.test(s),
      "an in-app Shopify connect flow appeared — if it now EXISTS, this guard " +
        "should be updated to assert it works, not deleted",
    ).toBe(false);
  });

  it("the badge wording tells the seller where to go", () => {
    // "Live" alone would read as connected-in-app. The location is the whole
    // point of the badge.
    const s = swift();
    const badge = /case \.api: return "([^"]+)"/.exec(s)?.[1] ?? "";
    expect(badge).toMatch(/web/i);
  });
});

describe("the iOS channel list matches the web's mechanism table (US-2531)", () => {
  it("Shopify really is an API channel on the web side", () => {
    // The Swift comment claims it "mirrors web MARKETPLACE_TIER". If the web
    // ever moved Shopify to another mechanism, the iOS `.api` tier — and its
    // "manage on web" badge — would be describing something that no longer
    // exists.
    expect(MARKETPLACE_MECHANISM.shopify).toBe("api");
  });

  it("eBay is the in-app one, and stays distinguishable from Shopify", () => {
    const s = read(MARKETPLACES);
    expect(MARKETPLACE_MECHANISM.ebay).toBe("api");
    // Both are `api` on the web, but only eBay is connectable in the app, which
    // is exactly why the Swift needs its own tier note rather than deriving the
    // badge from the mechanism alone.
    expect(s).toMatch(/eBay is managed in-app \(connectionCard above\)/);
  });
});

describe("the iOS paywall advertises no marketplace it cannot deliver (US-2531 AC3)", () => {
  it("it does not name Shopify at all", () => {
    // Naming it on a plan screen would sell a connection the app cannot make.
    for (const rel of [
      "ios/GradeThread/Billing/PaywallView.swift",
      "ios/GradeThread/Billing/PlanGatePresentation.swift",
    ]) {
      expect(read(rel), `${rel} mentions Shopify`).not.toMatch(/shopify/i);
    }
  });
});

describe("what this slice does NOT claim (US-2531)", () => {
  it("no in-app Shopify connection is asserted to exist", () => {
    // AC2's FIRST branch (ship the connection flow) and the "and links there"
    // half of the second are Swift edits that cannot be compiled or run from
    // this checkout. This guard locks the honesty that is already true and
    // fails if it regresses; it does not pretend the link exists.
    const tracker = read("docs/reviews/full-surface-2026-08/FIX-PROGRESS.md");
    expect(tracker).toContain("US-2531");
  });
});
