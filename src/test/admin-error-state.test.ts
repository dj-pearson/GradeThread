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
}

function factsFor(rel: string): PageFacts {
  const src = readFileSync(resolve(process.cwd(), rel), "utf8");
  return {
    rel,
    usesQuery: /\buseQuery\b|\buseInfiniteQuery\b/.test(src),
    rendersEmptyState: /<EmptyState\b|<ContentUnavailable/.test(src),
    rendersErrorState: /<ErrorState\b/.test(src),
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
});
