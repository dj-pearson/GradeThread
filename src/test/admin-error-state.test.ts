import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, sep } from "node:path";

// US-2507. An admin page that renders an EmptyState without checking `isError`
// first tells the operator "there is nothing here" when the truth is "the load
// failed". That is not a cosmetic gap: admin/growth/quests.tsx used to answer a
// failed quests query with "No quests yet — Create one to give sellers a reason
// to come back this week", which invites an operator to duplicate a live
// program, or to conclude one is empty when it is running.
//
// The customer-facing app has been fixing exactly this one story at a time
// (US-1636 dashboard, US-2026 buyer wants, US-1131 verified directory, US-1631
// billing). The admin tree never got that pass; this guard is what stops it
// growing back.
//
// Scope is deliberately the EMPTY-STATE pages. A page with no empty state
// cannot mislead in this particular way, so requiring ErrorState everywhere
// would be a different (and much larger) rule than the failure this guards.

const ADMIN_ROOTS = ["src/pages/admin", "src/pages/content"];

/**
 * US-2507 ratchet. These pages render NOTHING when a read fails — the weakest
 * form of the defect: nothing claims "no data", nothing spins, the page just
 * has holes in it and the operator cannot tell an outage from a quiet day.
 *
 * The two HARMFUL shapes above are hard failures with no allowlist, because
 * they actively mislead. This one is an allowlist that may only SHRINK: a new
 * page cannot join it, and removing a page from the list is enforced the moment
 * it is fixed. Delete entries as they are fixed; when the list is empty, delete
 * it and make the assertion absolute.
 */
const KNOWN_SILENT_READS: string[] = [
  "src/pages/admin/ads.tsx",
  "src/pages/admin/ai-models.tsx",
  "src/pages/admin/analytics.tsx",
  "src/pages/admin/authenticity.tsx",
  "src/pages/admin/brand-knowledge.tsx",
  "src/pages/admin/category-map.tsx",
  "src/pages/admin/claims.tsx",
  "src/pages/admin/growth/announcements.tsx",
  "src/pages/admin/growth/reward-north-star.tsx",
  "src/pages/admin/guarantee-pool.tsx",
  "src/pages/admin/jobs.tsx",
  "src/pages/admin/rate-limits.tsx",
  "src/pages/admin/system.tsx",
  "src/pages/admin/user-detail.tsx",
];

function listPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__") walk(p);
      } else if (e.name.endsWith(".tsx")) {
        out.push(p.split(sep).join("/"));
      }
    }
  };
  for (const r of ADMIN_ROOTS) walk(resolve(process.cwd(), r));
  return out.map((p) => p.slice(p.indexOf("src/")));
}

interface PageFacts {
  rel: string;
  usesQuery: boolean;
  rendersEmptyState: boolean;
  rendersErrorState: boolean;
  /**
   * A guard that treats "no data" as "still loading". react-query leaves `data`
   * undefined on an ERROR too, so this branch swallows the failure and renders
   * the loading skeleton forever unless an isError branch runs first.
   * growth/buyer.tsx had an error branch and still hit this, because it sat
   * BELOW the loading guard and was therefore unreachable.
   */
  loadingSwallowsError: boolean;
  /**
   * Does ANYTHING in the page react to a failed read? A `toast.error` inside a
   * mutation handler does not count — that reports a write the operator just
   * asked for, not a read that silently returned nothing.
   */
  surfacesReadFailure: boolean;
}

function factsFor(rel: string): PageFacts {
  const src = readFileSync(resolve(process.cwd(), rel), "utf8");
  return {
    rel,
    usesQuery: /\buseQuery\b|\buseInfiniteQuery\b/.test(src),
    rendersEmptyState: /<EmptyState\b|<ContentUnavailable/.test(src),
    rendersErrorState: /<ErrorState\b/.test(src),
    loadingSwallowsError: /isLoading\s*\|\|\s*!\s*\w/.test(src),
    surfacesReadFailure:
      /<ErrorState\b/.test(src) ||
      /\bisError\b/.test(src) ||
      /\bisLoadingError\b/.test(src) ||
      // A destructured `error` from useQuery, rendered as `{error ? …}` or
      // `{error && …}`. Deliberately NOT `json.error` / `err.message`, which are
      // queryFn plumbing and mutation toasts rather than a read-failure UI.
      /(^|[^.\w])error\s*(\?|&&)/m.test(src),
  };
}

describe("admin pages don't report a failed load as an empty one (US-2507)", () => {
  const pages = listPages().map(factsFor);

  it("found the admin pages to check", () => {
    // Guard the guard: a broken glob must fail loudly, not silently pass.
    expect(pages.length).toBeGreaterThan(50);
    expect(pages.some((p) => p.rel.endsWith("growth/quests.tsx"))).toBe(true);
  });

  it("every query-backed page with an EmptyState also renders an ErrorState", () => {
    const offenders = pages
      .filter((p) => p.usesQuery && p.rendersEmptyState && !p.rendersErrorState)
      .map((p) => p.rel);
    expect(
      offenders,
      "these render an empty state on a failed query — an outage reads as " +
        "'you have no data'. Add an <ErrorState onRetry={refetch}> branch " +
        "BEFORE the empty-state branch:\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });

  // The other half of the same defect: instead of claiming "no data", the page
  // never stops loading. Both come from forgetting that an errored react-query
  // leaves `data` undefined.
  it("no page treats 'no data' as 'still loading' without an error branch", () => {
    const offenders = pages
      .filter((p) => p.usesQuery && p.loadingSwallowsError && !p.rendersErrorState)
      .map((p) => p.rel);
    expect(
      offenders,
      "these guard on `isLoading || !data`, and react-query leaves `data` " +
        "undefined on an ERROR too — so a failed load renders the loading " +
        "skeleton forever. Add an <ErrorState> branch and put it FIRST:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  // The weakest form, and the last one: the page reacts to a failed read in no
  // way at all. Nothing claims "no data" and nothing spins — it just renders a
  // shell with holes in it, and the operator has no way to tell an outage from
  // a quiet day. A toast.error inside a mutation handler does not count; that
  // reports a write the operator asked for.
  it("no NEW page ignores a failed read, and the known list only shrinks", () => {
    const offenders = pages
      .filter((p) => p.usesQuery && !p.surfacesReadFailure)
      .map((p) => p.rel)
      .sort();

    const added = offenders.filter((f) => !KNOWN_SILENT_READS.includes(f));
    expect(
      added,
      "these are NEW pages that render nothing when a read fails — an outage " +
        "is indistinguishable from a quiet day. Add an " +
        "<ErrorState onRetry={refetch}> branch:\n  " + added.join("\n  "),
    ).toEqual([]);

    const fixed = KNOWN_SILENT_READS.filter((f) => !offenders.includes(f));
    expect(
      fixed,
      "these were fixed — delete them from KNOWN_SILENT_READS so the ratchet " +
        "keeps its grip:\n  " + fixed.join("\n  "),
    ).toEqual([]);
  });
});
