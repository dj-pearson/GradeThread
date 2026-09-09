import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, sep } from "node:path";

// US-3217. The FlipDesk half of US-2507.
//
// US-2507 built <ErrorState> / <QueryBoundary> and a source-scan guard so no
// ADMIN page can tell an operator "there is nothing here" when the truth is
// "the load failed". Its roots are src/pages/admin and src/pages/content only.
// FlipDesk, the surface sellers pay for, was never in scope, and it had every
// shape of the defect the admin guard was built to stop:
//
//   listings.tsx      a failed flipdesk_listing_page RPC read as
//                     "Nothing waiting to list"
//   expenses.tsx      a failed read read as "No expenses logged", with a CTA
//                     to start tracking overhead
//   sources.tsx       had an error branch, and printed the literal string
//                     "Failed to load sources: [object Object]", no retry
//   money-overview    every figure comes from one of six reads; a failure
//                     rendered "Profit, FY2026: $0.00 -- $0.00 came in" and
//                     "your books have nothing unexplained in them"
//   reconciliation    a failed sales read rendered "No discrepancies. Fees and
//                     shipping look clean."
//
// A wrong accounting figure is worse than no page. This guard is what stops
// the shape growing back.
//
// SHAPE B (`isLoading || !data` with no error branch) is deliberately NOT
// enforced here, unlike in the admin guard. That regex matches effect bodies
// (`if (isLoading || !item) return;`) and widget visibility guards
// (`if (isLoading || !poll) return null;`) as readily as render branches, and
// FlipDesk pages are full of both. All three current hits were checked by hand
// and all three are false positives.

// US-3237 widened this past FlipDesk. src/pages/admin and src/pages/content
// have their own guard (admin-error-state.test.ts); these are everything else a
// customer can reach. Kept as one file rather than three because the rules and
// the shrink-only list are the same.
const ROOTS = [
  "src/pages/flipdesk",
  "src/pages/buyer",
  "src/pages/fit",
  "src/pages/tools",
  "src/pages/TOP_LEVEL",
];

/**
 * Shape C ratchet: pages that react to a failed read in NO way at all. The
 * page renders a shell with holes in it and the seller cannot tell an outage
 * from a quiet day.
 *
 * SHRINK-ONLY, and it fails in BOTH directions on purpose -- a page fixed but
 * left on the list is as loud as a new offender. That is the only reason
 * US-2507's equivalent list went from nine to zero instead of becoming
 * furniture. Delete this constant and the test that reads it once it is empty.
 */
const READ_FAILURE_UNHANDLED = [
  "src/pages/flipdesk/analytics.tsx",
  "src/pages/flipdesk/composer.tsx",
];

/**
 * NOT offenders, with the reason. US-3250: a page can carry a query and still
 * be right to say nothing when it fails.
 *
 * money.tsx — its only query drives a BADGE COUNTER on a tab. Hiding a badge
 * when the count cannot be fetched is correct degradation, not a false claim:
 * nothing on screen asserts the books are clean, and the page's real content is
 * a nested router view that does its own reads. An ErrorState for a badge would
 * be noise, and padding a shrink-only list with cosmetic fixes is how it stops
 * meaning anything.
 */
const SILENCE_IS_CORRECT = ["src/pages/flipdesk/money.tsx"];

interface PageFacts {
  rel: string;
  usesQuery: boolean;
  rendersEmptyState: boolean;
  rendersErrorState: boolean;
  surfacesReadFailure: boolean;
}

function listPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string, recurse: boolean) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (recurse && e.name !== "__tests__") walk(p, true);
      } else if (e.name.endsWith(".tsx") && !e.name.endsWith(".test.tsx")) {
        out.push(p.split(sep).join("/"));
      }
    }
  };
  for (const r of ROOTS) {
    // The sentinel means "src/pages itself, no subdirectories" -- the
    // grading-side seller pages (submissions, billing, api-keys, settings).
    // Recursing there would swallow admin and content, which have their own
    // guard and their own shape of rule.
    if (r === "src/pages/TOP_LEVEL") walk(resolve(process.cwd(), "src/pages"), false);
    else walk(resolve(process.cwd(), r), true);
  }
  return out.map((p) => p.slice(p.indexOf("src/")));
}

