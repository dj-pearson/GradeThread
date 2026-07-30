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
import { COMPOSER_FOCUS_ANCHORS } from "@/lib/publish-blockers";
// US-2263: anchors and markup can live in any section file (`all`); the card
// ORDER is a property of the page's JSX, where the call sites sit (`src`).
import {
  composerPage as src,
  composerAll as all,
  composerSections,
} from "./helpers/composer-source";

// US-2263: the sections are components now, so the order is the order of their
// CALL SITES in the page — which is exactly where a reorder would happen, and
// reads as the workflow it encodes.
const ORDER: [string, string][] = [
  ["Photos", "<PhotosCard"],
  ["Measurements", "<MeasurementsCard"],
  ["Title", "<TitleCard"],
  ["eBay specifics", "<SpecificsSection"],
  ["Grade this item", "<GradeThisItemCard"],
  ["Comps", "<EbayCompsPanel"],
  ["Condition & price", "<PriceCard"],
  ["Cost & margin", "<CostMarginCard"],
  ["Format & variations", "<ListingFormatControls"],
  ["Shipping & returns", "<PoliciesCard"],
  ["Promote", "<PromoteCard"],
  ["Description", "<DescriptionCard"],
  ["Item details", "<ItemDetailsCard"],
  ["Storage & SKU", "<StorageSkuCard"],
];

describe("composer focus anchors (US-954)", () => {
  it("renders an element for every anchor COMPOSER_FOCUS_ANCHORS points at", () => {
    const missing = Object.entries(COMPOSER_FOCUS_ANCHORS)
      .filter(([, anchorId]) => !all.includes(`id="${anchorId}"`))
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
    expect(src.indexOf("<MeasurementsCard")).toBeLessThan(
      src.indexOf("<SpecificsSection"),
    );
  });

  it("puts photos before the AI actions and the grade card that need them", () => {
    expect(src.indexOf("<PhotosCard")).toBeLessThan(
      src.indexOf("<GradeThisItemCard"),
    );
  });

  it("puts the grade card before the condition the grade maps to", () => {
    expect(src.indexOf("<GradeThisItemCard")).toBeLessThan(
      src.indexOf("<PriceCard"),
    );
  });

  it("puts comps before the price input they inform", () => {
    expect(src.indexOf("<EbayCompsPanel")).toBeLessThan(src.indexOf("<PriceCard"));
  });
});

describe("the publish area holds everything that decides how it goes live (US-2252/US-2253)", () => {
  const footer = src.indexOf(`<div className="flex justify-end gap-2">`);

  it("has a footer action row to anchor against", () => {
    expect(footer).toBeGreaterThan(0);
  });

  it("puts the channel picker below the editor cards and above the CTA", () => {
    const pushTo = src.indexOf("<PushToCard");
    expect(pushTo).toBeGreaterThan(src.indexOf("<StorageSkuCard"));
    expect(pushTo).toBeLessThan(footer);
  });

  it("puts the drop schedule next to the button that publishes", () => {
    const schedule = src.indexOf("<ScheduleCard");
    expect(schedule).toBeGreaterThan(0);
    expect(schedule).toBeLessThan(footer);
    // …and out of the pricing card it used to hide in.
    expect(schedule).toBeGreaterThan(src.indexOf("<CostMarginCard"));
    expect(
      composerSections["price-card.tsx"],
      "the drop schedule crept back into the pricing card",
    ).not.toContain('id="schedule-at"');
  });

  it("leaves nothing editable below the Save/Publish row", () => {
    const after = src.slice(footer);
    // Dialogs are fine below it (they render in a portal); cards are not.
    expect(after).not.toContain("<ListingKit");
    expect(after).not.toContain("<CardTitle>");
    for (const name of ORDER.map(([, marker]) => marker)) {
      expect(after, `${name} renders below the CTA`).not.toContain(name);
    }
  });
});
