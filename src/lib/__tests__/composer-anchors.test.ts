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
      // US-2625. Not a publish blocker — a wrong measurement never stops a
      // listing going out, which is precisely why it needed a route. The
      // drag-adjust editor lives in the composer (deliberately the one item
      // editor), so a seller working an AutoLister batch had no way to reach
      // it and asked for a feature that was already built.
      "measurements",
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

// US-2275 moved the Save/publish row OFF the bottom of the page and into the
// sticky preview rail, because reaching it meant scrolling past all thirteen
// cards every single time.
//
// US-2252/US-2253's guarantee was expressed as ORDER — the channel picker and
// drop schedule sat directly above the CTA, and nothing editable sat below it.
// Half of that no longer type-checks as a layout rule: a sticky CTA has no
// "below". What it protected is still protected, just by different means, and
// each half is asserted separately here:
//
//   * the CTA can't outrun the channel picker — it names the channels in its own
//     label and disables itself with a reason when none are picked (asserted
//     below against the button's own source, not against card order);
//   * the editable cards are all in ONE column, so nothing is stranded beside or
//     under the rail.
describe("the publish rail: actions reachable, config still with the form (US-2275)", () => {
  // Anchored on the render site, not a className — the row's classes changed
  // once already and took three tests down with them.
  const railRender = src.indexOf("{actionRow}");
  const preview = src.indexOf("Listing preview");

  it("declares the action row once and renders it once", () => {
    expect(src.split("const actionRow = (").length - 1).toBe(1);
    expect(src.split("{actionRow}").length - 1).toBe(1);
  });

  it("renders the actions inside the sticky rail, above the preview", () => {
    const rail = src.indexOf("@4xl:sticky @4xl:top-4 @4xl:self-start");
    expect(rail).toBeGreaterThan(0);
    expect(railRender).toBeGreaterThan(rail);
    // Actions first: the rail clips at the viewport bottom, so whatever is last
    // is what gets cut off — and that must never be the button.
    expect(railRender).toBeLessThan(preview);
  });

  it("keeps the blocker notices with the button they explain", () => {
    // Each notice must render in the rail (after the actions), not back down the
    // page where the seller can't see it while looking at a disabled button.
    //
    // US-2960 removed the second entry, `specDescMismatches`. It warned that a
    // changed item specific had left the description stale — a real drift while
    // the description was one opaque string that restated the same facts. The
    // attributes BLOCK derives those values from the very columns the specific
    // writes, so the two cannot disagree any more and the notice would have
    // fired on nothing.
    for (const notice of ["missingRequired.length > 0"]) {
      const at = src.indexOf(notice);
      expect(at, notice).toBeGreaterThan(railRender);
      expect(at, notice).toBeLessThan(preview);
    }
  });

  it("keeps the publish config editable and in the editor column", () => {
    // Still present, still after the last editor card, and now BEFORE the rail —
    // i.e. inside the column with everything else the seller can change.
    const pushTo = src.indexOf("<PushToCard");
    const schedule = src.indexOf("<ScheduleCard");
    const kit = src.indexOf("<ListingKit");
    for (const [name, at] of [
      ["<PushToCard", pushTo],
      ["<ScheduleCard", schedule],
      ["<ListingKit", kit],
    ] as [string, number][]) {
      expect(at, `${name} is missing`).toBeGreaterThan(0);
      expect(at, `${name} left the editor column`).toBeGreaterThan(
        src.indexOf("<StorageSkuCard"),
      );
      expect(at, `${name} drifted into the rail`).toBeLessThan(railRender);
    }
    // …and the schedule stays out of the pricing card it used to hide in.
    expect(schedule).toBeGreaterThan(src.indexOf("<CostMarginCard"));
    expect(
      composerSections["price-card.tsx"],
      "the drop schedule crept back into the pricing card",
    ).not.toContain('id="schedule-at"');
  });

  it("gates the CTA on the channel picker through the button, not through order", () => {
    // This is what replaces "the picker sits above the CTA": wherever the button
    // is, it refuses to fire with no channel selected and says why.
    const row = src.slice(src.indexOf("const actionRow = ("), railRender);
    expect(row).toContain("pushPlatforms.size === 0");
    expect(row).toContain("Pick at least one marketplace");
    // And it states the destination in its own label.
    expect(row).toContain("Save & publish to eBay");
  });

  it("leaves every editable card in the one editor column", () => {
    // The rail holds actions, notices and the preview — nothing the seller edits.
    const rail = src.slice(railRender, preview);
    for (const marker of ORDER.map(([, m]) => m)) {
      expect(rail, `${marker} rendered in the action rail`).not.toContain(marker);
    }
    expect(rail).not.toContain("<ListingKit");
    expect(rail).not.toContain("<PushToCard");
  });
});
