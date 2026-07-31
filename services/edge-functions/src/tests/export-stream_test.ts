// US-2030: bounded-memory GDPR export — paging + progressive JSON.
//
// The failure being prevented is an OOM that only appears at the account size
// where it matters, so the interesting cases are the boundaries: an exact
// multiple of the page size, a short final page, an empty table, and a mid-page
// error. All are pure and testable without a DB.
//
//   deno test --allow-env src/tests/export-stream_test.ts

import { assertEquals, assertRejects } from "@std/assert";

const { pageThrough, streamJsonArrayMembers, EXPORT_PAGE_SIZE } = await import(
  "../lib/export-stream.ts"
);

/** A fake table of `total` rows that answers range queries. */
function fakeTable(total: number, calls: Array<[number, number]> = []) {
  return (from: number, to: number) => {
    calls.push([from, to]);
    const rows = [];
    for (let i = from; i <= to && i < total; i++) rows.push({ i });
    return Promise.resolve({ data: rows });
  };
}

async function collect(gen: AsyncGenerator<unknown[]>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const page of gen) out.push(...page);
  return out;
}

Deno.test("pages through a table larger than one page", async () => {
  const calls: Array<[number, number]> = [];
  const rows = await collect(pageThrough(fakeTable(25, calls), 10));
  assertEquals(rows.length, 25);
  assertEquals(calls, [[0, 9], [10, 19], [20, 29]]);
});

// The boundary that catches an off-by-one: with total EXACTLY a multiple of the
// page size, the last full page cannot be distinguished from "there may be
// more", so one extra (empty) query is correct and must terminate.
Deno.test("terminates cleanly when the row count is an exact multiple", async () => {
  const calls: Array<[number, number]> = [];
  const rows = await collect(pageThrough(fakeTable(20, calls), 10));
  assertEquals(rows.length, 20);
  assertEquals(calls.length, 3, "expected a final empty page to prove exhaustion");
});

Deno.test("a short first page ends after ONE query", async () => {
  const calls: Array<[number, number]> = [];
  const rows = await collect(pageThrough(fakeTable(3, calls), 10));
  assertEquals(rows.length, 3);
  assertEquals(calls.length, 1, "a short page is unambiguous — no second round trip");
});

Deno.test("an empty table yields nothing and queries once", async () => {
  const calls: Array<[number, number]> = [];
  const rows = await collect(pageThrough(fakeTable(0, calls), 10));
  assertEquals(rows, []);
  assertEquals(calls.length, 1);
});

// A silently short export is the worst outcome: the subject receives a file
// that LOOKS complete and is not — a compliance failure disguised as success.
Deno.test("a page error THROWS rather than truncating the export", async () => {
  const failing = (from: number) =>
    from === 0
      ? Promise.resolve({ data: [{ i: 0 }, { i: 1 }] })
      : Promise.resolve({ data: null, error: new Error("connection reset") });
  await assertRejects(
    () => collect(pageThrough(failing, 2)),
    Error,
    "connection reset",
  );
});

// ── progressive JSON array serialisation ────────────────────────────

async function joined(total: number, pageSize: number): Promise<string> {
  let s = "";
  for await (const chunk of streamJsonArrayMembers(pageThrough(fakeTable(total), pageSize))) {
    s += chunk;
  }
  return s;
}

Deno.test("emits valid JSON array members across page boundaries", async () => {
  // Parsing it back is the real assertion — comma placement is exactly the kind
  // of thing that looks right and produces invalid JSON only when non-empty.
  const body = await joined(25, 10);
  const parsed = JSON.parse("[" + body + "]");
  assertEquals(parsed.length, 25);
  assertEquals(parsed[0], { i: 0 });
  assertEquals(parsed[24], { i: 24 });
});

Deno.test("an empty result emits NOTHING, so [] stays valid", async () => {
  const body = await joined(0, 10);
  assertEquals(body, "");
  assertEquals(JSON.parse("[" + body + "]"), []);
});

Deno.test("a single row emits no leading comma", async () => {
  const body = await joined(1, 10);
  assertEquals(body.startsWith(","), false);
  assertEquals(JSON.parse("[" + body + "]").length, 1);
});

Deno.test("the default page size is a sane bound", () => {
  assertEquals(EXPORT_PAGE_SIZE > 0 && EXPORT_PAGE_SIZE <= 1000, true);
});

// ── AC3: the heavy account ───────────────────────────────────────────
//
// "Test against a seeded heavy account — the failure mode only appears at the
// size where it matters." There is no seeded heavy account to point at, and
// waiting for one would leave the AC open forever. So these assert the PROPERTY
// that a heavy account would have exposed, at heavy-account scale, without one.
//
// The OOM this story exists to prevent came from holding an entire table in
// memory at once. In a pull-based pipeline the thing that guarantees bounded
// memory is LAZINESS: page k+1 must not be fetched until page k has been fully
// consumed, so at most one page is ever live no matter how big the account is.
// That is deterministic and checkable — unlike measuring RSS, which is noisy
// and would make this suite flaky.

