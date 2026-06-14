// Unit tests for the publish-time topic-cluster interlinker (US-873).
//
// inferPillar / scoreRelatedPosts are pure, but content-interlink.ts imports the
// service-role supabase client at module load, so set dummy env BEFORE the
// dynamic import (mirrors content-social-publish_test).
//
//   deno test --allow-env src/tests/content-interlink_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  inferPillar,
  scoreRelatedPosts,
  normalizeKeywords,
  PILLAR_CORNERSTONE_URL,
  INTERLINK_MAX,
} = await import("../lib/content-interlink.ts");

// ── inferPillar ────────────────────────────────────────────

Deno.test("inferPillar: explicit pillar slug in the angle wins", () => {
  assertEquals(
    inferPillar({
      angle: "ladders to category-grading cluster",
      productFocus: "gradethread",
    }),
    "category-grading",
  );
});

Deno.test("inferPillar: inferred from keywords when angle is absent", () => {
  assertEquals(
    inferPillar({
      title: "How to spot pilling and seam wear on a knit",
      primaryKeyword: "fabric defect inspection",
      productFocus: "gradethread",
    }),
    "defect-taxonomy",
  );
});

Deno.test("inferPillar: scoped to the product focus pillar set", () => {
  // "ebay" hints belong to a FlipDesk pillar; a gradethread post can't pick it.
  const gt = inferPillar({
    title: "ebay listing titles that convert",
    productFocus: "gradethread",
  });
  assert(gt === null || !gt.startsWith("ebay"));

  assertEquals(
    inferPillar({
      title: "ebay listing titles and item specifics that convert",
      productFocus: "flipdesk",
    }),
    "ebay-listing-optimization",
  );
});

Deno.test("inferPillar: returns null when nothing matches", () => {
  assertEquals(
    inferPillar({ title: "", primaryKeyword: null, productFocus: "both" }),
    null,
  );
});

Deno.test("every GradeThread pillar maps to a real cornerstone path", () => {
  for (const slug of [
    "condition-vocabulary",
    "category-grading",
    "defect-taxonomy",
    "trust-psychology",
    "grading-photography",
    "price-by-grade",
  ]) {
    const url = PILLAR_CORNERSTONE_URL[slug];
    assert(url && url.startsWith("/"), `missing cornerstone for ${slug}`);
  }
});

// ── scoreRelatedPosts ──────────────────────────────────────

const CANDIDATES = [
  { id: "a", slug: "denim-grading", pillar: "category-grading", keywords: ["denim", "fade"] },
  { id: "b", slug: "knit-grading", pillar: "category-grading", keywords: ["knit", "pilling"] },
  { id: "c", slug: "what-is-nwot", pillar: "condition-vocabulary", keywords: ["nwot"] },
  { id: "d", slug: "leather-care", pillar: "category-grading", keywords: ["leather"] },
  { id: "e", slug: "old-post", pillar: null, keywords: ["misc"] },
];

Deno.test("scoreRelatedPosts: only links to existing candidate slugs, never self", () => {
  const source = {
    id: "src",
    pillar: "category-grading",
    keywords: ["denim", "fade"],
  };
  const links = scoreRelatedPosts(source, CANDIDATES);

  const candidateSlugs = new Set(CANDIDATES.map((c) => c.slug));
  assert(links.length >= 1);
  for (const l of links) {
    assert(candidateSlugs.has(l.slug), `${l.slug} is not an existing published slug`);
    assert(l.id !== source.id, "must never self-link");
  }
});

Deno.test("scoreRelatedPosts: excludes the source even if present in candidates", () => {
  const withSelf = [
    { id: "src", slug: "self", pillar: "category-grading", keywords: ["denim"] },
    ...CANDIDATES,
  ];
  const links = scoreRelatedPosts(
    { id: "src", pillar: "category-grading", keywords: ["denim"] },
    withSelf,
  );
  assert(!links.some((l) => l.id === "src"));
  assert(!links.some((l) => l.slug === "self"));
});

Deno.test("scoreRelatedPosts: dedupes by slug and caps at the max", () => {
  const dupes = [
    ...CANDIDATES,
    { id: "a2", slug: "denim-grading", pillar: "category-grading", keywords: ["denim"] },
  ];
  const links = scoreRelatedPosts(
    { id: "src", pillar: "category-grading", keywords: ["denim", "knit", "leather", "nwot", "fade", "pilling"] },
    dupes,
  );
  const slugs = links.map((l) => l.slug);
  assertEquals(new Set(slugs).size, slugs.length, "no duplicate slugs");
  assert(links.length <= INTERLINK_MAX);
});

Deno.test("scoreRelatedPosts: ranks shared-pillar + shared-keyword highest", () => {
  const links = scoreRelatedPosts(
    { id: "src", pillar: "category-grading", keywords: ["denim", "fade"] },
    CANDIDATES,
  );
  // 'a' (same pillar + 2 shared keywords) must rank first.
  assertEquals(links[0]?.slug, "denim-grading");
});

Deno.test("scoreRelatedPosts: backfills toward the minimum when few relate", () => {
  // A source that relates to nothing still gets backfilled to the min of 3.
  const links = scoreRelatedPosts(
    { id: "src", pillar: "grading-photography", keywords: ["lighting"] },
    CANDIDATES,
  );
  assert(links.length >= 3, `expected backfill to >=3, got ${links.length}`);
  const candidateSlugs = new Set(CANDIDATES.map((c) => c.slug));
  for (const l of links) assert(candidateSlugs.has(l.slug));
});

// ── normalizeKeywords ──────────────────────────────────────

Deno.test("normalizeKeywords: lowercases, trims, dedupes, drops empties", () => {
  assertEquals(
    normalizeKeywords("  Denim  ", ["FADE", "denim", "", "  "]),
    ["denim", "fade"],
  );
});
