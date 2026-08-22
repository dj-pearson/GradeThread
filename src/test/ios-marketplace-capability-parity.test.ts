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

describe("the screen now LINKS to where the connection happens (US-2531 AC2)", () => {
  // This block used to assert the opposite, and its own comment said the link
  // did not exist. Saying "connect it on the web" without a way to get there
  // left an iPhone-only subscriber reading an instruction they could not
  // follow, which is the narrower gap the earlier pass identified and left.

  it("a web-managed channel renders a link, and only a web-managed one", () => {
    const s = read(MARKETPLACES);
    // Anchored on the tier test rather than on the label: a link offered to
    // every row would point Poshmark at a connection page it has no place on.
    expect(s).toContain("if case .api = channel.tier");
    const start = s.indexOf("if case .api = channel.tier");
    const block = s.slice(start, start + 900);
    expect(block).toContain("WebManagedChannel(");
    expect(block).toMatch(/Connect .*on the web/);
  });

  it("it opens the dashboard page that owns the handshake", () => {
    // NOT a Shopify OAuth URL. The web app owns the redirect target and the
    // session that completes the handshake; deep-linking past it strands the
    // seller on a callback nothing in the app can receive.
    const s = read(MARKETPLACES);
    expect(s).toContain("https://gradethread.com/dashboard/flipdesk/marketplaces");

    // PINNED ON THE PRESENTATION, NOT ON A VARIABLE NAME. This used to assert
    // the literal `.sheet(item: $webManagedChannel)` and went red when that
    // binding was correctly removed: a SwiftUI view has ONE sheet slot, so the
    // chained-sheet fix collapsed every `.sheet` on this screen into a single
    // `$sheet` driven by a MarketplacesSheet enum. The feature never broke —
    // the assertion named a spelling rather than a behaviour, which made a
    // correct refactor look like a regression.
    //
    // What has to stay true: exactly one sheet slot, and the web-managed
    // channel is one of the things it presents.
    // CODE LINES ONLY. The view's own doc comments explain the one-slot rule and
    // quote `.sheet(item:)` twice while doing it, so a whole-file count reads 3
    // and this assertion fails against correct code — the exact fail-open shape
    // the repo's guard notes warn about, arriving here as a fail-CLOSED one.
    const code = s
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
      .join("\n");
    expect(
      code.match(/\.sheet\(item:/g) ?? [],
      "a second .sheet on this view competes for the one slot the loser never wins",
    ).toHaveLength(1);
    expect(s).toContain(".sheet(item: $sheet)");

    // SCOPED TO THE SHEET BODY, not the whole file. `case .webChannel(let
    // channel):` also appears in MarketplacesSheet's `id` property, so a
    // whole-file `toContain` is satisfied by the enum declaring the case even
    // if the sheet stopped PRESENTING it — a scan passing on a sibling's
    // correctness. The sabotage run caught exactly that.
    const sheetBody = s.slice(s.indexOf(".sheet(item: $sheet)"));
    expect(
      sheetBody.slice(0, sheetBody.indexOf("case .sync:")),
      "the sheet slot no longer presents the web-managed channel",
    ).toContain("SafariView(url: channel.url)");
  });

  it("and it still is not an in-app connect flow", () => {
    // The link satisfies AC2's second branch. It must not be mistaken for the
    // first: nothing here performs the OAuth.
    const s = read(MARKETPLACES);
    expect(/connect(Shopify|_shopify)|shopifyOAuth|startShopify/i.test(s)).toBe(false);
  });

  it("still tracks the story", () => {
    const tracker = read("docs/reviews/full-surface-2026-08/FIX-PROGRESS.md");
    expect(tracker).toContain("US-2531");
  });
});
