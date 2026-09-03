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
  OFFER_RECHECK_MS,
  resolveSyncScope,
  selectSkusToSkip,
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

// ── US-3111: the per-SKU offer read stagger ──────────────────────────
//
// The fan-out is one `GET /sell/inventory/v1/offer?sku=` per SKU over eBay's
// whole inventory list — 984 SKUs on production — repeated every catalog pass.
// Two thirds of those SKUs are Seller-Hub listings with no Inventory-API offer,
// so the call returns nothing and we ask again six hours later. selectSkusToSkip
// is what stops that, which makes its edge cases worth pinning: every branch
// below decides whether we spend about a thousand eBay calls.

Deno.test("a SKU read inside the window is skipped", () => {
  const skip = selectSkusToSkip(
    [{ sku: "SKU-1", ebay_offer_checked_at: ago(60_000) }],
    NOW,
  );
  assertEquals([...skip], ["SKU-1"]);
});

Deno.test("a SKU read outside the window is read again", () => {
  const skip = selectSkusToSkip(
    [{ sku: "SKU-1", ebay_offer_checked_at: ago(OFFER_RECHECK_MS) }],
    NOW,
  );
  assertEquals(skip.size, 0);
});

Deno.test("a SKU never read is never skipped", () => {
  // This is how a brand new SKU, and every SKU on the first pass after deploy,
  // gets discovered at all.
  const skip = selectSkusToSkip(
    [{ sku: "SKU-1", ebay_offer_checked_at: null }],
    NOW,
  );
  assertEquals(skip.size, 0);
});

Deno.test("rows with no sku or an unparseable stamp are read", () => {
  const skip = selectSkusToSkip(
    [
      { sku: null, ebay_offer_checked_at: ago(60_000) },
      { sku: "SKU-2", ebay_offer_checked_at: "not a date" },
      { sku: "SKU-3", ebay_offer_checked_at: "" },
    ],
    NOW,
  );
  assertEquals(skip.size, 0);
});

Deno.test("a future timestamp is a clock problem, not a fresh read", () => {
  // Treating it as fresh would skip the SKU until wall-clock caught up, which
  // on a badly skewed clock could be indefinitely.
  const skip = selectSkusToSkip(
    [{ sku: "SKU-1", ebay_offer_checked_at: ago(-60 * 60 * 1000) }],
    NOW,
  );
  assertEquals(skip.size, 0);
});

Deno.test("the window is a day, so a full pass never skips the whole catalog", () => {
  // If OFFER_RECHECK_MS ever dropped below the catalog refresh interval the
  // stagger would do nothing; if it grew unbounded, an ended listing could sit
  // in 'listed' for a week. It belongs strictly between the two.
  assertEquals(OFFER_RECHECK_MS > CATALOG_REFRESH_MS, true);
  assertEquals(OFFER_RECHECK_MS <= 7 * 24 * 60 * 60 * 1000, true);
});

Deno.test("a mixed catalog skips only the fresh half", () => {
  const skip = selectSkusToSkip(
    [
      { sku: "fresh-a", ebay_offer_checked_at: ago(60_000) },
      { sku: "fresh-b", ebay_offer_checked_at: ago(OFFER_RECHECK_MS - 1_000) },
      { sku: "stale-a", ebay_offer_checked_at: ago(OFFER_RECHECK_MS + 1_000) },
      { sku: "never", ebay_offer_checked_at: null },
    ],
    NOW,
  );
  assertEquals([...skip].sort(), ["fresh-a", "fresh-b"]);
});