function factsFor(rel: string): PageFacts {
  const src = readFileSync(resolve(process.cwd(), rel), "utf8");
  return {
    rel,
    usesQuery: /\buseQuery\b|\buseInfiniteQuery\b/.test(src),
    rendersEmptyState: /<EmptyState\b|<ContentUnavailable/.test(src),
    rendersErrorState: /<ErrorState\b/.test(src),
    surfacesReadFailure:
      /<ErrorState\b/.test(src) ||
      /\bisError\b/.test(src) ||
      /\bisLoadingError\b/.test(src) ||
      // A destructured `error` from useQuery, rendered as `{error ? …}` or
      // `{error && …}`. Deliberately NOT `json.error` / `err.message`, which
      // are queryFn plumbing and mutation toasts rather than a read-failure UI.
      /(^|[^.\w])error\s*(\?|&&)/m.test(src) ||
      // A page may DELEGATE its failure UI to a component rather than render
      // <ErrorState> inline — autolister-bulk-edit returns <DraftsFailed/>
      // after US-3250 moved its three early returns out to stay under the
      // file's line ceiling. Matching a rendered <…Error…/> or <…Failed…/>
      // element catches that. Deliberately NOT `if (error)`, which every
      // queryFn contains as `if (error) throw error` and which would make this
      // rule match almost everything.
      /<\w*(?:Error|Failed)\w*[\s/>]/.test(src),
  };
}

describe("customer pages don't report a failed load as an empty one (US-3217, US-3237)", () => {
  const pages = listPages().map(factsFor);

  it("found the pages to check", () => {
    // Guard the guard: a broken glob must fail loudly, not silently pass.
    expect(pages.length).toBeGreaterThan(90);
    expect(pages.filter((p) => p.usesQuery).length).toBeGreaterThan(25);
    expect(pages.some((p) => p.rel.endsWith("flipdesk/listings.tsx"))).toBe(true);
    expect(pages.some((p) => p.rel === "src/pages/api-keys.tsx")).toBe(true);
    expect(pages.some((p) => p.rel.startsWith("src/pages/fit/"))).toBe(true);
    // ...and NOT the trees that have their own guard.
    expect(pages.some((p) => p.rel.startsWith("src/pages/admin/"))).toBe(false);
    expect(pages.some((p) => p.rel.startsWith("src/pages/content/"))).toBe(false);
    // An exclusion for a file that no longer exists is a rename to notice, not
    // a free pass.
    const stale = SILENCE_IS_CORRECT.filter((rel) => !pages.some((p) => p.rel === rel));
    expect(stale, "excluded but missing: " + stale.join(", ")).toEqual([]);
  });

  it("every query-backed page with an EmptyState also renders an ErrorState", () => {
    const offenders = pages
      .filter((p) => p.usesQuery && p.rendersEmptyState && !p.rendersErrorState)
      .map((p) => p.rel)
      .sort();
    expect(
      offenders,
      "these render an empty state on a failed query — an outage reads as " +
        "'you have no data'. Add an <ErrorState onRetry={refetch}> branch " +
        "BEFORE the empty-state branch:\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });

  it("the unhandled-read-failure list only shrinks", () => {
    const actual = pages
      .filter((p) => p.usesQuery && !p.surfacesReadFailure)
      .filter((p) => !SILENCE_IS_CORRECT.includes(p.rel))
      .map((p) => p.rel)
      .sort();
    const allowed = [...READ_FAILURE_UNHANDLED].sort();

    const added = actual.filter((p) => !allowed.includes(p));
    expect(
      added,
      "these render nothing when a read fails — an outage is " +
        "indistinguishable from a quiet day. Add an " +
        "<ErrorState onRetry={refetch}> branch:\n  " + added.join("\n  "),
    ).toEqual([]);

    const fixed = allowed.filter((p) => !actual.includes(p));
    expect(
      fixed,
      "these now handle a failed read — delete them from " +
        "READ_FAILURE_UNHANDLED so the list keeps meaning something:\n  " +
        fixed.join("\n  "),
    ).toEqual([]);
  });
});
