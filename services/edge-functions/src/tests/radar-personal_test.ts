// US-1864: the personal Radar layer's arithmetic.
//
// `radar-personal.ts` imports nothing that touches `lib/supabase.ts`, so this
// file needs no env dance (see the edge-test note in
// vault/70-agent/ralph-learnings.md) and can be run alone.
//
// What these cases are actually defending:
//   • The cold-start promise. One item from one source must produce a ranked
//     store with no venue, no network data and no consent anywhere in sight.
//   • The money definitions. A cancelled sale is not profit; expected profit
//     comes from a price the reseller SET; realized ROI is measured against the
//     spend on what SOLD, not against everything still on the rack.
//   • The absence in the row. `buildPersonalScanRow` has no coordinate
//     parameter, and the row's KEY SET is asserted rather than the absence of a
//     field — the US-1861 lesson, which fails when someone adds the column back
//     instead of passing forever.

import { assert, assertEquals } from "@std/assert";
import {
  buildPersonalScanRow,
  buildPersonalStores,
  expectedProfitCents,
  isPersonalStoreSort,
  type PersonalItemFact,
  type PersonalScanFact,
  type PersonalSourceSeed,
  type PersonalVenueSeed,
  sortPersonalStores,
} from "../lib/radar-personal.ts";

function source(over: Partial<PersonalSourceSeed> = {}): PersonalSourceSeed {
  return {
    id: "src-1",
    name: "Goodwill on Main",
    source_type: "thrift_store",
    location: "Main St",
    radar_venue_id: null,
    ...over,
  };
}

function item(over: Partial<PersonalItemFact> = {}): PersonalItemFact {
  return {
    source_id: "src-1",
    brand: "Patagonia",
    purchase_price: 5,
    purchase_date: "2026-05-01T00:00:00.000Z",
    list_price: null,
    target_price: null,
    net_profit: null,
    sale_price: null,
    sale_status: null,
    sale_date: null,
    ...over,
  };
}

function scan(over: Partial<PersonalScanFact> = {}): PersonalScanFact {
  return {
    venue_id: "ven-1",
    brand: "Nike",
    verdict: "buy",
    scanned_at: "2026-06-01T12:00:00.000Z",
    ...over,
  };
}

const venue: PersonalVenueSeed = {
  id: "ven-1",
  display_name: "Thrift store (dr5ru)",
  chain: "goodwill",
};

Deno.test("US-1864: works at n=1 — one item, one source, no venue, no network", () => {
  const out = buildPersonalStores({
    sources: [source()],
    venues: [],
    items: [item({ net_profit: 40, sale_price: 50, sale_status: "completed" })],
    scans: [],
  });

  assertEquals(out.stores.length, 1);
  const store = out.stores[0];
  assertEquals(store.key, "src-1");
  assertEquals(store.source_id, "src-1");
  assertEquals(store.venue_id, null);
  assertEquals(store.linked, false);
  assertEquals(store.items_sourced, 1);
  assertEquals(store.items_sold, 1);
  assertEquals(store.spend_cents, 500);
  assertEquals(store.realized_profit_cents, 4000);
  // 4000 / 500 = 800%. The whole point: a $5 buy that nets $40 is a great store
  // and the number says so on day one.
  assertEquals(store.roi_pct, 800);
  assertEquals(store.realized_roi_pct, 800);
  assertEquals(store.sell_through_pct, 100);
  assertEquals(store.top_brands, [
    { brand: "Patagonia", items: 1, realized_profit_cents: 4000 },
  ]);
  assertEquals(store.visits, 0);
  assertEquals(store.last_visit_at, "2026-05-01T00:00:00.000Z");
  assertEquals(store.last_visit_source, "purchase");
});

