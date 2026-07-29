// US-2252: the composer's card order was reshuffled to follow the actual listing
// workflow (photos → measure → title → specifics → grade → comps → price …).
// Two things can silently break when cards move:
//
//   1. A deep-link anchor. AutoLister pre-flight blockers send the seller to
//      /items/:id?focus=<field>, and COMPOSER_FOCUS_ANCHORS maps that to a DOM
//      id. Move or rename the card holding that id and the deep link lands
//      nowhere — silently, because the effect just returns when the element is
//      missing.
//   2. The order itself. The point of the reorder is that a card producing data
//      comes BEFORE the card consuming it; nothing enforces that but a test.
//
// Both are asserted against the composer source. A source-text assertion is a
// blunt instrument, but the alternative is mounting a page that needs Supabase,
// eBay taxonomy, seven hooks and a query client — and the failure mode here
// (silent no-op) is exactly what a blunt guard is for.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPOSER_FOCUS_ANCHORS } from "@/lib/publish-blockers";

const src = readFileSync(
  join(process.cwd(), "src/pages/flipdesk/composer.tsx"),
  "utf8",
);

describe("composer focus anchors (US-954)", () => {
  it("renders an element for every anchor COMPOSER_FOCUS_ANCHORS points at", () => {
    const missing = Object.entries(COMPOSER_FOCUS_ANCHORS)
      .filter(([, anchorId]) => !src.includes(`id="${anchorId}"`))
      .map(([focus, anchorId]) => `${focus} → #${anchorId}`);
    expect(missing).toEqual([]);
  });

  it("covers every field the AutoLister pre-flight can deep-link to", () => {
    // If a new blocker gains a ?focus= key, it needs an anchor here too.
    expect(Object.keys(COMPOSER_FOCUS_ANCHORS).sort()).toEqual([
      "category",
      "condition",
      "photos",
      "price",
      "specifics",
      "title",
    ]);
  });
});

describe("composer card order follows the workflow (US-2252)", () => {
  // Ordered by the marker each card renders. Every entry must appear exactly
  // once, in this order, in the editor column.
  const ORDER: [string, string][] = [
    ["Photos", `<Card id="composer-photos">`],
    ["Measurements", `<Card id="composer-measurements">`],
    ["Title", `<CardTitle>Title</CardTitle>`],
    ["eBay specifics", `<div id="composer-category">`],
    ["Grade this item", `<GradeThisItemCard`],
    ["Comps", `<EbayCompsPanel`],
    ["Condition & price", `<CardTitle>Condition &amp; price</CardTitle>`],
    ["Cost & margin", `<CardTitle>Cost &amp; margin</CardTitle>`],
    ["Format & variations", `<CardTitle>Format &amp; variations</CardTitle>`],
    ["Shipping & returns", `<CardTitle>Shipping &amp; returns</CardTitle>`],
    ["Promote", `<CardTitle>Promote on eBay</CardTitle>`],
    ["Description", `<CardTitle>Description</CardTitle>`],
    ["Item details", `<CardTitle>Item details</CardTitle>`],
    ["Storage & SKU", `<CardTitle>Storage &amp; SKU</CardTitle>`],
  ];

  it("places every card exactly once", () => {
    for (const [name, marker] of ORDER) {
      const count = src.split(marker).length - 1;
      expect(count, `${name} (${marker})`).toBe(1);
    }
  });

  it("orders the cards so producers come before consumers", () => {
    const positions = ORDER.map(([name, marker]) => ({
      name,
      at: src.indexOf(marker),
    }));
    const sorted = [...positions].sort((a, b) => a.at - b.at);
    expect(sorted.map((p) => p.name)).toEqual(positions.map((p) => p.name));
  });

  // The specific inversions the reorder fixed. Spelled out so a future move that
  // recreates one fails with a reason rather than a diff of a name list.
  it("puts measurements before the specifics editor that syncs them", () => {
    expect(src.indexOf(`<Card id="composer-measurements">`)).toBeLessThan(
      src.indexOf(`<div id="composer-category">`),
    );
  });

  it("puts photos before the AI actions and the grade card that need them", () => {
    expect(src.indexOf(`<Card id="composer-photos">`)).toBeLessThan(
      src.indexOf(`<GradeThisItemCard`),
    );
  });

  it("puts the grade card before the condition the grade maps to", () => {
    expect(src.indexOf(`<GradeThisItemCard`)).toBeLessThan(
      src.indexOf(`<CardTitle>Condition &amp; price</CardTitle>`),
    );
  });

  it("puts comps before the price input they inform", () => {
    expect(src.indexOf(`<EbayCompsPanel`)).toBeLessThan(
      src.indexOf(`id="listing-price"`),
    );
  });
});

describe("the publish area holds everything that decides how it goes live (US-2252/US-2253)", () => {
  const footer = src.indexOf(`<div className="flex justify-end gap-2">`);

  it("has a footer action row to anchor against", () => {
    expect(footer).toBeGreaterThan(0);
  });

  it("puts the channel picker below the editor cards and above the CTA", () => {
    const pushTo = src.indexOf(`<CardTitle>Push to</CardTitle>`);
    expect(pushTo).toBeGreaterThan(
      src.indexOf(`<CardTitle>Storage &amp; SKU</CardTitle>`),
    );
    expect(pushTo).toBeLessThan(footer);
  });

  it("puts the drop schedule next to the button that publishes", () => {
    const schedule = src.indexOf(`<CardTitle>When it goes live</CardTitle>`);
    expect(schedule).toBeGreaterThan(0);
    expect(schedule).toBeLessThan(footer);
    // …and out of the pricing card it used to hide in.
    expect(schedule).toBeGreaterThan(
      src.indexOf(`<CardTitle>Cost &amp; margin</CardTitle>`),
    );
  });

  it("leaves nothing editable below the Save/Publish row", () => {
    const after = src.slice(footer);
    // Dialogs are fine below it (they render in a portal); cards are not.
    expect(after).not.toContain("<ListingKit");
    expect(after).not.toContain("<CardTitle>");
  });
});
