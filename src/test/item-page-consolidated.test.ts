import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gradeRoiHintWouldRender } from "@/lib/flipdesk-analytics";

// US-2519. The item page is the app's most-used screen. It fired four separate
// `listings` queries at the same inventory_item_id — one per panel — then
// stacked twelve panels vertically, offered two prompts for the same grading
// action, and sent Back to a hardcoded /dashboard/flipdesk/items regardless of
// which inventory view the seller came from.

const PAGE = "src/pages/flipdesk/item.tsx";
const HOOK = "src/hooks/use-item-listings.ts";
const DIALOG = "src/components/flipdesk/item-detail-dialog.tsx";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("one listings read for the whole item page (US-2519)", () => {
  it("the page has no `listings` query of its own", () => {
    const src = read(PAGE);
    // Every panel goes through the shared hook now.
    expect(src).not.toMatch(/\.from\("listings"\)/);
    expect(src).toMatch(/useItemListings\(itemId\)/);
  });

  it("the shared hook is the only listings read, and covers every panel's columns", () => {
    const hook = read(HOOK);
    expect(hook).toMatch(/\.from\("listings"\)/);
    // The union of what the four panels used to select. A missing column is a
    // panel that silently renders nothing.
    for (const col of [
      "platform_offer_id",
      "platform_listing_id",
      "listing_url",
      "batch_id",
      "synced_to_ebay_at",
      "platform_fields",
      "publish_error",
      "publish_failed_at",
      "listing_title",
      "listing_price",
      "quantity",
    ]) {
      expect(hook, `the shared read drops ${col}`).toContain(`"${col}"`);
    }
  });

  it("the selectors keep each panel's original filter", () => {
    const hook = read(HOOK);
    // The notice and promotion cards wanted the newest ACTIVE listing; the
    // GradeThread card wanted the newest eBay one at ANY status, drafts
    // included. Collapsing those two into one selector would break the card
    // that shows publish errors on a draft.
    expect(hook).toMatch(/listing_status === "active"/);
    expect(hook).toMatch(/r\.platform === "ebay"/);
    expect(hook).toMatch(/delist_unresolved/);
    expect(hook).toMatch(/oversell_conflict/);
    expect(hook).toMatch(/\.order\("updated_at", \{ ascending: false \}\)/);
  });

  it("mutations invalidate the one shared key", () => {
    const src = read(PAGE);
    expect(src).toMatch(/invalidateQueries\(\{ queryKey: itemListingsKey\(itemId\) \}\)/);
    // The four old keys are gone, so nothing can invalidate half the page.
    for (const key of [
      "item_gt_listing",
      "item_ebay_listing",
      "item_ebay_native_notice",
      "item_listing_alerts",
    ]) {
      expect(src, `${key} is still in use`).not.toContain(key);
    }
  });
});

describe("the panels are grouped, not stacked (US-2519)", () => {
  it("renders four tabs with the editor as the default", () => {
    const src = read(PAGE);
    expect(src).toMatch(/useState\("details"\)/);
    for (const tab of ["details", "listing", "grade", "money"]) {
      expect(src).toContain(`<TabsTrigger value="${tab}">`);
      expect(src).toContain(`<TabsContent value="${tab}"`);
    }
    // The composer is the reason the page exists, so it is on the default tab.
    const details = src.slice(
      src.indexOf('<TabsContent value="details"'),
      src.indexOf('<TabsContent value="listing"'),
    );
    expect(details).toContain("<FlipdeskComposerPage");
  });

  it("keeps the double-sale alerts outside the tabs", () => {
    const src = read(PAGE);
    // A listing that could not be ended means the garment can still be bought
    // right now. That does not go behind a tab the seller may never open.
    const alertsAt = src.indexOf("<ListingAlertsSection");
    const tabsAt = src.indexOf("<Tabs value={tab}");
    expect(alertsAt).toBeGreaterThan(-1);
    expect(alertsAt).toBeLessThan(tabsAt);
  });

  it("the #canvas-grading deep link still lands, now that it is inside a tab", () => {
    const src = read(PAGE);
    expect(src).toMatch(/if \(hash === "#canvas-grading"\) setTab\("details"\)/);
    // And both nudges route through the one helper that selects the tab first.
    expect(src).toMatch(/function goToGrading\(\)/);
    expect(src).toMatch(/onGrade=\{goToGrading\}/);
  });
});

describe("one grade nudge at a time (US-2519)", () => {
  it("the value-only nudge is suppressed when the ROI hint will render", () => {
    const src = read(PAGE);
    expect(src).toMatch(/\{!roiHintShows &&/);
    expect(src).toMatch(/gradeRoiHintWouldRender\(/);
  });

  it("the predicate agrees with the hint's own render conditions", () => {
    // An already-graded item: the hint returns null, so the predicate must be
    // false or the value nudge would be suppressed for nothing.
    expect(
      gradeRoiHintWouldRender([], { category: "clothing", grade: 8.5 }),
    ).toBe(false);
    // No sold history at all: no estimate, so nothing to say.
    expect(gradeRoiHintWouldRender([], { category: "clothing" })).toBe(false);
  });
});

describe("Back returns where the seller came from (US-2519)", () => {
  it("the item page reads the origin off the navigation state", () => {
    const src = read(PAGE);
    expect(src).toMatch(/location\.state as \{ from\?: string \}/);
    expect(src).toMatch(/navigate\(backTo\)/);
    // The breadcrumb goes to the same place as the arrow, not to a different one.
    expect(src).toMatch(/<Link to=\{backTo\}/);
  });

  it("the inventory quick-look passes its own URL through", () => {
    const src = read(DIALOG);
    // The mode, tab, search, sort and saved view all live in the query string.
    expect(src).toMatch(
      /state: \{ from: `\$\{location\.pathname\}\$\{location\.search\}` \}/,
    );
  });

  it("a cold deep link still has somewhere to go", () => {
    const src = read(PAGE);
    expect(src).toMatch(/\?\?\s*\n?\s*"\/dashboard\/flipdesk\/items"/);
  });
});