Deno.test("US-1864: a cancelled or refunded sale is not realized profit", () => {
  const out = buildPersonalStores({
    sources: [source()],
    venues: [],
    items: [
      item({ net_profit: 40, sale_status: "cancelled", list_price: 30 }),
      item({ net_profit: 90, sale_status: "refunded", list_price: 30 }),
      item({ net_profit: 10, sale_status: "pending", list_price: 30 }),
    ],
    scans: [],
  });

  const store = out.stores[0];
  assertEquals(store.items_sold, 0);
  assertEquals(store.realized_profit_cents, 0);
  assertEquals(store.realized_roi_pct, null, "no completed sale ⇒ no realized ROI");
  // Each falls back to the EXPECTED path instead: ask 30 − cost 5 = 25.
  assertEquals(store.expected_profit_cents, 7500);
  assertEquals(store.spend_cents, 1500);
  assertEquals(store.roi_pct, 500);
});

Deno.test("US-1864: expected profit comes from a price the reseller set", () => {
  // The live listing wins over the recorded target; with neither there is no
  // expectation at all, which is different from expecting nothing.
  assertEquals(expectedProfitCents(item({ list_price: 40, target_price: 25 })), 3500);
  assertEquals(expectedProfitCents(item({ list_price: null, target_price: 25 })), 2000);
  assertEquals(expectedProfitCents(item({ list_price: null, target_price: null })), null);
  assertEquals(expectedProfitCents(item({ list_price: 0 })), null);
  // An honest negative: listed below cost is a loss waiting to happen.
  assertEquals(expectedProfitCents(item({ purchase_price: 20, list_price: 12 })), -800);
});

Deno.test("US-1864: realized ROI is measured against the spend on what SOLD", () => {
  const out = buildPersonalStores({
    sources: [source()],
    venues: [],
    items: [
      item({ purchase_price: 10, net_profit: 20, sale_status: "completed" }),
      // Nine more $10 buys still on the rack. Blended ROI drops; realized does
      // not, because nothing about the sold item changed.
      ...Array.from({ length: 9 }, () => item({ purchase_price: 10 })),
    ],
    scans: [],
  });

  const store = out.stores[0];
  assertEquals(store.spend_cents, 10_000);
  assertEquals(store.sold_spend_cents, 1000);
  assertEquals(store.realized_roi_pct, 200);
  // (2000 realized + 0 expected) / 10000 spend.
  assertEquals(store.roi_pct, 20);
  assertEquals(store.sell_through_pct, 10);
});

Deno.test("US-1864: a scanned venue nobody has named still becomes a store", () => {
  const out = buildPersonalStores({
    sources: [],
    venues: [venue],
    items: [],
    scans: [scan(), scan({ verdict: "skip", scanned_at: "2026-06-02T09:00:00.000Z" })],
  });

  assertEquals(out.stores.length, 1);
  const store = out.stores[0];
  assertEquals(store.key, "venue:ven-1");
  assertEquals(store.source_id, null);
  assertEquals(store.venue_id, "ven-1");
  assertEquals(store.name, "Thrift store (dr5ru)");
  assertEquals(store.chain, "goodwill");
  assertEquals(store.visits, 2);
  assertEquals(store.buy_visits, 1);
  assertEquals(store.last_visit_at, "2026-06-02T09:00:00.000Z");
  assertEquals(store.last_visit_source, "scan");
  // No money, so no ROI — and the brands can only be what kept turning up.
  assertEquals(store.roi_pct, null);
  assertEquals(store.top_brands, [
    { brand: "Nike", items: 0, realized_profit_cents: 0 },
  ]);
});

