// US-2169: the row-cap contract, asserted rather than remembered.
//
// PostgREST clips any response at `db-max-rows` and reports it only in the
// Content-Range header, which supabase-js does not surface. So a read that
// exceeds the ceiling comes back SHORT, with no error, and renders as if it
// were complete. The two failure shapes this guards are the ones that already
// shipped in this repo:
//
//   1. a paging loop that advances by its PAGE SIZE and stops on a short page —
//      correct only while the ceiling is at least the page size, which nothing
//      here sets or verifies. Below that, the loop written to prevent silent
//      truncation truncates on its first request.
//   2. a fixed `.limit(N)` whose result is rendered as everything.
//
// Both are invisible in testing and in review: below the cap they behave
// perfectly, and above it they are wrong quietly. Hence a source-scan.

import { describe, it, expect } from "vitest";
import { SCAN_TIMEOUT_MS } from "@/lib/__tests__/_source-scan";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  fetchAllPages,
  fetchCapped,
  READ_PAGE_SIZE,
  ASSUMED_DB_MAX_ROWS,
  CAPPED_READ_LIMIT,
} from "@/lib/paged-read";

const SRC = resolve(process.cwd(), "src");

// US-2383: both the listing and the file CONTENTS are memoized per worker.
// Before this, sourceFiles() re-walked src/ and read() re-read every matched
// file on each of the two scanning tests — the same duplicate-read waste
// US-2129 removed from the other guards — and under a full parallel run that
// pushed each scan past vitest's 5000ms default. The pair of scanning tests
// below therefore also carry SCAN_TIMEOUT_MS. Neither change alters WHAT is
// scanned; a guard that quietly stopped covering files would be worse than the
// flake.
const textCache = new Map<string, string>();
const read = (p: string) => {
  const hit = textCache.get(p);
  if (hit !== undefined) return hit;
  const text = readFileSync(resolve(process.cwd(), p), "utf8");
  textCache.set(p, text);
  return text;
};

let cachedFiles: string[] | null = null;
function sourceFiles(): string[] {
  if (!cachedFiles) {
    cachedFiles = readdirSync(SRC, { recursive: true, encoding: "utf8" })
      .filter((p) => /\.tsx?$/.test(p))
      .filter((p) => !p.startsWith("test") && !p.includes("__tests__"))
      .map((p) => `src/${p.split("\\").join("/")}`);
  }
  return cachedFiles;
}

describe("the configured caps stay consistent (AC4)", () => {
  it("keeps the capped-read probe answerable by the server", () => {
    // fetchCapped asks for limit + 1 as its evidence that more rows exist. If
    // that number can be clipped by the server, "exactly at the cap" and "more
    // exists" become indistinguishable and the notice goes silent again.
    expect(CAPPED_READ_LIMIT + 1).toBeLessThanOrEqual(ASSUMED_DB_MAX_ROWS);
  });

  it("does not let the page size become a correctness dependency", () => {
    // READ_PAGE_SIZE is allowed to sit AT the assumed ceiling precisely because
    // fetchAllPages does not depend on it. This asserts the property that makes
    // that safe, so lowering the real cap costs round trips and nothing else.
    expect(READ_PAGE_SIZE).toBeLessThanOrEqual(ASSUMED_DB_MAX_ROWS);
  });
});

describe("fetchAllPages cannot be truncated by a server cap", () => {
  it("walks a catalog whose every response is clipped well below the page size", async () => {
    const CAP = 137; // an awkward number on purpose — nothing divides evenly
    const TOTAL = 1000;
    const catalog = Array.from({ length: TOTAL }, (_, i) => i);
    const seen: number[] = [];

    const all = await fetchAllPages<number>(async (from, to) => {
      seen.push(from);
      return catalog.slice(from, Math.min(to + 1, from + CAP));
    });

    expect(all).toEqual(catalog);
    // Advanced by rows RECEIVED. If it advanced by READ_PAGE_SIZE it would have
    // made exactly one request and returned 137 of 1000.
    expect(seen[1]).toBe(CAP);
  });

  it("stops on empty, not on short", async () => {
    let calls = 0;
    const all = await fetchAllPages<number>(async (from) => {
      calls++;
      return from === 0 ? [1, 2, 3] : [];
    });
    expect(all).toEqual([1, 2, 3]);
    expect(calls).toBe(2); // the confirming request is the point
  });

  it("lets an error through instead of returning a partial set", async () => {
    // A swallowed error is indistinguishable from the end of the data, which is
    // the same silent-shortfall failure by another route.
    await expect(
      fetchAllPages<number>(async () => {
        throw new Error("pg down");
      }),
    ).rejects.toThrow("pg down");
  });
});

