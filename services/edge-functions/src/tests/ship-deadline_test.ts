// US-3189: the ship-by deadline, and the two ways it is allowed to be absent.
import { assertEquals } from "@std/assert";
import {
  MAX_HANDLING_DAYS,
  normalizeHandlingDays,
  resolveShipBy,
  resolveShippedAt,
} from "../lib/ship-deadline.ts";

Deno.test("resolveShipBy: eBay's own date wins over the derived one", () => {
  // A handling time that would derive a LATER date is deliberately supplied:
  // eBay has already resolved business days and the site cutoff, and our
  // arithmetic must never override that answer.
  const got = resolveShipBy({
    shipByDate: "2026-09-10T23:59:59.000Z",
    soldAt: "2026-09-01T12:00:00.000Z",
    handlingDays: 30,
  });
  assertEquals(got, "2026-09-10T23:59:59.000Z");
});

Deno.test("resolveShipBy: derives from sold_at + handling_days when eBay gave none", () => {
  const got = resolveShipBy({
    shipByDate: null,
    soldAt: "2026-09-01T12:00:00.000Z",
    handlingDays: 3,
  });
  assertEquals(got, "2026-09-04T12:00:00.000Z");
});

Deno.test("resolveShipBy: same-day handling means the deadline is the sale", () => {
  // Zero is a real handling time, not a missing one, so it must not fall
  // through to null the way an absent value does.
  const got = resolveShipBy({
    shipByDate: null,
    soldAt: "2026-09-01T12:00:00.000Z",
    handlingDays: 0,
  });
  assertEquals(got, "2026-09-01T12:00:00.000Z");
});

Deno.test("resolveShipBy: null when handling_days is unknown", () => {
  assertEquals(
    resolveShipBy({ shipByDate: null, soldAt: "2026-09-01T12:00:00.000Z", handlingDays: null }),
    null,
  );
});

Deno.test("resolveShipBy: null when there is no sale date to count from", () => {
  assertEquals(
    resolveShipBy({ shipByDate: null, soldAt: null, handlingDays: 3 }),
    null,
  );
});

Deno.test("resolveShipBy: null on both inputs missing — never a default deadline", () => {
  assertEquals(resolveShipBy({}), null);
});

Deno.test("resolveShipBy: an unparseable eBay date falls through to the derivation", () => {
  // A malformed date must not become the deadline, and must not suppress the
  // fallback either — that combination would silently drop the order out of
  // the Ship queue.
  const got = resolveShipBy({
    shipByDate: "not a date",
    soldAt: "2026-09-01T12:00:00.000Z",
    handlingDays: 2,
  });
  assertEquals(got, "2026-09-03T12:00:00.000Z");
});

Deno.test("resolveShipBy: an implausible handling time is not a deadline", () => {
  // A parse artefact landing in this field would otherwise sort a live order to
  // the bottom of the queue for years.
  assertEquals(
    resolveShipBy({
      shipByDate: null,
      soldAt: "2026-09-01T12:00:00.000Z",
      handlingDays: MAX_HANDLING_DAYS + 1,
    }),
    null,
  );
  assertEquals(
    resolveShipBy({ shipByDate: null, soldAt: "2026-09-01T12:00:00.000Z", handlingDays: -1 }),
    null,
  );
});

Deno.test("normalizeHandlingDays: whole days in range, else null", () => {
  assertEquals(normalizeHandlingDays(1), 1);
  assertEquals(normalizeHandlingDays("2"), 2);
  assertEquals(normalizeHandlingDays(1.4), 1);
  assertEquals(normalizeHandlingDays(0), 0);
  assertEquals(normalizeHandlingDays(MAX_HANDLING_DAYS), MAX_HANDLING_DAYS);
  assertEquals(normalizeHandlingDays(MAX_HANDLING_DAYS + 1), null);
  assertEquals(normalizeHandlingDays(-3), null);
  assertEquals(normalizeHandlingDays("soon"), null);
  assertEquals(normalizeHandlingDays(null), null);
  assertEquals(normalizeHandlingDays(undefined), null);
});

// ── US-268: the sale upsert the ship-by write rides on stays tenant-scoped ──
//
// The order-sync update is not reachable as a route, so there is no HTTP case
// for it in tenant-isolation_test.ts. What CAN regress is the predicate itself:
// somebody adds a field to salePayload, reformats the call, and the second lock
// goes with it. This pins the predicate to the source.
Deno.test("US-3189: the order-sync sales update filters by user_id, not id alone", async () => {
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-ebay.ts", import.meta.url),
  );
  const call = src.match(
    /\.from\("sales"\)\s*\n\s*\.update\(salePayload\)[\s\S]{0,240}?;/,
  );
  if (!call) {
    throw new Error(
      "the order-sync sales update was not found — if it moved, move this assertion with it",
    );
  }
  const text = call[0];
  if (!text.includes('.eq("user_id", userId)')) {
    throw new Error(
      'the order-sync sales update lost its .eq("user_id", userId) predicate:\n' + text,
    );
  }
});

// ── US-3209: importing eBay's own "this shipped" ────────────────────────────

Deno.test("US-3209: FULFILLED with no local date is written from eBay's clock", () => {
  // The whole point: a seller who bought the label in eBay's own flow never
  // pressed Mark shipped here, and the queue went on showing finished work.
  assertEquals(
    resolveShippedAt({
      fulfillmentStatus: "FULFILLED",
      existingShippedAt: null,
      orderModifiedAt: "2026-09-05T14:00:00.000Z",
    }),
    "2026-09-05T14:00:00.000Z",
  );
});

Deno.test("US-3209: an existing date is never moved, whatever eBay says", () => {
  // Forward only. The stored date may have come from the seller's own hand, a
  // label purchase, or a previous sync, and all three beat a re-read.
  assertEquals(
    resolveShippedAt({
      fulfillmentStatus: "FULFILLED",
      existingShippedAt: "2026-09-01T00:00:00.000Z",
      orderModifiedAt: "2026-09-05T14:00:00.000Z",
    }),
    null,
  );
  // Including when eBay has since gone quiet about it.
  assertEquals(
    resolveShippedAt({
      fulfillmentStatus: "NOT_STARTED",
      existingShippedAt: "2026-09-01T00:00:00.000Z",
      orderModifiedAt: "2026-09-05T14:00:00.000Z",
    }),
    null,
  );
});

Deno.test("US-3209: a partly shipped order is not a shipped order", () => {
  // IN_PROGRESS means at least one line item is still outstanding. Marking the
  // sale shipped would drop the remaining item out of the queue.
  for (const status of ["NOT_STARTED", "IN_PROGRESS", "", null, undefined]) {
    assertEquals(
      resolveShippedAt({
        fulfillmentStatus: status,
        existingShippedAt: null,
        orderModifiedAt: "2026-09-05T14:00:00.000Z",
      }),
      null,
      `status ${String(status)}`,
    );
  }
});

Deno.test("US-3209: an unusable eBay timestamp falls back to now, not to null", () => {
  // A backfilled order with no readable modified date still shipped. Dating it
  // "now" is wrong by days; dropping it is wrong forever.
  assertEquals(
    resolveShippedAt({
      fulfillmentStatus: "fulfilled",
      existingShippedAt: "   ",
      orderModifiedAt: "not a date",
      now: () => Date.parse("2026-09-09T00:00:00.000Z"),
    }),
    "2026-09-09T00:00:00.000Z",
  );
});
