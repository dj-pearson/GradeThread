import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2857 + US-2858.
//
// The first-run tour told a brand-new account to look "under Submissions", "in
// the Inventory section", "on the Finances page" and "see the API Keys page".
// Three of those four names had been retired: Inventory moved under FlipDesk
// (US-740), Finances became FlipDesk > Money (US-2161), API Keys became
// Developers (US-2554). Nothing failed when they were renamed, because nothing
// connected the onboarding copy to the nav, so the product's first sentence to
// every new user was a set of directions to rooms that had moved.
//
// Separately, three of the buttons the same user is asked to press went through
// a router redirect rather than to a page.
//
// This file connects the three things: the onboarding copy, the router, and the
// sidebar. It is a SOURCE SCAN, so it can only fail if it actually finds the
// strings it is looking for — hence the self-check block at the bottom, which
// fails if the extractors come back empty. A guard that silently extracts
// nothing passes forever and proves nothing.

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const ROUTES_FILE = "src/routes/index.tsx";
const SIDEBAR_FILE = "src/components/dashboard/sidebar.tsx";

// The files that tell a new user where to go.
const ONBOARDING_FILES = [
  "src/components/onboarding/onboarding-flow.tsx",
  // US-2859: the checklist COMPONENT names no destinations any more. Both it
  // and the FlipDesk surface render from this one step list, so this is the
  // file that has to be right.
  "src/lib/activation-steps.ts",
  "src/pages/dashboard.tsx",
];

const routesSrc = read(ROUTES_FILE);
const sidebarSrc = read(SIDEBAR_FILE);

// ---------------------------------------------------------------- the router

/** Component names in routes/index.tsx that redirect instead of rendering. */
const REDIRECT_ELEMENTS = [
  "<Navigate",
  "<ViewRedirect",
  "<TabRedirect",
  "<InventoryModeRedirect",
  "<InventoryItemRedirect",
  "<ContentRedirect",
];

interface RouteEntry {
  path: string;
  redirects: boolean;
}

function parseRoutes(src: string): RouteEntry[] {
  const out: RouteEntry[] = [];
  // Every route is declared on one line as `{ path: "...", element: ... }`.
  for (const line of src.split("\n")) {
    const m = /path:\s*"([^"]+)"/.exec(line);
    if (!m) continue;
    const path = m[1]!;
    out.push({
      path,
      redirects: REDIRECT_ELEMENTS.some((el) => line.includes(el)),
    });
  }
  return out;
}

const routes = parseRoutes(routesSrc);
const routedPaths = new Set(routes.map((r) => r.path));
const redirectPaths = new Set(
  routes.filter((r) => r.redirects).map((r) => r.path),
);

// --------------------------------------------------------------- the sidebar

/** Every NavItem label the sidebar renders. */
function parseNavLabels(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/label:\s*"([^"]+)"/g)) out.add(m[1]!);
  return out;
}

/** Every nav group / subgroup title the sidebar renders. */
function parseNavTitles(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/title:\s*"([^"]+)"/g)) out.add(m[1]!);
  return out;
}

const navLabels = parseNavLabels(sidebarSrc);
const navTitles = parseNavTitles(sidebarSrc);

// ------------------------------------------------------- the onboarding copy

interface CopyRoute {
  file: string;
  route: string;
}

/**
 * Routes named by onboarding copy: `to: "/..."` object fields and `to="/..."`
 * JSX props. Only in-app paths; an external URL is not the router's problem.
 */
function parseCopyRoutes(file: string): CopyRoute[] {
  const src = read(file);
  const out: CopyRoute[] = [];
  for (const m of src.matchAll(/\bto[:=]\s*"(\/[^"]*)"/g)) {
    out.push({ file, route: m[1]! });
  }
  return out;
}

const copyRoutes = ONBOARDING_FILES.flatMap(parseCopyRoutes);

/** Strip the query string / hash — the router matches on the path. */
const pathOf = (route: string) => route.split(/[?#]/)[0]!;

describe("onboarding copy points at pages that exist (US-2857)", () => {
  for (const { file, route } of copyRoutes) {
    it(`${file} -> ${route} is routed`, () => {
      expect(
        routedPaths.has(pathOf(route)),
        `${file} sends a new user to ${route}, which no route declares. ` +
          "Onboarding is the one place a dead link costs an account.",
      ).toBe(true);
    });
  }

  it("the tour names sidebar labels exactly as the sidebar spells them", () => {
    const src = read("src/components/onboarding/onboarding-flow.tsx");
    const labels = [...src.matchAll(/navLabel:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(labels.length, "no navLabel fields found — extractor is broken").toBeGreaterThan(
      0,
    );
    for (const label of labels) {
      expect(
        navLabels.has(label),
        `The tour tells the user to look for "${label}" in the sidebar, and no ` +
          `NavItem uses that label. Sidebar labels today: ${[...navLabels].join(", ")}`,
      ).toBe(true);
    }
  });

  it("the tour names sidebar sections exactly as the sidebar spells them", () => {
    const src = read("src/components/onboarding/onboarding-flow.tsx");
    const groups = [...src.matchAll(/navGroup:\s*"([^"]*)"/g)]
      .map((m) => m[1]!)
      .filter(Boolean);
    for (const group of groups) {
      expect(
        navTitles.has(group),
        `The tour says a destination lives under "${group}" and no nav group ` +
          "or subgroup has that title.",
      ).toBe(true);
    }
  });
});

describe("no onboarding button lands on a redirect (US-2858)", () => {
  for (const { file, route } of copyRoutes) {
    it(`${file} -> ${route} renders a page`, () => {
      expect(
        redirectPaths.has(pathOf(route)),
        `${file} sends a new user to ${route}, which is a redirect alias. Use ` +
          "the canonical route so the URL the product shows is the URL the " +
          "user ends on.",
      ).toBe(false);
    });
  }
});

// ---------------------------------------------------------------- self-check
//
// See vault/70-agent — a source scan that extracts nothing reads exactly like a
// clean codebase. These assertions fail if any extractor stops finding data, so
// a rename or a refactor cannot quietly disarm the guard above.
describe("the guard is actually reading the files", () => {
  it("found routes, including at least one redirect", () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(redirectPaths.size).toBeGreaterThan(5);
  });

  it("found sidebar labels and section titles", () => {
    expect(navLabels.size).toBeGreaterThan(10);
    expect(navTitles.size).toBeGreaterThan(3);
  });

  it("found onboarding routes in every file it claims to cover", () => {
    for (const file of ONBOARDING_FILES) {
      expect(
        copyRoutes.some((r) => r.file === file),
        `${file} yielded no routes — either it stopped naming destinations, or ` +
          "the extractor no longer matches how it names them.",
      ).toBe(true);
    }
  });

  it("recognises the known redirect aliases the copy used to point at", () => {
    // These three are the exact paths US-2858 moved off. If the router ever
    // stops classifying them as redirects, the test above goes quiet.
    for (const alias of [
      "/dashboard/inventory/new",
      "/dashboard/flipdesk/items",
      "/dashboard/finances",
    ]) {
      expect(redirectPaths.has(alias), `${alias} is no longer a redirect`).toBe(
        true,
      );
    }
  });
});