describe("fetchCapped reports truncation as a fact", () => {
  it("asks for one row past the cap and hides the probe row", async () => {
    let asked = 0;
    const res = await fetchCapped<number>(async (limit) => {
      asked = limit;
      return Array.from({ length: limit }, (_, i) => i);
    }, 10);
    expect(asked).toBe(11);
    expect(res.rows).toHaveLength(10);
    expect(res.truncated).toBe(true);
    expect(res.limit).toBe(10);
  });

  it("is not truncated when the source has exactly the cap", async () => {
    const res = await fetchCapped<number>(
      async () => Array.from({ length: 10 }, (_, i) => i),
      10,
    );
    expect(res.rows).toHaveLength(10);
    expect(res.truncated).toBe(false);
  });

  it("is not truncated when the source has fewer", async () => {
    const res = await fetchCapped<number>(async () => [1, 2], 10);
    expect(res.truncated).toBe(false);
  });
});

describe("no surface reintroduces the stop-on-short-page loop", () => {
  it("has no hand-rolled paging loop outside the shared reader", () => {
    // The anti-pattern, verbatim from the two loops this story replaced:
    //   if (batch.length < CHUNK) break;
    // Anything that needs to page must call fetchAllPages, which owns the
    // stop-on-EMPTY rule in one place.
    const offenders = sourceFiles().filter((f) =>
      /\.length\s*<\s*[A-Z_a-z]+\s*\)\s*break/.test(read(f)),
    );
    expect(offenders).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("routes every .range() paging caller through the shared reader", () => {
    // A `.range(` on its own is fine — grid.tsx renders ONE server-side page
    // with a count, which is a different (and correct) shape. What must not
    // come back is a LOOP over .range() written by hand.
    const looping = sourceFiles().filter((f) => {
      const src = read(f);
      return /for\s*\([^)]*\)[^]{0,400}\.range\(/.test(src) && !src.includes("fetchAllPages");
    });
    expect(looping).toEqual([]);
  }, SCAN_TIMEOUT_MS);
});

describe("the capped surfaces tell the seller", () => {
  // US-3077 split two of these in half: the READ moved into a hook so the
  // overview widgets could count the same rows, while the page kept the
  // rendering. Both halves still have to hold, so each surface names the file
  // that caps and the file that says so, rather than assuming one file.
  const CAPPED: Array<{ reads: string; renders: string }> = [
    {
      reads: "src/hooks/use-autolister.ts",
      renders: "src/pages/flipdesk/autolister-drafts.tsx",
    },
    {
      reads: "src/hooks/use-scheduled-drops.ts",
      renders: "src/pages/flipdesk/scheduled-drops.tsx",
    },
  ];

  it.each(CAPPED)("$renders renders a truncation notice", ({ reads, renders }) => {
    expect(read(reads)).toContain("fetchCapped");
    // The read reporting truncation and nothing rendering it is the same
    // silence with extra steps.
    const src = read(renders);
    expect(src).toContain("TruncatedNotice");
    expect(src).toContain("truncated &&");
  });

  it("the reconcile link picker filters server-side and says when it capped", () => {
    // This one was worse than truncation: both predicates ran client-side over
    // whichever 200 rows were most recently updated, so a seller whose recent
    // touches were all photographed got an EMPTY picker while linkable items
    // existed. The cap was silently choosing the WRONG 200 rows.
    const src = read("src/pages/flipdesk/reconcile.tsx");
    expect(src).toContain('.eq("photo_count", 0)');
    expect(src).toContain('.in("status", [...LINKABLE_STATUSES])');
    expect(src).toContain("fetchCapped");
    // And an empty search result must not read as "you have no such item".
    expect(src).toContain("truncated &&");
  });
});
