// US-2717: the sold-sync review queue does not grow a row per poll.
//
// 00632 shipped `marketplace_sync_reviews_open_uniq` and said in its own comment
// what it was for: "a poll every 30 minutes re-observes the same unexplained
// absence forever, and without this the seller opens the queue to forty copies
// of one problem." It is partial on `listing_id IS NOT NULL` -- and the branch
// that recurs hardest is the one with no listing id.
//
// The first half of this file proves the recurrence with the planner itself,
// because it is not a hypothetical: `seenKeys` is built from the dedupe LEDGER,
// and a row lands in that ledger only when a sale is CONFIRMED. An unmatched
// sale is never confirmed, so it is never suppressed, so it arrives again on
// every single poll carrying the same key. The second half pins the two things
// that stop it turning into rows: the route upserts, and an index exists for it
// to upsert onto.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  type KnownListing,
  type ObservationBatch,
  planObservations,
} from "../lib/marketplace-observations.ts";

const ROUTE = new URL("../routes/flipdesk-sync.ts", import.meta.url);
const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);

const known: KnownListing[] = [{
  id: "listing-1",
  itemId: "item-1",
  platform: "poshmark",
  listingUrl: "https://poshmark.com/listing/known-111",
  title: "Known Jacket",
  priceCents: 4500,
  listingStatus: "active",
}];

/** A sold row for something the seller listed OUTSIDE FlipDesk. */
const batch: ObservationBatch = {
  platform: "poshmark",
  observedAt: "2026-08-20T10:00:00.000Z",
  signedIn: true,
  sold: [{
    listingUrl: "https://poshmark.com/listing/stranger-999",
    title: "Listed Somewhere Else",
    soldPriceCents: 3000,
    soldAt: "2026-08-19T00:00:00.000Z",
    orderRef: "ORDER-1",
    thumbAssetId: null,
  }],
  closet: null,
};

Deno.test("US-2717: an unmatched sale returns on every poll with the SAME key", () => {
  // The route's ledger, modelled exactly: only confirmed sales are written to
  // it, so this set is the one the route would actually build.
  const ledger = new Set<string>();
  const keys: string[] = [];

  for (let poll = 0; poll < 5; poll++) {
    const plan = planObservations({ batch, known, seenKeys: ledger });
    assertEquals(
      plan.unmatched.length,
      1,
      "the planner stopped re-reporting an unmatched sale, which would mean the " +
        "ledger now suppresses it — if that is deliberate, this guard and the " +
        "00633 index are both obsolete",
    );
    keys.push(plan.unmatched[0].dedupeKey);
    for (const sale of plan.confirmed) ledger.add(sale.dedupeKey);
  }

  assertEquals(
    new Set(keys).size,
    1,
    "five polls produced more than one dedupe key for one sold row, so nothing " +
      "downstream could deduplicate them",
  );
  assertEquals(keys[0], "poshmark:ref:ORDER-1");
});

Deno.test("US-2717: the route UPSERTS unmatched rows rather than inserting them", async () => {
  const src = await Deno.readTextFile(ROUTE);

  // The unmatched block, located by the reason it writes rather than by a line
  // number: `probable_match` with a null listing id is the shape at issue.
  const at = src.indexOf("plan.unmatched.length > 0");
  assert(at !== -1, "the unmatched-sales block is gone from flipdesk-sync.ts");
  const block = src.slice(at, at + 1200);

  assert(
    block.includes(".upsert("),
    "the unmatched block writes with .insert(). Every poll re-emits the same " +
      "sold row (see the planner test above), and the partial unique index from " +
      "00632 does not cover listing_id IS NULL — so each poll adds a row. At the " +
      "poll's 45-minute default that is ~32 copies a day, forever, and " +
      "GET /reviews returns only the newest 200.",
  );
  assert(
    block.includes('onConflict: "user_id,platform,dedupe_key"'),
    "the unmatched upsert must name the 00633 index's columns; a conflict target " +
      "with no matching unique index fails the write outright",
  );
});

Deno.test("US-2717: a unique index exists for that conflict target", async () => {
  let sql = "";
  for await (const e of Deno.readDir(MIGRATIONS)) {
    if (!e.isFile || !e.name.endsWith(".sql")) continue;
    sql += await Deno.readTextFile(new URL(e.name, MIGRATIONS));
  }

  const idx = sql.indexOf("marketplace_sync_reviews_unmatched_uniq");
  assert(
    idx !== -1,
    "no migration declares marketplace_sync_reviews_unmatched_uniq, so the " +
      "route's onConflict target does not exist and every unmatched write fails",
  );
  const decl = sql.slice(idx, idx + 400);
  assert(
    /\(user_id,\s*platform,\s*dedupe_key\)/.test(decl),
    "the index columns must match the route's onConflict list exactly",
  );
  assert(
    /listing_id IS NULL/.test(decl),
    "the index must be partial on listing_id IS NULL, or it collides with " +
      "marketplace_sync_reviews_open_uniq, which already owns the other half",
  );
  assert(
    /dedupe_key IS NOT NULL/.test(decl),
    "count_gap and circuit_breaker carry a NULL dedupe_key and describe a whole " +
      "read rather than one sale — they are expected to recur and must stay out " +
      "of this index",
  );
});

Deno.test("US-2717: the ledger read is bounded by the batch, not by the tenant", async () => {
  const src = await Deno.readTextFile(ROUTE);
  const at = src.indexOf('from("marketplace_sync_observations")');
  assert(at !== -1, "the ledger read is gone from flipdesk-sync.ts");
  const block = src.slice(at, at + 500);

  assert(
    block.includes('.in("dedupe_key"'),
    "the ledger read selects every key this tenant has on this platform. That " +
      "table holds one row per sale forever, so the query grows with the " +
      "seller's lifetime sales and is re-run on every poll; a batch is capped at " +
      "MAX_SOLD_ROWS, so filtering on the batch's own keys is bounded instead.",
  );
});

Deno.test("US-2717: the source guards can actually fail (self-check)", () => {
  // Every source-scan rule here proves it can fire before it is trusted: the
  // extension's passivity guard shipped unmatchable for an hour.
  const insertShape = `if (plan.unmatched.length > 0) {
      await supabaseAdmin.from("marketplace_sync_reviews").insert(rows);
    }`;
  const at = insertShape.indexOf("plan.unmatched.length > 0");
  assert(
    !insertShape.slice(at, at + 1200).includes(".upsert("),
    "the upsert detection no longer spots a plain insert",
  );

  const unboundedLedger = `from("marketplace_sync_observations")
      .select("dedupe_key")
      .eq("user_id", ownerId)`;
  assert(
    !unboundedLedger.slice(0, 500).includes('.in("dedupe_key"'),
    "the bounded-read detection no longer spots an unbounded ledger select",
  );
});
