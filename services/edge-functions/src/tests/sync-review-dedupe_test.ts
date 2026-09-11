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
// that stop it turning into rows: the route deduplicates, and an index exists as
// the backstop.
//
// ⚠ REWRITTEN 2026-09-11 (US-3364), and the rewrite is the point of the file.
//
// The second half used to assert that the route called `.upsert()` with
// `onConflict: "user_id,platform,dedupe_key"`. That assertion was green from the
// day it was written, and the write it guarded failed EVERY TIME: both indexes
// here are partial, Postgres refuses a partial index as an ON CONFLICT target
// unless the statement repeats the predicate, PostgREST cannot send one, and the
// answer was HTTP 400 / 42P10 on every call. A source scan can tell you the
// string is the one you meant to write. Whether the database accepts it is a
// different question, and it was the question that mattered.
// sync-review-lands_test.ts answers that one against a real Postgres; this file
// keeps the parts a source scan genuinely owns.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  type KnownListing,
  type ObservationBatch,
  planObservations,
} from "../lib/marketplace-observations.ts";
import { openReviewKey } from "../routes/flipdesk-sync.ts";

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

Deno.test("US-2717: an unmatched sale is deduped on its dedupe_key", async () => {
  const src = await Deno.readTextFile(ROUTE);

  // The unmatched rows must go through the same writer as everything else, so
  // there is one dedupe rule rather than two call sites each assuming the other
  // half was handled.
  const at = src.indexOf("plan.unmatched.map(");
  assert(at !== -1, "the unmatched-sales rows are gone from flipdesk-sync.ts");
  assert(
    src.includes("writeSyncReviews(ownerId, batch.platform, reviewRows)"),
    "the review write no longer goes through writeSyncReviews, which is the " +
      "only thing that deduplicates these rows now that neither partial index " +
      "can be an ON CONFLICT target (US-3364)",
  );

  // And the rule itself, exercised rather than read: two polls of one unmatched
  // sale are one identity.
  const poll = { reason: "probable_match", listing_id: null, dedupe_key: "poshmark:ref:ORDER-1" };
  assert(openReviewKey(poll) !== null, "an unmatched sale must be deduped");
  assertEquals(
    openReviewKey(poll),
    openReviewKey({ ...poll }),
    "the same sold row observed twice must produce one key, or the seller gets " +
      "~32 copies a day at the poll's 45-minute default, forever, while " +
      "GET /reviews returns only the newest 200",
  );
  assert(
    openReviewKey(poll) !== openReviewKey({ ...poll, dedupe_key: "poshmark:ref:ORDER-2" }),
    "two different sales must not collapse into one review row",
  );
});

Deno.test("US-2717: a unique index exists as the backstop", async () => {
  let sql = "";
  for await (const e of Deno.readDir(MIGRATIONS)) {
    if (!e.isFile || !e.name.endsWith(".sql")) continue;
    sql += await Deno.readTextFile(new URL(e.name, MIGRATIONS));
  }

  const idx = sql.indexOf("marketplace_sync_reviews_unmatched_uniq");
  assert(
    idx !== -1,
    "no migration declares marketplace_sync_reviews_unmatched_uniq, so two " +
      "polls racing on the same unmatched sale both insert and the seller gets " +
      "two rows for one problem",
  );
  const decl = sql.slice(idx, idx + 400);
  assert(
    /\(user_id,\s*platform,\s*dedupe_key\)/.test(decl),
    "the index columns must match openReviewKey's dedupe branch exactly, or the " +
      "route and the backstop disagree about what one problem is",
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
  const bypassed = `if (plan.unmatched.length > 0) {
      await supabaseAdmin.from("marketplace_sync_reviews").insert(
        plan.unmatched.map((u) => ({ user_id: ownerId })),
      );
    }`;
  assert(
    !bypassed.includes("writeSyncReviews(ownerId, batch.platform, reviewRows)"),
    "the writer detection no longer spots a write that skips writeSyncReviews",
  );

  const unboundedLedger = `from("marketplace_sync_observations")
      .select("dedupe_key")
      .eq("user_id", ownerId)`;
  assert(
    !unboundedLedger.slice(0, 500).includes('.in("dedupe_key"'),
    "the bounded-read detection no longer spots an unbounded ledger select",
  );
});