Deno.test("US-1864: a linked source absorbs its venue's visits into one row", () => {
  const out = buildPersonalStores({
    sources: [source({ radar_venue_id: "ven-1" })],
    venues: [venue],
    items: [item({ net_profit: 30, sale_status: "completed" })],
    scans: [scan(), scan({ scanned_at: "2026-06-05T10:00:00.000Z" })],
  });

  assertEquals(out.stores.length, 1, "the venue must not appear a second time");
  const store = out.stores[0];
  assertEquals(store.key, "src-1", "the named source is the identity that wins");
  assertEquals(store.venue_id, "ven-1");
  assertEquals(store.linked, true);
  assertEquals(store.chain, "goodwill");
  assertEquals(store.items_sourced, 1);
  assertEquals(store.visits, 2);
  // The scan is newer than the purchase, so it sets the last-visit date.
  assertEquals(store.last_visit_at, "2026-06-05T10:00:00.000Z");
  assertEquals(store.last_visit_source, "scan");
});

Deno.test("US-1864: a source pointing at a venue that no longer resolves reads as unlinked", () => {
  // Merged away or deleted. The reseller's own store must not vanish with it.
  const out = buildPersonalStores({
    sources: [source({ radar_venue_id: "ven-gone" })],
    venues: [],
    items: [item()],
    scans: [],
  });
  assertEquals(out.stores.length, 1);
  assertEquals(out.stores[0].venue_id, null);
  assertEquals(out.stores[0].linked, false);
  assertEquals(out.stores[0].name, "Goodwill on Main");
});

Deno.test("US-1864: unplaced visits and unattributed items are counted, not invented", () => {
  const out = buildPersonalStores({
    sources: [source()],
    venues: [],
    items: [item(), item({ source_id: null })],
    scans: [scan({ venue_id: null })],
  });

  assertEquals(out.unattributed_items, 1);
  assertEquals(out.unplaced_visits, 1);
  assertEquals(out.stores.length, 1);
  assertEquals(out.stores[0].items_sourced, 1, "the sourceless item is not attributed");
});

Deno.test("US-1864: a source with no items and no visits is not a store", () => {
  // It is a name somebody typed. It belongs on the Sources tab, not in a ranking
  // of where their money came from.
  const out = buildPersonalStores({
    sources: [source(), source({ id: "src-2", name: "Estate sale" })],
    venues: [],
    items: [item()],
    scans: [],
  });
  assertEquals(out.stores.map((s) => s.key), ["src-1"]);
});

Deno.test("US-1864: top brands rank by realized profit, then volume", () => {
  const out = buildPersonalStores({
    sources: [source()],
    venues: [],
    items: [
      item({ brand: "Nike" }),
      item({ brand: "Nike" }),
      item({ brand: "Nike" }),
      item({ brand: "Arc'teryx", net_profit: 120, sale_status: "completed" }),
      item({ brand: "Levi's", net_profit: 15, sale_status: "completed" }),
      item({ brand: "Gap", net_profit: 1, sale_status: "completed" }),
      item({ brand: null }),
    ],
    scans: [],
  });

  const brands = out.stores[0].top_brands;
  assertEquals(brands.length, 3, "capped at three so a row does not wrap");
  assertEquals(brands[0], { brand: "Arc'teryx", items: 1, realized_profit_cents: 12_000 });
  assertEquals(brands[1], { brand: "Levi's", items: 1, realized_profit_cents: 1500 });
  // Nike has the volume but no realized profit, so it loses to a single $1 sale
  // and only its item count survives. Three unsold Nikes are not evidence yet.
  assertEquals(brands[2], { brand: "Gap", items: 1, realized_profit_cents: 100 });
});

Deno.test("US-1864: an unrankable store sorts LAST, never first", () => {
  const stores = buildPersonalStores({
    sources: [
      source({ id: "profitable", name: "Profitable" }),
      source({ id: "no-spend", name: "No spend" }),
    ],
    venues: [],
    items: [
      item({ source_id: "profitable", net_profit: 20, sale_status: "completed" }),
      // Zero cost: a donation, or a price nobody recorded. No spend ⇒ no ROI.
      item({ source_id: "no-spend", purchase_price: 0 }),
    ],
    scans: [],
  }).stores;

  assertEquals(sortPersonalStores(stores, "roi").map((s) => s.key), [
    "profitable",
    "no-spend",
  ]);
  // Same rule for recency: no date is not "now".
  const byRecent = sortPersonalStores(
    [
      { ...stores[0], last_visit_at: null },
      { ...stores[1], last_visit_at: "2026-01-01T00:00:00.000Z" },
    ],
    "recent",
  );
  assertEquals(byRecent[0].last_visit_at, "2026-01-01T00:00:00.000Z");
});

