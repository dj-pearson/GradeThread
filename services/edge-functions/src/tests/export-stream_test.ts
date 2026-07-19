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
