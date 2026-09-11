import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADMIN_NAV, ADMIN_NAV_ITEMS } from "@/lib/admin-nav";

// US-3252. The admin sidebar is a module now instead of nine arrays inside
// admin-layout.tsx, and this holds it against the router.
//
// TWO DIRECTIONS, and they catch different mistakes.
//
//   * A nav entry pointing at a path with no route sends an operator to the
//     in-shell 404. Nothing else notices: the link renders, it highlights, it
//     navigates. A typo in a path is invisible until someone clicks it.
//   * A route with no nav entry is a page nobody can find. That is the defect
//     US-2808 was filed about (the registered-numbers queue was routed and
//     unlinked for a release), and it is also what a careless edit to this
//     list does -- delete a line and the destination is still routed, still
//     working, and unreachable.
//
// Both are derived from src/routes/admin-routes.tsx rather than from a
// remembered list. A guard that hard-codes what it expects goes stale and then
// blames the code for its own drift.

const ROUTES = "src/routes/admin-routes.tsx";

/**
 * Every admin path that renders a PAGE, from the router.
 *
 * Excluded, each for a reason:
 *  - `<Navigate>` routes are redirects into a host tab (US-2559), so they are
 *    deliberately not destinations;
 *  - `:param` routes are detail views reached from their list;
 *  - `*` is the in-shell 404.
 */
function routedAdminPaths(src: string): Set<string> {
  const out = new Set<string>();
  if (/<Route\s+index\b/.test(src)) out.add("/admin");
  for (const m of src.matchAll(/<Route\s+path="([^"]+)"\s+element=\{([\s\S]*?)\}\s*\/>/g)) {
    const path = m[1]!;
    const element = m[2]!;
    if (path.includes(":") || path === "*") continue;
    if (element.includes("<Navigate")) continue;
    out.add(`/admin/${path}`);
  }
  return out;
}

/**
 * Routed admin pages that are deliberately not sidebar entries.
 *
 * Shrink-only: an entry that stops being unlinked FAILS, so this list can only
 * get shorter. That is what stops it becoming the place a forgotten page goes
 * to be forgotten.
 */
const UNLINKED: Record<string, string> = {
  // Reached from a button on the Help Center page (see
  // src/pages/content/help-list.tsx). A drill-down from its parent, not a
  // top-level destination.
  "/admin/content/help/report":
    "drill-down from the Help Center page, not a destination of its own",
  // MEASURED 2026-09-11, and this one is a finding rather than a decision:
  // nothing anywhere in src/ links to it. The page works and an operator can
  // only reach it by typing the URL. Recorded here so the guard is honest
  // about what it is letting through; closing it is a separate change, and
  // the day someone links it this entry fails and gets deleted.
  "/admin/listing-coverage":
    "routed but linked from nowhere in src/ as of 2026-09-11; reachable only by URL",
};

