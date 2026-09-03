import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// US-3104 — the iOS buyer preview claims parity with the web one.
//
// A preview whose sections drift from the page it previews is worse than having
// no preview: the seller checks it, believes it, and publishes anyway. The two
// implementations are in different languages and different repositories of
// habit, so nothing but a test keeps them in step — and Swift only compiles in
// the macOS lane, which means an XCTest could not be that test for most of the
// people editing either file.
//
// Two things are checked, and both are claims a reader of either file would
// otherwise have to take on trust:
//
//   1. The SECTION ORDER matches what ebay-view-item-preview.tsx renders.
//   2. The seller-credentials MARKER is the same literal on both sides. It is
//      what decides whether the description renders as HTML or as text, and a
//      drift shows raw markup to a buyer-facing preview.

const ROOT = resolve(__dirname, "../..");
const SWIFT_MODEL = resolve(
  ROOT,
  "ios/GradeThread/Marketplaces/Publish/EbayPreviewModel.swift",
);
const WEB_PREVIEW = resolve(
  ROOT,
  "src/components/flipdesk/ebay-view-item-preview.tsx",
);
const WEB_TEMPLATES = resolve(ROOT, "src/lib/listing-templates.ts");

function swiftSectionOrder(): string[] {
  const source = readFileSync(SWIFT_MODEL, "utf8");
  const start = source.indexOf("enum Section:");
  expect(start, "EbayPreviewModel.Section not found").toBeGreaterThan(-1);
  const block = source.slice(start, source.indexOf("}", start));
  return [...block.matchAll(/^\s*case (\w+)$/gm)].flatMap((m) =>
    m[1] ? [m[1]] : [],
  );
}

describe("iOS eBay buyer preview parity (US-3104)", () => {
  it("renders the same sections the web component does, in the same order", () => {
    // The web's mobile column is the canonical order: hero, thumbs, buy box,
    // specifics, description. `gallery` folds hero + thumbs, and the buy box
    // expands into title, condition and price (asserted separately below).
    expect(swiftSectionOrder()).toEqual([
      "gallery",
      "title",
      "condition",
      "price",
      "specifics",
      "description",
    ]);
  });

  it("the web mobile column still runs hero → thumbs → buy box → specifics → description", () => {
    const web = readFileSync(WEB_PREVIEW, "utf8");
    // The single-column branch, which is the one the phone mirrors.
    const start = web.indexOf("// eBay mobile: single column");
    expect(start, "the mobile branch comment moved — re-check the order").toBeGreaterThan(-1);
    const branch = web.slice(start, web.indexOf("// eBay desktop", start));
    const order = ["{hero}", "{thumbs}", "{buyBox}", "{specificsTable}", "{descriptionBlock}"]
      .map((token) => {
        const at = branch.indexOf(token);
        expect(at, `${token} missing from the mobile branch`).toBeGreaterThan(-1);
        return at;
      });
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("the web buy box puts the title, then the condition pill, then the price", () => {
    // This is the pair US-3104's acceptance criterion transposes. The component
    // is the authority — eBay's own view-item page reads the same way — so the
    // Swift order above follows it, and this pins what "it" is.
    const web = readFileSync(WEB_PREVIEW, "utf8");
    const start = web.indexOf("const buyBox = (");
    expect(start, "buyBox not found").toBeGreaterThan(-1);
    const box = web.slice(start, web.indexOf("\n  );", start));
    const titleAt = box.indexOf("<h2");
    const conditionAt = box.indexOf("{conditionLabel}");
    const priceAt = box.indexOf("{priceLabel}");
    expect(titleAt).toBeGreaterThan(-1);
    expect(conditionAt).toBeGreaterThan(titleAt);
    expect(priceAt).toBeGreaterThan(conditionAt);
  });

  it("both sides look for the same seller-credentials marker", () => {
    const swift = readFileSync(SWIFT_MODEL, "utf8");
    const templates = readFileSync(WEB_TEMPLATES, "utf8");

    const webMarker = templates.match(
      /export const SELLER_CREDENTIALS_MARKER = "([^"]+)"/,
    )?.[1];
    const swiftMarker = swift.match(
      /static let sellerCredentialsMarker = "([^"]+)"/,
    )?.[1];

    expect(webMarker, "SELLER_CREDENTIALS_MARKER not found on the web side").toBeTruthy();
    expect(swiftMarker, "sellerCredentialsMarker not found in the Swift model").toBeTruthy();
    expect(swiftMarker).toEqual(webMarker);
  });

  it("the preview web view runs no JavaScript and goes nowhere", () => {
    // US-3104 AC4. Both halves are one line each and both are easy to lose in a
    // refactor, which is exactly why they are asserted rather than reviewed:
    // the description carries seller text and a server-built block, and a
    // preview with no address bar must not navigate anywhere on a link tap.
    const sheet = readFileSync(
      resolve(ROOT, "ios/GradeThread/Marketplaces/Publish/EbayViewItemPreviewSheet.swift"),
      "utf8",
    );
    expect(sheet).toContain("allowsContentJavaScript = false");
    expect(sheet).toContain("decisionHandler(isInitialLoad ? .allow : .cancel)");
    // No remote load: the only content is a string built in-process.
    expect(sheet).toContain("loadHTMLString(html, baseURL: nil)");
    expect(sheet).not.toMatch(/webView\.load\(URLRequest/);
  });
});