Deno.test("US-1864: every declared sort is accepted and ties break by name", () => {
  for (const s of ["roi", "realized_roi", "profit", "spend", "items", "visits", "recent", "name"]) {
    assert(isPersonalStoreSort(s), `${s} must be a valid sort`);
  }
  for (const bad of [null, undefined, "", "ROI", " roi ", "margin"]) {
    assertEquals(isPersonalStoreSort(bad), false);
  }

  const stores = buildPersonalStores({
    sources: [
      source({ id: "b", name: "Bravo" }),
      source({ id: "a", name: "Alpha" }),
    ],
    venues: [],
    items: [item({ source_id: "a" }), item({ source_id: "b" })],
    scans: [],
  }).stores;
  // Identical numbers on every axis, so the order must be stable rather than
  // whatever the read happened to return.
  assertEquals(sortPersonalStores(stores, "spend").map((s) => s.name), [
    "Alpha",
    "Bravo",
  ]);
  assertEquals(sortPersonalStores(stores, "name").map((s) => s.name), [
    "Alpha",
    "Bravo",
  ]);
});

Deno.test("US-1864: sortPersonalStores does not mutate its input", () => {
  const stores = buildPersonalStores({
    sources: [source({ id: "a", name: "Alpha" }), source({ id: "z", name: "Zulu" })],
    venues: [],
    items: [
      item({ source_id: "a" }),
      item({ source_id: "z", net_profit: 50, sale_status: "completed" }),
    ],
    scans: [],
  }).stores;
  const before = stores.map((s) => s.key);
  sortPersonalStores(stores, "roi");
  assertEquals(stores.map((s) => s.key), before);
});

Deno.test("US-1864: a personal visit row has no field a coordinate could land in", () => {
  const row = buildPersonalScanRow({
    accountId: "acct-1",
    venueId: "ven-1",
    cell: "dr5ru",
    brand: "  Patagonia  ",
    category: "Clothing",
    gradeBand: "high",
    verdict: "buy",
    at: new Date("2026-06-01T12:00:00.000Z"),
  });
  assert(row);
  // The KEY SET, not `assert(!row.lat)` — the second passes forever, including
  // after somebody adds the column back. This fails.
  assertEquals(Object.keys(row).sort(), [
    "brand",
    "category",
    "geohash",
    "grade_band",
    "scanned_at",
    "user_id",
    "venue_id",
    "verdict",
  ]);
  assertEquals(row.brand, "Patagonia");
  assertEquals(row.user_id, "acct-1");
  assertEquals(row.scanned_at, "2026-06-01T12:00:00.000Z");
});

Deno.test("US-1864: an unlocatable visit produces no row", () => {
  assertEquals(
    buildPersonalScanRow({
      accountId: "acct-1",
      venueId: null,
      cell: null,
      brand: null,
      category: null,
      gradeBand: "ungraded",
      verdict: "unknown",
      at: new Date("2026-06-01T12:00:00.000Z"),
    }),
    null,
  );
  // A cell alone is enough — that is the state the schema's located CHECK allows.
  const cellOnly = buildPersonalScanRow({
    accountId: "acct-1",
    venueId: null,
    cell: "dr5ru",
    brand: null,
    category: null,
    gradeBand: "ungraded",
    verdict: "unknown",
    at: new Date("2026-06-01T12:00:00.000Z"),
  });
  assert(cellOnly);
  assertEquals(cellOnly.venue_id, null);
  assertEquals(cellOnly.geohash, "dr5ru");
});