describe("US-3252: the admin nav and the admin router agree", () => {
  const routes = routedAdminPaths(
    readFileSync(resolve(process.cwd(), ROUTES), "utf8"),
  );

  it("the parse found the router, so a quiet pass means something", () => {
    // Guards the guard. If the Route elements are reformatted past this regex
    // the set empties, and "every nav entry is routed" would then be a
    // statement about nothing.
    expect(routes.size).toBeGreaterThan(60);
    expect(routes.has("/admin")).toBe(true);
    expect(routes.has("/admin/users")).toBe(true);
  });

  it("the parse can tell a page from a redirect", () => {
    // Fed samples rather than asserted against the live file, so this stays
    // true after the last redirect is retired. Without it, a parse that
    // stopped excluding <Navigate> would quietly demand nav entries for
    // sixteen retired paths.
    const sample = [
      '<Route index element={<SuspenseWrapper><AdminDashboardPage /></SuspenseWrapper>} />',
      '<Route path="users" element={<SuspenseWrapper><AdminUsersPage /></SuspenseWrapper>} />',
      '<Route path="moderation" element={<Navigate to="/admin/safety?view=moderation" replace />} />',
      '<Route path="users/:id" element={<SuspenseWrapper><AdminUserDetailPage /></SuspenseWrapper>} />',
      '<Route path="*" element={<SuspenseWrapper><InShellNotFound homeTo="/admin" /></SuspenseWrapper>} />',
    ].join("\n");
    expect([...routedAdminPaths(sample)].sort()).toEqual([
      "/admin",
      "/admin/users",
    ]);
  });

  it("every nav entry points at a route that exists", () => {
    const dangling = ADMIN_NAV_ITEMS.filter((item) => !routes.has(item.to)).map(
      (item) => `${item.label} -> ${item.to}`,
    );
    expect(
      dangling,
      "these sidebar entries navigate to a path with no admin route, so " +
        "clicking one lands on the in-shell 404:\n  " + dangling.join("\n  "),
    ).toEqual([]);
  });

  it("every routed admin page is reachable from the sidebar", () => {
    const linked = new Set(ADMIN_NAV_ITEMS.map((item) => item.to));
    const orphans = [...routes].filter(
      (path) => !linked.has(path) && !UNLINKED[path],
    );
    expect(
      orphans,
      "these admin pages are routed and nothing links to them, so an " +
        "operator cannot find them:\n  " + orphans.join("\n  "),
    ).toEqual([]);
  });

  it("the unlinked list only shrinks", () => {
    const linked = new Set(ADMIN_NAV_ITEMS.map((item) => item.to));
    const stale = Object.keys(UNLINKED).filter(
      (path) => linked.has(path) || !routes.has(path),
    );
    expect(
      stale,
      "these paths are listed as deliberately unlinked but are now in the " +
        "sidebar or gone from the router -- delete the entry:\n  " +
        stale.join("\n  "),
    ).toEqual([]);
  });
});

describe("US-3252: the list is internally coherent", () => {
  it("carries the whole sidebar, so an emptied list cannot pass", () => {
    expect(ADMIN_NAV_ITEMS.length).toBeGreaterThan(60);
    expect(ADMIN_NAV.length).toBeGreaterThan(5);
  });

  it("no path appears twice", () => {
    const seen = new Map<string, number>();
    for (const item of ADMIN_NAV_ITEMS) {
      seen.set(item.to, (seen.get(item.to) ?? 0) + 1);
    }
    const dupes = [...seen].filter(([, n]) => n > 1).map(([to]) => to);
    expect(dupes, "two sidebar entries lead to the same place").toEqual([]);
  });

  it("a parent entry matches its route exactly", () => {
    // Without `end`, react-router's NavLink treats a prefix match as active,
    // so /admin/growth and /admin/growth/campaigns both highlight and the
    // sidebar shows two current pages. Derived from the paths, so a new child
    // entry under an existing parent is caught the day it is added rather
    // than whenever somebody notices two red rows.
    const paths = ADMIN_NAV_ITEMS.map((item) => item.to);
    const offenders = ADMIN_NAV_ITEMS.filter(
      (item) =>
        !item.end && paths.some((other) => other.startsWith(`${item.to}/`)),
    ).map((item) => `${item.to} (${item.label})`);
    expect(
      offenders,
      "these entries are a parent of another entry but do not set end: true, " +
        "so both rows highlight at once:\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });

  it("exactly one section is untitled and it comes first", () => {
    const untitled = ADMIN_NAV.filter((section) => section.title === null);
    expect(untitled.length).toBe(1);
    expect(ADMIN_NAV[0]!.title).toBeNull();
  });

  it("no section is empty", () => {
    // An empty section renders a heading over nothing.
    const empty = ADMIN_NAV.filter((section) => section.items.length === 0).map(
      (section) => section.title ?? "(untitled)",
    );
    expect(empty).toEqual([]);
  });

  it("every label is real text", () => {
    const blank = ADMIN_NAV_ITEMS.filter((item) => item.label.trim() === "");
    expect(blank.map((item) => item.to)).toEqual([]);
  });
});
