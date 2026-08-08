// US-1855: the public Showcase / "Finds" feed — pure logic.
//
// Everything here is a total function of its inputs (no DB, no env, no fetch) so
// the feed's rules — what a brand facet URL is, how trending is ranked, what a
// public find row may contain — are unit-testable without a database.
//
// The IMPURE half (queries, consent enforcement, reaction writes) lives in
// routes/content-public.ts (public reads) and routes/showcase.ts (owner writes).

/** One row of `public_showcase_finds`, as PostgREST returns it. */
export interface ShowcaseFindRow {
  grade_report_id: string;
  certificate_id: string;
  overall_score: number;
  grade_tier: string;
  graded_at: string;
  showcased_at: string;
  title: string | null;
  brand: string | null;
  brand_slug: string | null;
  category: string | null;
  garment_type: string | null;
  value_cents: number | null;
  seller_handle: string | null;
  seller_display_name: string | null;
}

/** A find as the public API serves it. */
export interface PublicFind {
  id: string;
  certificate_id: string;
  certificate_url: string;
  image_url: string;
  title: string;
  brand: string | null;
  brand_slug: string | null;
  category: string | null;
  overall_score: number;
  grade_tier: string;
  value_cents: number | null;
  showcased_at: string;
  seller_handle: string | null;
  seller_display_name: string | null;
  seller_url: string | null;
  reactions: number;
}

export type FindsSort = "trending" | "recent" | "top_graded";

export interface FindsQuery {
  sort: FindsSort;
  brandSlug: string | null;
  category: string | null;
  minGrade: number | null;
  limit: number;
}

export const FINDS_DEFAULT_LIMIT = 24;
export const FINDS_MAX_LIMIT = 60;
/**
 * How many consented rows one feed request may scan before ranking. The feed is
 * opt-in (a bounded set), and trending has to see more than one page to rank it,
 * so the scan ceiling is deliberately well above the page size.
 */
export const FINDS_SCAN_LIMIT = 600;

/**
 * URL-safe brand key. MUST agree with the `brand_slug` expression in migration
 * 00546 (`public_showcase_finds`) — the SQL side is what a facet request filters
 * on, this side is what builds the link, and a mismatch would render links that
 * return an empty page. A test pins the two rule sets to the same examples.
 */
