// US-3110: the scope decision that stopped every order sync from re-reading the
// whole eBay offer catalog.
//
// The bug this guards: doListingsPull always fanned out one
// `GET /sell/inventory/v1/offer?sku=` per SKU before it looked at orders, and
// the two callers that only ever need orders (the notification webhook and the
// order backstop) fired it every few minutes. Measured on production over
// 2026-09-01..03: 25,312 Inventory calls a day across two connected sellers, or
// roughly 41 full catalog reads.
//
// resolveSyncScope is deliberately pure — the interesting behaviour is "when
// does an orders-only request become a full read", and that must be provable
// without a database or an eBay token.

// US-2379: flipdesk-ebay.ts reaches lib/supabase.ts through its static imports,
// which reads env at module load. This must come first.
import "./_env.ts";
import { assertEquals } from "@std/assert";
import {
  CATALOG_REFRESH_MS,
  resolveSyncScope,
  SPECIFICS_RECHECK_MS,
} from "../routes/flipdesk-ebay.ts";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

Deno.test("a full request is never downgraded", () => {
  assertEquals(resolveSyncScope("full", ago(60_000), NOW), "full");
  assertEquals(resolveSyncScope("full", null, NOW), "full");
});

Deno.test("orders stays orders while the catalog is fresh", () => {
  assertEquals(resolveSyncScope("orders", ago(60_000), NOW), "orders");
  assertEquals(
    resolveSyncScope("orders", ago(CATALOG_REFRESH_MS - 1_000), NOW),
    "orders",
  );
});

Deno.test("orders upgrades to full once the catalog goes stale", () => {
  assertEquals(
    resolveSyncScope("orders", ago(CATALOG_REFRESH_MS), NOW),
    "full",
  );
  assertEquals(
    resolveSyncScope("orders", ago(CATALOG_REFRESH_MS + 60_000), NOW),
    "full",
  );
});

Deno.test("a connection that has never read the catalog reads it", () => {
  // The whole point of the upgrade rule: no caller can starve the reconcile by
  // asking for "orders" forever, and a fresh connection is never left with an
  // empty listing catalog because a webhook happened to arrive first.
  assertEquals(resolveSyncScope("orders", null, NOW), "full");
});

Deno.test("an unparseable timestamp reads the catalog rather than skipping it", () => {
  // Fail toward correctness: a garbled cursor costs one extra catalog read,
  // where the other direction would silently stop reconciling listings.
  assertEquals(resolveSyncScope("orders", "not a date", NOW), "full");
  assertEquals(resolveSyncScope("orders", "", NOW), "full");
});

Deno.test("the catalog refreshes several times a day, not once", () => {
  // A seller who edits a price in Seller Hub should not wait until tomorrow to
  // see it in FlipDesk. Four reads a day is the floor this window buys.
  const readsPerDay = (24 * 60 * 60 * 1000) / CATALOG_REFRESH_MS;
  assertEquals(readsPerDay >= 4, true);
  assertEquals(readsPerDay <= 24, true);
});

Deno.test("the specifics negative cache outlives a day of syncing", () => {
  // The failure mode being prevented is a per-sync re-ask. Any window shorter
  // than a day would let the old behaviour back in through the front door.
  assertEquals(SPECIFICS_RECHECK_MS > 24 * 60 * 60 * 1000, true);
});
