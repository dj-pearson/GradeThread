// US-2927: the two rules that make the post-sale case store safe to poll into.
//
// 1. An upsert built from a SUMMARY must not erase a field a richer read
//    already stored. That is the whole reason toCaseRow drops `undefined` and
//    keeps `null` — the distinction is invisible in the SQL, so it is asserted
//    here instead.
// 2. An empty cache is NOT fresh. "We have no rows" and "this seller has no
//    open cases" are different claims and only eBay can tell them apart; a
//    freshness rule that conflated them would serve an empty Post-sale page to
//    a seller with three open returns.
import { assert, assertEquals, assertFalse } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  POST_SALE_FRESHNESS_MS,
  cancellationToCaseInput,
  disputeToCaseInput,
  isSummarySetFresh,
  returnToCaseInput,
  toCaseRow,
} = await import("../lib/post-sale-store.ts");

const NOW = "2026-08-26T12:00:00.000Z";

Deno.test("toCaseRow always writes the key columns", () => {
  const row = toCaseRow("u1", { caseType: "return", externalId: "r1" }, NOW);
  assertEquals(row.user_id, "u1");
  assertEquals(row.platform, "ebay");
  assertEquals(row.case_type, "return");
  assertEquals(row.external_id, "r1");
  assertEquals(row.last_seen_at, NOW);
});

Deno.test("toCaseRow OMITS an undefined field so an upsert cannot erase it", () => {
  // A summary that cannot carry respond_by leaves it undefined. If the row
  // carried `respond_by: null`, the upsert would wipe the deadline a detail
  // fetch had already stored — the exact bug this rule exists to prevent.
  const row = toCaseRow("u1", { caseType: "return", externalId: "r1" }, NOW);
  assertFalse("respond_by" in row);
  assertFalse("buyer_username" in row);
  assertFalse("amount_cents" in row);
});

Deno.test("toCaseRow WRITES an explicit null, because that is eBay saying there is none", () => {
  const row = toCaseRow(
    "u1",
    { caseType: "return", externalId: "r1", reason: null, itemExternalId: null },
    NOW,
  );
  assert("reason" in row);
  assertEquals(row.reason, null);
  assert("item_external_id" in row);
  assertEquals(row.item_external_id, null);
});

Deno.test("returnToCaseInput carries the summary through and closes on a terminal state", () => {
  const open = returnToCaseInput(
    {
      returnId: "r1",
      state: "RETURN_REQUESTED",
      orderId: null,
      itemId: "i1",
      reason: "NOT_AS_DESCRIBED",
      creationDate: "2026-08-20T00:00:00.000Z",
      respondBy: "2026-08-28T00:00:00.000Z",
      buyerUsername: "buyer_one",
    },
    NOW,
  );
  assertEquals(open.caseType, "return");
  assertEquals(open.externalId, "r1");
  assertEquals(open.itemExternalId, "i1");
  assertEquals(open.respondBy, "2026-08-28T00:00:00.000Z");
  assertEquals(open.closedAt, null);

  const closed = returnToCaseInput(
    {
      returnId: "r2",
      state: "CLOSED",
      orderId: null,
      itemId: null,
      reason: null,
      creationDate: null,
      respondBy: null,
      buyerUsername: null,
    },
    NOW,
  );
  assertEquals(closed.closedAt, NOW);
});

Deno.test("cancellationToCaseInput keeps requestorType reachable through raw", () => {
  const input = cancellationToCaseInput(
    {
      cancelId: "c1",
      state: "CANCEL_REQUESTED",
      orderId: "o1",
      reason: "BUYER_CHANGED_MIND",
      requestorType: "BUYER",
      creationDate: null,
    },
    NOW,
  );
  assertEquals(input.caseType, "cancellation");
  // requestorType has no column; the poll reads it back off `raw`, so the raw
  // payload has to be the whole summary rather than the projected columns.
  assertEquals((input.raw as { requestorType?: string }).requestorType, "BUYER");
});

Deno.test("disputeToCaseInput converts money to cents and keeps the deadline", () => {
  const input = disputeToCaseInput(
    {
      paymentDisputeId: "d1",
      orderId: "o1",
      status: "ACTION_NEEDED",
      reason: "ITEM_NOT_RECEIVED",
      amount: 42.55,
      currency: "USD",
      openedDate: "2026-08-20T00:00:00.000Z",
      respondByDate: "2026-08-30T00:00:00.000Z",
      buyerUsername: "buyer1",
    },
    NOW,
  );
  assertEquals(input.amountCents, 4255);
  assertEquals(input.currency, "USD");
  assertEquals(input.respondBy, "2026-08-30T00:00:00.000Z");
  assertEquals(input.closedAt, null);
});

Deno.test("an empty cache is never fresh", () => {
  assertFalse(isSummarySetFresh([], Date.parse(NOW)));
});

Deno.test("freshness is the OLDEST row, not the newest", () => {
  const nowMs = Date.parse(NOW);
  const recent = new Date(nowMs - 1000).toISOString();
  const stale = new Date(nowMs - POST_SALE_FRESHNESS_MS - 1000).toISOString();
  assert(isSummarySetFresh([{ last_seen_at: recent }], nowMs));
  assertFalse(isSummarySetFresh([{ last_seen_at: recent }, { last_seen_at: stale }], nowMs));
});

Deno.test("a row with no last_seen_at is never fresh", () => {
  assertFalse(isSummarySetFresh([{ last_seen_at: null }], Date.parse(NOW)));
  assertFalse(isSummarySetFresh([{ last_seen_at: "not a date" }], Date.parse(NOW)));
});
