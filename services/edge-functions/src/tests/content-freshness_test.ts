// US-875: unit tests for the content-freshness selection + material-change math.
//
// rankStalePosts / pickStalePost / materialChangeRatio are pure (clock injected),
// so the staleness ranking, the thrash guard, the minimum-staleness floor, the
// GSC-vs-fallback importance, and the trivial-diff cutoff are all asserted here
// without any DB or AI.
//
//   deno test src/tests/content-freshness_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  fallbackImportance,
  type FreshnessPost,
  gscImportance,
  htmlToWords,
  materialChangeRatio,
  pickStalePost,
  rankStalePosts,
} from "../lib/content-freshness.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed epoch ms

function daysAgo(n: number): string {
  return new Date(NOW - n * DAY).toISOString();
}

const OPTS = { cooldownDays: 30, minStaleDays: 30 };

function post(over: Partial<FreshnessPost> & { id: string; slug: string }): FreshnessPost {
  return {
    published_at: daysAgo(60),
    last_refreshed_at: null,
    reading_time_min: 5,
    ...over,
  };
}

Deno.test("ranks the oldest post first when importance is equal", () => {
  const posts = [
    post({ id: "a", slug: "a", published_at: daysAgo(40), reading_time_min: 5 }),
    post({ id: "b", slug: "b", published_at: daysAgo(90), reading_time_min: 5 }),
    post({ id: "c", slug: "c", published_at: daysAgo(60), reading_time_min: 5 }),
  ];
  const ranked = rankStalePosts(posts, new Map(), NOW, OPTS);
  assertEquals(ranked.map((r) => r.id), ["b", "c", "a"]);
});

Deno.test("thrash guard: a post refreshed within the cooldown is ineligible", () => {
  const posts = [
    // old but refreshed 5 days ago → blocked by 30-day cooldown
    post({ id: "fresh", slug: "fresh", published_at: daysAgo(200), last_refreshed_at: daysAgo(5) }),
    // old and never refreshed → eligible
    post({ id: "stale", slug: "stale", published_at: daysAgo(45), last_refreshed_at: null }),
  ];
  const ranked = rankStalePosts(posts, new Map(), NOW, OPTS);
  const picked = pickStalePost(ranked);
  assertEquals(picked?.id, "stale");
  // The cooled-down post is present but not eligible.
  assertEquals(ranked.find((r) => r.id === "fresh")?.eligible, false);
});

Deno.test("minimum-staleness floor: brand-new posts are ineligible", () => {
  const posts = [
    post({ id: "new", slug: "new", published_at: daysAgo(10) }), // < 30d
  ];
  const ranked = rankStalePosts(posts, new Map(), NOW, OPTS);
  assertEquals(ranked[0].eligible, false);
  assertEquals(pickStalePost(ranked), null);
});

Deno.test("uses last_refreshed_at as the freshness anchor when present", () => {
  const posts = [
    // published long ago but refreshed 40d ago → eligible (>30d cooldown, >30d stale)
    post({ id: "x", slug: "x", published_at: daysAgo(300), last_refreshed_at: daysAgo(40) }),
  ];
  const ranked = rankStalePosts(posts, new Map(), NOW, OPTS);
  // ageDays measured from the 40-day-old refresh, not the 300-day publish.
  assert(Math.abs(ranked[0].ageDays - 40) < 0.01);
  assertEquals(ranked[0].eligible, true);
});

Deno.test("GSC importance outranks an older but low-traffic post", () => {
  const posts = [
    post({ id: "old", slug: "old", published_at: daysAgo(80), reading_time_min: 3 }),
    post({ id: "hot", slug: "hot", published_at: daysAgo(60), reading_time_min: 3 }),
  ];
  // 'hot' has heavy GSC traffic; 'old' has none.
  const gsc = new Map<string, number>([["hot", 5000], ["old", 0]]);
  const ranked = rankStalePosts(posts, gsc, NOW, OPTS);
  // hot: 60 * gscImportance(5000,5000)=3 → 180.
  // old: 80 * fallback(3)=1.2 → 96. Traffic wins despite hot being younger.
  assertEquals(pickStalePost(ranked)?.id, "hot");
});

Deno.test("degrades gracefully to reading-time fallback when GSC is empty", () => {
  const posts = [
    post({ id: "short", slug: "short", published_at: daysAgo(60), reading_time_min: 2 }),
    post({ id: "long", slug: "long", published_at: daysAgo(60), reading_time_min: 15 }),
  ];
  const ranked = rankStalePosts(posts, new Map(), NOW, OPTS);
  // Same age → the longer (more pillar-like) article wins.
  assertEquals(ranked[0].id, "long");
});

Deno.test("fallbackImportance is bounded 1..2 and monotonic", () => {
  assertEquals(fallbackImportance(0), 1);
  assertEquals(fallbackImportance(null), 1);
  assertEquals(fallbackImportance(15), 2);
  assertEquals(fallbackImportance(100), 2); // capped
  assert(fallbackImportance(8) > fallbackImportance(2));
});

Deno.test("gscImportance is bounded 1..3", () => {
  assertEquals(gscImportance(0, 100), 1);
  assertEquals(gscImportance(100, 100), 3);
  assertEquals(gscImportance(50, 100), 2);
  assertEquals(gscImportance(10, 0), 1); // no max → neutral
});

Deno.test("posts with no usable date are dropped", () => {
  const posts: FreshnessPost[] = [
    { id: "nodate", slug: "nodate", published_at: null, last_refreshed_at: null, reading_time_min: 5 },
  ];
  const ranked = rankStalePosts(posts, new Map(), NOW, OPTS);
  assertEquals(ranked.length, 0);
});

// ── material change ──────────────────────────────────────────

Deno.test("htmlToWords strips tags and entities", () => {
  assertEquals(htmlToWords("<p>Hello&nbsp;<b>World</b></p>"), ["hello", "world"]);
});

Deno.test("identical bodies are not material", () => {
  const html = "<p>" + "word ".repeat(200) + "</p>";
  const r = materialChangeRatio(html, html);
  assertEquals(r.material, false);
  assertEquals(r.changedRatio, 0);
});

Deno.test("formatting-only change is not material", () => {
  const a = "<p>the quick brown fox jumps over the lazy dog</p>";
  const b = "<div><strong>the quick brown fox jumps over the lazy dog</strong></div>";
  assertEquals(materialChangeRatio(a, b).material, false);
});

Deno.test("a one-word typo fix in a long article is not material", () => {
  const base = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
  const a = `<p>${base} teh</p>`;
  const b = `<p>${base} the</p>`;
  const r = materialChangeRatio(a, b);
  assert(r.changedRatio < 0.1);
  assertEquals(r.material, false);
});

Deno.test("substantial expansion is material via growth", () => {
  const base = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const extra = Array.from({ length: 60 }, (_, i) => `new${i}`).join(" ");
  const a = `<p>${base}</p>`;
  const b = `<p>${base}</p><h2>More</h2><p>${extra}</p>`;
  const r = materialChangeRatio(a, b);
  assert(r.growthRatio >= 0.08);
  assertEquals(r.material, true);
});

Deno.test("heavy rewrite is material via changed words", () => {
  const a = `<p>${Array.from({ length: 100 }, (_, i) => `alpha${i}`).join(" ")}</p>`;
  const b = `<p>${Array.from({ length: 100 }, (_, i) => `beta${i}`).join(" ")}</p>`;
  const r = materialChangeRatio(a, b);
  assert(r.changedRatio >= 0.1);
  assertEquals(r.material, true);
});
