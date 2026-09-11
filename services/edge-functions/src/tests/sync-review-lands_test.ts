// US-3364: a listing-linked review row actually LANDS in the review queue.
//
// The defect this file exists for was not a missing write. The write was there,
// it was checked from US-3363 onwards, and it failed every single time:
//
//   POST /rest/v1/marketplace_sync_reviews?on_conflict=user_id,platform,reason,listing_id
//   HTTP 400
//   {"code":"42P10","message":"there is no unique or exclusion constraint
//     matching the ON CONFLICT specification"}
//
// Both unique indexes on that table are PARTIAL, and Postgres refuses a partial
// index as an ON CONFLICT target unless the statement repeats the index
// predicate, which PostgREST cannot send. A control upsert on
// marketplace_sync_state, whose index is not partial, returned 201 in the same
// session -- so it is the predicate and not the table.
//
// THE LESSON THIS FILE ENCODES: every guard that existed before this pointed at
// the SOURCE. sync-review-dedupe_test.ts asserted the route calls `.upsert()`
// with the right onConflict string, and it was green the whole time, because
// the string was right and the database rejected it anyway. So the assertion
// that matters here is a row count read back out of a real Postgres, and the
// source scans below are deliberately about the shape that CANNOT be checked
// any other way.
//
// Run the integration half against the throwaway local stack:
//
//   docker start supabase_rest_gradethread supabase_kong_gradethread
//   TEST_SUPABASE_URL=http://127.0.0.1:54321 \
//   TEST_SUPABASE_SERVICE_ROLE_KEY=<local service key> \
//   TEST_SYNC_REVIEW_USER_ID=<a user id that exists> \
//   deno test --allow-net --allow-env --allow-read src/tests/sync-review-lands_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
import { requireIntegrationFixtures } from "./integration-required.ts";
import { resetSupabaseAdminForTests } from "../lib/supabase.ts";
import { openReviewKey, writeSyncReviews } from "../routes/flipdesk-sync.ts";

const ROUTE = new URL("../routes/flipdesk-sync.ts", import.meta.url);
const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);

// ── 1. the key function IS the two index definitions ───────────────────────

Deno.test("US-3364: openReviewKey keys a listing row on (reason, listing_id)", () => {
  const a = openReviewKey({ reason: "unexplained_absence", listing_id: "L1", dedupe_key: null });
  const b = openReviewKey({ reason: "probable_match", listing_id: "L1", dedupe_key: null });
  const c = openReviewKey({ reason: "unexplained_absence", listing_id: "L2", dedupe_key: null });
  assert(a !== null);
  assert(a !== b, "two reasons on one listing are two separate problems");
  assert(a !== c, "one reason on two listings is two separate problems");
  // A listing-linked row is keyed on the listing even when it carries a dedupe
  // key, because marketplace_sync_reviews_unmatched_uniq is partial on
  // listing_id IS NULL and does not cover it.
  assertEquals(
    openReviewKey({ reason: "probable_match", listing_id: "L1", dedupe_key: "k" }),
    b,
  );
});

Deno.test("US-3364: an unmatched row keys on dedupe_key alone", () => {
  const a = openReviewKey({ reason: "probable_match", listing_id: null, dedupe_key: "poshmark:ref:1" });
  const b = openReviewKey({ reason: "probable_match", listing_id: null, dedupe_key: "poshmark:ref:2" });
  assert(a !== null && a !== b);
});

Deno.test("US-3364: count_gap and circuit_breaker are NOT deduped", () => {
  // Both indexes exclude them on purpose: they describe the state of a whole
  // read rather than one sale, and each new read is a new fact. A key here
  // would silence the second report of a channel that is still broken.
  for (const reason of ["count_gap", "circuit_breaker"]) {
    assertEquals(openReviewKey({ reason, listing_id: null, dedupe_key: null }), null);
  }
});

Deno.test("US-3364: the key function matches what the migrations declare", async () => {
  let sql = "";
  for await (const e of Deno.readDir(MIGRATIONS)) {
    if (!e.isFile || !e.name.endsWith(".sql")) continue;
    sql += await Deno.readTextFile(new URL(e.name, MIGRATIONS));
  }

  const open = sql.slice(sql.indexOf("marketplace_sync_reviews_open_uniq"));
  assert(
    /\(user_id,\s*platform,\s*reason,\s*listing_id\)/.test(open.slice(0, 400)),
    "00632's index columns changed; openReviewKey's listing branch must change with it",
  );
  assert(
    /status = 'open' AND listing_id IS NOT NULL/.test(open.slice(0, 400)),
    "00632's predicate changed. If it is no longer partial, the route can go " +
      "back to a plain onConflict upsert and this whole file is obsolete.",
  );

  const unmatched = sql.slice(sql.indexOf("marketplace_sync_reviews_unmatched_uniq"));
  assert(
    /\(user_id,\s*platform,\s*dedupe_key\)/.test(unmatched.slice(0, 400)),
    "00633's index columns changed; openReviewKey's dedupe branch must change with it",
  );
  assert(
    /listing_id IS NULL AND dedupe_key IS NOT NULL/.test(unmatched.slice(0, 400)),
    "00633's predicate changed; openReviewKey's precedence between the two " +
      "branches depends on it",
  );
});

