// US-3392: the listing-suggestions panel names every marketplace.
//
// WHAT WENT WRONG. listing-suggestions.tsx carried its own map of 8 of the 12
// platform keys and fell back to the raw key for the rest, so the "list on more
// platforms" suggestion read `"Levi's 501" is only listed on etsy.` to a
// seller. US-3388's registry recorded the gap as a subset copy; recording a gap
// is not closing one.
//
// WHY IT DRIVES THE COMPONENT. A test that imports the label map and compares
// its keys passes whether or not the component ever calls it — the bug was a
// lookup, not a map. So this renders ListingSuggestions into a real DOM with
// createRoot, the way the app does, and reads textContent off the panel. The
// assertion is the sentence the seller sees.
import { describe, it, expect, afterEach } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

import { ListingSuggestions } from "@/components/analytics/listing-suggestions";
import { LISTING_PLATFORMS, MARKETPLACE_LABELS } from "@/lib/constants";
import type {
  GradeReportRow,
  InventoryItemRow,
  ListingRow,
} from "@/types/database";

// React 19 requires this flag for act() to flush effects in a test env.
// No @testing-library in this repo — render via createRoot like the app does.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function item(id: string, title: string): InventoryItemRow {
  return {
    id,
    user_id: "user-1",
    title,
    status: "listed",
    submission_id: null,
  } as unknown as InventoryItemRow;
}

function listing(itemId: string, platform: string): ListingRow {
  return {
    id: `listing-${itemId}`,
    inventory_item_id: itemId,
    platform,
    is_active: true,
    // Today, so the "listed for N days" suggestion never fires and the only
    // sentence in the panel is the one naming the platform.
    listed_at: new Date().toISOString(),
  } as unknown as ListingRow;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Render the panel for one item listed on exactly one platform. */
function panelTextFor(platform: string): string {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(
      h(
        MemoryRouter,
        null,
        h(ListingSuggestions, {
          items: [item("item-1", "Levi's 501")],
          listings: [listing("item-1", platform)],
          gradeReports: [] as GradeReportRow[],
        }),
      ),
    );
  });
  return container.textContent ?? "";
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  localStorage.clear();
});

describe("the listing-suggestions panel names the marketplace", () => {
  // AC1. These four are the ones that printed a raw key: they were absent from
  // the private map this file's subject used to carry.
  for (const platform of ["etsy", "shopify", "whatnot", "vinted"] as const) {
    it(`says "${MARKETPLACE_LABELS[platform]}" rather than "${platform}"`, () => {
      const text = panelTextFor(platform);
      expect(text, "the suggestion did not render at all").toContain(
        "is only listed on",
      );
      expect(text).toContain(`is only listed on ${MARKETPLACE_LABELS[platform]}`);
      // The raw key, verbatim, is what a seller used to read. Case matters:
      // "Etsy" passes the line above and "etsy" is the bug.
      expect(text).not.toContain(`is only listed on ${platform}`);
    });
  }

  // Not just the four. A copy that is short by four today is short by one
  // tomorrow, so the panel is held to the whole platform list.
  it("names every platform in LISTING_PLATFORMS", () => {
    const wrong: string[] = [];
    for (const platform of LISTING_PLATFORMS) {
      const text = panelTextFor(platform);
      const expected = `is only listed on ${MARKETPLACE_LABELS[platform]}`;
      if (!text.includes(expected)) {
        wrong.push(`${platform}: panel read ${JSON.stringify(text.slice(0, 120))}`);
      }
      act(() => {
        root?.unmount();
      });
      root = null;
      container?.remove();
      container = null;
    }
    expect(
      wrong,
      "one marketplace vocabulary. The panel must read MARKETPLACE_LABELS, " +
        "not a copy of part of it.",
    ).toEqual([]);
  });

  // The fallback is still a fallback. `ListingRow.platform` is a plain string
  // off the row, so a value nothing has heard of has to render as itself rather
  // than as "undefined" or an empty gap in the sentence.
  it("falls back to the raw value for a platform nobody has registered", () => {
    const text = panelTextFor("some_new_marketplace");
    expect(text).toContain("is only listed on some_new_marketplace");
    expect(text).not.toContain("undefined");
  });
});
