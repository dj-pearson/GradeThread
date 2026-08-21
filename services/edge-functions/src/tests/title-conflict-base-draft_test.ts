// US-2728 AC5 — the two-row case that 500'd the composer.
//
// WHAT BROKE, AND WHY NO TEST CAUGHT IT. The title-conflicts route selected a
// listing by item id and owner and called `.maybeSingle()`. That is correct for
// an item with one listing, and every item had one listing, because
// cross-listing was broken. US-2727 fixed the writeback; the first successful
// Poshmark cross-post gave an item its second row; `.maybeSingle()` met two and
// PostgREST answered PGRST116. The composer's duplicate-title panel 500'd for
// precisely the sellers who had just succeeded.
//
// THE FAKE BELOW IS THE POINT. It is not a stub that returns what the test
// wants — it re-implements the four PostgREST behaviours that interact to cause
// this: `eq` filters, `order` sorts, `limit` truncates, and `maybeSingle`
// ERRORS on more than one surviving row. Without that last rule the test would
// pass against the original broken query, which is exactly the trap the route
// fell into. Case 2 exists to prove the fake still has teeth.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { loadTitleConflictBaseDraft, BASE_DRAFT_PLATFORM } = await import(
  "../lib/title-conflict-base-draft.ts"
);

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";

