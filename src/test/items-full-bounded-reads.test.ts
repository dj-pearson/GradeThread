// US-2167 AC5: no unbounded read of `items_full` can come back.
//
// `items_full` is the wide denormalized inventory view and the heaviest read in
// FlipDesk. Two separate things go wrong when one is issued with no bound, and
// the second is the one that matters:
//
//   1. cost — a seller's whole catalog crosses the wire to render 50 rows;
//   2. CORRECTNESS — PostgREST caps a response at its `db-max-rows` and reports
//      that ONLY in the Content-Range header. supabase-js raises no error, so an
//      over-cap seller receives a SHORT ARRAY that looks complete. Every surface
//      is then wrong in the same direction at once, with nothing signalling it.
//
// A source-scan guard is the right shape here, because the failure has no
// runtime symptom to assert against below the cap — which is exactly why the
// unbounded reads survived so long. It works by ENUMERATION, not by pattern:
// every call site is declared with the bound it carries, and the scan asserts
// the declared set is the whole set. A new read therefore fails this test until
// its author states which bound it has, rather than passing because it happened
// not to match a regex.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");

/** How the from() call reads at every site: `from("items_full")`,
 *  `)("items_full")`, `bind(supabase)("items_full")`. The type-position
 *  `name: "items_full",` annotations deliberately do not match. */
const FROM_CALL = '("items_full")';

interface DeclaredRead {
  readonly file: string;
  /** Why this read cannot be truncated. Every token must appear in the file. */
  readonly bounds: readonly string[];
  readonly why: string;
}

const DECLARED: readonly DeclaredRead[] = [
  {
    file: "src/hooks/use-items-full.ts",
    bounds: [".range(", ".maybeSingle()"],
    why: "the shared list read pages with .range(); useItemFull reads one row",
  },
  {
    file: "src/pages/flipdesk/grid.tsx",
    bounds: [".range(", 'count: "exact"'],
    why: "the grid renders one server-side page and gets its total from the count",
  },
  {
    file: "src/pages/flipdesk/reconcile.tsx",
    bounds: [".limit("],
    why: "the photo-less link picker asks for at most 200 candidates",
  },
  {
    // US-2173 AC2 moved the mutation handlers into their own module, and the
    // one direct from-call on this surface travelled with them. The
    // declaration follows the code rather than the filename, which is the
    // point of declaring by file: a move has to be restated, not inferred.
    file: "src/pages/flipdesk/listings-actions.ts",
    bounds: ['.in("id", ids)'],
    why:
      "US-2168 moved the main read to the flipdesk_listing_page RPC, which " +
      "returns ONE page; the only direct from-call left is the US-2172 undo, " +
      "bounded by the ids it is putting back",
  },
];

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((p) => /\.tsx?$/.test(p))
    // The guards themselves quote the call shape; scanning them would make this
    // test find itself.
    .filter((p) => !p.startsWith("test") && !p.includes("__tests__"))
    .map((p) => `src/${p.split("\\").join("/")}`);
}

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("every items_full read is bounded (US-2167)", () => {
  const sites = sourceFiles().filter((f) => read(f).includes(FROM_CALL));

  it("has no call site that isn't declared here", () => {
    // The whole guard rests on this one assertion. A new unbounded read fails
    // here, and the fix is to add it to DECLARED with the bound it carries —
    // which is the moment the author has to decide what that bound is.
    expect([...sites].sort()).toEqual(DECLARED.map((d) => d.file).sort());
  });

  it.each(DECLARED)("$file is bounded: $why", ({ file, bounds }) => {
    const src = read(file);
    for (const token of bounds) expect(src).toContain(token);
  });

  it("pages the shared read rather than trusting the server's cap", () => {
    const src = read("src/hooks/use-items-full.ts");
    // US-2169 moved the loop itself into src/lib/paged-read.ts, which owns the
    // stop-on-EMPTY / advance-by-received rule and is guarded by
    // src/test/row-cap-contract.test.ts. What matters here is that this file
    // uses that reader instead of hand-rolling a loop again.
    expect(src).toContain("fetchAllPages");
    expect(src).toContain("export async function fetchItemsPaged");
  });

  it("gets its rows from the server-side page, not from the whole tenant", () => {
    // This assertion is the INVERSE of the one it replaces. That one required
    // the page to use the shared paging loop, which was the best available
    // answer while the table still needed every row to filter and sort in the
    // browser. US-2168 AC3 removed that need: the tab predicate, search, Sold
    // window, advanced filter and sort all run in SQL now, so the page asks for
    // the fifty rows it draws instead of the account it belongs to.
    //
    // (The blocker recorded here for months — "scoreListability has no SQL
    // equivalent" — was simply untrue. Every input it reads is a column on
    // items_full.)
    // Two files now: the page runs the paged query, and listings-actions.ts
    // replays the SAME RPC to build the CSV export — an export that read the
    // rendered page instead would silently ship 50 rows of a 900-row account.
    const src =
      read("src/pages/flipdesk/listings.tsx") +
      read("src/pages/flipdesk/listings-actions.ts");
    expect(src).toContain('supabase.rpc("flipdesk_listing_page"');
    // No CALL to the whole-tenant loop, and no import of it. The name may still
    // appear in prose explaining what this replaced — that history is worth
    // keeping, so the assertion targets the call and the import, not the word.
    expect(src).not.toMatch(/fetchItemsPaged\s*[<(]/);
    expect(src).not.toMatch(/^import .*fetchItemsPaged/m);
    // Exactly ONE direct from-call is expected here — the US-2172 undo's
    // read-back, which is scoped to the ids it is restoring. A second one would
    // be a new tenant-wide read wearing the first one's declaration.
    expect(src.split(FROM_CALL).length - 1).toBe(1);
  });

  it("counts tab totals with a server-side aggregate, not loaded rows", () => {
    // The other half of the same problem: a count derived from a truncated
    // array is wrong in the same silent way. The tab badges read the grouped
    // count instead.
    const src = read("src/pages/flipdesk/listings.tsx");
    expect(src).toContain("useInventoryStatusCounts");
  });
});
