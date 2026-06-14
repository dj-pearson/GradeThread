import { supabaseAdmin } from "./supabase.ts";

// Automated internal topic-cluster interlinking at publish (US-873).
//
// Internal linking around topic clusters is one of the strongest topical-
// authority signals, but today it happens only by hand on the cornerstone
// pillar pages (US-855). At publish we:
//
//   1. infer the post's PILLAR (the seo.pillars cluster it ladders to) from the
//      originating topic's `angle` or its keywords, and persist it on the row so
//      "all spokes for a pillar" is a trivial `WHERE pillar = $1` query;
//   2. pick the 3–6 most semantically related *already-published* posts (same
//      pillar + shared keywords, scoped to a compatible product_focus) and write
//      them to `blog_post_links` as the curated related-links graph;
//   3. record the hub-and-spoke uplink (post → its cornerstone pillar page).
//
// The link set is rebuilt from scratch on every publish (delete-by-source then
// insert), so re-publishing an edited post refreshes it without duplicates.
//
// Targets are ALWAYS drawn from a `status = 'published'` query, so a generated
// post can only ever link to existing published slugs — never to a draft, an
// archived post, or itself. The public SSR (content-public.fetchRelated) reads
// this graph and prefers it over the tag-based fallback, so the two never double
// up. The pure scoring/inference helpers below are unit-tested in
// tests/content-interlink_test.ts.

// ── Pillar map (seo.pillars, seeded in 00191) ─────────────────────────────
// GradeThread pillars each have a cornerstone page (US-855); FlipDesk pillars
// don't yet, so a FlipDesk post is still pillar-tagged but gets no uplink row.
export const GRADETHREAD_PILLARS = [
  "condition-vocabulary",
  "category-grading",
  "defect-taxonomy",
  "trust-psychology",
  "grading-photography",
  "price-by-grade",
] as const;

export const FLIPDESK_PILLARS = [
  "ebay-listing-optimization",
  "thrift-sourcing",
  "reseller-finances",
  "inventory-ops",
  "crosslisting",
  "tooling-automation",
  "returns-reconciliation",
] as const;

export const PILLAR_SLUGS: readonly string[] = [
  ...GRADETHREAD_PILLARS,
  ...FLIPDESK_PILLARS,
];

// pillar slug → cornerstone page path (US-855). Only GradeThread pillars map.
export const PILLAR_CORNERSTONE_URL: Record<string, string> = {
  "condition-vocabulary": "/condition-grading",
  "category-grading": "/grading-by-category",
  "defect-taxonomy": "/design-vs-damage",
  "trust-psychology": "/reduce-returns",
  "grading-photography": "/reseller-grading-guide",
  "price-by-grade": "/resale-value-by-condition",
};

// Human label for the visible "Part of our … guide" uplink.
export const PILLAR_LABELS: Record<string, string> = {
  "condition-vocabulary": "Condition Grading",
  "category-grading": "Grading by Category",
  "defect-taxonomy": "Design vs. Damage",
  "trust-psychology": "Reduce Returns",
  "grading-photography": "Reseller Grading Guide",
  "price-by-grade": "Resale Value by Condition",
};

// Keyword hints used to infer a pillar when the topic angle doesn't already
// name one. Matched as substrings against the lowercased title + keywords.
const PILLAR_HINTS: Record<string, string[]> = {
  "condition-vocabulary": [
    "nwt", "nwot", "excellent", "very good", "fair condition", "poor condition",
    "condition grade", "grade tier", "what does", "what is", "mean", "vocabulary",
  ],
  "category-grading": [
    "denim", "jean", "knit", "sweater", "leather", "vintage", "tee", "t-shirt",
    "suit", "shoe", "sneaker", "outerwear", "jacket", "coat", "activewear",
    "dress", "category",
  ],
  "defect-taxonomy": [
    "pilling", "fading", "stain", "seam", "odor", "smell", "repair", "shrinkage",
    "defect", "damage", "wear", "hole", "fabric integrity", "snag", "fray",
  ],
  "trust-psychology": [
    "trust", "return rate", "returns", "dispute", "not as described", "inr",
    "buyer confidence", "standardized", "reduce returns",
  ],
  "grading-photography": [
    "photo", "photograph", "lighting", "angle", "flatlay", "camera", "shot",
    "label shot", "tag shot",
  ],
  "price-by-grade": [
    "price", "pricing", "value", "worth", "resale value", "realization",
    "profit margin", "by condition",
  ],
  "ebay-listing-optimization": [
    "ebay", "listing title", "item specific", "store strategy", "optimize listing",
  ],
  "thrift-sourcing": [
    "thrift", "sourcing", "source", "route", "goodwill", "estate sale",
    "yard sale", "bins",
  ],
  "reseller-finances": [
    "p&l", "cost basis", "tax", "1099", "cogs", "accounting", "profit and loss",
  ],
  "inventory-ops": [
    "inventory", "sku", "bin location", "throughput", "organize inventory",
  ],
  "crosslisting": [
    "crosslist", "cross-list", "poshmark", "mercari", "depop", "grailed",
  ],
  "tooling-automation": [
    "spreadsheet", "automation", "automate", "tooling", "workflow",
  ],
  "returns-reconciliation": [
    "reconcile", "reconciliation", "payout", "partial refund", "inr handling",
  ],
};

