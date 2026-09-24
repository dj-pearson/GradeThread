import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sanitizeSearch } from "@/lib/search-filter";

// US-2544. The Submissions list wore a magnifying glass over two dropdowns and
// no search box, sorted without saying which way, showed an empty disputes
// table to every seller who had never filed one, and scrolled a five-column
// table sideways on a phone.

const PAGE = "src/pages/submissions.tsx";
function page(): string {
  return readFileSync(resolve(process.cwd(), PAGE), "utf8");
}
// SUB-07: the filters and the CSV export moved out of the page so the list's
// two sort branches and the export share one set of predicates.
const QUERY = "src/lib/submission-list-query.ts";
const EXPORT = "src/lib/submissions-export.ts";
function lib(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("search term sanitizing (US-2544)", () => {
  it("strips the characters PostgREST .or() reads as syntax", () => {
    // Left in, these do not narrow the search - they change what is parsed.
    expect(sanitizeSearch("levi's, vintage")).toBe("levi's  vintage");
    expect(sanitizeSearch("jacket (blue)")).toBe("jacket  blue");
    expect(sanitizeSearch("*")).toBe("");
  });

  it("leaves an ordinary term alone", () => {
    expect(sanitizeSearch("  Carhartt  ")).toBe("Carhartt");
    expect(sanitizeSearch("size 32x34")).toBe("size 32x34");
  });

  // SUB-08: the date bounds moved to local days; see search-filter-local-days.test.ts.
});

describe("the list can be searched and dated (US-2544 AC2)", () => {
  it("has a real search field over title and brand", () => {
    const src = page();
    expect(src).toContain("<SearchInput");
    expect(lib(QUERY)).toContain("title.ilike.%${term}%,brand.ilike.%${term}%");
  });

  it("debounces rather than querying every keystroke", () => {
    const src = page();
    expect(src).toMatch(/setSearchDraft/);
    expect(src, "no debounce timer").toMatch(/setTimeout\(\s*\(\)\s*=>\s*\{[\s\S]{0,120}setSearch\(searchDraft\)/);
  });

  it("filters BOTH sort branches, not just the default one", () => {
    // The score branch is a separate query. A filter applied to only one of
    // them changes the result set when you click a column header, which is the
    // kind of bug nobody reports because it looks like the data changed.
    const src = page();
    expect(lib(QUERY), "the helper is gone").toContain(
      "export function applySubmissionFilters",
    );
    const calls = src.match(/= applySubmissionFilters\(/g) ?? [];
    expect(calls.length, "expected one call per sort branch").toBe(2);
  });

  it("carries the search and the dates in the query key", () => {
    // Without this react-query serves the previous filter's cached page.
    const src = page();
    const key = /queryKey: \[([\s\S]*?)\]/.exec(src);
    expect(key).not.toBeNull();
    for (const part of ["search", "dateFrom", "dateTo"]) {
      expect(key![1], `${part} missing from the query key`).toContain(part);
    }
  });
});

describe("sort direction is visible (US-2544 AC2)", () => {
  it("the active column shows which way it is sorted", () => {
    const src = page();
    expect(src).toContain("<SortIcon field=");
    expect(src, "still a static ArrowUpDown on both headers").toMatch(
      /sortDirection === "asc" \? \(\s*<ArrowUp/,
    );
  });

  it("and says so to a screen reader", () => {
    const src = page();
    expect(src).toContain('aria-sort={ariaSortFor("overall_score")}');
    expect(src).toContain('aria-sort={ariaSortFor("created_at")}');
  });
});

describe("disputes collapse when there are none (US-2544 AC3)", () => {
  it("no full empty state for a seller who never filed one", () => {
    const src = page();
    expect(src, "the card-sized empty state is back").not.toMatch(
      /title="No disputes filed"/,
    );
    expect(src).toContain("No disputes filed. You can dispute a grade");
  });

  it("a dispute load FAILURE still says so", () => {
    // Collapsing on empty must not collapse on error - that would turn an
    // outage into "you have no disputes", which is a lie about the user's data.
    const src = page();
    expect(src).toContain("!disputesError && !disputesLoading && myDisputes.length === 0");
    expect(src).toContain('title="Couldn\'t load disputes"');
  });
});

describe("rows are selectable and exportable (US-2544 AC4)", () => {
  it("the export takes an optional id list", () => {
    expect(lib(EXPORT)).toContain("export async function exportSubmissionsCsv(");
    expect(lib(EXPORT)).toContain("ids?: string[];");
    expect(page()).toMatch(/exportSubmissionsCsv\(ownerId!, \{\s*ids: \[\.\.\.selected\],/);
  });

  it("the selected ids are chunked like every other id list here", () => {
    // A selection can span hundreds of rows; one .in() would overflow the URL.
    const src = lib(EXPORT);
    const chunked = /if \(ids\) \{[\s\S]{0,200}fetchInChunks/.test(src);
    expect(chunked, "selected-id export is not chunked").toBe(true);
  });

  it("select-all covers the page, and selection survives paging", () => {
    const src = page();
    expect(src).toContain("allOnPageSelected");
    expect(src, "selection must not be cleared by setPage").not.toMatch(
      /setPage\([^)]*\);\s*setSelected\(new Set\(\)\)/,
    );
  });
});

describe("the table has a phone layout (US-2544 AC5)", () => {
  it("cards under md, table from md up", () => {
    const src = page();
    expect(src).toMatch(/className="space-y-2 md:hidden"/);
    expect(src).toContain('className="hidden overflow-x-auto md:block"');
  });

  it("the card shows the grade, not just the title", () => {
    // The grade is the column a seller opens this page for, and it was the one
    // pushed off-screen by the horizontal scroll.
    const src = page();
    const cards = src.slice(src.indexOf('className="space-y-2 md:hidden"'));
    const card = cards.slice(0, cards.indexOf('className="hidden overflow-x-auto md:block"'));
    expect(card).toContain("<ScoreBandIcon");
    expect(card).toContain("getStatusBadgeClasses");
  });
});

describe("the search guard is shared, not copied (US-2544)", () => {
  it("admin users reads it from lib rather than defining its own", () => {
    const src = readFileSync(resolve(process.cwd(), "src/pages/admin/users.tsx"), "utf8");
    expect(src).toContain('from "@/lib/search-filter"');
    expect(src, "a second local copy has appeared").not.toContain(
      "function sanitizeSearch",
    );
  });
});

describe("every read is scoped to the effective owner (SUB-01)", () => {
  // RLS unions own rows, member workspaces and, for an admin, every seller.
  // Leaning on it alone showed admins the whole platform in their list, count,
  // CSV and My Disputes. Each from() below must name the owner explicitly.
  it("each submissions/disputes read carries .eq(\"user_id\", ownerId)", () => {
    let total = 0;
    for (const src of [page(), lib(EXPORT)]) {
      const reads = [...src.matchAll(/\.from\("(submissions|disputes)"\)/g)];
      total += reads.length;
      for (const m of reads) {
        const window = src.slice(m.index!, m.index! + 260);
        expect(window, `unscoped ${m[1]} read at offset ${m.index}`).toMatch(
          /\.eq\("user_id", ownerId!?\)/,
        );
      }
    }
    // Two list branches, My Disputes, and the export's two reads.
    expect(total).toBeGreaterThanOrEqual(5);
  });

  it("the owner comes from the active workspace, and keys carry it", () => {
    const src = page();
    expect(src).toContain("s.activeWorkspaceOwnerId ?? s.user?.id");
    expect(src).toMatch(/queryKey: \[\s*"submissions",\s*ownerId,/);
    expect(src).toContain('queryKey: ["my-disputes", ownerId]');
  });
});

describe("grades show on every row that has one (SUB-06)", () => {
  it("both sort branches pass every row id to fetchGradeMap", () => {
    const src = page();
    const calls = [...src.matchAll(/await fetchGradeMap\(([^;]*)\);/g)].map((m) =>
      (m[1] ?? "").replace(/\s+/g, ""),
    );
    expect(calls).toEqual(["rows.map((s)=>s.id)", "submissionRows.map((s)=>s.id)"]);
    expect(src, "a status filter crept back in").not.toMatch(
      /fetchGradeMap\(\s*submissionRows\.filter/,
    );
  });

  it("a pending_review score is labelled Preliminary", () => {
    const src = page();
    expect((src.match(/sub\.status === "pending_review" && \(\s*<PreliminaryLabel \/>/g) ?? []).length).toBe(2);
  });

  it("paging keeps the table mounted, within one owner only", () => {
    const src = page();
    expect(src).toContain("prevQuery?.queryKey[1] === ownerId ? keepPreviousData(prev) : undefined");
    expect(src).toContain("isFetching && isPlaceholderData");
  });
});
