// US-2844: the comp condition sample store, write path.
//
// The two things this has to prove: a listing we have already paid to read
// never gets paid for twice, and nothing that identifies a seller, a listing or
// an image ever reaches the table.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  COMP_READS_TABLE,
  type CompReadClient,
  type CompReadRow,
  photoSetHash,
  recordCompReads,
  toCompReadRow,
} from "../lib/comp-reads.ts";

const input = (over: Record<string, unknown> = {}) => ({
  cellKey: "patagonia-better-sweater|11484|EBAY_US",
  photoSetHash: "abc123",
  readScore: 7.5,
  readConfidence: 0.82,
  imagesAnalyzed: 4,
  askingPriceCents: 4100,
  currency: "USD",
  stockRejected: false,
  stockReasons: [] as string[],
  ...over,
});

// ── the mapper ─────────────────────────────────────────────────────────────

Deno.test("the row carries the sample and nothing that identifies anybody", () => {
  const row = toCompReadRow(input());
  assertEquals(Object.keys(row).sort(), [
    "asking_price_cents",
    "cell_key",
    "currency",
    "images_analyzed",
    "photo_set_hash",
    "read_confidence",
    "read_score",
    "stock_reasons",
    "stock_rejected",
  ]);
  const serialized = JSON.stringify(row);
  for (const forbidden of ["seller", "listingId", "listing_id", "url", "title", "http"]) {
    assert(!serialized.includes(forbidden), `row leaked ${forbidden}`);
  }
});

Deno.test("a rejected read without a reason is refused here, not by a 23514 at 3am", () => {
  assertThrows(
    () => toCompReadRow(input({ stockRejected: true, stockReasons: [] })),
    Error,
    "stock_reasons",
  );
  // With a reason it is fine, and the score may be absent because we never scored it.
  const row = toCompReadRow(
    input({ stockRejected: true, stockReasons: ["cross_cell_hash"], readScore: null }),
  );
  assertEquals(row.stock_rejected, true);
  assertEquals(row.read_score, null);
});

Deno.test("a score outside the scale is refused, matching the table check", () => {
  assertThrows(() => toCompReadRow(input({ readScore: 10.5 })), Error, "read_score");
  assertThrows(() => toCompReadRow(input({ readScore: 0.5 })), Error, "read_score");
  assertThrows(() => toCompReadRow(input({ readConfidence: 1.4 })), Error, "read_confidence");
});

Deno.test("an empty cell key is refused: a sample nobody can find is not a sample", () => {
  assertThrows(() => toCompReadRow(input({ cellKey: "   " })), Error, "cell_key");
});

// ── the dedupe key ─────────────────────────────────────────────────────────

Deno.test("the photo set hash ignores photo ORDER, because sellers reshuffle galleries", async () => {
  const a = await photoSetHash(["h3", "h1", "h2"]);
  const b = await photoSetHash(["h1", "h2", "h3"]);
  assertEquals(a, b);
  const c = await photoSetHash(["h1", "h2"]);
  assert(c !== a, "a different set must hash differently");
});

Deno.test("the photo set hash is stable across calls and is not the raw hashes", async () => {
  const a = await photoSetHash(["h1", "h2"]);
  const b = await photoSetHash(["h1", "h2"]);
  assertEquals(a, b);
  assert(!a.includes("h1"));
  assertEquals(a.length, 64);
});

Deno.test("an empty photo set has no hash and says so", async () => {
  await assertRejects(() => photoSetHash([]), Error, "no photos");
});

// ── the no-op on a hash we already hold (AC4) ──────────────────────────────

/** A stand-in for supabase-js that remembers which hashes it already holds. */
function fakeClient(existing: string[] = []) {
  const held = new Set(existing);
  const calls: { onConflict: string; ignoreDuplicates: boolean; rows: number }[] = [];
  const client: CompReadClient = {
    from(table: string) {
      assertEquals(table, COMP_READS_TABLE);
      return {
        upsert(rows: CompReadRow[], opts: { onConflict: string; ignoreDuplicates: boolean }) {
          calls.push({ ...opts, rows: rows.length });
          const fresh = rows.filter((r) => !held.has(r.photo_set_hash));
          for (const r of fresh) held.add(r.photo_set_hash);
          return {
            select(_cols: string) {
              return Promise.resolve({ data: fresh, error: null });
            },
          };
        },
      };
    },
  };
  return { client, calls, held };
}

Deno.test("a hash we already hold is a no-op: nothing written, nothing thrown", async () => {
  const { client, calls } = fakeClient(["abc123"]);
  const r = await recordCompReads(client, [input()]);
  assertEquals(r.written, 0);
  assertEquals(r.skipped, 1);
  assertEquals(r.error, null);
  // The skip has to happen in the DB, not in our head: ask for it explicitly.
  assertEquals(calls[0].ignoreDuplicates, true);
  assertEquals(calls[0].onConflict, "photo_set_hash");
});

Deno.test("a fresh hash is written, and a mixed batch reports both halves", async () => {
  const { client, held } = fakeClient(["abc123"]);
  const r = await recordCompReads(client, [
    input(),
    input({ photoSetHash: "new1" }),
    input({ photoSetHash: "new2" }),
  ]);
  assertEquals(r.written, 2);
  assertEquals(r.skipped, 1);
  assert(held.has("new1") && held.has("new2"));
});

Deno.test("an empty batch does not touch the database at all", async () => {
  const { client, calls } = fakeClient();
  const r = await recordCompReads(client, []);
  assertEquals(r.written, 0);
  assertEquals(r.skipped, 0);
  assertEquals(calls.length, 0);
});

Deno.test("a database error is reported, not swallowed and not thrown", async () => {
  const client: CompReadClient = {
    from() {
      return {
        upsert() {
          return {
            select() {
              return Promise.resolve({ data: null, error: { message: "connection reset" } });
            },
          };
        },
      };
    },
  };
  const r = await recordCompReads(client, [input()]);
  assertEquals(r.written, 0);
  assertEquals(r.error, "connection reset");
});

// ── AC5: no image bytes, anywhere ──────────────────────────────────────────

Deno.test("AC5: neither the module nor the migration stores image bytes", async () => {
  const src = await Deno.readTextFile(new URL("../lib/comp-reads.ts", import.meta.url));
  // Uint8Array and crypto.subtle are deliberately NOT on this list. The module
  // hashes a joined string of photo hashes, so it handles bytes that are text,
  // never bytes that are an image. Banning the word would ban hashing itself
  // and would prove nothing about what gets stored.
  for (const forbidden of ["base64", "bytea", "blob", "imageBytes", "imageData", "dataUri", "data:image"]) {
    assert(!src.includes(forbidden), `comp-reads.ts mentions ${forbidden}`);
  }
  const sql = await Deno.readTextFile(
    new URL("../../../../supabase/migrations/00663_comp_condition_reads.sql", import.meta.url),
  );
  assert(!/\bbytea\b/i.test(sql), "the migration declares a bytea column");
  assert(!/\buser_id\b/i.test(sql), "the migration mentions user_id, which trips rls-guard discovery");
  assert(/insert into public\.applied_migrations \(version\) values \('00663'\)/.test(sql));
  // Regression guard, from a defect caught by running the SQL rather than
  // reading it: array_length('{}', 1) is NULL, and a CHECK that evaluates to
  // NULL passes. Without the coalesce the reason constraint accepted exactly
  // the row it exists to refuse.
  assert(
    /coalesce\(array_length\(stock_reasons, 1\), 0\)/.test(sql),
    "the reason constraint lost its coalesce and is inert again",
  );
});