export type ContentProductFocus = "gradethread" | "flipdesk" | "both";

// Pillars eligible for a given product focus (a FlipDesk post shouldn't be
// tagged with a grading pillar and vice-versa; `both` can use either set).
function pillarsForFocus(focus: string | null | undefined): readonly string[] {
  if (focus === "gradethread") return GRADETHREAD_PILLARS;
  if (focus === "flipdesk") return FLIPDESK_PILLARS;
  return PILLAR_SLUGS; // "both" / unknown → all
}

export interface InferPillarInput {
  angle?: string | null;
  title?: string | null;
  primaryKeyword?: string | null;
  secondaryKeywords?: string[] | null;
  productFocus?: string | null;
}

/**
 * Infer which seo.pillars cluster a post ladders to. Prefers an explicit pillar
 * slug named in the topic `angle` (the seeded rule: "every new blog topic must
 * declare a pillar in its angle"); otherwise scores keyword hints against the
 * title + keywords. Returns null when nothing matches (the post is published
 * without a pillar uplink rather than guessing wrong). Pure / no I/O.
 */
export function inferPillar(input: InferPillarInput): string | null {
  const eligible = pillarsForFocus(input.productFocus);

  // 1. Explicit pillar slug named in the angle wins.
  const angle = (input.angle ?? "").toLowerCase();
  if (angle) {
    for (const slug of eligible) {
      if (angle.includes(slug)) return slug;
    }
  }

  // 2. Score keyword hints against the post's own text.
  const haystack = [
    input.title ?? "",
    input.primaryKeyword ?? "",
    ...(input.secondaryKeywords ?? []),
    angle,
  ]
    .join(" ")
    .toLowerCase();
  if (!haystack.trim()) return null;

  let best: string | null = null;
  let bestScore = 0;
  for (const slug of eligible) {
    const hints = PILLAR_HINTS[slug] ?? [];
    let score = 0;
    for (const hint of hints) {
      if (haystack.includes(hint)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = slug;
    }
  }
  return bestScore > 0 ? best : null;
}

// Normalize a primary keyword + secondary keyword array into a deduped set of
// lowercased phrases used for shared-keyword scoring.
export function normalizeKeywords(
  primary: string | null | undefined,
  secondary: string[] | null | undefined,
): string[] {
  const out = new Set<string>();
  const add = (s: string | null | undefined) => {
    const v = (s ?? "").trim().toLowerCase();
    if (v) out.add(v);
  };
  add(primary);
  for (const s of secondary ?? []) add(s);
  return [...out];
}

export interface InterlinkSource {
  id: string;
  pillar: string | null;
  keywords: string[];
}

export interface InterlinkCandidate {
  id: string;
  slug: string;
  pillar: string | null;
  keywords: string[];
}

export interface ScoredLink {
  id: string;
  slug: string;
  score: number;
}

export const INTERLINK_MIN = 3;
export const INTERLINK_MAX = 6;

/**
 * Rank candidate posts by semantic relatedness to a source post and return the
 * 3–6 best as the related-links set. Scoring: same pillar (+3) plus one point
 * per shared keyword phrase. Never links to itself, dedupes by slug, and (since
 * every candidate is sourced from a published-posts query) can only ever return
 * existing published slugs.
 *
 * If fewer than INTERLINK_MIN candidates are positively related, the set is
 * backfilled with same-focus candidates (carried in their input order, which the
 * caller orders newest-first) so even an early post still interlinks — but the
 * set is never padded beyond what real candidates exist. Pure / no I/O.
 */
export function scoreRelatedPosts(
  source: InterlinkSource,
  candidates: InterlinkCandidate[],
  opts: { min?: number; max?: number } = {},
): ScoredLink[] {
  const min = opts.min ?? INTERLINK_MIN;
  const max = opts.max ?? INTERLINK_MAX;
  const srcKw = new Set(source.keywords);

  const seen = new Set<string>();
  const usable: Array<{ id: string; slug: string; score: number; order: number }> = [];
  candidates.forEach((c, order) => {
    if (!c.id || !c.slug) return;
    if (c.id === source.id) return; // never self
    if (seen.has(c.slug)) return; // dedupe by slug
    seen.add(c.slug);
    let score = 0;
    if (source.pillar && c.pillar && c.pillar === source.pillar) score += 3;
    for (const k of c.keywords) {
      if (srcKw.has(k)) score += 1;
    }
    usable.push({ id: c.id, slug: c.slug, score, order });
  });

  const related = usable.filter((c) => c.score > 0);
  related.sort((a, b) => (b.score - a.score) || (a.order - b.order));

  // Backfill toward the minimum with the next most-recent same-focus posts.
  if (related.length < min) {
    const have = new Set(related.map((r) => r.slug));
    const filler = usable
      .filter((c) => c.score === 0 && !have.has(c.slug))
      .sort((a, b) => a.order - b.order);
    for (const f of filler) {
      if (related.length >= min) break;
      related.push(f);
    }
  }

  return related.slice(0, max).map((r) => ({ id: r.id, slug: r.slug, score: r.score }));
}

export interface InterlinkPost {
  id: string;
  slug: string;
  title: string;
  product_focus: string;
  primary_keyword: string | null;
  secondary_keywords: string[] | null;
  topic_id: string | null;
  pillar?: string | null;
}

export interface InterlinkResult {
  pillar: string | null;
  relatedCount: number;
  cornerstone: string | null;
}

/**
 * Publish-time orchestration: infer + persist the pillar, then rebuild the
 * post's outbound link graph (related spokes + cornerstone uplink) in
 * blog_post_links. Best-effort — callers `.catch(log)` so a failure never aborts
 * the publish.
 */
export async function applyInterlinks(post: InterlinkPost): Promise<InterlinkResult> {
  // 1. Resolve the pillar (topic angle first, then keyword inference).
  let angle: string | null = null;
  if (post.topic_id) {
    const { data } = await supabaseAdmin
      .from("content_topics")
      .select("angle")
      .eq("id", post.topic_id)
      .maybeSingle();
    angle = (data?.angle as string | null) ?? null;
  }
  const pillar = inferPillar({
    angle,
    title: post.title,
    primaryKeyword: post.primary_keyword,
    secondaryKeywords: post.secondary_keywords,
    productFocus: post.product_focus,
  });

  // Persist the pillar so the cornerstone→spokes direction is queryable.
  if (pillar && pillar !== post.pillar) {
    await supabaseAdmin.from("blog_posts").update({ pillar }).eq("id", post.id);
  }

  // 2. Candidate pool: published posts in a compatible product focus.
  const focusFilter =
    post.product_focus === "both"
      ? ["gradethread", "flipdesk", "both"]
      : [post.product_focus, "both"];
  const { data: rows } = await supabaseAdmin
    .from("blog_posts")
    .select("id, slug, pillar, primary_keyword, secondary_keywords, published_at")
    .eq("status", "published")
    .in("product_focus", focusFilter)
    .neq("id", post.id)
    .order("published_at", { ascending: false })
    .limit(500);

  const candidates: InterlinkCandidate[] = (rows ?? []).map((r) => ({
    id: r.id as string,
    slug: r.slug as string,
    pillar: (r.pillar as string | null) ?? null,
    keywords: normalizeKeywords(
      r.primary_keyword as string | null,
      r.secondary_keywords as string[] | null,
    ),
  }));

  const source: InterlinkSource = {
    id: post.id,
    pillar,
    keywords: normalizeKeywords(post.primary_keyword, post.secondary_keywords),
  };
  const related = scoreRelatedPosts(source, candidates);

  // 3. Rebuild the link graph idempotently (delete-by-source then insert).
  await supabaseAdmin.from("blog_post_links").delete().eq("source_post_id", post.id);

  const cornerstone = pillar ? PILLAR_CORNERSTONE_URL[pillar] ?? null : null;
  const inserts: Array<Record<string, unknown>> = related.map((r, i) => ({
    source_post_id: post.id,
    target_post_id: r.id,
    target_url: null,
    relation: "related",
    pillar,
    rank: i,
  }));
  if (cornerstone) {
    inserts.push({
      source_post_id: post.id,
      target_post_id: null,
      target_url: cornerstone,
      relation: "pillar",
      pillar,
      rank: 0,
    });
  }
  if (inserts.length > 0) {
    const { error } = await supabaseAdmin.from("blog_post_links").insert(inserts);
    if (error) console.error("[content-interlink] insert failed:", error);
  }

  return { pillar, relatedCount: related.length, cornerstone };
}
