// US-1965: eBay order-sync backstop — owner-selection logic.
//
// selectBackstopOwners is the pure heart of the cron: it decides which tenants
// get a fresh incremental pull this tick (stalest-first, de-duped per owner,
// skipping the recently-synced, bounded to a batch). The route file imports the
// service-role supabase client transitively, so set dummy env BEFORE the
// dynamic import (same pattern as the other edge tests).
//   deno test --allow-env --allow-read src/tests/ebay-order-backstop_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { selectBackstopOwners, BACKSTOP_BATCH_SIZE, BACKSTOP_FRESH_WINDOW_MS } = await import(
  "../routes/jobs-ebay-order-backstop.ts"
);

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const FRESH = 15 * 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const opts = { nowMs: NOW, freshWindowMs: FRESH, batchSize: 25 };

Deno.test("never-synced connections (null cursor) are selected, stalest-first", () => {
  const owners = selectBackstopOwners(
    [
      { user_id: "b", last_synced_at: ago(60 * 60_000) }, // 1h ago
      { user_id: "a", last_synced_at: null }, // never synced
    ],
    opts,
  );
  assertEquals(owners, ["a", "b"]); // null sorts before the 1h-old cursor
});

Deno.test("owners synced within the fresh window are skipped", () => {
  const owners = selectBackstopOwners(
    [
      { user_id: "fresh", last_synced_at: ago(5 * 60_000) }, // 5 min ago → skip
      { user_id: "stale", last_synced_at: ago(2 * 60 * 60_000) }, // 2h ago → keep
    ],
    opts,
  );
  assertEquals(owners, ["stale"]);
});

Deno.test("de-dupes by owner keeping the STALEST connection cursor", () => {
  // Owner d has one stale + one fresh connection: the stale one wins, so d is
  // selected (a multi-account seller with any lagging connection gets swept).
  const owners = selectBackstopOwners(
    [
      { user_id: "d", last_synced_at: ago(3 * 60_000) }, // fresh
      { user_id: "d", last_synced_at: ago(2 * 60 * 60_000) }, // stale (wins)
    ],
    opts,
  );
  assertEquals(owners, ["d"]);
});

Deno.test("an owner whose only connections are ALL fresh is skipped", () => {
  const owners = selectBackstopOwners(
    [
      { user_id: "e", last_synced_at: ago(5 * 60_000) },
      { user_id: "e", last_synced_at: ago(3 * 60_000) },
    ],
    opts,
  );
  assertEquals(owners, []);
});

Deno.test("orders strictly stalest-first across owners", () => {
  const owners = selectBackstopOwners(
    [
      { user_id: "b", last_synced_at: ago(60 * 60_000) }, // 1h
      { user_id: "d", last_synced_at: ago(2 * 60 * 60_000) }, // 2h
      { user_id: "a", last_synced_at: null }, // never
    ],
    opts,
  );
  assertEquals(owners, ["a", "d", "b"]);
});

Deno.test("truncates to batchSize (stalest kept)", () => {
  const owners = selectBackstopOwners(
    [
      { user_id: "a", last_synced_at: null },
      { user_id: "d", last_synced_at: ago(2 * 60 * 60_000) },
      { user_id: "b", last_synced_at: ago(60 * 60_000) },
    ],
    { ...opts, batchSize: 2 },
  );
  assertEquals(owners, ["a", "d"]);
});

Deno.test("rows with no owner id are dropped", () => {
  const owners = selectBackstopOwners(
    [
      { user_id: null, last_synced_at: null },
      { user_id: "a", last_synced_at: null },
    ],
    opts,
  );
  assertEquals(owners, ["a"]);
});

Deno.test("an unparseable cursor is treated as never-synced (fail-safe: sweep it)", () => {
  const owners = selectBackstopOwners(
    [{ user_id: "x", last_synced_at: "not-a-date" }],
    opts,
  );
  assertEquals(owners, ["x"]);
});

Deno.test("boundary: a cursor exactly at the fresh window edge is treated as fresh (skipped)", () => {
  // Keep condition is `cursorMs < freshCutoff` (strictly older than the cutoff),
  // so a connection synced exactly freshWindowMs ago counts as fresh and is not
  // re-pulled; anything a hair older is swept.
  assertEquals(
    selectBackstopOwners([{ user_id: "edge", last_synced_at: ago(FRESH) }], opts),
    [],
  );
  assertEquals(
    selectBackstopOwners([{ user_id: "edge", last_synced_at: ago(FRESH + 1000) }], opts),
    ["edge"],
  );
});

Deno.test("constants are sane guardrails", () => {
  assert(BACKSTOP_BATCH_SIZE > 0 && BACKSTOP_BATCH_SIZE <= 100);
  assert(BACKSTOP_FRESH_WINDOW_MS >= 60_000);
});
