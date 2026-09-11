import { useEffect } from "react";
import { useLocation } from "react-router";
import { ALL_SURFACES } from "@/lib/surfaces";
import { BUYER_NAV } from "@/lib/buyer-nav";
import { ADMIN_NAV_ITEMS } from "@/lib/admin-nav";

// US-3229. Give each signed-in page its own browser tab.
//
// index.html ships one <title> and nothing replaced it once a seller signed
// in: components/seo.tsx does set document.title, but only the public
// marketing pages render it, and no page under src/pages/flipdesk sets a title
// at all. A reseller works in tabs by definition -- Inventory in one, Listings
// in another, Money in a third -- and all three read "GradeThread - The
// Standard for Clothing Condition Grading", as does every history entry and
// every bookmark.
//
// Titles are DERIVED from src/lib/surfaces.ts rather than written on 113
// pages. That registry already answers "what does the product contain", with
// the label spelled exactly as the product spells it and a canonical web link
// that includes the ?tab= / ?view= naming a surface inside a tabbed host. A new
// surface therefore gets a title by being in the registry, which is the only
// version of this that stays true.

const SUFFIX = "GradeThread";
const DASHBOARD_ROOT = "/dashboard";

type Entry = {
  path: string;
  /** The one query param that names a surface inside a tabbed host, if any. */
  param: { key: string; value: string } | null;
  label: string;
};

/**
 * A label that more than one surface uses is qualified by its nav group, or
 * the tab strip reintroduces the very collision this hook exists to remove.
 * Today that is exactly one word: "Overview" is both `/dashboard` (Grading)
 * and `/dashboard/flipdesk` (FlipDesk). Derived, so a future duplicate is
 * handled by existing rather than by being remembered here.
 */
const DUPLICATE_LABELS: ReadonlySet<string> = (() => {
  const seen = new Map<string, number>();
  for (const s of ALL_SURFACES) seen.set(s.label, (seen.get(s.label) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([label]) => label));
})();

/**
 * The buyer tree is not in the surfaces registry (US-3252) and does not need to
 * be: src/lib/buyer-nav.ts already declares it once, with the labels the buyer
 * sidebar renders. Reading THAT is better than copying eight labels into a
 * second list, which is precisely the two-lists-that-disagree problem the
 * surfaces registry exists to solve. One source per tree.
 *
 * Admin came off that list on 2026-09-11 (US-3252): its nav is now
 * src/lib/admin-nav.ts rather than nine unexported arrays inside
 * admin-layout.tsx, so there is finally something to read. It stays a
 * SEPARATE registry from surfaces.ts on purpose, because surfaces.ts asks
 * product questions (iOS parity, plan gate, workspace capability) and admin
 * answers none of them.
 */
const BUYER_ENTRIES: Entry[] = BUYER_NAV.map((item) => ({
  path: item.to,
  param: null,
  label: item.label,
}));

/**
 * US-3252. Same shape as the buyer entries and for the same reason: one
 * source per tree. No param handling, because an admin nav entry is a plain
 * path; if one ever gains a ?view= the tabbed-host branch above is where it
 * belongs rather than here.
 */
const ADMIN_ENTRIES: Entry[] = ADMIN_NAV_ITEMS.map((item) => ({
  path: item.to,
  param: null,
  label: item.label,
}));

/** Built once: the registry is a module-level constant. */
const ENTRIES: Entry[] = ALL_SURFACES.flatMap((s) => {
  if (s.web === null) return [];
  const [path, query] = s.web.split("?");
  const first = query ? new URLSearchParams(query).entries().next() : null;
  const pair = first && !first.done ? first.value : null;
  const group = s.nav?.group ?? null;
  return [{
    path: path!,
    param: pair ? { key: pair[0], value: pair[1] } : null,
    label:
      DUPLICATE_LABELS.has(s.label) && group ? `${group} ${s.label}` : s.label,
  }];
}).concat(BUYER_ENTRIES, ADMIN_ENTRIES);

/**
 * The label for a location, or null when nothing in the registry covers it.
 *
 * Precedence, and each step earns its place:
 *  1. exact path + the matching tab/view param, so Repricing does not read
 *     as Pricing;
 *  2. exact path with no param, for the tabbed host's own default tab;
 *  3. longest path PREFIX, so /dashboard/flipdesk/items/<id> answers with
 *     FlipDesk rather than the bare product name. Detail routes are most of
 *     what a working seller actually has open. `/dashboard` is excluded here
 *     because it prefixes everything.
 */
export function surfaceLabelFor(pathname: string, search: string): string | null {
  const params = new URLSearchParams(search);

  for (const e of ENTRIES) {
    if (e.path !== pathname || !e.param) continue;
    if (params.get(e.param.key) === e.param.value) return e.label;
  }
  for (const e of ENTRIES) {
    if (e.path === pathname && !e.param) return e.label;
  }

  let best: Entry | null = null;
  for (const e of ENTRIES) {
    // `/dashboard` is a prefix of every signed-in route, so leaving it in
    // would title the 404 "Overview" and hide every future gap behind a
    // plausible answer. It still matches exactly, in step 2.
    if (e.path === DASHBOARD_ROOT) continue;
    if (!pathname.startsWith(e.path + "/")) continue;
    if (!best || e.path.length > best.path.length) best = e;
  }
  return best?.label ?? null;
}

/** `<label> - GradeThread`, or the bare product name when nothing matches. */
export function surfaceTitleFor(pathname: string, search: string): string {
  const label = surfaceLabelFor(pathname, search);
  return label ? `${label} - ${SUFFIX}` : SUFFIX;
}

/** Keeps document.title in step with the route. Mount once, in a layout. */
export function useSurfaceTitle(): void {
  const { pathname, search } = useLocation();
  useEffect(() => {
    document.title = surfaceTitleFor(pathname, search);
  }, [pathname, search]);
}
