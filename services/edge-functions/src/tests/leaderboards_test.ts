// US-1856: the reward leaderboards' pure rules.
//
// lib/leaderboards.ts touches no env and no DB (it only pulls in showcase.ts,
// which is equally pure), so this file imports it statically — no dynamic-import
// env dance needed. The IMPURE half (leaderboards-data.ts) reaches
// lib/supabase.ts and is deliberately NOT imported here.
import { assert, assertEquals } from "@std/assert";
import {
  brandSlug,
  isLeaderboardMetric,
  isLeaderboardPeriod,
  LEADERBOARD_ALIAS_MAX,
  LEADERBOARD_DEFAULT_LIMIT,
  LEADERBOARD_MAX_LIMIT,
  LEADERBOARD_METRICS,
  type LeaderboardCandidate,
  leaderboardIdentity,
  leaderboardPath,
  metricByKey,
  normalizeAlias,
  parseLeaderboardQuery,
  periodLabel,
  rankLeaderboard,
  viewerRank,
} from "../lib/leaderboards.ts";
import { brandSlug as showcaseBrandSlug } from "../lib/showcase.ts";

const SITE = "https://gradethread.com";

function cand(over: Partial<LeaderboardCandidate> = {}): LeaderboardCandidate {
  return {
    userId: "u1",
    alias: "Thrift Goblin",
    handle: null,
    score: 10,
    secondary: 0,
    since: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// ─── Catalog ────────────────────────────────────────────────────────────────

Deno.test("the four boards AC1 names all exist", () => {
  const keys = LEADERBOARD_METRICS.map((m) => m.key).sort();
  assertEquals(keys, ["finds", "grades", "shares", "xp"]);
  for (const m of LEADERBOARD_METRICS) {
    assert(m.name.length > 0);
    assert(m.description.length > 0);
    assert(m.scoreLabel.length > 0);
    assert(metricByKey(m.key) === m);
  }
});

Deno.test("only garment-backed boards are facetable", () => {
  // XP has no brand and a referral signup has no garment category, so offering
  // a facet on them would be a filter that silently did nothing.
  assertEquals(metricByKey("xp")!.facetable, false);
  assertEquals(metricByKey("shares")!.facetable, false);
  assertEquals(metricByKey("grades")!.facetable, true);
  assertEquals(metricByKey("finds")!.facetable, true);
});

Deno.test("metric + period guards reject junk", () => {
  assert(isLeaderboardMetric("xp"));
  assert(!isLeaderboardMetric("XP"));
  assert(!isLeaderboardMetric("toString"));
  assert(!isLeaderboardMetric(null));
  assert(isLeaderboardPeriod("weekly"));
  assert(isLeaderboardPeriod("all_time"));
  assert(!isLeaderboardPeriod("monthly"));
  assertEquals(periodLabel("weekly"), "This week");
  assertEquals(periodLabel("all_time"), "All time");
});

// ─── Query parsing ──────────────────────────────────────────────────────────

Deno.test("parseLeaderboardQuery defaults to the all-time hub", () => {
  const q = parseLeaderboardQuery(new URLSearchParams());
  assertEquals(q.metric, null);
  assertEquals(q.period, "all_time");
  assertEquals(q.brandSlug, null);
  assertEquals(q.category, null);
  assertEquals(q.limit, LEADERBOARD_DEFAULT_LIMIT);
});

Deno.test("parseLeaderboardQuery bounds the limit and drops junk facets", () => {
  const q = parseLeaderboardQuery(
    new URLSearchParams({
      metric: "grades",
      period: "weekly",
      brand: "The North Face",
      category: "Outer Wear!",
      limit: "9999",
    }),
  );
  assertEquals(q.metric, "grades");
  assertEquals(q.period, "weekly");
  assertEquals(q.brandSlug, "the-north-face");
  // Not slug-shaped ⇒ dropped rather than sent to PostgREST.
  assertEquals(q.category, null);
  assertEquals(q.limit, LEADERBOARD_MAX_LIMIT);

  const bad = parseLeaderboardQuery(
    new URLSearchParams({ metric: "nope", period: "yearly", limit: "-3" }),
  );
  assertEquals(bad.metric, null);
  assertEquals(bad.period, "all_time");
  assertEquals(bad.limit, LEADERBOARD_DEFAULT_LIMIT);
});

Deno.test("the brand slug rule is the SAME one the finds feed uses", () => {
  // A leaderboard brand facet links into /finds/b/<slug>. Two slug rules would
  // render links into an empty feed, so this pins them to one function.
  for (const raw of ["Carhartt", "The North Face", "Levi's 501", "  ", "A&F"]) {
    assertEquals(brandSlug(raw), showcaseBrandSlug(raw));
  }
  assertEquals(brandSlug("The North Face"), "the-north-face");
  assertEquals(brandSlug("!!!"), null);
});

// ─── Identity ───────────────────────────────────────────────────────────────

Deno.test("nobody is listed without the opt-in, whatever aliases they own", () => {
  assertEquals(
    leaderboardIdentity({
      verified_enabled: true,
      verified_handle: "goblin",
      verified_display_name: "Thrift Goblin",
      referral_display_name: "Goblin",
    }),
    null,
  );
  assertEquals(leaderboardIdentity({ leaderboard_opt_in: false }), null);
});

Deno.test("an opted-in user with no resolvable alias is still not listed", () => {
  // There is no anonymous row on a leaderboard, and falling back to an id or an
  // email would be the exact leak the opt-in exists to prevent.
  assertEquals(leaderboardIdentity({ leaderboard_opt_in: true }), null);
  assertEquals(
    leaderboardIdentity({ leaderboard_opt_in: true, leaderboard_alias: "   " }),
    null,
  );
});

Deno.test("the alias falls back through surfaces the user already made public", () => {
  const base = { leaderboard_opt_in: true } as const;
  // Explicit alias wins.
  assertEquals(
    leaderboardIdentity({
      ...base,
      leaderboard_alias: "Picked Name",
      verified_enabled: true,
      verified_handle: "goblin",
      verified_display_name: "Thrift Goblin",
    }),
    { alias: "Picked Name", handle: "goblin" },
  );
  // Then the verified display name.
  assertEquals(
    leaderboardIdentity({
      ...base,
      verified_enabled: true,
      verified_handle: "goblin",
      verified_display_name: "Thrift Goblin",
      referral_display_name: "Ref",
    }),
    { alias: "Thrift Goblin", handle: "goblin" },
  );
  // A verified profile with no display name falls back to the handle itself.
  assertEquals(
    leaderboardIdentity({ ...base, verified_enabled: true, verified_handle: "goblin" }),
    { alias: "goblin", handle: "goblin" },
  );
  // Then the referral alias, then the buyer alias — neither carries a handle,
  // because only a PUBLIC verified profile is something to link to.
  assertEquals(
    leaderboardIdentity({ ...base, referral_display_name: "Ref Alias" }),
    { alias: "Ref Alias", handle: null },
  );
  assertEquals(
    leaderboardIdentity({ ...base, rewards_display_name: "Buyer Alias" }),
    { alias: "Buyer Alias", handle: null },
  );
});

Deno.test("a handle is published only while the verified profile is ON", () => {
  assertEquals(
    leaderboardIdentity({
      leaderboard_opt_in: true,
      leaderboard_alias: "Picked",
      verified_enabled: false,
      verified_handle: "goblin",
    }),
    { alias: "Picked", handle: null },
  );
});

Deno.test("normalizeAlias trims, collapses and bounds", () => {
  assertEquals(normalizeAlias("  Thrift   Goblin  "), "Thrift Goblin");
  assertEquals(normalizeAlias(""), null);
  assertEquals(normalizeAlias(42), null);
  assertEquals(normalizeAlias("x".repeat(200))!.length, LEADERBOARD_ALIAS_MAX);
});

// ─── Ranking + anti-gaming ──────────────────────────────────────────────────

Deno.test("a zero score is not a rank", () => {
  // Registering aliases must not pad the tail or push a real competitor off the
  // visible page.
  const out = rankLeaderboard(
    [
      cand({ userId: "a", alias: "Real", score: 3 }),
      cand({ userId: "b", alias: "Empty", score: 0 }),
      cand({ userId: "c", alias: "Negative", score: -5 }),
      cand({ userId: "d", alias: "NaN", score: Number.NaN }),
    ],
    SITE,
    10,
  );
  assertEquals(out.map((e) => e.alias), ["Real"]);
});

Deno.test("ranking is score, then secondary, then account age, then alias", () => {
  const out = rankLeaderboard(
    [
      cand({ userId: "a", alias: "Zoe", score: 5, secondary: 1, since: "2026-01-01T00:00:00Z" }),
      cand({ userId: "b", alias: "Abe", score: 5, secondary: 2, since: "2026-05-01T00:00:00Z" }),
      cand({ userId: "c", alias: "Bea", score: 9, secondary: 0, since: "2026-05-01T00:00:00Z" }),
    ],
    SITE,
    10,
  );
  assertEquals(out.map((e) => e.alias), ["Bea", "Abe", "Zoe"]);

  // Same score AND same secondary ⇒ the older account first.
  const byAge = rankLeaderboard(
    [
      cand({ userId: "new", alias: "Zed", score: 4, since: "2026-06-01T00:00:00Z" }),
      cand({ userId: "old", alias: "Yan", score: 4, since: "2024-06-01T00:00:00Z" }),
    ],
    SITE,
    10,
  );
  assertEquals(byAge.map((e) => e.alias), ["Yan", "Zed"]);

  // Unknown account age sorts LAST, never first.
  const unknownAge = rankLeaderboard(
    [
      cand({ userId: "?", alias: "Nul", score: 4, since: null }),
      cand({ userId: "k", alias: "Kno", score: 4, since: "2026-06-01T00:00:00Z" }),
    ],
    SITE,
    10,
  );
  assertEquals(unknownAge.map((e) => e.alias), ["Kno", "Nul"]);
});

Deno.test("equal work shares a rank and the next rank skips", () => {
  const out = rankLeaderboard(
    [
      cand({ userId: "a", alias: "Ann", score: 9, secondary: 1, since: "2026-01-01T00:00:00Z" }),
      cand({ userId: "b", alias: "Bob", score: 9, secondary: 1, since: "2026-02-01T00:00:00Z" }),
      cand({ userId: "c", alias: "Cal", score: 4, secondary: 0, since: "2026-01-01T00:00:00Z" }),
    ],
    SITE,
    10,
  );
  assertEquals(out.map((e) => e.rank), [1, 1, 3]);
  assertEquals(out.map((e) => e.tied), [true, true, false]);
});

Deno.test("the page cap bounds what is published", () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    cand({ userId: `u${i}`, alias: `A${i}`, score: 50 - i }));
  assertEquals(rankLeaderboard(many, SITE, 10).length, 10);
  // A nonsensical cap still yields at least one row rather than an empty board.
  assertEquals(rankLeaderboard(many, SITE, 0).length, 1);
});

