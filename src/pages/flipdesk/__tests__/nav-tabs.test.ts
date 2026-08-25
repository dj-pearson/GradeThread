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
import { readdirSync, readFileSync } from "node:fs";
import {
  PRICING_TABS,
  resolvePricingTab,
  resolveSourcingTab,
  RETIRED_NAV_REDIRECTS,
  SOURCING_TABS,
  MONEY_VIEWS,
  AUTOLISTER_VIEWS,
  resolveMoneyView,
  resolveAutolisterView,
  RETIRED_VIEW_REDIRECTS,
} from "@/pages/flipdesk/nav-tabs";
import { ALL_SURFACES } from "@/lib/surfaces";

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
  // US-2876: the sidebar builds itself from src/lib/surfaces.ts, so what it
  // links is what the registry declares. Read as VALUES rather than as text --
  // the assertions are the same ones, checked one step closer to the truth.
  const navLinks = new Set(
    ALL_SURFACES.filter((s) => s.nav !== null).map((s) => s.web),
  );

  it("links the hosts, not the retired paths", () => {
    expect(navLinks.size, "no nav surfaces read").toBeGreaterThan(15);
    expect(navLinks.has("/dashboard/flipdesk/pricing")).toBe(true);
    expect(navLinks.has("/dashboard/flipdesk/sourcing")).toBe(true);
    for (const gone of Object.keys(RETIRED_NAV_REDIRECTS)) {
      expect(navLinks.has(gone), `${gone} should no longer be a sidebar entry`).toBe(
        false,
      );
    }
  });

  it("keeps Analytics highlighted across its tab paths", () => {
    // `end: true` would un-highlight the nav item on /analytics/community and
    // /analytics/performance, which now live under it.
    const analytics = ALL_SURFACES.find((s) => s.web === "/dashboard/flipdesk/analytics");
    expect(analytics, "the Analytics nav entry is gone").toBeDefined();
    expect(analytics!.nav?.end ?? false).toBe(false);
  });
});

