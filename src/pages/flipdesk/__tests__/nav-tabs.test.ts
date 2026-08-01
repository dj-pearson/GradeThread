// US-2161 — the consolidated FlipDesk nav.
//
// Two properties matter, and neither is about looks:
//   1. A retired path still resolves. Nine URLs stopped being pages; if any of
//      them 404s, a bookmark, a shared link, the command palette or
//      flipdesk-search breaks — which is strictly worse than the crowded nav
//      the consolidation replaced.
//   2. An unknown ?tab= lands on a real tab. A truncated share link or a typo
//      should look like the page, not like a bug.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  PRICING_TABS,
  resolvePricingTab,
  resolveSourcingTab,
  RETIRED_NAV_REDIRECTS,
  SOURCING_TABS,
} from "@/pages/flipdesk/nav-tabs";

describe("tab resolution", () => {
  it("accepts every declared tab", () => {
    for (const t of PRICING_TABS) expect(resolvePricingTab(t)).toBe(t);
    for (const t of SOURCING_TABS) expect(resolveSourcingTab(t)).toBe(t);
  });

  it("falls back to the first tab for anything unknown", () => {
    // Absent, empty, junk, and a value from the OTHER host's tab set.
    for (const bad of [null, undefined, "", "  ", "nope", "sources"]) {
      expect(resolvePricingTab(bad)).toBe("repricing");
    }
    for (const bad of [null, undefined, "", "bulk", "automations"]) {
      expect(resolveSourcingTab(bad)).toBe("scout");
    }
  });

  it("is not fooled by case or padding", () => {
    // Exact match only — a near-miss must land on the default rather than
    // silently rendering something the URL didn't ask for.
    expect(resolvePricingTab("Repricing")).toBe("repricing");
    expect(resolvePricingTab(" bulk ")).toBe("repricing");
  });
});

describe("retired nav paths", () => {
  const routes = readFileSync("src/routes/index.tsx", "utf8");

  it("covers all nine consolidated surfaces", () => {
    // Guard against a redirect being dropped in a later edit: the map is the
    // contract, so it must stay complete.
    expect(Object.keys(RETIRED_NAV_REDIRECTS)).toHaveLength(9);
  });

  it("every retired path has a route that redirects to its new home", () => {
    for (const [from, to] of Object.entries(RETIRED_NAV_REDIRECTS)) {
      expect(
        routes.includes(`path: "${from}"`),
        `${from} must still be a declared route`,
      ).toBe(true);
      // Either a plain Navigate to the new URL, or the TabRedirect that merges
      // the incoming query string with the tab (US-2161: /scout?brand=Nike must
      // not lose its brand on the way to /sourcing?tab=scout).
      const [base, tab] = to.split("?tab=");
      const merged = tab
        ? routes.includes(`<TabRedirect to="${base}" tab="${tab}" />`)
        : false;
      expect(
        routes.includes(`to="${to}"`) || merged,
        `${from} must redirect to ${to}`,
      ).toBe(true);
    }
  });

  it("preserves incoming query params through a tab redirect", () => {
    // The regression this guards: a bare Navigate replaces the whole search
    // string. /flipdesk/scout?brand=Nike is a live in-app link from the
    // community recommendations, and dropping the brand makes it useless.
    const params = new URLSearchParams("?brand=Nike&sort=price");
    params.set("tab", "scout");
    expect(params.get("brand")).toBe("Nike");
    expect(params.get("sort")).toBe("price");
    expect(params.get("tab")).toBe("scout");
    // And the router uses the merging component, not a literal target, for
    // every path that can carry params.
    expect(routes).toContain(
      '<TabRedirect to="/dashboard/flipdesk/sourcing" tab="scout" />',
    );
  });

  it("declares the two consolidated hosts and the analytics tab paths", () => {
    for (const path of [
      "/dashboard/flipdesk/pricing",
      "/dashboard/flipdesk/sourcing",
      "/dashboard/flipdesk/analytics/community",
      "/dashboard/flipdesk/analytics/performance",
    ]) {
      expect(routes.includes(`path: "${path}"`), `${path} must exist`).toBe(true);
    }
  });

  it("no retired path still points at its old standalone page", () => {
    // The bug this catches: leaving the old element in place next to the new
    // redirect, so the consolidation silently does nothing.
    for (const dead of [
      "<FlipdeskRepricingPage />",
      "<FlipdeskBulkPricingPage />",
      "<FlipdeskAutomationsPage />",
      "<FlipdeskScoutPage />",
      "<FlipdeskScoutBuyPage />",
      "<FlipdeskSourcesPage />",
      "<FlipdeskDemandPage />",
      "<FlipdeskCommunityInsightsPage />",
      "<PriceSuggestionsPage />",
    ]) {
      expect(routes.includes(dead), `${dead} should no longer be routed`).toBe(
        false,
      );
    }
  });
});

describe("sidebar", () => {
  const sidebar = readFileSync("src/components/dashboard/sidebar.tsx", "utf8");

  it("links the hosts, not the retired paths", () => {
    expect(sidebar).toContain('to: "/dashboard/flipdesk/pricing"');
    expect(sidebar).toContain('to: "/dashboard/flipdesk/sourcing"');
    for (const gone of Object.keys(RETIRED_NAV_REDIRECTS)) {
      expect(
        sidebar.includes(`to: "${gone}"`),
        `${gone} should no longer be a sidebar entry`,
      ).toBe(false);
    }
  });

  it("keeps Analytics highlighted across its tab paths", () => {
    // `end: true` would un-highlight the nav item on /analytics/community and
    // /analytics/performance, which now live under it.
    const line = sidebar
      .split("\n")
      .find((l) => l.includes('to: "/dashboard/flipdesk/analytics"'));
    expect(line).toBeDefined();
    expect(line).toContain("end: false");
  });
});