// ── 2. the route names no partial index as a conflict target ───────────────

Deno.test("US-3364: the only onConflict on marketplace_sync_reviews is the pkey", async () => {
  const src = (await Deno.readTextFile(ROUTE)).replace(/\r\n/g, "\n");
  // Comments quote the broken strings verbatim -- this file's header does too --
  // so the scan reads code only.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

  const targets: string[] = [];
  for (const m of code.matchAll(/onConflict:\s*"([^"]+)"/g)) {
    const owner = code.lastIndexOf('.from("', m.index!);
    const table = code.slice(owner + 7, code.indexOf('"', owner + 7));
    if (table === "marketplace_sync_reviews") targets.push(m[1]!);
  }

  assertEquals(
    targets,
    ["id"],
    "an ON CONFLICT target on marketplace_sync_reviews that is not `id` names " +
      "one of the two PARTIAL indexes, and Postgres answers 42P10 for the whole " +
      "statement. marketplace_sync_reviews_pkey is the only non-partial unique " +
      "index on the table.",
  );
});

Deno.test("US-3364: that scan can actually fail (self-check)", () => {
  const broken = `
    await supabaseAdmin.from("marketplace_sync_reviews").upsert(rows, {
      onConflict: "user_id,platform,reason,listing_id",
    });
  `;
  const targets: string[] = [];
  for (const m of broken.matchAll(/onConflict:\s*"([^"]+)"/g)) {
    const owner = broken.lastIndexOf('.from("', m.index!);
    const table = broken.slice(owner + 7, broken.indexOf('"', owner + 7));
    if (table === "marketplace_sync_reviews") targets.push(m[1]!);
  }
  assertEquals(targets, ["user_id,platform,reason,listing_id"], "the scan stopped seeing the defect");
});

// ── 3. the rows land, in a real Postgres ───────────────────────────────────

const URL_ENV = Deno.env.get("TEST_SUPABASE_URL");
const KEY = Deno.env.get("TEST_SUPABASE_SERVICE_ROLE_KEY");
const USER = Deno.env.get("TEST_SYNC_REVIEW_USER_ID");
const CONFIGURED = Boolean(URL_ENV && KEY && USER);

const RUN = requireIntegrationFixtures(
  "sync-review-lands",
  ["TEST_SUPABASE_URL", "TEST_SUPABASE_SERVICE_ROLE_KEY", "TEST_SYNC_REVIEW_USER_ID"],
  CONFIGURED,
);

/** A platform string nothing else in the fixture uses, so cleanup is exact. */
const PLATFORM = "us3364test";

/** A marketplace_sync_reviews row, spelled out here because the column list is
 *  the thing under test: the route builds the same shape at its call site. */
interface ReviewRowFixture {
  user_id: string;
  platform: string;
  reason: string;
  status: string;
  listing_id: string | null;
  inventory_item_id: string | null;
  listing_url: string | null;
  title: string | null;
  sold_price_cents: number | null;
  sold_at: string | null;
  dedupe_key: string | null;
  unexplained: number | null;
  claimed: number | null;
  cap: number | null;
  updated_at: string;
}

function row(over: Partial<ReviewRowFixture>): ReviewRowFixture {
  return {
    user_id: USER!,
    platform: PLATFORM,
    reason: "unexplained_absence",
    status: "open",
    listing_id: null,
    inventory_item_id: null,
    listing_url: null,
    title: null,
    sold_price_cents: null,
    sold_at: null,
    dedupe_key: null,
    unexplained: null,
    claimed: null,
    cap: null,
    updated_at: new Date().toISOString(),
    ...over,
  };
}