/**
 * A fake table that also tracks how many pages are IN FLIGHT: handed to the
 * consumer but not yet fully drained. Peak in-flight is the memory bound.
 */
function trackedTable(total: number, pageSize: number) {
  const state = { fetched: 0, emitted: 0, peakInFlight: 0 };
  const fetch = (from: number, to: number) => {
    state.fetched++;
    const inFlight = state.fetched - Math.floor(state.emitted / pageSize);
    if (inFlight > state.peakInFlight) state.peakInFlight = inFlight;
    const rows = [];
    for (let i = from; i <= to && i < total; i++) rows.push({ i });
    return Promise.resolve({ data: rows });
  };
  return { state, fetch };
}

Deno.test("AC3: at heavy-account scale, only one page is ever in flight", async () => {
  // 100k rows at the real page size = 200 round trips. The old code held all
  // 100k at once; this must hold ~500 regardless of the total.
  const total = 100_000;
  const { state, fetch } = trackedTable(total, EXPORT_PAGE_SIZE);
  let seen = 0;
  for await (const page of pageThrough(fetch, EXPORT_PAGE_SIZE)) {
    seen += page.length;
    state.emitted = seen;
    // The page the consumer holds is bounded by the page size, not the account.
    assertEquals(page.length <= EXPORT_PAGE_SIZE, true);
  }
  assertEquals(seen, total);
  // 200 full pages plus the one empty page that proves the end — 100k is an
  // exact multiple of the page size, the boundary the earlier test pins. A full
  // last page is indistinguishable from "there may be more", so the extra round
  // trip is the deliberate cost of never truncating.
  assertEquals(state.fetched, total / EXPORT_PAGE_SIZE + 1);
  // THE ASSERTION THAT MATTERS: peak concurrent pages is 1, so peak memory is
  // one page — the same for a 100-row account and a 100,000-row one.
  assertEquals(state.peakInFlight, 1);
});

Deno.test("AC3: the generator is lazy — no page is fetched ahead of demand", async () => {
  // Laziness is what makes the bound above hold. If pageThrough ever eagerly
  // prefetched (or was rewritten to collect first), peak memory would scale
  // with the account again and every other test here would still pass.
  const { state, fetch } = trackedTable(10_000, EXPORT_PAGE_SIZE);
  const gen = pageThrough(fetch, EXPORT_PAGE_SIZE);
  assertEquals(state.fetched, 0, "constructing the generator must fetch nothing");
  await gen.next();
  assertEquals(state.fetched, 1, "one page consumed must cost exactly one query");
  await gen.next();
  assertEquals(state.fetched, 2);
  await gen.return(undefined);
  assertEquals(state.fetched, 2, "abandoning the export must not keep fetching");
});

Deno.test("AC3: a heavy account still serialises to ONE valid JSON document", async () => {
  // The comma-placement bug is invisible on a small account and produces an
  // unparseable multi-megabyte file on a large one — the failure mode this AC
  // is really about. Assembled the same way the route assembles it.
  const total = 25_000;
  let body = "";
  for await (
    const chunk of streamJsonArrayMembers(
      pageThrough(fakeTable(total), EXPORT_PAGE_SIZE),
    )
  ) {
    body += chunk;
  }
  const envelope = JSON.parse(`{"sales":[${body}]}`) as { sales: Array<{ i: number }> };
  assertEquals(envelope.sales.length, total);
  // Order must survive paging — an export that silently reorders or drops a
  // page in the middle is the compliance failure, not the crash.
  assertEquals(envelope.sales[0].i, 0);
  assertEquals(envelope.sales[EXPORT_PAGE_SIZE].i, EXPORT_PAGE_SIZE);
  assertEquals(envelope.sales[total - 1].i, total - 1);
});

Deno.test("AC3: a failure deep in a heavy export rejects, never truncates", async () => {
  // On a big account a mid-export failure is far more likely than on a small
  // one, and returning the pages collected so far would hand the subject a file
  // that looks complete. It must throw.
  const failAt = 50 * EXPORT_PAGE_SIZE;
  const flaky = (from: number, to: number) => {
    if (from >= failAt) {
      return Promise.resolve({ data: null, error: new Error("statement timeout") });
    }
    const rows = [];
    for (let i = from; i <= to; i++) rows.push({ i });
    return Promise.resolve({ data: rows });
  };
  await assertRejects(
    () => collect(pageThrough(flaky, EXPORT_PAGE_SIZE)),
    Error,
    "statement timeout",
  );
});
