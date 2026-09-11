import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { surfaceLabelFor, surfaceTitleFor } from "@/hooks/use-surface-title";

// US-3229. Every signed-in page shared index.html's one <title>, so a reseller
// with Inventory, Listings and Money open read three identical tabs, and so did
// every history entry and bookmark.
//
// The titles are derived from src/lib/surfaces.ts. That is the point and also
// the risk: if the registry moves a path or renames a field, the lookup starts
// returning null for everything and every tab quietly goes back to saying
// "GradeThread". These cases exist so that fails loudly instead.

describe("each signed-in surface gets its own tab title (US-3229)", () => {
  it("resolves the surfaces a seller actually lives in", () => {
    expect(surfaceLabelFor("/dashboard/flipdesk/inventory", "")).toBe("Inventory");
    expect(surfaceLabelFor("/dashboard/flipdesk/money", "")).toBe("Money");
    expect(surfaceLabelFor("/dashboard/submissions", "")).toBe("Submissions");
  });

  it("tells two tabs of the same host apart", () => {
    // Without the param step, Repricing would read as Pricing.
    const base = surfaceLabelFor("/dashboard/flipdesk/pricing", "");
    const repricing = surfaceLabelFor("/dashboard/flipdesk/pricing", "?tab=repricing");
    expect(base).not.toBeNull();
    expect(repricing).not.toBeNull();
    expect(repricing).not.toBe(base);
  });

  it("falls back to the nearest parent surface for a detail route", () => {
    // Detail routes are most of what a working seller has open, and they are
    // not surfaces, so without the prefix step they would all read "GradeThread".
    expect(
      surfaceLabelFor("/dashboard/flipdesk/items/8f1c2b7e-0000-4000-8000-000000000000", ""),
    ).toBe("FlipDesk Overview");
  });

  it("says just the product name when nothing matches", () => {
    // `/dashboard` prefixes every signed-in route, so if it were allowed to
    // match as a prefix the 404 would read "Overview" and every future gap
    // would hide behind a plausible answer.
    expect(surfaceTitleFor("/dashboard/nothing-here", "")).toBe("GradeThread");
    expect(surfaceLabelFor("/dashboard", "")).not.toBeNull();
  });

  it("qualifies a label two surfaces share, so the tabs still differ", () => {
    // "Overview" is both /dashboard (Grading) and /dashboard/flipdesk
    // (FlipDesk). Left alone, those two tabs would read identically -- the
    // exact thing this hook exists to stop.
    const grading = surfaceLabelFor("/dashboard", "");
    const flipdesk = surfaceLabelFor("/dashboard/flipdesk", "");
    expect(grading).not.toBe(flipdesk);
    expect(flipdesk).toBe("FlipDesk Overview");
  });

  it("formats a matched title as '<label> - GradeThread'", () => {
    expect(surfaceTitleFor("/dashboard/flipdesk/inventory", "")).toBe(
      "Inventory - GradeThread",
    );
  });

  it("resolves for most of the registry, not a lucky few (self-check)", () => {
    // If a registry change breaks the lookup, the cases above might still pass
    // by coincidence. This one cannot: it asserts breadth.
    const resolved = [
      "/dashboard",
      "/dashboard/flipdesk",
      "/dashboard/flipdesk/inventory",
      "/dashboard/flipdesk/listings",
      "/dashboard/flipdesk/money",
      "/dashboard/flipdesk/analytics",
      "/dashboard/flipdesk/marketplaces",
      "/dashboard/flipdesk/import",
      "/dashboard/submissions",
      "/dashboard/account",
    ].filter((p) => surfaceLabelFor(p, "") !== null);
    expect(resolved.length).toBeGreaterThanOrEqual(9);
  });

  it("resolves the buyer tree from BUYER_NAV (US-3252)", () => {
    // Buyer routes are NOT in the surfaces registry and deliberately stay out
    // of it: src/lib/buyer-nav.ts already declares them once with the labels
    // the sidebar renders. Copying those into a second list is the
    // two-lists-that-disagree problem the registry exists to solve.
    expect(surfaceLabelFor("/buyer", "")).toBe("Home");
    expect(surfaceLabelFor("/buyer/alerts", "")).toBe("Watchlist & Alerts");
    expect(surfaceLabelFor("/buyer/settings", "")).toBe("Settings");
    expect(surfaceTitleFor("/buyer/rewards", "")).toBe("Rewards - GradeThread");
  });

  it("titles admin surfaces from the extracted nav (US-3252)", () => {
    // This case used to assert the OPPOSITE, that admin resolved to null,
    // because its nav was nine unexported arrays inside admin-layout.tsx and
    // there was nothing to read. US-3252 moved it to src/lib/admin-nav.ts on
    // 2026-09-11, so the assertion inverts rather than being deleted: an
    // expectation that stops being true is a finding, and dropping it would
    // leave the tab title untested on 72 admin pages.
    expect(surfaceLabelFor("/admin/users", "")).toBe("Users");
    expect(surfaceTitleFor("/admin/users", "")).toBe("Users - GradeThread");
    // The prefix rule reaches a detail route under a listed path, which is
    // most of what an admin actually has open.
    expect(surfaceLabelFor("/admin/users/some-uuid", "")).toBe("Users");
  });

  it("is mounted in all three signed-in layouts, not merely exported", () => {
    // A hook nothing calls titles nothing. Admin joined this list on
    // 2026-09-11 with US-3252; route-announcer.test.tsx holds the other half,
    // that each layout's mount has a source the hook actually reads.
    for (const rel of [
      "src/layouts/dashboard-layout.tsx",
      "src/layouts/buyer-layout.tsx",
      "src/layouts/admin-layout.tsx",
    ]) {
      const layout = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(layout, `${rel} does not mount useSurfaceTitle`).toContain(
        "useSurfaceTitle()",
      );
    }
  });
});