Deno.test({
  name: "US-3364: a listing-linked review row LANDS, and a second poll adds none",
  ignore: !RUN,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Point the route's own service-role client at this database. The client is
    // built on first use (US-2661), so setting the env and dropping the memo is
    // enough -- and it means the code under test is the shipped code, not a
    // copy of it that takes a client parameter.
    Deno.env.set("SUPABASE_URL", URL_ENV!);
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", KEY!);
    resetSupabaseAdminForTests();

    const db = createClient(URL_ENV!, KEY!, { auth: { persistSession: false } });
    const clean = async () => {
      await db.from("marketplace_sync_reviews").delete()
        .eq("user_id", USER!).eq("platform", PLATFORM);
    };
    const count = async (): Promise<number> => {
      const { data, error } = await db.from("marketplace_sync_reviews")
        .select("id").eq("user_id", USER!).eq("platform", PLATFORM);
      assertEquals(error, null, "reading the queue back must not fail");
      return (data ?? []).length;
    };

    await clean();
    assertEquals(await count(), 0, "the fixture did not start clean");

    // A listing id has to be real: the column is a FK to public.listings with
    // ON DELETE CASCADE, so a made-up uuid would fail for a reason that has
    // nothing to do with this story.
    const { data: anyListing, error: listErr } = await db
      .from("listings")
      .select("id, inventory_item_id")
      .eq("user_id", USER!)
      .limit(1)
      .maybeSingle();
    assertEquals(listErr, null);
    assert(
      anyListing,
      `TEST_SYNC_REVIEW_USER_ID=${USER} owns no listings, so the listing-linked ` +
        `branch -- the one that was silently dropped -- cannot be exercised`,
    );
    const listingId = (anyListing as { id: string }).id;
    const itemId = (anyListing as { inventory_item_id: string }).inventory_item_id;

    try {
      // ── the shape that shipped, proved still broken on THIS database ──
      // Without this the test could go green because the table changed rather
      // than because the route did.
      const { error: oldShape } = await db
        .from("marketplace_sync_reviews")
        .upsert([row({ listing_id: listingId, inventory_item_id: itemId })], {
          onConflict: "user_id,platform,reason,listing_id",
          ignoreDuplicates: false,
        });
      assert(oldShape, "the old upsert succeeded, so this database is not the one the story is about");
      assertEquals(
        oldShape.code,
        "42P10",
        `expected 42P10 from the partial-index conflict target, got ${oldShape.code}: ${oldShape.message}`,
      );
      assertEquals(await count(), 0, "a 42P10 statement must write nothing");

      // ── poll 1 ──
      const first = await writeSyncReviews(USER!, PLATFORM, [
        row({ listing_id: listingId, inventory_item_id: itemId, title: "poll one" }),
        row({ reason: "probable_match", dedupe_key: "us3364:ref:A", title: "unmatched one" }),
        row({ reason: "count_gap", unexplained: 2 }),
      ]);
      assertEquals(first.failed, 0, "poll one reported a failed write");
      assertEquals(first.inserted, 3);
      assertEquals(first.refreshed, 0);
      assertEquals(await count(), 3, "poll one did not land three rows");

      const { data: landed } = await db.from("marketplace_sync_reviews")
        .select("reason, listing_id, title")
        .eq("user_id", USER!).eq("platform", PLATFORM).eq("reason", "unexplained_absence");
      assertEquals((landed ?? []).length, 1, "the LISTING-LINKED row is the one that used to vanish");
      assertEquals((landed as { listing_id: string }[])[0]!.listing_id, listingId);

      // ── poll 2, thirty minutes later, same absence, same unmatched sale ──
      const second = await writeSyncReviews(USER!, PLATFORM, [
        row({ listing_id: listingId, inventory_item_id: itemId, title: "poll two" }),
        row({ reason: "probable_match", dedupe_key: "us3364:ref:A", title: "unmatched one" }),
      ]);
      assertEquals(second.failed, 0, "poll two reported a failed write");
      assertEquals(second.inserted, 0, "poll two inserted a duplicate");
      assertEquals(
        second.raced,
        0,
        "the route fell through to the index and got a 23505 instead of " +
          "recognising its own open rows. The queue is still correct, because " +
          "the index catches it -- which is exactly why this has to be asserted " +
          "rather than inferred from a row count.",
      );
      assertEquals(second.refreshed, 2, "poll two did not recognise both open rows");
      assertEquals(
        await count(),
        3,
        "the seller now has more than one row for one problem, which is exactly " +
          "what the partial indexes exist to prevent",
      );

      // Refreshed means refreshed: the row carries poll two's data, not poll one's.
      const { data: refreshed } = await db.from("marketplace_sync_reviews")
        .select("title").eq("user_id", USER!).eq("platform", PLATFORM)
        .eq("reason", "unexplained_absence").maybeSingle();
      assertEquals((refreshed as { title: string } | null)?.title, "poll two");

      // ── a count_gap is expected to recur ──
      const third = await writeSyncReviews(USER!, PLATFORM, [row({ reason: "count_gap", unexplained: 3 })]);
      assertEquals(third.inserted, 1, "a count_gap describes one READ and must not be deduped");
      assertEquals(await count(), 4);

      // ── resolving a review does not silence the next one ──
      // This is the whole reason the indexes are partial, and the reason
      // dropping the predicate in a migration would not have been equivalent.
      const { error: resolveErr } = await db.from("marketplace_sync_reviews")
        .update({ status: "resolved" })
        .eq("user_id", USER!).eq("platform", PLATFORM).eq("reason", "unexplained_absence");
      assertEquals(resolveErr, null);

      const fourth = await writeSyncReviews(USER!, PLATFORM, [
        row({ listing_id: listingId, inventory_item_id: itemId, title: "it came back" }),
      ]);
      assertEquals(
        fourth.inserted,
        1,
        "the seller resolved the review, the problem returned, and they were not told",
      );
      assertEquals(await count(), 5);
    } finally {
      await clean();
      // Leave the process pointing back at the test default, so a shared run
      // does not inherit a live database from this file.
      Deno.env.set("SUPABASE_URL", "http://localhost:54321");
      Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
      resetSupabaseAdminForTests();
    }
  },
});
