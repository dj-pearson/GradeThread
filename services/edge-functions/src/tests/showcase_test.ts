// US-1855: the Showcase feed's pure rules.
//
// lib/showcase.ts touches no env and no DB, so this file imports it statically —
// no dynamic-import env dance needed (it pulls in nothing that reaches
// lib/supabase.ts).
import { assert, assertEquals } from "@std/assert";
import {
  brandFacets,
  brandSlug,
  categoryFacets,
  FINDS_DEFAULT_LIMIT,
  FINDS_MAX_LIMIT,
  parseFindsQuery,
  projectFind,
  type PublicFind,
  rankFinds,
  type ShowcaseFindRow,
  showcaseLeaderboard,
  trendingScore,
} from "../lib/showcase.ts";

const SITE = "https://gradethread.com";

function row(over: Partial<ShowcaseFindRow> = {}): ShowcaseFindRow {
  return {
    grade_report_id: "11111111-1111-4111-8111-111111111111",
    certificate_id: "22222222-2222-4222-8222-222222222222",
    overall_score: 8.5,
    grade_tier: "Excellent",
    graded_at: "2026-08-01T00:00:00.000Z",
    showcased_at: "2026-08-01T00:00:00.000Z",
    title: "Carhartt Detroit Jacket",
    brand: "Carhartt",
    brand_slug: "carhartt",
    category: "outerwear",
    garment_type: "jacket",
    value_cents: 12500,
    seller_handle: "thriftgoblin",
    seller_display_name: "Thrift Goblin",
    ...over,
  };
}

function find(over: Partial<PublicFind> = {}): PublicFind {
  return { ...projectFind(row(), 0, SITE), ...over };
}

// The SQL side of this rule lives in migration 00543 as
//   trim(BOTH '-' FROM regexp_replace(lower(brand), '[^a-z0-9]+', '-', 'g'))
// and is what a facet page filters on. These cases are the shared contract: if
// either side changes, /finds/b/<slug> starts rendering an empty page.
Deno.test("brandSlug matches the SQL brand_slug rules", () => {
  assertEquals(brandSlug("Carhartt"), "carhartt");
  assertEquals(brandSlug("Ralph Lauren"), "ralph-lauren");
  assertEquals(brandSlug("Levi's"), "levi-s");
  assertEquals(brandSlug("  A.P.C.  "), "a-p-c");
  assertEquals(brandSlug("&&&"), null);
  assertEquals(brandSlug(""), null);
  assertEquals(brandSlug(null), null);
});

Deno.test("parseFindsQuery bounds and defaults everything", () => {
  const empty = parseFindsQuery(new URLSearchParams());
  assertEquals(empty.sort, "trending");
  assertEquals(empty.limit, FINDS_DEFAULT_LIMIT);
  assertEquals(empty.brandSlug, null);
  assertEquals(empty.category, null);
  assertEquals(empty.minGrade, null);

  const q = parseFindsQuery(
    new URLSearchParams(
      "sort=recent&brand=Ralph Lauren&category=outerwear&min_grade=8.44&limit=9999",
    ),
  );
  assertEquals(q.sort, "recent");
  assertEquals(q.brandSlug, "ralph-lauren");
  assertEquals(q.category, "outerwear");
  assertEquals(q.minGrade, 8.4);
  assertEquals(q.limit, FINDS_MAX_LIMIT);

  // Junk must be dropped rather than forwarded to PostgREST: `category` is an
  // enum column, so a non-slug value would raise 22P02 and surface as a 500.
  const junk = parseFindsQuery(
    new URLSearchParams("sort=chaos&category=%27;drop&min_grade=99&limit=-4"),
  );
  assertEquals(junk.sort, "trending");
  assertEquals(junk.category, null);
  assertEquals(junk.minGrade, null);
  assertEquals(junk.limit, FINDS_DEFAULT_LIMIT);
});

Deno.test("projectFind exposes only public, non-expiring fields", () => {
  const f = projectFind(row(), 3, SITE);
  assertEquals(f.certificate_url, `${SITE}/cert/${row().certificate_id}`);
  // Never a signed storage URL — those expire in 15 minutes and a crawler
  // reading the JSON-LD image later would get a 403.
  assertEquals(f.image_url, `${SITE}/cert-photo/${row().certificate_id}/0`);
  assertEquals(f.seller_url, `${SITE}/verified/thriftgoblin`);
  assertEquals(f.reactions, 3);
  assert(!("submission_id" in f), "a find must not carry a submission id");
  assert(!("user_id" in f), "a find must not carry a user id");
});

Deno.test("projectFind leaves an anonymous find unlinked", () => {
  const f = projectFind(
    row({ seller_handle: null, seller_display_name: null }),
    0,
    SITE,
  );
  assertEquals(f.seller_handle, null);
  assertEquals(f.seller_url, null);
});

Deno.test("trending decays: fresh attention outranks stale volume", () => {
  const now = Date.parse("2026-08-10T00:00:00.000Z");
  const stale = trendingScore(40, "2026-07-20T00:00:00.000Z", now);
  const fresh = trendingScore(5, "2026-08-09T00:00:00.000Z", now);
  assert(
    fresh > stale,
    `a find from yesterday with 5 reactions must beat a three-week-old one with 40 (${fresh} vs ${stale})`,
  );
});

Deno.test("rankFinds honours each sort", () => {
  const now = Date.parse("2026-08-10T00:00:00.000Z");
  const old = find({
    id: "old",
    reactions: 30,
    overall_score: 9.8,
    showcased_at: "2026-07-01T00:00:00.000Z",
  });
  const recent = find({
    id: "recent",
    reactions: 2,
    overall_score: 6.0,
    showcased_at: "2026-08-09T00:00:00.000Z",
  });

  assertEquals(rankFinds([old, recent], "recent", now)[0].id, "recent");
  assertEquals(rankFinds([recent, old], "top_graded", now)[0].id, "old");
  assertEquals(rankFinds([old, recent], "trending", now)[0].id, "recent");

  // Pure: the input array is not reordered in place.
  const input = [old, recent];
  rankFinds(input, "recent", now);
  assertEquals(input[0].id, "old");
});

Deno.test("facets count the whole window, most-used first", () => {
  const rows = [
    row({ brand: "Carhartt", brand_slug: "carhartt", category: "outerwear" }),
    row({ brand: "Carhartt", brand_slug: "carhartt", category: "tops" }),
    row({ brand: "Levi's", brand_slug: "levi-s", category: "bottoms" }),
    row({ brand: null, brand_slug: null, category: null }),
  ];
  const brands = brandFacets(rows);
  assertEquals(brands.length, 2);
  assertEquals(brands[0], { label: "Carhartt", slug: "carhartt", count: 2 });
  assertEquals(categoryFacets(rows).length, 3);
});

Deno.test("leaderboard ranks by reactions and skips anonymous finds", () => {
  const board = showcaseLeaderboard([
    find({ id: "a", seller_handle: "one", seller_display_name: "One", reactions: 4 }),
    find({ id: "b", seller_handle: "one", seller_display_name: "One", reactions: 3 }),
    find({ id: "c", seller_handle: "two", seller_display_name: "Two", reactions: 6 }),
    // Showcased anonymously: consented to be SEEN, not to be named on a board.
    find({ id: "d", seller_handle: null, seller_display_name: null, reactions: 99 }),
  ]);
  assertEquals(board.length, 2);
  assertEquals(board[0].handle, "one");
  assertEquals(board[0].reactions, 7);
  assertEquals(board[0].finds, 2);
  assertEquals(board[1].handle, "two");
});