// US-2161 (second pass, 2026-08-02) — the two further merges the owner
// approved: Money (Finances + Expenses + Reconcile) and AutoLister (generator +
// its Drafts output). FlipDesk goes 19 entries down to 16.
//
// These carry one risk the first three did not, and it is the whole reason the
// parameter is `?view=`: Reconcile ALREADY owns `?tab=` for its four inner tabs
// (US-963). If the outer host had reused `tab`, every existing Reconcile deep
// link would have had to be renamed, or would have been quietly overwritten.
describe("the ?view= hosts (US-2161 second pass)", () => {
  it("accepts every declared view and falls back for anything else", () => {
    for (const v of MONEY_VIEWS) expect(resolveMoneyView(v)).toBe(v);
    for (const v of AUTOLISTER_VIEWS) expect(resolveAutolisterView(v)).toBe(v);
    // Absent, empty, junk, a value from the other host, and — the one that
    // matters — a value from Reconcile's INNER tab set, which must not be
    // mistaken for an outer view.
    for (const bad of [null, undefined, "", "  ", "nope", "generate", "payouts"]) {
      expect(resolveMoneyView(bad)).toBe("finances");
    }
    for (const bad of [null, undefined, "", "reconcile", "photos"]) {
      expect(resolveAutolisterView(bad)).toBe("generate");
    }
  });

  it("keeps ?view= and Reconcile's ?tab= in separate namespaces", () => {
    // The collision this design exists to avoid. No outer view name may also be
    // an inner Reconcile tab name, or a single `?tab=` would have been
    // ambiguous and the split would be pointless.
    const reconcileInnerTabs = ["photos", "ebay", "payouts", "cross-source"];
    for (const v of MONEY_VIEWS) {
      expect(reconcileInnerTabs, `view "${v}" collides with a Reconcile tab`)
        .not.toContain(v);
    }
  });

  it("every retired path redirects to its host, preserving the inner tab", () => {
    const routes = readFileSync("src/routes/index.tsx", "utf8");
    for (const [from, to] of Object.entries(RETIRED_VIEW_REDIRECTS)) {
      const view = new URL(to, "https://x").searchParams.get("view");
      const base = to.split("?")[0];
      // A ViewRedirect, not a bare <Navigate to="...?view=x">. The difference
      // is load-bearing: a literal query string REPLACES whatever was on the
      // incoming URL, which would drop Reconcile's ?tab= on the floor. The
      // first pass of this story found exactly that bug on /scout?brand=Nike.
      const line = routes.split("\n").find((l) => l.includes(`path: "${from}"`));
      expect(line, `no route for retired path ${from}`).toBeTruthy();
      expect(line, `${from} must redirect via ViewRedirect`).toContain(
        "<ViewRedirect",
      );
      expect(line).toContain(`view="${view}"`);
      expect(line).toContain(`to="${base}"`);
    }
  });

  it("ViewRedirect merges the incoming query rather than replacing it", () => {
    // Asserted on the implementation because the failure is invisible in a
    // route table: both shapes route, only one keeps ?tab=payouts.
    const routes = readFileSync("src/routes/index.tsx", "utf8");
    const start = routes.indexOf("function ViewRedirect(");
    expect(start, "ViewRedirect is gone").toBeGreaterThan(0);
    // A fixed window, NOT indexOf("}") — the first brace belongs to the
    // destructured parameter list, so cutting there yields the signature and
    // every assertion below fails on an empty body.
    const body = routes.slice(start, start + 600);
    expect(body).toContain("new URLSearchParams(search)");
    expect(body).toContain('params.set("view"');
    // It must NOT clear the inner tab — that is Money's job on a view CHANGE,
    // not the redirect's job on arrival.
    expect(body).not.toContain('delete("tab")');
  });

  it("no retired path still renders its old standalone page", () => {
    const routes = readFileSync("src/routes/index.tsx", "utf8");
    for (const from of Object.keys(RETIRED_VIEW_REDIRECTS)) {
      const line = routes.split("\n").find((l) => l.includes(`path: "${from}"`));
      expect(line, `${from} still renders a page beside its redirect`)
        .not.toContain("SuspenseWrapper");
    }
  });

  it("the sidebar links the hosts and drops the merged entries", () => {
    const navLinks = new Set(ALL_SURFACES.filter((s) => s.nav !== null).map((s) => s.web));
    expect(navLinks.has("/dashboard/flipdesk/money")).toBe(true);
    for (const gone of Object.keys(RETIRED_VIEW_REDIRECTS)) {
      // AutoLister keeps its own entry — only the Drafts child was merged away.
      if (gone === "/dashboard/flipdesk/autolister/drafts") {
        expect(navLinks.has(gone)).toBe(false);
        expect(navLinks.has("/dashboard/flipdesk/autolister")).toBe(true);
        continue;
      }
      expect(navLinks.has(gone), `${gone} is still a sidebar entry`).toBe(false);
    }
  });

  it("no in-app link points at a retired path", () => {
    // The first pass established this rule: repoint every caller at the
    // canonical route so nothing depends on the redirect hop. A redirect is a
    // safety net for bookmarks, not a routing layer for our own links.
    const files = readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter((p) => /\.tsx?$/.test(p))
      .map((p) => `src/${p.split("\\").join("/")}`)
      .filter((p) => !p.includes("__tests__") && !p.startsWith("src/test/"))
      .filter((p) => p !== "src/pages/flipdesk/nav-tabs.ts")
      .filter((p) => p !== "src/routes/index.tsx");
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const gone of Object.keys(RETIRED_VIEW_REDIRECTS)) {
        // Quoted and terminated, so a lazy import of the hosted page MODULE
        // does not read as a link to the retired ROUTE.
        if (new RegExp(`["'\`]${gone}["'?\`]`).test(src)) {
          offenders.push(`${file} -> ${gone}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("FlipDesk is down to 16 sidebar entries", () => {
    // AC6's number, asserted rather than described. The story predicted ~14;
    // reaching that needed merges no criterion specified, so the owner approved
    // these two and amended the target to 16. Pinning it means the next entry
    // someone adds is a decision, not a drift.
    //
    // US-2876: counted off the registry rather than by matching `to:` lines in
    // a slice of sidebar.tsx. Same number, and it can no longer be thrown off
    // by how the component happens to be formatted.
    const flipdesk = ALL_SURFACES.filter((s) => s.nav?.group === "FlipDesk");
    expect(flipdesk.length).toBe(16);
    // Catalog 3 + List & sell 3 + Sourcing 3 + Channels & money 6 + Automate 1.
    const perSubgroup = (title: string) =>
      flipdesk.filter((s) => s.nav?.subgroup === title).length;
    expect(perSubgroup("Catalog")).toBe(3);
    expect(perSubgroup("List & sell")).toBe(3);
    expect(perSubgroup("Sourcing")).toBe(3);
    expect(perSubgroup("Channels & money")).toBe(6);
    expect(perSubgroup("Automate & insights")).toBe(1);
  });
});