Deno.test("a profile URL is emitted only for a public handle", () => {
  const out = rankLeaderboard(
    [
      cand({ userId: "a", alias: "Linked", handle: "goblin" }),
      cand({ userId: "b", alias: "Plain", handle: null, score: 9 }),
    ],
    SITE,
    10,
  );
  const linked = out.find((e) => e.alias === "Linked")!;
  const plain = out.find((e) => e.alias === "Plain")!;
  assertEquals(linked.profile_url, `${SITE}/verified/goblin`);
  assertEquals(plain.profile_url, null);
});

Deno.test("viewerRank reports a true rank from beyond the visible page", () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    cand({ userId: `u${i}`, alias: `A${i}`, score: 100 - i }));
  const mine = viewerRank(many, SITE, "u40");
  assertEquals(mine?.rank, 41);
  assertEquals(mine?.is_you, true);
  // Not opted in / not scoring ⇒ no rank at all, never "last".
  assertEquals(viewerRank(many, SITE, null), null);
  assertEquals(viewerRank(many, SITE, "someone-else"), null);
  assertEquals(
    viewerRank([cand({ userId: "z", score: 0 })], SITE, "z"),
    null,
  );
});

// ─── URLs ───────────────────────────────────────────────────────────────────

Deno.test("leaderboardPath builds the paths the SSR function matches", () => {
  assertEquals(leaderboardPath(null), "/leaderboards");
  assertEquals(leaderboardPath("xp"), "/leaderboards/xp");
  assertEquals(
    leaderboardPath("grades", { brandSlug: "carhartt" }),
    "/leaderboards/grades/b/carhartt",
  );
  assertEquals(
    leaderboardPath("finds", { category: "outerwear" }),
    "/leaderboards/finds/c/outerwear",
  );
  // Brand wins when both are supplied — one facet per page, matching the SSR
  // path grammar, which has no shape for two.
  assertEquals(
    leaderboardPath("grades", { brandSlug: "carhartt", category: "outerwear" }),
    "/leaderboards/grades/b/carhartt",
  );
});
