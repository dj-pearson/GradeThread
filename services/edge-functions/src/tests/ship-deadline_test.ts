// US-3189: the ship-by deadline, and the two ways it is allowed to be absent.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  MAX_HANDLING_DAYS,
  normalizeHandlingDays,
  resolveShipBy,
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
