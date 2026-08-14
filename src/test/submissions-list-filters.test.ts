import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sanitizeSearch, endOfDayIso } from "@/lib/search-filter";

// US-2544. The Submissions list wore a magnifying glass over two dropdowns and
// no search box, sorted without saying which way, showed an empty disputes
// table to every seller who had never filed one, and scrolled a five-column
// table sideways on a phone.

const PAGE = "src/pages/submissions.tsx";
function page(): string {
  return readFileSync(resolve(process.cwd(), PAGE), "utf8");
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

  it("ends a date range at the end of that day", () => {
    // .lte against a bare date compares to midnight, which drops everything
    // filed on the day the seller picked as the end of the range.
    expect(endOfDayIso("2026-08-14")).toBe("2026-08-14T23:59:59.999Z");
  });
});

describe("the list can be searched and dated (US-2544 AC2)", () => {
  it("has a real search field over title and brand", () => {
    const src = page();
    expect(src).toContain("<SearchInput");
    expect(src).toContain("title.ilike.%${term}%,brand.ilike.%${term}%");
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
    expect(src, "the helper is gone").toContain("const withSearchAndDates =");
    const calls = src.match(/= withSearchAndDates\(/g) ?? [];
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
    const src = page();
    expect(src).toContain("async function exportSubmissionsCsv(ids?: string[])");
    expect(src).toContain("exportSubmissionsCsv([...selected])");
  });

  it("the selected ids are chunked like every other id list here", () => {
    // A selection can span hundreds of rows; one .in() would overflow the URL.
    const src = page();
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
