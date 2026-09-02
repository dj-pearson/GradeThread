import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2204: the hot reads on the widest tables must project explicit columns.
//
// `select("*")` on submissions / inventory_items / grade_reports pulls every
// column of every row — including the wide JSON ones (raw_analysis,
// platform_fields, measurements) that no list view renders. The regression is
// silent: the page keeps working, it just transfers more and more as the row
// gets wider and the account grows. That is what makes a source-scan guard the
// right shape here — nothing at runtime ever complains.
//
// Two things this file deliberately does NOT assert:
//
//  - Count-only reads. `select("*", { count: "exact", head: true })` transfers
//    ZERO rows; the "*" is just PostgREST's count target. Flagging those is the
//    false positive the story calls out, so `head: true` is an explicit pass.
//  - Single-row detail reads and the merge/export paths. Those legitimately
//    want the whole row, and projecting them trades a real correctness risk for
//    no measurable win.
//
// The projection constants asserted below are the other half of the guarantee:
// each read types its rows as `Pick<Row, …>` of exactly those columns, so a cell
// reaching for a column the select stopped fetching fails `tsc` rather than
// rendering blank.

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), "utf8");
}

/**
 * Every `.select(...)` argument that follows a `.from("<table>")` in `src`.
 * Looks ahead a bounded window so a chained builder (filters between `from`
 * and `select` is not the house style, but `.select` is always close) is found
 * without walking into the next statement.
 */
function selectArgsFor(src: string, table: string): string[] {
  const args: string[] = [];
  const from = `from("${table}")`;
  let at = src.indexOf(from);
  while (at !== -1) {
    const window = src.slice(at, at + 400);
    const m = window.match(/\.select\(([\s\S]*?)\)\s*(?:[;.\n])/);
    if (m?.[1]) args.push(m[1]);
    at = src.indexOf(from, at + from.length);
  }
  return args;
}

// [file, table] pairs whose reads are on a hot path and must stay projected.
const PROJECTED_READS: ReadonlyArray<readonly [string, string]> = [
  ["src/pages/submissions.tsx", "submissions"],
  // US-2362: src/pages/inventory.tsx was DELETED. It was superseded by
  // /dashboard/flipdesk/inventory and its old route had been a <Navigate>
  // since the consolidation, so nothing could reach it. Its entries are
  // removed here rather than pointed at the replacement, because the FlipDesk
  // listings page is guarded by its own, stricter pair —
  // items-full-bounded-reads.test.ts and listings-page-scoped-reads.test.ts.
  // US-3075: the dashboard is a widget board now and reads nothing itself.
  // Its recent-submissions read moved to the widget, projection and all.
  ["src/components/dashboard/widgets/grading-recent-submissions.tsx", "submissions"],
  ["src/components/dashboard/widgets/grading-queue.tsx", "submissions"],
  ["src/components/dashboard/widgets/grading-attention.tsx", "submissions"],
  ["src/pages/new-submission.tsx", "inventory_items"],
  ["src/components/dashboard/grade-charts.tsx", "submissions"],
  ["src/components/dashboard/grade-charts.tsx", "grade_reports"],
];

// The projection constant each file must still define. If one of these is
// renamed away the read has almost certainly gone back to "*".
const PROJECTION_CONSTANTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["src/pages/submissions.tsx", ["SUBMISSION_LIST_COLUMNS"]],
  [
    "src/components/dashboard/widgets/grading-recent-submissions.tsx",
    ["RECENT_SUBMISSION_COLUMNS"],
  ],
  ["src/pages/new-submission.tsx", ["LINKABLE_ITEM_COLUMNS"]],
  [
    "src/components/dashboard/grade-charts.tsx",
    ["CHART_SUBMISSION_COLUMNS", "CHART_REPORT_COLUMNS"],
  ],
];

describe("hot reads project explicit columns (US-2204)", () => {
  for (const [file, table] of PROJECTED_READS) {
    it(`${file}: no row-fetching select("*") on ${table}`, () => {
      const args = selectArgsFor(source(file), table);
      // A rename or a moved query would silently empty this list and pass.
      expect(args.length, `no ${table} reads found in ${file}`).toBeGreaterThan(0);

      for (const arg of args) {
        if (!arg.includes('"*"')) continue;
        // The one allowed "*": a count with head:true, which fetches no rows.
        expect(
          arg.replace(/\s+/g, " "),
          `select("*") on ${table} in ${file} must be a head-only count`
        ).toContain("head: true");
      }
    });
  }

  for (const [file, constants] of PROJECTION_CONSTANTS) {
    it(`${file}: keeps its projection constant`, () => {
      const src = source(file);
      for (const name of constants) {
        expect(src, `${name} missing from ${file}`).toContain(`const ${name}`);
      }
    });
  }

  it("the CSV export selects only the columns it writes", () => {
    // The submissions export is unpaginated by design, so it is the single read
    // whose row width scales with the entire account.
    const src = source("src/pages/submissions.tsx");
    const at = src.indexOf("async function exportSubmissionsCsv");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 2000);
    expect(body).not.toContain('.select("*")');
    expect(body).toContain("garment_category");
  });
});
