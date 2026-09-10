// US-3195 AC5: what the Aged tab says when nothing is rotting.
//
// The bug this pins: the aged tab was missing from the title/description chain
// in listings.tsx, so it fell to the final `else`. A seller with two hundred
// healthy listings and nothing past their threshold was told "No items yet" and
// "Add an item to start building your listing pipeline", under a Rocket. That
// is not a softer wording of the truth, it is the opposite of it — the account
// is full, the death pile is empty, and the empty pile is the good outcome.
//
// The chain moved out of the JSX so it can be asserted without rendering a
// 2,100-line page.
import { describe, expect, it } from "vitest";
import { Rocket } from "lucide-react";

import { listingsEmptyState } from "@/pages/flipdesk/listings-empty-state";
import { TABS } from "@/pages/flipdesk/inventory-tabs";

describe("listingsEmptyState — the Aged tab (US-3195 AC5)", () => {
  it("says nothing is past the threshold, not that the account is empty", () => {
    const e = listingsEmptyState({ tab: "aged", unlistedFilter: "all", agedThresholdDays: 60 });
    expect(e.title).toBe("Nothing has gone stale");
    expect(e.title).not.toContain("No items yet");
    expect(e.description).toContain("60 days");
    // The wrong copy, spelled out so a future edit cannot drift back to it.
    expect(e.description).not.toContain("Add an item");
  });

  it("names the seller's own threshold, not the default", () => {
    const e = listingsEmptyState({ tab: "aged", unlistedFilter: "all", agedThresholdDays: 21 });
    expect(e.description).toContain("21 days");
    expect(e.description).not.toContain("60 days");
  });

  it("does not use the add-your-first-item Rocket", () => {
    const e = listingsEmptyState({ tab: "aged", unlistedFilter: "all", agedThresholdDays: 60 });
    expect(e.icon).not.toBe(Rocket);
  });
});

describe("listingsEmptyState — the tabs that already worked", () => {
  it("keeps the wording every other tab had", () => {
    expect(listingsEmptyState({ tab: "active", unlistedFilter: "all" }).title).toBe(
      "No active listings",
    );
    expect(listingsEmptyState({ tab: "sold", unlistedFilter: "all" }).title).toBe(
      "No sold items match this filter",
    );
    expect(listingsEmptyState({ tab: "shipped", unlistedFilter: "all" }).title).toBe(
      "Nothing shipped yet",
    );
    expect(listingsEmptyState({ tab: "returned", unlistedFilter: "all" }).title).toBe(
      "No returns",
    );
    expect(listingsEmptyState({ tab: "unlisted", unlistedFilter: "all" }).title).toBe(
      "Nothing waiting to list",
    );
    expect(
      listingsEmptyState({ tab: "unlisted", unlistedFilter: "needs_draft" }).title,
    ).toBe("Nothing under Needs draft");
    // The genuine "your account is empty" case keeps the Rocket and the CTA.
    expect(listingsEmptyState({ tab: "all", unlistedFilter: "all" }).icon).toBe(Rocket);
  });

  it("gives every tab a title and a description", () => {
    // A tab added later must not silently inherit "No items yet" the way Aged
    // did — this fails on the next one that does.
    for (const t of TABS) {
      const e = listingsEmptyState({ tab: t.id, unlistedFilter: "all" });
      expect(e.title, t.id).toBeTruthy();
      expect(e.description, t.id).toBeTruthy();
    }
  });
});