interface Row {
  id: string;
  listing_title: string | null;
  platform_category_id: string | null;
  platform: string;
  user_id: string;
  inventory_item_id: string;
  created_at: string;
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "listing-ebay",
    listing_title: "Carhartt Detroit Jacket",
    platform_category_id: "57988",
    platform: "ebay",
    user_id: OWNER,
    inventory_item_id: ITEM,
    created_at: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

interface FakeResult {
  filters: Array<{ column: string; value: unknown }>;
  limit: number | null;
  ordered: string | null;
}

/**
 * A small, honest PostgREST.
 *
 * `forcedError` models a transport/permission failure so the error branch is
 * covered without pretending a filter caused it.
 */
function fakeDb(rows: Row[], forcedError: unknown | null = null) {
  const seen: FakeResult = { filters: [], limit: null, ordered: null };

  function builder(working: Row[]) {
    const api = {
      eq(column: string, value: unknown) {
        seen.filters.push({ column, value });
        return builder(
          working.filter((r) => (r as unknown as Record<string, unknown>)[column] === value),
        );
      },
      order(column: string, opts: { ascending: boolean }) {
        seen.ordered = `${column}:${opts.ascending ? "asc" : "desc"}`;
        const sorted = [...working].sort((a, b) =>
          opts.ascending
            ? a.created_at.localeCompare(b.created_at)
            : b.created_at.localeCompare(a.created_at)
        );
        return builder(sorted);
      },
      limit(n: number) {
        seen.limit = n;
        return builder(working.slice(0, n));
      },
      maybeSingle() {
        if (forcedError) return Promise.resolve({ data: null, error: forcedError });
        // THE RULE THAT MATTERS. PostgREST refuses to collapse more than one
        // row, and answers PGRST116 rather than picking one.
        if (working.length > 1) {
          return Promise.resolve({
            data: null,
            error: {
              code: "PGRST116",
              message: "JSON object requested, multiple (or no) rows returned",
              details: `Results contain ${working.length} rows`,
            },
          });
        }
        return Promise.resolve({ data: working[0] ?? null, error: null });
      },
    };
    return api;
  }

  return {
    seen,
    db: {
      from(_table: string) {
        return { select: (_cols: string) => builder(rows) };
      },
    },
  };
}

// ── 1. The regression itself: an eBay draft PLUS a Poshmark cross-listing ────
//
// This is the exact shape that reached production. Before the fix it is a 500.

Deno.test("an item cross-posted to Poshmark still returns its eBay base draft", async () => {
  const { db } = fakeDb([
    row({ id: "listing-ebay", platform: "ebay" }),
    row({
      id: "listing-poshmark",
      platform: "poshmark",
      platform_category_id: null,
      // Newer than the eBay row, so ordering alone would pick this one.
      created_at: "2026-08-19T00:00:00.000Z",
    }),
  ]);

  const { row: found, error } = await loadTitleConflictBaseDraft(OWNER, ITEM, db);

  assertEquals(error, null, "the two-row case must not error - this was the PGRST116 500");
  assert(found, "no base draft came back");
  assertEquals(found.id, "listing-ebay", "picked the Poshmark row, whose category is null");
  assertEquals(found.platform_category_id, "57988");
});

// ── 2. The fake can still fail, so case 1 means something ────────────────────
//
// Drop the platform pin and the SAME fixture reproduces the production error.
// If this ever stops erroring, the fake has lost the rule that makes this file
// worth having and case 1 is no longer evidence of anything.

Deno.test("without the platform pin the same fixture reproduces PGRST116", async () => {
  const { db } = fakeDb([
    row({ id: "listing-ebay", platform: "ebay" }),
    row({ id: "listing-poshmark", platform: "poshmark" }),
  ]);

  // The pre-fix query, spelled out: item + owner, then maybeSingle.
  // deno-lint-ignore no-explicit-any
  const q = db.from("listings").select("id").eq("inventory_item_id", ITEM) as any;
  const { data, error } = await q.eq("user_id", OWNER).maybeSingle();

  assertEquals(data, null);
  assertEquals(
    (error as { code: string }).code,
    "PGRST116",
    "the fake no longer models PostgREST's refusal to collapse two rows",
  );
});

// ── 3. Tenancy (US-268) ──────────────────────────────────────────────────────
//
// The service-role client bypasses RLS, so this filter is the whole defence.

Deno.test("another seller's listing for the same item id is not returned", async () => {
  const { db, seen } = fakeDb([
    row({ id: "listing-theirs", user_id: OTHER }),
  ]);

  const { row: found, error } = await loadTitleConflictBaseDraft(OWNER, ITEM, db);

  assertEquals(error, null);
  assertEquals(found, null, "a foreign owner's listing came back");
  assert(
    seen.filters.some((f) => f.column === "user_id" && f.value === OWNER),
    "the query never filtered on user_id",
  );
});

Deno.test("the query is scoped, pinned, ordered and capped", async () => {
  const { db, seen } = fakeDb([row()]);
  await loadTitleConflictBaseDraft(OWNER, ITEM, db);

  const by = (c: string) => seen.filters.find((f) => f.column === c)?.value;
  assertEquals(by("inventory_item_id"), ITEM);
  assertEquals(by("user_id"), OWNER);
  assertEquals(by("platform"), BASE_DRAFT_PLATFORM, "the platform pin is what fixes US-2728");
  assertEquals(seen.ordered, "created_at:desc");
  assertEquals(seen.limit, 1);
});

// ── 4. Two eBay rows should not happen, and must not 500 if they do ──────────
//
// The belt to the platform pin's braces. "An item has one eBay listing" is the
// same species of assumption as the one that caused this story.

Deno.test("two eBay rows collapse to the newest instead of erroring", async () => {
  const { db } = fakeDb([
    row({ id: "older", created_at: "2026-08-01T00:00:00.000Z" }),
    row({ id: "newer", created_at: "2026-08-18T00:00:00.000Z" }),
  ]);

  const { row: found, error } = await loadTitleConflictBaseDraft(OWNER, ITEM, db);

  assertEquals(error, null, "limit(1) is missing, so two eBay rows still reach maybeSingle");
  assertEquals(found?.id, "newer");
});

// ── 5. The ordinary cases the route branches on ──────────────────────────────

Deno.test("an item with no listings yet is an empty answer, not an error", async () => {
  const { db } = fakeDb([]);
  const { row: found, error } = await loadTitleConflictBaseDraft(OWNER, ITEM, db);
  assertEquals(error, null);
  assertEquals(found, null);
});

Deno.test("a real database error is propagated rather than read as 'no draft'", async () => {
  const { db } = fakeDb([row()], { code: "57014", message: "canceling statement" });
  const { row: found, error } = await loadTitleConflictBaseDraft(OWNER, ITEM, db);
  assertEquals(found, null);
  assertEquals((error as { code: string }).code, "57014");
});