export function brandSlug(brand: string | null | undefined): string | null {
  if (typeof brand !== "string") return null;
  const slug = brand
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

/** Parse a raw query string into a validated, bounded feed query. */
export function parseFindsQuery(params: URLSearchParams): FindsQuery {
  const rawSort = params.get("sort");
  const sort: FindsSort = rawSort === "recent"
    ? "recent"
    : rawSort === "top_graded"
    ? "top_graded"
    : "trending";

  const brandSlugParam = brandSlug(params.get("brand_slug") ?? params.get("brand"));

  // garment_category is an enum on the base table; anything not slug-shaped
  // cannot match a value, so drop it rather than sending junk to PostgREST.
  const rawCategory = (params.get("category") ?? "").trim().toLowerCase();
  const category = /^[a-z0-9_]{1,40}$/.test(rawCategory) ? rawCategory : null;

  const rawMin = Number(params.get("min_grade"));
  const minGrade = Number.isFinite(rawMin) && rawMin > 1 && rawMin <= 10
    ? Math.round(rawMin * 10) / 10
    : null;

  const rawLimit = Number(params.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(FINDS_MAX_LIMIT, Math.floor(rawLimit))
    : FINDS_DEFAULT_LIMIT;

  return { sort, brandSlug: brandSlugParam, category, minGrade, limit };
}

/** Half-life, in days, of a find's trending freshness term. */
export const TRENDING_HALF_LIFE_DAYS = 3;

/**
 * Trending score: reactions decayed by how long ago the find was showcased.
 *
 * A pure count would freeze the feed — the earliest finds accumulate reactions
 * forever and nothing new can ever outrank them. The decay makes attention
 * perishable, so a find that just landed and got a handful of reactions can beat
 * one that got twice as many a fortnight ago. The +1 keeps a brand-new,
 * zero-reaction find above nothing at all rather than tied with every other zero.
 */
export function trendingScore(
  reactions: number,
  showcasedAtIso: string,
  nowMs: number,
): number {
  const at = Date.parse(showcasedAtIso);
  const ageDays = Number.isFinite(at) ? Math.max(0, (nowMs - at) / 86_400_000) : 0;
  const decay = Math.pow(0.5, ageDays / TRENDING_HALF_LIFE_DAYS);
  return (reactions + 1) * decay;
}

/** Sort a projected page of finds. Pure; does not mutate the input. */
export function rankFinds(
  finds: PublicFind[],
  sort: FindsSort,
  nowMs: number,
): PublicFind[] {
  const out = [...finds];
  if (sort === "recent") {
    out.sort((a, b) => b.showcased_at.localeCompare(a.showcased_at));
    return out;
  }
  if (sort === "top_graded") {
    out.sort((a, b) =>
      b.overall_score - a.overall_score ||
      b.showcased_at.localeCompare(a.showcased_at)
    );
    return out;
  }
  out.sort((a, b) => {
    const diff = trendingScore(b.reactions, b.showcased_at, nowMs) -
      trendingScore(a.reactions, a.showcased_at, nowMs);
    if (diff !== 0) return diff;
    return b.showcased_at.localeCompare(a.showcased_at);
  });
  return out;
}

/**
 * Project one view row into the public payload.
 *
 * The image is the STABLE `/cert-photo/<certId>/0` proxy, never a signed storage
 * URL: signed URLs expire in 15 minutes, so a feed card (or a crawler reading
 * the JSON-LD `image`) would show a 403 the moment the page outlived the
 * signature. The proxy re-signs per request behind the same publicity gate.
 */
export function projectFind(
  row: ShowcaseFindRow,
  reactions: number,
  siteUrl: string,
): PublicFind {
  const handle = row.seller_handle;
  return {
    id: row.grade_report_id,
    certificate_id: row.certificate_id,
    certificate_url: `${siteUrl}/cert/${row.certificate_id}`,
    image_url: `${siteUrl}/cert-photo/${row.certificate_id}/0`,
    title: row.title?.trim() || "Graded find",
    brand: row.brand,
    brand_slug: row.brand_slug ?? brandSlug(row.brand),
    category: row.category,
    overall_score: Number(row.overall_score),
    grade_tier: row.grade_tier,
    value_cents: typeof row.value_cents === "number" ? row.value_cents : null,
    showcased_at: row.showcased_at,
    seller_handle: handle,
    seller_display_name: row.seller_display_name,
    seller_url: handle ? `${siteUrl}/verified/${handle}` : null,
    reactions,
  };
}

export interface FindFacet {
  label: string;
  slug: string;
  count: number;
}

/** Brand facets, most-used first, derived from the scanned rows. */
export function brandFacets(rows: ShowcaseFindRow[], max = 24): FindFacet[] {
  const byLabel = new Map<string, FindFacet>();
  for (const r of rows) {
    const slug = r.brand_slug ?? brandSlug(r.brand);
    if (!slug || !r.brand) continue;
    const existing = byLabel.get(slug);
    if (existing) existing.count += 1;
    else byLabel.set(slug, { label: r.brand, slug, count: 1 });
  }
  return [...byLabel.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, max);
}

/** Category facets, most-used first. Categories are already slug-shaped. */
export function categoryFacets(rows: ShowcaseFindRow[], max = 24): FindFacet[] {
  const byKey = new Map<string, FindFacet>();
  for (const r of rows) {
    const key = r.category;
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) existing.count += 1;
    else byKey.set(key, { label: key.replace(/_/g, " "), slug: key, count: 1 });
  }
  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, max);
}

export interface ShowcaseLeader {
  handle: string;
  display_name: string;
  finds: number;
  reactions: number;
}

/**
 * The community leaderboard the Showcase feeds (AC3): sellers ranked by the
 * reactions their consented finds earned.
 *
 * Only sellers who run a PUBLIC verified profile can be ranked — a seller who
 * showcased a find anonymously consented to the find being seen, not to being
 * named on a leaderboard. Same rule the referral leaderboard follows.
 */
export function showcaseLeaderboard(
  finds: PublicFind[],
  max = 10,
): ShowcaseLeader[] {
  const byHandle = new Map<string, ShowcaseLeader>();
  for (const f of finds) {
    if (!f.seller_handle) continue;
    const existing = byHandle.get(f.seller_handle);
    if (existing) {
      existing.finds += 1;
      existing.reactions += f.reactions;
    } else {
      byHandle.set(f.seller_handle, {
        handle: f.seller_handle,
        display_name: f.seller_display_name ?? f.seller_handle,
        finds: 1,
        reactions: f.reactions,
      });
    }
  }
  return [...byHandle.values()]
    .sort((a, b) =>
      b.reactions - a.reactions || b.finds - a.finds ||
      a.handle.localeCompare(b.handle)
    )
    .slice(0, max);
}
