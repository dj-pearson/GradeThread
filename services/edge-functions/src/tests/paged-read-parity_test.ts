// US-2387: the EDGE half of the paged-read contract, and its lockstep guard.
//
// lib/paged-read.ts mirrors src/lib/paged-read.ts because Deno and the SPA are
// separate projects that cannot import across each other. A comment saying
// "keep in lockstep" is not a mechanism — this repo has shipped a drifted
// mirror twice (US-1557, US-2041), which is why lockstep-registry.test.ts
// exists at all. So the behaviours are asserted here AND the constants are
// asserted against the web file's actual source.
//
// The behaviour that matters most is stop-on-EMPTY, not stop-on-short. That
// distinction is the entire reason this helper exists: a short page can mean
// the end of the data OR a server cap, and the client cannot tell them apart.
// The two web loops this replaced advanced by page size and broke on a short
// page, so the paging written to prevent silent truncation performed it.

import { assert, assertEquals } from "@std/assert";
import {
  ASSUMED_DB_MAX_ROWS,
  CAPPED_READ_LIMIT,
  fetchAllPages,
  fetchCapped,
  READ_PAGE_SIZE,
} from "../lib/paged-read.ts";

// ── fetchAllPages ────────────────────────────────────────────────────

Deno.test("US-2387: walks a set whose every response is clipped far below the page size", async () => {
  const CAP = 137; // awkward on purpose — nothing divides evenly
  const TOTAL = 1000;
  const catalog = Array.from({ length: TOTAL }, (_, i) => i);
  const seen: number[] = [];

  const all = await fetchAllPages<number>((from, to) => {
    seen.push(from);
    return Promise.resolve(catalog.slice(from, Math.min(to + 1, from + CAP)));
  });

  assertEquals(all, catalog);
  // Advanced by rows RECEIVED. Advancing by READ_PAGE_SIZE would have made one
  // request and returned 137 of 1000, reported as the whole set.
  assertEquals(seen[1], CAP);
});

Deno.test("US-2387: stops on EMPTY, not on short", async () => {
  let calls = 0;
  const all = await fetchAllPages<number>((from) => {
    calls++;
    return Promise.resolve(from === 0 ? [1, 2, 3] : []);
  });
  assertEquals(all, [1, 2, 3]);
  // The confirming request IS the contract. Without it, a first page shorter
  // than the page size would be read as the end.
  assertEquals(calls, 2);
});

Deno.test("US-2387: an error propagates instead of becoming a partial set", async () => {
  // A swallowed error is indistinguishable from the end of the data — on the
  // edge that is a sweep deciding there is no work to do.
  let threw = false;
  try {
    await fetchAllPages<number>(() => Promise.reject(new Error("pg down")));
  } catch (e) {
    threw = true;
    assertEquals((e as Error).message, "pg down");
  }
  assert(threw, "fetchAllPages must not absorb a failing page");
});

// ── fetchCapped ──────────────────────────────────────────────────────

Deno.test("US-2387: asks for one row past the cap and hides the probe row", async () => {
  let asked = 0;
  const res = await fetchCapped<number>((limit) => {
    asked = limit;
    return Promise.resolve(Array.from({ length: limit }, (_, i) => i));
  }, 10);
  assertEquals(asked, 11);
  assertEquals(res.rows.length, 10);
  assertEquals(res.truncated, true);
  assertEquals(res.limit, 10);
});

Deno.test("US-2387: exactly at the cap is NOT truncated", async () => {
  const res = await fetchCapped<number>(
    () => Promise.resolve(Array.from({ length: 10 }, (_, i) => i)),
    10,
  );
  assertEquals(res.rows.length, 10);
  assertEquals(res.truncated, false);
});

Deno.test("US-2387: the capped probe stays answerable by the server", () => {
  // fetchCapped asks for limit + 1 as its evidence. If that number can itself
  // be clipped, "exactly at the cap" and "more exists" become indistinguishable
  // and the truncation flag goes silently wrong.
  assert(CAPPED_READ_LIMIT + 1 <= ASSUMED_DB_MAX_ROWS);
  // READ_PAGE_SIZE may sit AT the ceiling precisely because fetchAllPages does
  // not depend on it — lowering the real cap costs round trips and nothing else.
  assert(READ_PAGE_SIZE <= ASSUMED_DB_MAX_ROWS);
});

// ── the mirror itself ────────────────────────────────────────────────

Deno.test("US-2387: the edge constants match the web file's, read from its source", async () => {
  const web = await Deno.readTextFile(
    new URL("../../../../src/lib/paged-read.ts", import.meta.url),
  );
  const num = (name: string): number => {
    const m = new RegExp(`export const ${name} = (\\d+);`).exec(web);
    assert(m, `web paged-read.ts no longer declares ${name}`);
    return Number(m[1]);
  };
  assertEquals(num("READ_PAGE_SIZE"), READ_PAGE_SIZE);
  assertEquals(num("ASSUMED_DB_MAX_ROWS"), ASSUMED_DB_MAX_ROWS);
  assertEquals(num("CAPPED_READ_LIMIT"), CAPPED_READ_LIMIT);
});

Deno.test("US-2387: the web half still stops on empty, not on short", async () => {
  // The behaviour cannot be imported across projects, so assert the line that
  // carries it. If someone 'optimises' the web loop back to breaking on a short
  // page, this fails here rather than in production six months later.
  const web = await Deno.readTextFile(
    new URL("../../../../src/lib/paged-read.ts", import.meta.url),
  );
  assert(
    web.includes("if (batch.length === 0) break;"),
    "web fetchAllPages no longer stops on an EMPTY page",
  );
  assert(
    web.includes("from += batch.length;"),
    "web fetchAllPages no longer advances by rows RECEIVED",
  );
});
