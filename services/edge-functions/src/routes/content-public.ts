import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { decodeTagCode } from "../lib/brand-decoders.ts";
import {
  canonicalStyleCode,
  MIN_STYLE_CODE_LENGTH,
} from "../lib/style-code-observations.ts";
import {
  pickStyleCodeName,
  type StyleCodeNameRow,
} from "../lib/style-code-names.ts";
import {
  indexableCodes,
  normalizeSubmittedName,
  pickSubmittedName,
  PUBLIC_LOOKUP_BRAND_KEY,
  publicStyleCode,
  type SitemapCandidateRow,
  submissionRefusal,
  type SubmittedNameRow,
} from "../lib/public-style-code.ts";
import { PUBLIC_MIN_SUBMISSIONS } from "../lib/style-code-names.ts";

/** US-2748: the sitemap cap. Generous — the indexable set is the codes we can
 *  NAME, which is far smaller than the codes we have seen. warnIfCapped says so
 *  when it binds, because a silently-truncated sitemap tells crawlers that the
 *  missing URLs do not exist. */
const STYLE_CODE_SITEMAP_CAP = 20_000;
/** US-9032: the registry is seeded from ~180 known brands plus resolved
 *  sightings, so this cap is headroom rather than a real ceiling today. */
const RN_SITEMAP_CAP = 5_000;
import {
  indexableNumbers,
  publicRegisteredNumber,
  type RegistryRowForPublic,
  type SitemapNumberRow,
} from "../lib/public-registered-number.ts";
import { parseRegisteredNumber, registeredNumberKey } from "../lib/registered-numbers.ts";
import { filterListablePhotos } from "../lib/item-photo-storage.ts";
import { verifyPreviewToken } from "../lib/preview-token.ts";
import { verifyCertIntegrity } from "../lib/cert-integrity.ts";
import { isCertificateWithheld } from "../lib/certificate-visibility.ts";
import {
  buildCertGallery,
  galleryRowAt,
  selectHeroUrl,
  type SubmissionImageRow as CertSubmissionImageRow,
} from "../lib/certificate-gallery.ts";
import { normalizeCertNumber } from "../lib/cert-number.ts";
import { certDisplayTitle } from "../lib/cert-display-title.ts";
import { certDescriptionText } from "../lib/cert-description.ts";
import {
  resolveRevisionChain,
  type RevisionResolution,
  revisionMessage,
  type RevisionRow,
} from "../lib/cert-revision.ts";
import {
  CERTIFICATE_REPORT_REASONS,
  composeCertificateReportReason,
  enqueueModerationFlag,
  isCertificateReportReason,
  resolveCertificateOwner,
} from "../lib/moderation-queue.ts";
import { buildPublicProfile, normalizeVisibility } from "../lib/buyer-profile.ts";
import {
  type CertImageData,
  fetchImageDataUri,
  isSellerBadgeFormat,
  renderAchievementBadge,
  renderCertImage,
  renderSellerBadge,
  type SellerBadgeFormat,
  type SlabFormat,
  SLAB_FORMATS,
} from "../lib/cert-image-render.ts";
import {
  buildBadgeStatusLine,
  FALLBACK_PNG_BASE64,
  isCardFrameKey,
} from "../lib/cert-og-template.ts";
import { captureException, readCtxVar } from "../lib/observability.ts";
import { rankReferrers } from "../lib/referral-rewards.ts";
import { isBadgeTargetType, recordBadgeClick } from "../lib/badge-analytics.ts";
import { visitorFingerprint } from "../lib/share-to-earn.ts";
import { clientIp } from "../middleware/rate-limit.ts";
import {
  badgeByKey,
  type PublicAchievement,
  publicAchievements,
} from "../lib/rewards-badges.ts";
import { grantReward, isOffPlatformEmbedReferer } from "../lib/rewards-engine.ts";
import { isFrameUnlocked, publicLevelFlair, tierForLevel } from "../lib/rewards-levels.ts";
import {
  loadPublicSellerIntegrity,
  loadSellerBadgeStanding,
} from "../lib/buyer-grade-confirmation.ts";
import { projectTrustSignals } from "../lib/buyer-trust-signals.ts";
import {
  brandFacets,
  categoryFacets,
  FINDS_SCAN_LIMIT,
  parseFindsQuery,
  projectFind,
  rankFinds,
  type ShowcaseFindRow,
  showcaseLeaderboard,
} from "../lib/showcase.ts";
import {
  LEADERBOARD_HUB_LIMIT,
  LEADERBOARD_METRICS,
  type LeaderboardMetric,
  type LeaderboardMetricKey,
  leaderboardPath,
  parseLeaderboardQuery,
  rankLeaderboard,
} from "../lib/leaderboards.ts";
import { boardWindow, loadBoard, loadCohort } from "../lib/leaderboards-data.ts";
import { loadSeasonTimezone } from "../lib/rewards-seasons.ts";
import { PILLAR_CORNERSTONE_URL, PILLAR_LABELS } from "../lib/content-interlink.ts";

// US-580: these endpoints are anonymous/unauthenticated, so a 500 body must
// NEVER carry raw error.message — that leaks DB/PostgREST internals (table
// names, column names, constraint text) to the public. Log the detail
// server-side (redacted + reported to the tracker, correlated to the access-log
// line by request id, mirroring the global app.onError in main.ts) and return a
// generic body to the caller.
function publicError(c: Context, err: unknown, label: string): Response {
  let path = c.req.path;
  try {
    path = new URL(c.req.url).pathname;
  } catch { /* keep c.req.path */ }
  captureException(err, {
    route: `${c.req.method} ${path}`,
    method: c.req.method,
    url: `${path} (${label})`,
    correlationId: readCtxVar(c, "correlationId"),
  });
  console.error(
    `content-public ${label}:`,
    err instanceof Error ? err.message : String(err),
  );
  return c.json({ error: "Internal error" }, 500);
}

/**
 * Is this a syntactically valid UUID?
 *
 * certificate_id is a uuid COLUMN, so passing anything else straight into
 * `.eq()` makes Postgres raise 22P02 ("invalid input syntax for type uuid"),
 * which publicError() then reports as a 500 — plus a fresh Sentry issue per
 * distinct junk value.
 *
 * That was live: scanners probing /cert/EXAMPLE, /cert/not-a-uuid-xyz,
 * /cert/%3Cid%3E and friends produced five separate Sentry issues, and because
 * the cert SSR Pages Function treats any non-404 upstream reply as
 * UpstreamUnavailable (US-2044 — deliberately, so a transient blip is never
 * reported to a crawler as "gone"), each of those 500s surfaced to the outside
 * world as a 503 with Retry-After. A permanently invalid certificate URL was
 * telling search engines to come back and try again.
 *
 * A malformed id cannot match any row, so the honest answer is 404 — which is
 * exactly what these routes already document.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string | undefined): boolean {
  return typeof value === "string" && UUID_RE.test(value);
}

// Anonymous read endpoints powering the public blog SSR worker. No
// auth middleware: every query is constrained server-side to
// status='published', so even if someone hits these directly they
// only ever see live content. Service-role client bypasses RLS,
// which means the filter MUST be present on every query — be careful
// when adding new endpoints here.
//
// Mounted at /api/content/public in main.ts (carved out from the
// admin middleware that covers the rest of /api/content/*).

export const contentPublicRoutes = new Hono();

// Cap how many posts a single response can return so a misbehaving
// crawler can't request /posts?limit=999999.
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/**
 * US-2096: several sitemap feeds are hard-capped with NO cursor, so once the
 * cap is reached the response is a silently truncated 200 — indistinguishable
 * from "that is everything". A sitemap that under-reports is worse than one
 * that errors: it tells crawlers the missing pages do not exist.
 *
 * The cap lives here, so the detection lives here too — the alternative was
 * duplicating each limit into the Pages Function and letting the two drift.
 * Returns `truncated` for the response body so the client can log it as well.
 */
function warnIfCapped(label: string, rowCount: number, limit: number): boolean {
  if (rowCount < limit) return false;
  console.error(
    `[content-public] ${label} returned exactly its ${limit}-row cap — the ` +
      `response is TRUNCATED and this feed needs cursor pagination (see US-2096, ` +
      `which added it to certificates.json).`,
  );
  return true;
}

const POST_COLUMNS =
  "id, slug, title, excerpt, body_html, product_focus, hero_image_url, " +
  "seo_title, seo_description, primary_keyword, secondary_keywords, " +
  "reading_time_min, published_at, updated_at, jsonld, " +
  // Blog GEO / E-E-A-T fields (US-304); author entity FK (US-874).
  "author, author_id, key_takeaways, faqs, " +
  // Topic-cluster pillar (US-873).
  "pillar, " +
  // Image SEO: hero alt/caption/credit/dimensions + inline-image metadata (US-876).
  "hero_image_alt, hero_image_caption, hero_image_credit, " +
  "hero_image_width, hero_image_height, inline_images";
const LIST_COLUMNS =
  "id, slug, title, excerpt, product_focus, hero_image_url, primary_keyword, " +
  // US-2206: author byline for the RSS <dc:creator> (text column, US-304).
  "reading_time_min, published_at, updated_at, author";

// US-874: public author-entity projection (Person JSON-LD + author page). The
// `same_as` array feeds Person.sameAs; nothing private (created_at, id) leaks.
const AUTHOR_COLUMNS =
  "id, slug, name, title, bio_md, avatar_url, credentials, same_as, updated_at";

// Max related posts surfaced on an article (US-304). The tag-based fallback
// shows up to 3; the curated editorial set (US-873) may surface up to 6.
const MAX_RELATED = 3;
const MAX_EDITORIAL_RELATED = 6;

// Row shapes for the column lists above. The lists are built by string
// concatenation, so they widen to `string` and Supabase can't infer the row
// type from them (it yields GenericStringError) — we cast results to these.
interface BlogListRow {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  product_focus: string | null;
  hero_image_url: string | null;
  primary_keyword: string | null;
  reading_time_min: number | null;
  published_at: string | null;
  updated_at: string | null;
  author: string | null;
}
interface BlogFullRow extends BlogListRow {
  body_html: string | null;
  seo_title: string | null;
  seo_description: string | null;
  secondary_keywords: string[] | null;
  jsonld: unknown;
  // author (byline text) is inherited from BlogListRow as string | null.
  author_id: string | null;
  key_takeaways: unknown;
  faqs: unknown;
  pillar: string | null;
  // Image SEO (US-876).
  hero_image_alt: string | null;
  hero_image_caption: string | null;
  hero_image_credit: string | null;
  hero_image_width: number | null;
  hero_image_height: number | null;
  inline_images: unknown;
}
interface AuthorRow {
  id: string;
  slug: string;
  name: string;
  title: string | null;
  bio_md: string | null;
  avatar_url: string | null;
  credentials: string[] | null;
  same_as: string[] | null;
  updated_at: string | null;
}

/** Public author projection (drops the internal id; normalizes nullable arrays). */
function publicAuthor(row: AuthorRow): {
  slug: string;
  name: string;
  title: string | null;
  bio_md: string | null;
  avatar_url: string | null;
  credentials: string[];
  same_as: string[];
} {
  return {
    slug: row.slug,
    name: row.name,
    title: row.title ?? null,
    bio_md: row.bio_md ?? null,
    avatar_url: row.avatar_url ?? null,
    credentials: Array.isArray(row.credentials) ? row.credentials : [],
    same_as: Array.isArray(row.same_as) ? row.same_as : [],
  };
}

/** Load a single author entity by id, or null. Powers the article Person node. */
async function fetchAuthorEntity(authorId: string | null): Promise<ReturnType<typeof publicAuthor> | null> {
  if (!authorId) return null;
  const { data } = await supabaseAdmin
    .from("content_authors")
    .select(AUTHOR_COLUMNS)
    .eq("id", authorId)
    .maybeSingle();
  return data ? publicAuthor(data as unknown as AuthorRow) : null;
}
interface CertReportRow {
  overall_score: number;
  grade_tier: string;
  fabric_condition_score: number | null;
  structural_integrity_score: number | null;
  cosmetic_appearance_score: number | null;
  functional_elements_score: number | null;
  odor_cleanliness_score: number | null;
  ai_summary: string | null;
  buyer_writeup: string | null;
  certificate_id: string;
  certificate_number: string | null;
  created_at: string;
  submission_id: string;
  // US-340: structured Verified Capture result; only the pass/fail boolean is
  // exposed publicly (raw device/recency reasons stay server-side).
  verified_capture: { verified?: boolean } | null;
  // US-861: structured original-photos result; only the pass/fail boolean is
  // exposed publicly (reuse-scan counts stay server-side).
  original_photos: { verified?: boolean } | null;
  // US-1283: structured Live Capture result; only the earned badge tier is
  // exposed publicly (the raw downgrade reasons stay server-side).
  live_capture: { badge?: string } | null;
  // US-1281: structured Verified 360 result; only the earned badge tier is
  // exposed publicly (the raw capture metrics stay server-side).
  verified_360: { badge?: string } | null;
  // US-1762: structured Video Capture result; only the earned badge tier is
  // exposed publicly (the frame metrics + shortfall reasons stay server-side).
  // US-1766 adds live_captured — the clip was recorded in the in-app recorder.
  video_capture: { badge?: string; live_captured?: boolean } | null;
  // US-2400: whether a human reviewer finalized this grade. Passed straight
  // through to the payload (NOT stripped like the structured signals above) —
  // it is the AI-disclosure variant the /cert SSR page and the partner widget
  // render, and it is already public via the public_grade_reports view.
  human_reviewed?: boolean | null;
}

/**
 * Normalize the jsonb `faqs` column into a clean array of {q,a} string pairs.
 * Defensive: the column is admin-written but feeds public FAQPage JSON-LD, so
 * drop anything malformed rather than emit broken structured data.
 */
function normalizeFaqs(raw: unknown): Array<{ q: string; a: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ q: string; a: string }> = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const q = (item as Record<string, unknown>).q;
      const a = (item as Record<string, unknown>).a;
      if (typeof q === "string" && typeof a === "string" && q.trim() && a.trim()) {
        out.push({ q: q.trim(), a: a.trim() });
      }
    }
  }
  return out;
}

/**
 * Normalize the jsonb `inline_images` column (US-876) into a clean array of
 * per-image SEO metadata. Defensive: it's admin/editor-written but feeds the
 * public SSR (alt text + figcaption + ImageObject dims), so drop anything
 * malformed rather than emit broken markup. Every entry must at least carry a
 * `src`; alt/caption default to "" and dimensions to null.
 */
function normalizeInlineImages(
  raw: unknown,
): Array<{ src: string; alt: string; caption: string; width: number | null; height: number | null }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ src: string; alt: string; caption: string; width: number | null; height: number | null }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const src = typeof r.src === "string" ? r.src.trim() : "";
    if (!src) continue;
    const width = typeof r.width === "number" && Number.isFinite(r.width) ? r.width : null;
    const height = typeof r.height === "number" && Number.isFinite(r.height) ? r.height : null;
    out.push({
      src,
      alt: typeof r.alt === "string" ? r.alt.trim() : "",
      caption: typeof r.caption === "string" ? r.caption.trim() : "",
      width,
      height,
    });
  }
  return out;
}

/**
 * Related published posts that share at least one tag with the given post,
 * ranked by shared-tag count then recency. Returns LIST_COLUMNS-shaped rows.
 * Empty when the post has no tags (graceful — the SSR omits the block).
 */
async function fetchRelated(
  postId: string,
  tags: string[],
): Promise<unknown[]> {
  if (tags.length === 0) return [];

  const { data: tagRows } = await supabaseAdmin
    .from("blog_post_tags")
    .select("post_id, tag")
    .in("tag", tags)
    .neq("post_id", postId);

  // Count shared tags per candidate post.
  const shareCount = new Map<string, number>();
  for (const r of tagRows ?? []) {
    const pid = r.post_id as string;
    shareCount.set(pid, (shareCount.get(pid) ?? 0) + 1);
  }
  if (shareCount.size === 0) return [];

  const candidateIds = Array.from(shareCount.keys());
  const { data: posts } = await supabaseAdmin
    .from("blog_posts")
    .select(LIST_COLUMNS)
    .eq("status", "published")
    .in("id", candidateIds)
    .limit(50);

  return ((posts ?? []) as unknown as BlogListRow[])
    .sort((a, b) => {
      const sa = shareCount.get(a.id) ?? 0;
      const sb = shareCount.get(b.id) ?? 0;
      if (sb !== sa) return sb - sa;
      // Tie-break: newest first.
      const pa = a.published_at ?? "";
      const pb = b.published_at ?? "";
      return pb.localeCompare(pa);
    })
    .slice(0, MAX_RELATED);
}

/**
 * Curated editorial related posts (US-873): the topic-cluster interlinks chosen
 * at publish and stored in blog_post_links (relation='related', rank order).
 * Returns LIST_COLUMNS-shaped rows in rank order, filtered to still-published
 * targets (a target archived after linking is silently dropped). Empty when the
 * post predates the interlinker or has no editorial links — the caller then
 * falls back to the tag-based set, so the two never duplicate.
 */
async function fetchEditorialRelated(postId: string): Promise<unknown[]> {
  const { data: links } = await supabaseAdmin
    .from("blog_post_links")
    .select("target_post_id, rank")
    .eq("source_post_id", postId)
    .eq("relation", "related")
    .order("rank", { ascending: true });

  const orderedIds = (links ?? [])
    .map((l) => l.target_post_id as string | null)
    .filter((id): id is string => !!id);
  if (orderedIds.length === 0) return [];

  const { data: posts } = await supabaseAdmin
    .from("blog_posts")
    .select(LIST_COLUMNS)
    .eq("status", "published")
    .in("id", orderedIds);

  const byId = new Map(
    ((posts ?? []) as unknown as BlogListRow[]).map((p) => [p.id, p]),
  );
  return orderedIds
    .map((id) => byId.get(id))
    .filter((p): p is BlogListRow => !!p)
    .slice(0, MAX_EDITORIAL_RELATED);
}

// ── GET /posts ────────────────────────────────────────────
// Cursor pagination by published_at (newest first). Cursor is the
// raw timestamp string of the last item in the previous page.
contentPublicRoutes.get("/posts", async (c) => {
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const cursor = c.req.query("cursor");
  const productFocus = c.req.query("product_focus");

  // US-2099: OFFSET paging alongside the cursor.
  //
  // The cursor is right for API consumers walking the whole list, but it cannot
  // address a page: /blog/page/3 has to be a stable, crawlable URL that resolves
  // without replaying pages 1 and 2. The blog hub was therefore hard-capped at
  // the first 20 posts, and post 21 had NO crawl path from the hub at all.
  //
  // Cursor still wins when both are supplied — it is the more precise mechanism
  // and existing callers must not change behaviour.
  const rawOffset = Number(c.req.query("offset") ?? 0);
  const offset =
    Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  const useOffset = !cursor && offset > 0;

  let q = supabaseAdmin
    .from("blog_posts")
    .select(LIST_COLUMNS)
    .eq("status", "published")
    .order("published_at", { ascending: false });
  q = useOffset ? q.range(offset, offset + limit - 1) : q.limit(limit);
  if (cursor) q = q.lt("published_at", cursor);
  if (productFocus) q = q.eq("product_focus", productFocus);

  const { data, error } = await q;
  if (error) return publicError(c, error, "query");

  const rows = (data ?? []) as unknown as BlogListRow[];
  const nextCursor =
    rows.length === limit ? rows[rows.length - 1]?.published_at : null;

  // US-2206: attach each post's tags so the RSS feed can emit <category> per
  // tag. One grouped query over the page's ids (post_id is indexed) — cheap and
  // the endpoint is cached; other consumers ignore the additive field.
  const postIds = rows.map((r) => r.id);
  const tagsByPost = new Map<string, string[]>();
  if (postIds.length > 0) {
    const { data: tagRows } = await supabaseAdmin
      .from("blog_post_tags")
      .select("post_id, tag")
      .in("post_id", postIds);
    for (const tr of (tagRows ?? []) as Array<{
      post_id: string;
      tag: string;
    }>) {
      const arr = tagsByPost.get(tr.post_id) ?? [];
      arr.push(tr.tag);
      tagsByPost.set(tr.post_id, arr);
    }
  }
  const postsWithTags = rows.map((r) => ({
    ...r,
    tags: tagsByPost.get(r.id) ?? [],
  }));

  // The TOTAL is what lets the hub render a finite, crawlable "page N of M"
  // trail instead of guessing. Only computed when paging by offset, so the
  // common cursor path pays nothing for it.
  let total: number | null = null;
  if (useOffset || offset === 0) {
    let cq = supabaseAdmin
      .from("blog_posts")
      .select("id", { head: true, count: "exact" })
      .eq("status", "published");
    if (productFocus) cq = cq.eq("product_focus", productFocus);
    const { count } = await cq;
    total = typeof count === "number" ? count : null;
  }

  return c.json({ posts: postsWithTags, next_cursor: nextCursor, total });
});

// ── GET /posts/:slug ──────────────────────────────────────
contentPublicRoutes.get("/posts/:slug", async (c) => {
  const slug = c.req.param("slug");
  const { data: post, error } = await supabaseAdmin
    .from("blog_posts")
    .select(POST_COLUMNS)
    .eq("status", "published")
    .eq("slug", slug)
    .maybeSingle();
  if (error) return publicError(c, error, "query");
  if (!post) return c.json({ error: "Not found" }, 404);
  const row = post as unknown as BlogFullRow;

  const { data: tagRows } = await supabaseAdmin
    .from("blog_post_tags")
    .select("tag")
    .eq("post_id", row.id);
  const tags = (tagRows ?? []).map((r) => r.tag as string);

  // GEO enhancements (US-304): normalized FAQs + related posts. US-873: prefer
  // the curated editorial topic-cluster links; fall back to the shared-tag set
  // only when the post has none (so the two never duplicate).
  const editorial = await fetchEditorialRelated(row.id);
  const related = editorial.length > 0 ? editorial : await fetchRelated(row.id, tags);

  // US-873: hub-and-spoke uplink to the cornerstone pillar page.
  const pillar = row.pillar ?? null;
  const pillarUrl = pillar ? PILLAR_CORNERSTONE_URL[pillar] ?? null : null;
  const pillarLabel = pillar ? PILLAR_LABELS[pillar] ?? null : null;

  // US-874: linked author entity → full Person JSON-LD + linked byline.
  const authorEntity = await fetchAuthorEntity(row.author_id);

  return c.json({
    post: {
      ...row,
      tags,
      faqs: normalizeFaqs(row.faqs),
      inline_images: normalizeInlineImages(row.inline_images),
      related,
      pillar,
      pillar_url: pillarUrl,
      pillar_label: pillarLabel,
      author_entity: authorEntity,
    },
  });
});

// ── GET /authors.json ─────────────────────────────────────
// Compact list of every author for the sitemap + llms.txt (US-874). Public
// projection only (no internal id beyond the slug); updated_at is the lastmod.
// ── GET /style-codes/:code ────────────────────────────────
// US-2747: the public style-code lookup. A reseller holding a garment types the
// code off its tag and gets the product name plus WHERE that name came from.
//
// Reads non-tenant reference tables only (style_code_names, seeded decoders):
// brand, code, name, provenance. No owner, no item, no seller identity — the
// same class of data 00503, 00627 and 00628 already hold.
//
// A blank is a real answer here and the common one early on. It is returned as
// name:null with indexable:false rather than as a 404, because the code still
// grounds gender and season from the decoder, and because the page invites the
// visitor to tell us what it is (US-2749).
contentPublicRoutes.get("/style-codes/:code", async (c) => {
  const requested = (c.req.param("code") ?? "").trim();
  const canonical = canonicalStyleCode(PUBLIC_LOOKUP_BRAND_KEY, requested);
  if (canonical.length < MIN_STYLE_CODE_LENGTH) {
    return c.json({ error: "That is not a style code" }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("style_code_names")
    .select("name, source, supporting, confidence, evidence_url, rejected_at")
    .eq("brand_key", PUBLIC_LOOKUP_BRAND_KEY)
    .eq("style_code_norm", canonical)
    .is("rejected_at", null);
  if (error) return publicError(c, error, "style-codes");

  const payload = publicStyleCode({
    requested,
    canonicalCode: canonical,
    resolved: pickStyleCodeName((data ?? []) as StyleCodeNameRow[]),
    decode: decodeTagCode(PUBLIC_LOOKUP_BRAND_KEY, canonical) ??
      decodeTagCode(PUBLIC_LOOKUP_BRAND_KEY, requested),
  });
  return c.json(payload);
});

// ── POST /style-codes/:code/submit ────────────────────────
// US-2749: the reseller looking up a code we cannot name is holding the
// garment. They are the best evidence in the world for that code, and until now
// the page told them we did not know and the conversation ended.
//
// NO ACCOUNT, and that is the point: requiring one excludes exactly the person
// this exists for. Nothing identifying is stored — no session, no IP, no user
// agent — because the counter is what makes a submission trustworthy, not
// knowing who sent it. Abuse is the rate limiter's job (60/min/IP, fail-closed,
// mounted over /api/content/public/*).
//
// A submission NEVER publishes on its own. It is counted per (code, name), and
// a name becomes the answer only once PUBLIC_MIN_SUBMISSIONS independent people
// have said the same thing — and even then it ranks below every other source.
contentPublicRoutes.post("/style-codes/:code/submit", async (c) => {
  const requested = (c.req.param("code") ?? "").trim();
  const canonical = canonicalStyleCode(PUBLIC_LOOKUP_BRAND_KEY, requested);
  if (canonical.length < MIN_STYLE_CODE_LENGTH) {
    return c.json({ error: "That is not a style code" }, 400);
  }

  let body: { name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const refusal = submissionRefusal(name);
  if (refusal) return c.json({ error: refusal }, 400);

  const nameNorm = normalizeSubmittedName(name);
  const { error: writeErr } = await supabaseAdmin.rpc(
    "record_style_code_submission",
    {
      p_brand_key: PUBLIC_LOOKUP_BRAND_KEY,
      p_style_code_norm: canonical,
      p_style_code_raw: requested,
      p_name_norm: nameNorm,
      p_name: name,
    },
  );
  if (writeErr) return publicError(c, writeErr, "style-code-submit");

  // Re-read and re-decide from ALL submissions for this code rather than acting
  // on the one just written: the question is what the crowd agrees on, and that
  // can change in either direction with any single submission.
  const { data, error } = await supabaseAdmin
    .from("style_code_submissions")
    .select("name, name_norm, submissions")
    .eq("brand_key", PUBLIC_LOOKUP_BRAND_KEY)
    .eq("style_code_norm", canonical);
  if (error) return publicError(c, error, "style-code-submit-read");

  const winner = pickSubmittedName(
    (data ?? []) as SubmittedNameRow[],
    PUBLIC_MIN_SUBMISSIONS,
  );

  if (winner) {
    const { error: promoteErr } = await supabaseAdmin.rpc("record_style_code_name", {
      p_brand_key: PUBLIC_LOOKUP_BRAND_KEY,
      p_style_code_norm: canonical,
      p_style_code_raw: requested,
      p_name: winner.name,
      p_source: "public",
      p_supporting: winner.submissions,
      // Below every derived source's ceiling. The ORDER that matters is by
      // source, in lib/style-code-names.ts; this number only feeds the
      // extraction's field confidence.
      p_confidence: 0.45,
      p_evidence_url: null,
    });
    if (promoteErr) return publicError(c, promoteErr, "style-code-promote");
  } else {
    // No winner any more — a tie developed, or the leader was never corroborated.
    // Removing the published row keeps what a visitor SEES consistent with the
    // evidence; leaving it would show a name the submissions no longer support.
    await supabaseAdmin
      .from("style_code_names")
      .delete()
      .eq("brand_key", PUBLIC_LOOKUP_BRAND_KEY)
      .eq("style_code_norm", canonical)
      .eq("source", "public");
  }

  // Says what happened without publishing the losing answers: a visitor learns
  // whether THEIR submission is now the shown name, not what everyone guessed.
  return c.json({
    ok: true,
    published: Boolean(winner && winner.name_norm === nameNorm),
    needsCorroboration: !winner,
  });
});

// ── GET /style-codes.json ─────────────────────────────────
// US-2748: exactly the codes that are indexable, for sitemap-style-codes.xml.
// The SAME predicate the page uses to decide noindex — a URL in the sitemap
// that renders noindex is what gets a whole section ignored, so the two cannot
// be allowed to drift apart.
contentPublicRoutes.get("/style-codes.json", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("style_code_names")
    .select("style_code_norm, name, updated_at, rejected_at")
    .eq("brand_key", PUBLIC_LOOKUP_BRAND_KEY)
    .is("rejected_at", null)
    .order("updated_at", { ascending: false })
    .limit(STYLE_CODE_SITEMAP_CAP);
  if (error) return publicError(c, error, "style-codes.json");

  // indexableCodes applies the SAME two conditions publicStyleCode applies, and
  // a test drives both from one fixture set. The `.is("rejected_at", null)`
  // above is belt-and-braces for the query planner; the decision is in the pure
  // function, which is the half that can be held to it.
  const codes = indexableCodes((data ?? []) as SitemapCandidateRow[]);
  const truncated = warnIfCapped("style-codes.json", (data ?? []).length, STYLE_CODE_SITEMAP_CAP);
  return c.json({ truncated, codes });
});

// ── GET /registered-numbers/:number ───────────────────────
// US-9030: the public RN lookup. Someone reads a number off a care label and
// gets the COMPANY that registered it, plus where that answer came from.
//
// TENANT SCOPING DOES NOT APPLY HERE, and the missing filter is deliberate:
// registered_number_registry and registered_number_sightings are global
// reference data with no owner column (00501, 00502), the same class as
// style_code_names. There is no user_id to scope by and nothing here reads a
// tenant table.
//
// A number with no registry row returns 200 with companyName:null rather than
// a 404 — the page still renders, still says honestly that we have no
// reference for it, and still offers the tag reader. Only a string that is not
// a registry number at all is a 400.
contentPublicRoutes.get("/registered-numbers/:number", async (c) => {
  const requested = (c.req.param("number") ?? "").trim();
  const parsed = parseRegisteredNumber(requested);
  if (!parsed) return c.json({ error: "That is not a registered identification number" }, 400);

  const key = registeredNumberKey(parsed);

  const [registryRes, sightingRes] = await Promise.all([
    supabaseAdmin
      .from("registered_number_registry")
      .select("registry_key, kind, digits, company_name, brand_keys, source_url, notes")
      .eq("registry_key", key)
      .maybeSingle(),
    supabaseAdmin
      .from("registered_number_sightings")
      .select("sighting_count")
      .eq("registry_key", key)
      .maybeSingle(),
  ]);
  if (registryRes.error) return publicError(c, registryRes.error, "registered-numbers");
  if (sightingRes.error) return publicError(c, sightingRes.error, "registered-numbers");

  const registry = registryRes.data as RegistryRowForPublic | null;

  // brand_keys are internal keys; a page shows names. An unknown key simply
  // drops out rather than being printed raw at a reader.
  let brandNames: string[] = [];
  const keys = (registry?.brand_keys ?? []).filter(Boolean);
  if (keys.length > 0) {
    const { data: brands, error: brandErr } = await supabaseAdmin
      .from("brand_knowledge")
      .select("brand_key, canonical_brand")
      .in("brand_key", keys);
    if (brandErr) return publicError(c, brandErr, "registered-numbers");
    brandNames = (brands ?? [])
      .map((b) => String(b.canonical_brand ?? "").trim())
      .filter(Boolean);
  }

  const payload = publicRegisteredNumber({
    requested,
    registry,
    brandNames,
    sightings: sightingRes.data ? Number(sightingRes.data.sighting_count) : null,
  });
  if (!payload) return c.json({ error: "That is not a registered identification number" }, 400);
  return c.json(payload);
});

// ── GET /registered-numbers.json ──────────────────────────
// US-9032: exactly the numbers that are indexable, for sitemap-rn.xml. The
// SAME predicate the page uses to decide noindex, for the same reason
// style-codes.json exists in this shape.
contentPublicRoutes.get("/registered-numbers.json", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("registered_number_registry")
    .select("registry_key, kind, digits, company_name, updated_at")
    .eq("kind", "RN")
    .not("company_name", "is", null)
    .order("updated_at", { ascending: false })
    .limit(RN_SITEMAP_CAP);
  if (error) return publicError(c, error, "registered-numbers.json");

  // The filters above are belt-and-braces for the query planner; the decision
  // is in indexableNumbers, which is the half a test can hold to the page.
  const numbers = indexableNumbers((data ?? []) as SitemapNumberRow[]);
  const truncated = warnIfCapped("registered-numbers.json", (data ?? []).length, RN_SITEMAP_CAP);
  return c.json({ truncated, numbers });
});

contentPublicRoutes.get("/authors.json", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("content_authors")
    .select(AUTHOR_COLUMNS)
    .order("name", { ascending: true })
    .limit(1000);
  if (error) return publicError(c, error, "authors");
  const authors = ((data ?? []) as unknown as AuthorRow[]).map((row) => ({
    ...publicAuthor(row),
    updated_at: row.updated_at,
  }));
  const truncated = warnIfCapped("authors.json", authors.length, 1000);
  return c.json({ truncated, authors });
});

// ── GET /authors/:slug ────────────────────────────────────
// One author entity + their published posts (newest first). 404 for an unknown
// slug. Service-role bypasses RLS, so the posts query is hard-filtered to
// status='published' (only live content is ever exposed).
contentPublicRoutes.get("/authors/:slug", async (c) => {
  const slug = c.req.param("slug");
  const { data: author, error } = await supabaseAdmin
    .from("content_authors")
    .select(AUTHOR_COLUMNS)
    .eq("slug", slug)
    .maybeSingle();
  if (error) return publicError(c, error, "author");
  if (!author) return c.json({ error: "Not found" }, 404);
  const row = author as unknown as AuthorRow;

  const { data: posts, error: postsErr } = await supabaseAdmin
    .from("blog_posts")
    .select(LIST_COLUMNS)
    .eq("status", "published")
    .eq("author_id", row.id)
    .order("published_at", { ascending: false })
    .limit(MAX_LIMIT);
  if (postsErr) return publicError(c, postsErr, "author-posts");

  return c.json({
    author: publicAuthor(row),
    posts: (posts ?? []) as unknown as BlogListRow[],
  });
});

// ── GET /tags/:tag ────────────────────────────────────────
contentPublicRoutes.get("/tags/:tag", async (c) => {
  const tag = c.req.param("tag").toLowerCase();
  const { data: tagRows, error: tagErr } = await supabaseAdmin
    .from("blog_post_tags")
    .select("post_id")
    .eq("tag", tag);
  if (tagErr) return publicError(c, tagErr, "tags");
  const ids = (tagRows ?? []).map((r) => r.post_id as string);
  if (ids.length === 0) return c.json({ posts: [] });

  const { data, error } = await supabaseAdmin
    .from("blog_posts")
    .select(LIST_COLUMNS)
    .eq("status", "published")
    .in("id", ids)
    .order("published_at", { ascending: false })
    .limit(MAX_LIMIT);
  if (error) return publicError(c, error, "query");
  return c.json({ posts: data ?? [], tag });
});

// ── GET /posts/preview/:token ─────────────────────────────
// Verifies a signed preview token and returns the draft post.
// The SSR worker hits this for /blog/preview/<token> URLs and
// renders the result with noindex,nofollow so it never enters
// search indexes even if shared publicly.
contentPublicRoutes.get("/posts/preview/:token", async (c) => {
  const token = c.req.param("token");
  const verified = await verifyPreviewToken(token).catch(() => null);
  if (!verified) {
    return c.json({ error: "Invalid or expired preview token" }, 401);
  }

  const { data: post, error } = await supabaseAdmin
    .from("blog_posts")
    .select(POST_COLUMNS)
    .eq("id", verified.postId)
    .maybeSingle();
  if (error) return publicError(c, error, "query");
  if (!post) return c.json({ error: "Not found" }, 404);
  const row = post as unknown as BlogFullRow;

  const { data: tagRows } = await supabaseAdmin
    .from("blog_post_tags")
    .select("tag")
    .eq("post_id", row.id);
  const tags = (tagRows ?? []).map((r) => r.tag as string);

  return c.json({
    post: {
      ...row,
      tags,
      faqs: normalizeFaqs(row.faqs),
    },
    preview: true,
    expires_at: new Date(verified.expiresAt * 1000).toISOString(),
  });
});

// ── GET /sitemap.json ─────────────────────────────────────
// Compact list used by both the sitemap.xml and rss.xml Pages
// Functions. We expose JSON (not XML) so the worker can choose
// how to render — same upstream call, two outputs.
contentPublicRoutes.get("/sitemap.json", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("blog_posts")
    .select(
      // US-975: hero image fields feed the image sitemap (sitemap-images.xml).
      "slug, published_at, updated_at, title, excerpt, hero_image_url, hero_image_alt, hero_image_caption",
    )
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(1000);
  if (error) return publicError(c, error, "query");

  // Collect distinct tags for /blog/tag/<tag> entries.
  const { data: tagRows } = await supabaseAdmin
    .from("blog_post_tags")
    .select("tag, post_id, blog_posts!inner(status)")
    .eq("blog_posts.status", "published");
  const tagSet = new Set<string>();
  for (const r of tagRows ?? []) {
    if (r.tag) tagSet.add(r.tag as string);
  }

  const truncated = warnIfCapped("sitemap.json posts", (data ?? []).length, 1000);

  return c.json({
    truncated,
    posts: data ?? [],
    tags: Array.from(tagSet).sort(),
  });
});

// ── Certificates (public grade certificates) ──────────────────────
// A grade report is PUBLIC iff it has a non-null certificate_id. NOTE: the old
// "Public can view grade reports with certificates" RLS policy that once
// encoded this signal was DROPPED in 00082_public_certificate_view.sql — so the
// public-ness gate now lives ENTIRELY in this code, not in the database. The
// service-role client bypasses RLS, so EVERY query here MUST carry
// .not("certificate_id","is",null) (and look up BY certificate_id, never by the
// internal report id) AND select only the CERT_REPORT_COLUMNS allowlist below —
// those two in-code gates are the sole defense. A private, uncertified report
// must be unreachable through these endpoints (US-268).

// Columns safe to expose publicly (the in-code allowlist gate). We deliberately
// omit confidence_score, detailed_notes, model_version internals, and the
// owner user_id.
//
// US-1945: split into GENESIS (present since 00001_initial_schema) and the
// post-genesis additions. A single missing column makes the WHOLE PostgREST
// select error (42703) -> publicError 500 -> the cert Function reads null ->
// EVERY certificate 404s. That is exactly the prod failure mode when migration
// drift leaves a recent column (certificate_number 00307, live_capture 00314,
// verified_360 00316, etc.) unapplied. So we try the full allowlist first and,
// on a missing-column error, fall back to the genesis-only set — a valid cert
// always renders its grade, and the absent extras degrade gracefully (the cert
// number falls back to the UUID-derived label; trust badges read as absent).
const CERT_REPORT_GENESIS_COLUMNS =
  "overall_score, grade_tier, fabric_condition_score, structural_integrity_score, " +
  "cosmetic_appearance_score, functional_elements_score, odor_cleanliness_score, " +
  "ai_summary, certificate_id, created_at, submission_id";

// Added after 00001; individually null-safe downstream (buyer_writeup 00118,
// verified_capture 00138, original_photos 00194, certificate_number 00307,
// live_capture 00314, verified_360 00316, factor_scores/rubric_key 00231).
//
// US-1997: factor_scores (jsonb) + rubric_key let the cert render a non-clothing
// Factor Breakdown (sports_cards/watches/shoes) from the generic rubric. NULL on
// every clothing report (which renders from the 5 typed columns), so exposing
// them changes nothing for existing certs — the client (certificate.tsx) already
// prefers them only when both are present and falls back to the typed columns
// otherwise. Kept in the EXTRA (not GENESIS) set so the 42703 fallback still
// serves clothing certs if 00231 is unapplied in prod (US-1945 drift-safety).
//
// US-2392: certified_content_updated_at is when this certificate's scores were
// last rewritten in place by a human-review adjustment. Exposing it is a
// deliberate allowlist decision, not a side effect — 00231's own comment defers
// exposure choices, so it is made here explicitly. It reveals nothing private:
// THAT a certificate was revised, and when, is exactly what someone verifying it
// is entitled to know, and it is the fact the integrity hash cannot carry
// (a legitimate adjustment recomputes the hash, so it verifies clean either way).
// NULL on every unrevised certificate, which is the truthful answer rather than
// a missing one. Kept in the EXTRA set so the 42703 genesis fallback still serves
// certificates if 00522 is unapplied.
//
// US-2400: human_reviewed drives the AI-disclosure variant on the /cert SSR page
// and the white-label partner widget (US-2399). Both read this endpoint, so
// without it here the flag was always undefined on those two surfaces and they
// always printed the stricter AI-only wording — while the SPA certificate page,
// which reads the public_grade_reports VIEW directly, printed the human-finalized
// one over the top of them in the same page load. Two provenance claims about one
// grade. Not private: the view has exposed it to anon since 00082. In the EXTRA
// set for the same US-1945 drift reason (it has existed since 00061, so the
// fallback risk is theoretical, but the rule is the rule).
// US-1762: video_capture is the walk-around-clip provenance result. Same
// treatment as live_capture / verified_360 — the raw blob is stripped below and
// only the earned badge boolean crosses the boundary. In the EXTRA set for the
// US-1945 drift reason: 00532 is recent, and a cert must still render if it has
// not been applied yet.
const CERT_REPORT_EXTRA_COLUMNS =
  "buyer_writeup, certificate_number, verified_capture, original_photos, " +
  "live_capture, verified_360, video_capture, factor_scores, rubric_key, " +
  "certified_content_updated_at, human_reviewed";

const CERT_REPORT_COLUMNS = `${CERT_REPORT_GENESIS_COLUMNS}, ${CERT_REPORT_EXTRA_COLUMNS}`;

// A PostgREST "column ... does not exist" error (Postgres 42703 / PostgREST
// PGRST204). Used to trigger the genesis-only fallback under migration drift.
function isMissingColumnError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const code = e?.code ?? "";
  if (code === "42703" || code === "PGRST204") return true;
  const msg = (e?.message ?? "").toLowerCase();
  return msg.includes("does not exist") && msg.includes("column");
}

// Load a public grade report by certificate_id with the drift fallback (US-1945).
// Preserves BOTH in-code publicity gates on every path: look up BY
// certificate_id and .not("certificate_id","is",null). Returns the same
// { data, error } shape the caller already handles.
async function loadPublicCertReport(certId: string) {
  const full = await supabaseAdmin
    .from("grade_reports")
    .select(CERT_REPORT_COLUMNS)
    .eq("certificate_id", certId)
    .not("certificate_id", "is", null)
    .maybeSingle();
  if (!full.error || !isMissingColumnError(full.error)) return full;

  // Migration drift: a post-genesis column is missing in this database. Log it
  // (this is an ops problem to fix — apply the held migrations) but do NOT let
  // it take down the whole certificate surface.
  captureException(full.error, {
    route: "GET /certificates/:id",
    url: "cert column drift — falling back to genesis columns (apply pending migrations)",
  });
  console.error(
    "content-public cert: column drift, genesis fallback:",
    full.error.message,
  );
  return await supabaseAdmin
    .from("grade_reports")
    .select(CERT_REPORT_GENESIS_COLUMNS)
    .eq("certificate_id", certId)
    .not("certificate_id", "is", null)
    .maybeSingle();
}

// Signed-URL TTL for certificate images (seconds). Long enough for an edge
// cache window; the cert SSR caches the HTML, not the URL, so this just needs
// to outlive a render.
// submission-images is private; reads use short-lived signed URLs (US-276,
// ≤15 min). The cert SSR/OG HTML is itself CDN-cached, so the URL only needs to
// outlive a single render.
const CERT_IMAGE_TTL = 15 * 60;

/** The grader's public standing as shown on a certificate (US-1912 AC3). */
interface CertSellerIntegrity {
  tier: string;
  label: string;
  /** The verified profile the tier is checkable against. */
  handle: string;
  /**
   * US-1913 AC2: the grader's reward LEVEL flair, beside the integrity tier —
   * the same pair the public profile shows, so a buyer who follows the handle
   * sees the same two facts rather than a different summary of the seller.
   * Null below level 1 (level 0 is the un-earned rung, and rendering it would
   * read as a rank). Same projection as the profile: tier name only, never XP.
   */
  level: { level: number; tier_name: string; tier_blurb: string } | null;
}

/**
 * Resolve the certificate's grader to a PUBLIC integrity tier, or null.
 *
 * Null on every uncertain path — no seller, no public profile, standing below
 * the floor, or a read error. A missing badge on a certificate is invisible; a
 * badge we could not verify is a trust claim, and this surface exists precisely
 * because buyers act on it.
 */
async function loadCertSellerIntegrity(
  sellerUserId: string | null,
): Promise<CertSellerIntegrity | null> {
  if (!sellerUserId) return null;
  try {
    const { data } = await supabaseAdmin
      .from("users")
      .select("verified_handle, verified_enabled")
      .eq("id", sellerUserId)
      .maybeSingle();
    const seller = data as
      | { verified_handle: string | null; verified_enabled: boolean | null }
      | null;
    if (!seller?.verified_enabled || !seller.verified_handle) return null;
    const standing = await loadPublicSellerIntegrity(sellerUserId);
    if (!standing) return null;
    // Level flair rides along only once the integrity gate above has passed —
    // the certificate says who graded it and how proven they are, and a level on
    // its own would be activity dressed as accuracy.
    const levelNumber = await rewardLevelFor(sellerUserId);
    const flair = levelNumber > 0 ? publicLevelFlair(levelNumber) : null;
    return {
      ...standing,
      handle: seller.verified_handle,
      level: flair
        ? {
          level: flair.level,
          tier_name: flair.tier_name,
          tier_blurb: flair.tier_blurb,
        }
        : null,
    };
  } catch (err) {
    console.error("[content-public] cert seller integrity failed:", err);
    return null;
  }
}

// ── GET /certificates/:id ─────────────────────────────────────────
// Public certificate by certificate_id. Returns 404 for any id that doesn't
// map to a certified (public) report — never leaks a private report.

// ── US-2569: a retired certificate resolves to its successor ───────────────
//
// A regrade nulls the old report's certificate_id (00150 + regradeSubmission),
// and every public read filters on `certificate_id IS NOT NULL` — so before
// 00600 the retired number resolved to nothing at all. That is the wrong answer
// for a trust surface: a buyer holding a hangtag with that number printed on it
// learns the number cannot be relied on, which is the only thing the product
// sells.
//
// `match` is the column to look the retired certificate up by — its id for
// /certificates/:id, its number for /certificates/by-number/:number.
//
// ⚠ THE WITHHOLD RULES STILL APPLY, and this is the part worth being careful
// about: a revision must never become a way to read around a moderation hold.
// The successor's submission is checked with the SAME isCertificateWithheld
// predicate a live certificate goes through, and a withheld successor answers
// "pending" rather than naming it.
const REVISION_COLUMNS =
  // submission_id is selected because the chain walk below needs every revision
  // for the same garment, not just the one that matched.
  "submission_id, superseded_report_id, superseded_certificate_id, superseded_certificate_number, " +
  "superseded_overall_score, superseded_grade_tier, superseding_report_id, " +
  "superseding_certificate_id, superseding_certificate_number, " +
  "superseding_overall_score, superseding_grade_tier, reason, superseded_at";

async function loadRevisionResolution(
  match: { certificateId: string } | { certificateNumber: string },
): Promise<RevisionResolution | null> {
  const base = supabaseAdmin.from("grade_report_revisions").select(REVISION_COLUMNS);
  const query = "certificateId" in match
    ? base.eq("superseded_certificate_id", match.certificateId)
    : base.eq("superseded_certificate_number", match.certificateNumber);

  const { data, error } = await query.maybeSingle();
  if (error || !data) return null;
  const start = data as unknown as RevisionRow;

  // Every revision for this garment, so a chain of regrades walks all the way to
  // the live grade rather than stopping at a certificate that is itself retired.
  const { data: siblings } = await supabaseAdmin
    .from("grade_report_revisions")
    .select(REVISION_COLUMNS)
    .eq("submission_id", (data as unknown as { submission_id?: string }).submission_id ?? "")
    .limit(50);
  const byRetired = new Map<string, RevisionRow>();
  for (const row of ((siblings ?? []) as unknown as RevisionRow[])) {
    byRetired.set(row.superseded_report_id, row);
  }

  const resolution = resolveRevisionChain(start, byRetired);
  if (resolution.status !== "revised") return resolution;

  // The successor must pass the same publicity gate a live certificate does.
  const { data: successor } = await supabaseAdmin
    .from("grade_reports")
    .select("submission_id")
    .eq("certificate_id", resolution.currentCertificateId)
    .not("certificate_id", "is", null)
    .maybeSingle();
  if (!successor) {
    return { status: "pending", revisedAt: resolution.revisedAt, hops: resolution.hops };
  }
  const { data: sub } = await supabaseAdmin
    .from("submissions")
    .select("flagged, moderation_status, status")
    .eq("id", (successor as { submission_id: string }).submission_id)
    .maybeSingle();
  if (isCertificateWithheld(sub as never)) {
    return { status: "pending", revisedAt: resolution.revisedAt, hops: resolution.hops };
  }
  return resolution;
}

/** The revised-certificate body, shared by the id and number lookups. */
function revisionBody(resolution: RevisionResolution) {
  return {
    revised: true,
    status: resolution.status,
    message: revisionMessage(resolution),
    revised_at: resolution.revisedAt,
    current_certificate_id: resolution.status === "revised"
      ? resolution.currentCertificateId
      : null,
    current_certificate_number: resolution.status === "revised"
      ? resolution.currentCertificateNumber
      : null,
    history: resolution.hops,
  };
}

contentPublicRoutes.get("/certificates/:id", async (c) => {
  const certId = c.req.param("id");
  // A non-UUID can never match a row; answer 404 rather than letting Postgres
  // raise 22P02 and turning a bad URL into a 500 (and a 503 at the SSR layer).
  if (!isUuid(certId)) return c.json({ error: "Not found" }, 404);

  const { data: report, error } = await loadPublicCertReport(certId);
  if (error) return publicError(c, error, "query");
  if (!report) {
    // US-2569: before answering 404, ask whether this certificate was REVISED.
    // 200 with a revised body rather than a 301: the client needs the history
    // and the "new grade pending" state, and a redirect can express neither.
    const revision = await loadRevisionResolution({ certificateId: certId });
    if (revision) return c.json(revisionBody(revision), 200);
    return c.json({ error: "Not found" }, 404);
  }
  const rep = report as unknown as CertReportRow;

  // Garment metadata from the parent submission (title/brand/category +
  // the seller's buyer-facing description, US-760).
  const { data: submission } = await supabaseAdmin
    .from("submissions")
    .select(
      // user_id is read for the US-1912 seller-integrity lookup below and is
      // NEVER put on the response — the fields below are picked one by one, so
      // it cannot ride along by accident the way a spread would let it.
      "user_id, title, brand, garment_type, garment_category, description, flagged, moderation_status, status",
    )
    .eq("id", rep.submission_id)
    .maybeSingle();

  // US-484: WITHHOLD a suspect certificate. A grade whose submission was flagged
  // for moderation (not-clothing / suspected image manipulation / cross-account
  // photo reuse — set in grading-pipeline.ts) must NOT be publicly resolvable
  // until a human clears it (admin approve sets flagged=false +
  // moderation_status='approved', US-476). 404 exactly like a private report so
  // a forged/altered grade can't be trusted via the public cert/SSR/OG path.
  const sub = submission as
    | { flagged?: boolean | null; moderation_status?: string | null; status?: string | null }
    | null;
  if (isCertificateWithheld(sub)) {
    return c.json({ error: "Not found" }, 404);
  }

  // US-1413: the full ordered gallery → signed URLs. The SPA cert route renders
  // the photo gallery + PSA-style defect callouts for ANONYMOUS buyers (the
  // cert's primary audience); it previously read submissions/submission-images
  // directly with the anon client, which RLS locks to the owner, so logged-out
  // viewers saw no photos at all. Serving signed URLs here (service-role) is the
  // same pattern the SSR/OG hero already uses — without exposing the private
  // bucket wholesale. The SSR hero is just the front/first entry of this list.
  const { data: imageRows } = await supabaseAdmin
    .from("submission_images")
    .select("id, storage_path, image_type, display_order")
    .eq("submission_id", rep.submission_id)
    .order("display_order", { ascending: true });
  const galleryRows = (imageRows ?? []) as CertSubmissionImageRow[];
  const galleryImages = await buildCertGallery(galleryRows, async (path) => {
    const { data: signed } = await supabaseAdmin.storage
      .from("submission-images")
      .createSignedUrl(path, CERT_IMAGE_TTL);
    return signed?.signedUrl ?? null;
  });
  const heroImageUrl = selectHeroUrl(galleryRows, galleryImages);

  // Strip the internal submission_id from the public payload, and reduce the
  // Verified Capture result (US-340) + the original-photos signal (US-861) to
  // their public pass/fail booleans — the raw device/recency reasons and the
  // reuse-scan counts stay server-side, like the authenticity tells.
  const publicReport: Record<string, unknown> = { ...rep };
  delete publicReport.submission_id;
  delete publicReport.verified_capture;
  delete publicReport.original_photos;
  delete publicReport.live_capture;
  delete publicReport.verified_360;
  delete publicReport.video_capture;

  // US-1844: the coarse public trust signals — the SINGLE projection the buyer
  // surfaces (extension/alerts/watchlist/portfolio) reuse, so a badge shown on a
  // buyer surface can never diverge from what the public cert page shows.
  const trust = projectTrustSignals(rep);

  // US-1912 AC3: the grader's Grade Integrity tier, on the certificate itself —
  // the page where a buyer is deciding whether to believe a grade is the page
  // where "how often has this grader been proven right" belongs.
  //
  // Two gates, both of which must hold. The seller must have OPTED IN to a
  // public profile (verified_enabled): a tier is a public reputation claim, and
  // a seller who never made their standing public does not acquire one by having
  // graded something. And the tier must clear the AC2 anti-gaming floor, which
  // loadPublicSellerIntegrity enforces. Either gate failing yields null and the
  // section simply does not render — a certificate never shows a bad standing,
  // only an earned good one. Nothing identifying is added beyond the handle the
  // seller already published.
  const sellerIntegrity = await loadCertSellerIntegrity(
    (submission as { user_id?: string | null } | null)?.user_id ?? null,
  );

  return c.json({
    certificate: {
      // Null unless the grader publishes a verified profile AND their standing
      // clears the display floor.
      seller_integrity: sellerIntegrity,
      ...publicReport,
      // US-340: positive-only device/recency pass; raw reasons stay server-side.
      verified_capture_passed: trust.verifiedCapture,
      // US-1283: positive-only. True iff the submission earned the strongest
      // fraud-proof "Live-Verified" badge; the downgrade reasons stay server-side.
      live_capture_verified: trust.liveCaptureVerified,
      // US-1281: positive-only. True iff the submission earned the premium
      // '360-Verified' badge; the raw capture metrics stay server-side.
      verified_360_badge: trust.verified360,
      // US-1762: positive-only. True iff the grade was produced from frames the
      // server extracted from one continuous clip; the frame metrics and the
      // reasons a clip fell short stay server-side.
      video_capture_verified: trust.videoCaptureVerified,
      // US-1766: positive-only. True iff that clip was ALSO recorded live in
      // the in-app recorder — a stronger reading of the same badge, so it is
      // never true without video_capture_verified.
      video_live_capture_verified: trust.videoLiveCaptureVerified,
      // US-861: positive-only. True iff the photo-reuse scan ran and found no
      // cross-account match. Never leaks hashes/distances.
      original_photos_verified: trust.originalPhotos,
      id: rep.certificate_id,
      title: submission?.title ?? "Graded garment",
      // US-2613: the seller's title with condition claims removed, for OUR
      // headline surfaces (the <title>, og:title, the OG card). `title` above
      // stays verbatim, because the body shows what the seller wrote and this
      // is a presentation rule rather than an edit to their listing.
      //
      // Computed HERE, once, rather than in each renderer: the SSR page and the
      // OG image are different runtimes (Cloudflare Pages and this Deno
      // service) and could not share a module, so two implementations would
      // drift — and the drift would show as a social card and a search snippet
      // disagreeing about the same certificate.
      display_title: certDisplayTitle(submission?.title ?? "Graded garment"),
      brand: submission?.brand ?? null,
      garment_type: submission?.garment_type ?? null,
      garment_category: submission?.garment_category ?? null,
      // US-2628: plain text, never markup. A submission description is usually
      // the LISTING description, which is HTML (eBay renders it) — and both
      // certificate renderers print this field as escaped text, so the raw tags
      // showed up as body copy. Flattened once here so the SPA and the SSR page
      // can't disagree; the generated credential/disclosure blocks are dropped
      // because the certificate already makes both claims itself.
      description: certDescriptionText(submission?.description),
      hero_image_url: heroImageUrl,
      // US-1413: full ordered gallery (signed URLs) for the SPA photo grid +
      // defect callouts. The SSR path ignores this and uses hero_image_url only.
      images: galleryImages,
    },
  });
});

// ── GET / HEAD /cert-image/:id ────────────────────────────────────
// Render-store-serve the branded certificate images (the PSA-style "slab"
// graded photo, the social OG card, the trust badge). US-763 was rendered by a
// Cloudflare Pages Function via workers-og, which exceeds the Free-plan Worker
// CPU limit (HTTP 503 "error code: 1102"); the edge has full CPU. Lazy: render
// once on first request, store in the public `cert-assets` bucket, serve from
// storage thereafter. The Pages Functions (/slab,/og,/badge) proxy this.
//
// Same publicity gate as GET /certificates/:id — resolved by certificate_id,
// non-null, + isCertificateWithheld — but a private/withheld/missing cert or any
// render error returns the transparent FALLBACK PNG with HTTP 200 (never a
// broken image; reachability probes still pass) and NEVER leaks a private report.
const CERT_IMG_CACHE =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";
const PUBLIC_SITE_URL =
  Deno.env.get("PUBLIC_SITE_URL")?.trim() || "https://gradethread.com";
const fallbackPng = () =>
  Uint8Array.from(atob(FALLBACK_PNG_BASE64), (ch) => ch.charCodeAt(0));

function certImageHeaders(cache: string): HeadersInit {
  return { "Content-Type": "image/png", "Cache-Control": cache };
}

/**
 * A user's reward LEVEL from the state cache (US-1851). Fail-CLOSED: a missing
 * row or a DB error reads 0, so the plain card renders rather than the fanciest
 * frame. The cache is authoritative here on purpose — recomputing the ledger on
 * a public image request would be absurd, and the row is written on every grant.
 */
async function rewardLevelFor(userId: string | null | undefined): Promise<number> {
  if (!userId) return 0;
  const { data, error } = await supabaseAdmin
    .from("user_reward_state")
    .select("level")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return 0;
  const level = Number((data as { level?: number }).level ?? 0);
  return Number.isFinite(level) && level > 0 ? level : 0;
}

// US-1913 AC3: the cache policy for a STATUS-format badge.
//
// The plain badges use CERT_IMG_CACHE, whose `stale-while-revalidate=604800`
// lets a CDN keep serving a week-old copy while it refreshes. That is right for
// a grade (it never changes) and wrong for a standing (it does). A seller must
// never have to re-paste their HTML to fix a badge, so the ONLY thing bounding
// how long a stale tier can be shown is this header — hence 24h flat, with no
// stale-while-revalidate window bolted on after it. The Pages Function proxies
// mirror this exactly; a proxy that re-applied the 7-day SWR would silently undo
// the bound.
const BADGE_STATUS_CACHE = "public, max-age=86400, s-maxage=86400";

/** True for `?status=1` / `?status=true` on a badge request. */
function wantsStatusBadge(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "status" || v === "yes";
}

/**
 * US-1913 AC1/AC4: the seller's opt-in status strip, composed from what they
 * have actually EARNED.
 *
 * Both halves fail closed independently: `loadSellerBadgeStanding` returns null
 * below the US-1912 confirmed-outcome floor (so no tier and no percentage), and
 * `rewardLevelFor` reads 0 on any problem (so no level). When neither survives,
 * buildBadgeStatusLine returns "" and the caller renders the PLAIN badge — a
 * status badge never degrades into a badge making a claim we can't stand behind.
 */
async function badgeStatusLineFor(
  sellerUserId: string | null | undefined,
): Promise<string> {
  if (!sellerUserId) return "";
  try {
    const [standing, level] = await Promise.all([
      loadSellerBadgeStanding(sellerUserId),
      rewardLevelFor(sellerUserId),
    ]);
    return buildBadgeStatusLine({
      tierLabel: standing?.label ?? null,
      accuracyPct: standing?.accuracyPct ?? null,
      level,
      levelTierName: level > 0 ? publicLevelFlair(level).tier_name : null,
    });
  } catch (err) {
    captureException(err, { level: "warn", route: "badge-status-line" });
    return "";
  }
}

// Marketplace/OG reachability probes HEAD before fetching — always answer 200.
contentPublicRoutes.on("HEAD", "/cert-image/:id", (c) =>
  new Response(null, {
    status: 200,
    headers: certImageHeaders(
      wantsStatusBadge(c.req.query("status")) ? BADGE_STATUS_CACHE : CERT_IMG_CACHE,
    ),
  }));

contentPublicRoutes.get("/cert-image/:id", async (c) => {
  const certId = c.req.param("id");
  if (!isUuid(certId)) return c.json({ error: "Not found" }, 404);
  const kindRaw = (c.req.query("kind") ?? "slab").toLowerCase();
  const kind = kindRaw === "og" || kindRaw === "badge" ? kindRaw : "slab";
  // US-1913: the opt-in status format of the per-listing cert badge.
  const wantsStatus = kind === "badge" && wantsStatusBadge(c.req.query("status"));
  const format = (
    kind === "slab" && c.req.query("format") && c.req.query("format")! in SLAB_FORMATS
      ? c.req.query("format")
      : "square"
  ) as SlabFormat;

  const serveFallback = () =>
    new Response(fallbackPng(), { status: 200, headers: certImageHeaders("public, max-age=300") });

  try {
    // Publicity gate — identical to GET /certificates/:id (by certificate_id,
    // non-null allowlist select). A miss must be indistinguishable from private.
    const { data: report } = await supabaseAdmin
      .from("grade_reports")
      .select(
        "overall_score, grade_tier, certificate_id, submission_id",
      )
      .eq("certificate_id", certId)
      .not("certificate_id", "is", null)
      .maybeSingle();
    if (!report) return serveFallback();
    const rep = report as unknown as {
      overall_score: number;
      grade_tier: string;
      certificate_id: string;
      submission_id: string;
    };

    const { data: submission } = await supabaseAdmin
      .from("submissions")
      .select("title, brand, flagged, moderation_status, status, user_id")
      .eq("id", rep.submission_id)
      .maybeSingle();
    const sub = submission as
      | { title?: string | null; brand?: string | null; flagged?: boolean | null; moderation_status?: string | null; status?: string | null; user_id?: string | null }
      | null;
    if (isCertificateWithheld(sub)) return serveFallback();

    // US-1849 AC3: `badge_embedded` — the catalog's highest-XP moat act. This is
    // the only server-observable proof that a grade badge is living on somebody
    // else's page: the badge PNG was requested BY a page we don't own. A missing
    // or same-origin referer earns nothing (isOffPlatformEmbedReferer defaults
    // to "no"), and the award is idempotent on the certificate — so one badge
    // earns once ever, no matter how many impressions it serves, which is why
    // there is nothing here to farm. Best-effort and non-blocking: this is a
    // public image endpoint and a reward problem must never delay or break it.
    if (kind === "badge" && sub?.user_id && isOffPlatformEmbedReferer(c.req.header("referer"))) {
      void grantReward(sub.user_id, "badge_embedded", {
        referenceId: `cert:${certId}`,
        source: "badge_embed",
        metadata: { target_type: "cert" },
      }).catch((err) =>
        captureException(err, { level: "warn", route: "cert-image.badge-reward" })
      );
    }

    // US-1851 AC4: a cosmetic FRAME on the shared slab, unlocked by the level of
    // the seller who owns the certificate — not the level of whoever requested
    // the image. Unknown key, locked key, or an unreadable level all resolve to
    // no frame (isFrameUnlocked fails closed), so `?frame=frame_legend` on a new
    // seller's card renders exactly the card they already had.
    let frameKey: string | null = null;
    if (kind === "slab") {
      const requested = (c.req.query("frame") ?? "").trim();
      if (isCardFrameKey(requested)) {
        const level = await rewardLevelFor(sub?.user_id);
        if (isFrameUnlocked(requested, level)) frameKey = requested;
      }
    }

    // US-1913 AC1/AC3/AC4: the status strip for the grader who owns this
    // certificate — never for whoever requested the image. Resolved per request,
    // which is what lets a tier change reach a badge already pasted into a live
    // listing. An empty string (below the floor, level 0, unreadable) renders
    // the plain badge.
    const statusLine = wantsStatus ? await badgeStatusLineFor(sub?.user_id) : "";

    // Cache: render once, then serve the stored PNG. Path keyed by certificate_id
    // (its stable public identity); invalidated by deleteCertImages on re-grade.
    // The frame is part of the key — a framed render must never overwrite the
    // plain one, and vice versa.
    //
    // The STATUS badge is deliberately EXEMPT from this durable cache. A stored
    // asset is only invalidated on re-grade, and a standing moves for reasons
    // that have nothing to do with the grade — so a stored status badge would
    // freeze a tier until the item was graded again, i.e. potentially forever.
    // It renders per request and leans on the 24h CDN bound instead.
    const key = kind === "slab"
      ? `slab-${format}${frameKey ? `-${frameKey}` : ""}`
      : kind;
    const path = `${certId}/${key}.png`;
    if (!wantsStatus) {
      const { data: cached } = await supabaseAdmin.storage
        .from("cert-assets")
        .download(path);
      if (cached) {
        return new Response(await cached.arrayBuffer(), {
          status: 200,
          headers: certImageHeaders(CERT_IMG_CACHE),
        });
      }
    }

    // Miss → render. Only the slab (non-label) needs the hero photo; embed it as
    // a data: URI (pre-fetched) so satori never does its own remote fetch.
    let heroDataUri: string | null = null;
    if (kind === "slab" && !SLAB_FORMATS[format].labelOnly) {
      const { data: imgs } = await supabaseAdmin
        .from("submission_images")
        .select("storage_path, image_type, display_order")
        .eq("submission_id", rep.submission_id)
        .order("display_order", { ascending: true });
      const rows = (imgs ?? []) as Array<{ storage_path: string; image_type: string; display_order: number }>;
      const hero = rows.find((r) => r.image_type === "front") ?? rows[0];
      if (hero) {
        const { data: signed } = await supabaseAdmin.storage
          .from("submission-images")
          .createSignedUrl(hero.storage_path, CERT_IMAGE_TTL);
        heroDataUri = await fetchImageDataUri(signed?.signedUrl);
      }
    }

    const data: CertImageData = {
      certId,
      // US-2613: our card, so our condition wording. Same helper as the SSR
      // payload above.
      title: certDisplayTitle(sub?.title ?? "Graded garment"),
      brand: sub?.brand ?? null,
      score: Number(rep.overall_score),
      gradeTier: rep.grade_tier,
      heroDataUri,
      certUrl: `${PUBLIC_SITE_URL}/cert/${certId}?s=qr`,
      frameKey,
      statusLine,
    };
    // A hero photo in a format satori/resvg can't rasterize (HEIC, AVIF, a
    // corrupt/truncated file) makes renderCertImage THROW, which would fall
    // through to the transparent fallback — a fully BLANK graded photo for a
    // perfectly valid, certified report. Degrade instead of blanking: if a
    // render that embedded the hero fails, retry once WITHOUT it. buildCertSlabHtml
    // renders a visible branded card (big score + tier) when heroImageUrl is null,
    // so the seller/buyer still gets a real graded photo, just without the garment
    // shot. Only a no-hero render that ALSO fails serves the transparent fallback.
    let png: Uint8Array;
    try {
      png = await renderCertImage(kind, format, data);
    } catch (renderErr) {
      if (!data.heroDataUri) throw renderErr; // nothing to strip → genuine failure
      captureException(renderErr, {
        route: "cert-image",
        tags: { certId, kind, retry: "no-hero" },
      });
      png = await renderCertImage(kind, format, { ...data, heroDataUri: null });
    }

    // Store durably (best-effort — a store failure still serves this render).
    // Never for the status badge: see the exemption above.
    if (!wantsStatus) {
      await supabaseAdmin.storage
        .from("cert-assets")
        .upload(path, png, { contentType: "image/png", upsert: true, cacheControl: "31536000" })
        .catch(() => {});
    }

    return new Response(new Uint8Array(png), {
      status: 200,
      headers: certImageHeaders(wantsStatus ? BADGE_STATUS_CACHE : CERT_IMG_CACHE),
    });
  } catch (err) {
    captureException(err, { route: "cert-image", tags: { certId, kind } });
    return serveFallback();
  }
});

// ── GET / HEAD /cert-photo/:id/:n ─────────────────────────────────
// US-2206: the STABLE, non-expiring URL for one garment photo on a public
// certificate.
//
// The gallery that GET /certificates/:id serves is signed with a 15-minute TTL
// (US-276 keeps `submission-images` private, and that is not negotiable). A
// signed URL is fine for rendering and useless for structured data: a crawler
// that reads one out of the Product JSON-LD and fetches it an hour later gets a
// 403, so `image[]` could only ever carry the hero. This endpoint is the
// indirection that fixes that — the PUBLIC url never expires, and the signing
// happens server-side, per request, behind the same publicity gate.
//
// `:n` is the position in display_order, matching the order both cert
// renderers index into, so /cert-photo/<id>/0 is the first photo on the page.
//
// The gate is identical to GET /certificates/:id and /cert-image/:id: resolved
// by certificate_id, non-null, plus isCertificateWithheld. A private, withheld,
// missing or out-of-range photo returns the transparent fallback PNG with HTTP
// 200 — the same choice /cert-image makes, so a probe cannot tell those cases
// apart and no page ever shows a broken image.
const CERT_PHOTO_CACHE =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

contentPublicRoutes.on("HEAD", "/cert-photo/:id/:n", () =>
  new Response(null, { status: 200, headers: certImageHeaders(CERT_PHOTO_CACHE) }));

contentPublicRoutes.get("/cert-photo/:id/:n", async (c) => {
  const certId = c.req.param("id");
  const position = Number(c.req.param("n"));
  const serveFallback = () =>
    new Response(fallbackPng(), {
      status: 200,
      headers: certImageHeaders("public, max-age=300"),
    });
  if (!isUuid(certId)) return serveFallback();

  try {
    const { data: report } = await supabaseAdmin
      .from("grade_reports")
      .select("certificate_id, submission_id")
      .eq("certificate_id", certId)
      .not("certificate_id", "is", null)
      .maybeSingle();
    if (!report) return serveFallback();
    const rep = report as unknown as { submission_id: string };

    const { data: submission } = await supabaseAdmin
      .from("submissions")
      .select("flagged, moderation_status, status")
      .eq("id", rep.submission_id)
      .maybeSingle();
    if (
      isCertificateWithheld(
        submission as
          | { flagged?: boolean | null; moderation_status?: string | null; status?: string | null }
          | null,
      )
    ) {
      return serveFallback();
    }

    const { data: imageRows } = await supabaseAdmin
      .from("submission_images")
      .select("id, storage_path, image_type, display_order")
      .eq("submission_id", rep.submission_id)
      .order("display_order", { ascending: true });
    const row = galleryRowAt(
      (imageRows ?? []) as CertSubmissionImageRow[],
      position,
    );
    if (!row) return serveFallback();

    // Sign for THIS request only. The signed URL never leaves the server — the
    // caller only ever sees the stable /cert-photo path — so the private-bucket
    // guarantee is unchanged.
    const { data: signed } = await supabaseAdmin.storage
      .from("submission-images")
      .createSignedUrl(row.storage_path, CERT_IMAGE_TTL);
    if (!signed?.signedUrl) return serveFallback();

    const upstream = await fetch(signed.signedUrl);
    if (!upstream.ok || !upstream.body) return serveFallback();

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
        "Cache-Control": CERT_PHOTO_CACHE,
      },
    });
  } catch (err) {
    captureException(err, { route: "cert-photo", tags: { certId } });
    return serveFallback();
  }
});

// ── GET /seller-badge/:handle ─────────────────────────────────────
// US-1761: the verified-seller STOREFRONT badge PNG (keyed to the handle, not a
// single cert). Rendered on the edge (full CPU) and proxied by the Pages
// Function functions/badge/verified/[handle].ts — sellers drop it, wrapped in a
// link to /verified/:handle, into a listing. Same publicity gate as
// /sellers/:handle (enabled + public). A miss/withheld/render error returns the
// transparent FALLBACK PNG (never a broken image; never leaks a private profile).
// NOT bucket-cached: seller stats change over time, so it renders on demand and
// relies on the shared 24h CDN cache rather than a stale-forever stored asset.
contentPublicRoutes.on("HEAD", "/seller-badge/:handle", (c) =>
  new Response(null, {
    status: 200,
    headers: certImageHeaders(
      wantsStatusBadge(c.req.query("status")) ? BADGE_STATUS_CACHE : CERT_IMG_CACHE,
    ),
  }));

contentPublicRoutes.get("/seller-badge/:handle", async (c) => {
  const handle = c.req.param("handle").trim();
  const fmtRaw = (c.req.query("format") ?? "wide").toLowerCase();
  const format: SellerBadgeFormat = isSellerBadgeFormat(fmtRaw) ? fmtRaw : "wide";
  // US-1913: the opt-in status format. Chosen per embed in Badge Studio, so the
  // same handle serves both the plain and the status badge.
  const wantsStatus = wantsStatusBadge(c.req.query("status"));
  const serveFallback = () =>
    new Response(fallbackPng(), { status: 200, headers: certImageHeaders("public, max-age=300") });

  if (!handle) return serveFallback();
  try {
    const { data: seller } = await supabaseAdmin
      .from("users")
      .select("id, verified_handle, verified_display_name")
      .ilike("verified_handle", handle)
      .eq("verified_enabled", true)
      .maybeSingle();
    if (!seller) return serveFallback();
    const s = seller as { id: string; verified_handle: string; verified_display_name: string | null };

    // Stats: certified grades for this seller (sample-capped, mirrors /sellers).
    const { data: certRows } = await supabaseAdmin
      .from("grade_reports")
      .select("overall_score, submissions!inner(user_id)")
      .eq("submissions.user_id", s.id)
      .not("certificate_id", "is", null)
      .limit(SELLER_STATS_SAMPLE);
    const rows = (certRows ?? []) as unknown as Array<{ overall_score: number }>;
    const total = rows.length;
    const sum = rows.reduce((acc, r) => acc + Number(r.overall_score), 0);
    const average = total > 0 ? Math.round((sum / total) * 10) / 10 : 0;

    // US-1913: the status strip is resolved on THIS request, which is what makes
    // a tier change reach a badge already pasted into somebody's storefront.
    const statusLine = wantsStatus ? await badgeStatusLineFor(s.id) : "";

    const png = await renderSellerBadge(format, {
      displayName: s.verified_display_name ?? s.verified_handle,
      totalGraded: total,
      totalIsCapped: total >= SELLER_STATS_SAMPLE,
      averageGrade: average,
      statusLine,
    });
    return new Response(new Uint8Array(png), {
      status: 200,
      headers: certImageHeaders(wantsStatus ? BADGE_STATUS_CACHE : CERT_IMG_CACHE),
    });
  } catch (err) {
    captureException(err, { route: "seller-badge", tags: { handle, format } });
    return serveFallback();
  }
});

// ── GET /achievement-badge/:key ───────────────────────────────────
// US-1850 AC3: a shareable PNG card for a gamification badge, rendered on the edge
// from the PUBLIC BADGE_CATALOG definition (name/description/tier) — proxied by a
// Pages Function like the other badges. An unknown key or render error returns the
// transparent FALLBACK PNG (never a broken image). The card describes the badge;
// whether a given user EARNED it is a separate, authenticated read.
contentPublicRoutes.on("HEAD", "/achievement-badge/:key", () =>
  new Response(null, { status: 200, headers: certImageHeaders(CERT_IMG_CACHE) }));

contentPublicRoutes.get("/achievement-badge/:key", async (c) => {
  const key = c.req.param("key").trim();
  const serveFallback = () =>
    new Response(fallbackPng(), { status: 200, headers: certImageHeaders("public, max-age=300") });
  const def = badgeByKey(key);
  if (!def) return serveFallback();
  try {
    const png = await renderAchievementBadge({
      name: def.name,
      description: def.description,
      tier: def.tier,
    });
    return new Response(new Uint8Array(png), { status: 200, headers: certImageHeaders(CERT_IMG_CACHE) });
  } catch (err) {
    captureException(err, { route: "achievement-badge", tags: { key } });
    return serveFallback();
  }
});

// ── GET /level-badge/:level ───────────────────────────────────────
// US-1857: the share card for a reward LEVEL, the other half of the one-tap
// share on a celebration. Same render path and same public-by-construction rule
// as /achievement-badge/:key — the card describes a RUNG on the public ladder
// (level number + its tier name and blurb), never who is standing on it, so it
// stays anonymous, cacheable and safe to hand to a Pages Function proxy.
//
// A level card is not a medal, so it says "GradeThread Level" and puts the level
// number in the medal. It carries no tier colour either: bronze/silver/gold
// belong to badges, and borrowing them here would imply a rarity the level
// ladder does not have.
contentPublicRoutes.on("HEAD", "/level-badge/:level", () =>
  new Response(null, { status: 200, headers: certImageHeaders(CERT_IMG_CACHE) }));

contentPublicRoutes.get("/level-badge/:level", async (c) => {
  const serveFallback = () =>
    new Response(fallbackPng(), { status: 200, headers: certImageHeaders("public, max-age=300") });
  const level = Number.parseInt(c.req.param("level"), 10);
  // A level is a small non-negative integer. Anything else is a crawler probing
  // the path, not a share — serve the transparent pixel rather than a card.
  if (!Number.isInteger(level) || level < 0 || level > 999) return serveFallback();

  try {
    const tier = tierForLevel(level);
    const png = await renderAchievementBadge({
      name: `Level ${level} · ${tier.name}`,
      description: tier.blurb,
      tier: "",
      eyebrow: "GradeThread Level",
      glyph: String(level),
    });
    return new Response(new Uint8Array(png), { status: 200, headers: certImageHeaders(CERT_IMG_CACHE) });
  } catch (err) {
    captureException(err, { route: "level-badge", tags: { level: String(level) } });
    return serveFallback();
  }
});

// ── GET /certificates/by-number/:number ───────────────────────────
// Resolve a PSA-style certificate number (typed by a buyer into /verify) to its
// certificate_id, applying the same certified + withhold rules as the cert
// endpoint. Returns minimal, buyer-safe data; never leaks a private/withheld
// report. The /verify page redirects to /cert/<certificate_id> on a hit.
contentPublicRoutes.get("/certificates/by-number/:number", async (c) => {
  const number = normalizeCertNumber(c.req.param("number"));

  const { data: report, error } = await supabaseAdmin
    .from("grade_reports")
    .select("certificate_id, submission_id, overall_score, grade_tier")
    .eq("certificate_number", number)
    .not("certificate_id", "is", null)
    .maybeSingle();
  if (error) return publicError(c, error, "query");
  if (!report) {
    // US-2569 AC5: the number on a hangtag outlives the certificate it was
    // issued against. Resolve it to the successor rather than saying not found.
    const revision = await loadRevisionResolution({ certificateNumber: number });
    if (revision) {
      return c.json({ found: false, ...revisionBody(revision) }, 200);
    }
    return c.json({ found: false }, 404);
  }
  const rep = report as unknown as {
    certificate_id: string;
    submission_id: string;
    overall_score: number;
    grade_tier: string;
  };

  const { data: submission } = await supabaseAdmin
    .from("submissions")
    .select("title, brand, flagged, moderation_status, status")
    .eq("id", rep.submission_id)
    .maybeSingle();
  const sub = submission as
    | {
        title?: string | null;
        brand?: string | null;
        flagged?: boolean | null;
        moderation_status?: string | null;
        status?: string | null;
      }
    | null;
  if (isCertificateWithheld(sub)) return c.json({ found: false }, 404);

  return c.json({
    found: true,
    certificate_id: rep.certificate_id,
    certificate_number: number,
    title: sub?.title ?? "Graded garment",
    brand: sub?.brand ?? null,
    overall_score: rep.overall_score,
    grade_tier: rep.grade_tier,
  });
});

// ── GET /certificates/:id/verify ──────────────────────────────────
// Public, no-auth integrity check (US-333). Re-derives the canonical content
// hash from the stored grade fields and confirms it matches what was sealed at
// finalization (and, when signed, that the HMAC validates). Detects a tampered
// DB row or a forged certificate screenshot — the QR points here, so a buyer
// can confirm authenticity without an account. Exposes only public fields:
// the verification verdict, algorithm, and the (non-secret) recomputed hash.
contentPublicRoutes.get("/certificates/:id/verify", async (c) => {
  const certId = c.req.param("id");
  if (!isUuid(certId)) return c.json({ error: "Not found" }, 404);

  // Same RLS-safe access as the cert endpoint: BY certificate_id, and only
  // certified (public) reports. A private report must stay unreachable (US-268).
  const { data: report, error } = await supabaseAdmin
    .from("grade_reports")
    .select(
      "certificate_id, submission_id, overall_score, grade_tier, fabric_condition_score, " +
        "structural_integrity_score, cosmetic_appearance_score, " +
        "functional_elements_score, odor_cleanliness_score, ai_summary, " +
        "buyer_writeup, coverage, authenticity_assessment, content_hash, content_signature, " +
        "integrity_version, created_at",
    )
    .eq("certificate_id", certId)
    .not("certificate_id", "is", null)
    .maybeSingle();
  if (error) return publicError(c, error, "query");
  if (!report) return c.json({ error: "Not found" }, 404);

  const r = report as unknown as {
    certificate_id: string;
    submission_id: string;
    overall_score: number | string;
    grade_tier: string;
    fabric_condition_score: number | string;
    structural_integrity_score: number | string;
    cosmetic_appearance_score: number | string;
    functional_elements_score: number | string;
    odor_cleanliness_score: number | string;
    ai_summary: string | null;
    buyer_writeup: string | null;
    // US-1279: the sealed coverage scope. Only consulted when integrity_version
    // >= 3; v1/v2 rows canonicalize without it.
    coverage:
      | { coverage_pct?: number | null; covered_zones?: string[] | null }
      | null;
    // US-2141: the sealed coarse authenticity verdict. Only consulted when
    // integrity_version >= 4; v1–v3 rows canonicalize without it.
    authenticity_assessment:
      | { verdict?: string | null; verdict_confidence?: number | null }
      | null;
    content_hash: string | null;
    content_signature: string | null;
    integrity_version: number | null;
    created_at: string;
  };

  // US-484: withhold verification for a flagged (suspect) certificate until a
  // human clears it — same gate as the cert endpoint, so a forged grade can't
  // be "verified" as authentic via the public path.
  const { data: vSub } = await supabaseAdmin
    .from("submissions")
    .select("flagged, moderation_status, status")
    .eq("id", r.submission_id)
    .maybeSingle();
  const vs = vSub as
    | { flagged?: boolean | null; moderation_status?: string | null; status?: string | null }
    | null;
  if (isCertificateWithheld(vs)) {
    return c.json({ error: "Not found" }, 404);
  }

  const result = await verifyCertIntegrity(
    {
      certificate_id: r.certificate_id,
      overall_score: r.overall_score,
      grade_tier: r.grade_tier,
      fabric_condition_score: r.fabric_condition_score,
      structural_integrity_score: r.structural_integrity_score,
      cosmetic_appearance_score: r.cosmetic_appearance_score,
      functional_elements_score: r.functional_elements_score,
      odor_cleanliness_score: r.odor_cleanliness_score,
      ai_summary: r.ai_summary ?? "",
      // US-770: sealed under integrity v2. v1 rows store integrity_version=1,
      // and verifyCertIntegrity canonicalizes them under v1 (ignoring this).
      buyer_writeup: r.buyer_writeup ?? "",
      // US-1279: sealed under integrity v3. v1/v2 rows canonicalize without
      // coverage (the verifier keys off the row's stored integrity_version).
      coverage_pct: r.coverage?.coverage_pct ?? null,
      covered_zones: r.coverage?.covered_zones ?? null,
      // US-2141: sealed under integrity v4. v1–v3 rows canonicalize without it
      // (the verifier keys off the row's stored integrity_version), so this is
      // additive and no historical certificate changes verdict.
      authenticity_verdict: r.authenticity_assessment?.verdict ?? null,
      authenticity_verdict_confidence: r.authenticity_assessment?.verdict_confidence ?? null,
    },
    r.content_hash,
    r.content_signature,
    r.integrity_version,
  );

  // US-1465: this fires on every public certificate view, so let a CDN absorb
  // bursts (e.g. a slab QR scanned by many buyers) instead of hitting the DB per
  // request. Short s-maxage keeps the moderation-withhold gate (a cert flagged
  // after caching) from serving a stale "verified" verdict for long.
  c.header(
    "Cache-Control",
    "public, max-age=30, s-maxage=60, stale-while-revalidate=120",
  );
  return c.json({
    certificate_id: r.certificate_id,
    status: result.status,
    verified: result.verified,
    signed: result.signed,
    algorithm: result.algorithm,
    integrity_version: result.integrity_version,
    content_hash: result.content_hash,
    issued_at: r.created_at,
  });
});

// ── POST /certificates/:id/view ───────────────────────────────────
// US-769: privacy-safe per-certificate view counter. Records NO buyer PII —
// it only bumps an aggregate count via a SECURITY DEFINER function that touches
// certified rows alone. Best-effort: a bad id / DB hiccup never fails the page.
// The client calls this once per browser session (coarse, abuse-resistant
// enough for a soft engagement signal — see certificate.tsx).
contentPublicRoutes.post("/certificates/:id/view", async (c) => {
  const certId = c.req.param("id");
  const { error } = await supabaseAdmin.rpc("increment_certificate_view", {
    p_certificate_id: certId,
  });
  // Swallow errors — the counter is non-critical and must never break the cert.
  return c.json({ ok: !error });
});


// ── POST /certificates/:id/report ─────────────────────────────────
// US-2550: the buyer's way out of "do not trust this certificate".
//
// That warning is the worst news the product can give someone, and until now
// it ended there — no report, no contact, nothing. This files against the
// certificate id the buyer is holding and lands in the SAME queue operators
// already drain (content_moderation_flags, US-889), whose own comment listed
// 'user_report' as a producer from the start.
//
// ANONYMOUS on purpose. The person best placed to report a forged certificate
// is the buyer looking at it on a marketplace, who has no GradeThread account
// and will not make one to file a complaint about us. The abuse surface that
// opens is bounded by three things: the /api/content/public/* limiter (60/min
// per IP, fail-closed), the partial unique index that keeps ONE open flag per
// certificate so a flood updates a single row rather than filling a table, and
// the fact that a flag is a queue entry, never an automatic takedown.
//
// It reports the certificate, not the reporter: nothing about the sender is
// stored — no IP, no fingerprint, no free-form contact details.
contentPublicRoutes.post("/certificates/:id/report", async (c) => {
  const certId = c.req.param("id");
  if (!isUuid(certId)) return c.json({ error: "Not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as
    | { reason?: unknown; note?: unknown }
    | null;
  if (!body || !isCertificateReportReason(body.reason)) {
    return c.json({ error: "Unknown report reason" }, 400);
  }
  const note = typeof body.note === "string" ? body.note : null;

  // Resolve the owner from the id rather than trusting anything sent, and use
  // it as the existence check: an unknown certificate is a 404, not a flag on
  // nothing. A WITHHELD certificate (US-484) is deliberately still reportable —
  // it is exactly the kind an operator wants a second signal on.
  const ownerUserId = await resolveCertificateOwner(certId);
  if (!ownerUserId) return c.json({ error: "Not found" }, 404);

  // Carry the repeat-report count in the reason. The queue keeps one open flag
  // per certificate, so without this the fifth reporter would silently
  // overwrite the first and five independent complaints would read as one.
  const { data: openFlag } = await supabaseAdmin
    .from("content_moderation_flags")
    .select("reason")
    .eq("content_type", "certificate")
    .eq("content_id", certId)
    .eq("status", "open")
    .maybeSingle();

  const flagId = await enqueueModerationFlag({
    contentType: "certificate",
    contentId: certId,
    ownerUserId,
    reason: composeCertificateReportReason(
      (openFlag as { reason: string } | null)?.reason ?? null,
      CERTIFICATE_REPORT_REASONS[body.reason],
      note,
    ),
    source: "user_report",
    // No reporter identity: this endpoint takes no auth and stores none.
    flaggedBy: null,
  });

  // A failed enqueue is logged inside the helper. The buyer is told the truth
  // either way rather than a cheerful lie, because the next thing they do
  // depends on whether the report actually went anywhere.
  if (!flagId) return c.json({ error: "Could not file the report" }, 502);
  return c.json({ ok: true });
});

// ── POST /badge-click ─────────────────────────────────────────────
// US-1760: attribute a click on an off-platform GradeThread badge (a cert badge
// or a verified-seller storefront badge) to the seller who owns it. Public +
// best-effort: the owner is resolved server-side from the cert/handle (never
// trusted from the caller), only known badge ?s= sources are recorded, and any
// error is swallowed so a bad ping never breaks the page. No buyer PII.
contentPublicRoutes.post("/badge-click", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { targetType?: unknown; targetId?: unknown; source?: unknown; variant?: unknown }
    | null;
  if (
    !body ||
    !isBadgeTargetType(body.targetType) ||
    typeof body.targetId !== "string" ||
    typeof body.source !== "string"
  ) {
    return c.json({ ok: false }, 200); // never surface validation detail to a public pinger
  }
  // US-1854: the visitor fingerprint for the share loop. Derived SERVER-SIDE
  // from the Cloudflare-verified IP + User-Agent — never from anything the
  // caller can set — so "unique verified click" can't be manufactured by a
  // pinger rotating a header. Null when the request carried no trustworthy IP,
  // which recordBadgeClick treats as "record it, reward nothing".
  const userAgent = c.req.header("user-agent") ?? null;
  const visitorHash = await visitorFingerprint(clientIp(c), userAgent);

  const { recorded } = await recordBadgeClick({
    targetType: body.targetType,
    targetId: body.targetId,
    source: body.source,
    visitorHash,
    userAgent,
    // US-1913 AC5: which badge FORMAT drove the click. Untrusted and unvalidated
    // on purpose — normalizeBadgeVariant folds anything that isn't "status" to
    // "plain", so the worst a spoofer can do is mislabel their OWN badge's
    // clicks, which is not a claim anybody else reads.
    variant: body.variant,
  });
  return c.json({ ok: recorded });
});

// ── GET /certificates.json ────────────────────────────────────────
// Compact list for the sitemap (US-293): every public certificate's id +
// lastmod. Capped + cursor-paginated by created_at so a crawler can't pull the
// whole table at once.
// ── GET /passports.json ───────────────────────────────────────────
// US-2110: compact list of PUBLIC garment passports for the sitemap.
//
// /passport/:slug is SSR'd with full Product JSON-LD and is explicitly designed
// to be indexable ("the marquee buyer-facing provenance surface — one
// indexable, AI-citable page per garment"), but no sitemap generator existed,
// so the pages were discoverable only via inbound links. They also sit outside
// the static-route CI guard, which skips any path containing ":" — nothing
// flagged the omission.
//
// VISIBILITY GATE: public_passport_slug is the opt-in. A garment is public if
// and only if it has one, which is exactly the predicate GET /api/passport/:slug
// resolves against — so this list cannot advertise a URL that would 404, and
// cannot leak a garment whose owner never published it.
//
// Cursor-paginated on created_at like certificates.json, and for the same
// reason: a crawler must not be able to pull the whole table in one request.
contentPublicRoutes.get("/passports.json", async (c) => {
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? 1000) || 1000, 1),
    5000,
  );
  const cursor = c.req.query("cursor");

  let q = supabaseAdmin
    .from("garments")
    .select("public_passport_slug, created_at")
    .not("public_passport_slug", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (cursor) q = q.lt("created_at", cursor);

  const { data, error } = await q;
  if (error) return publicError(c, error, "query");

  const rows = (data ?? []) as Array<{
    public_passport_slug: string | null;
    created_at: string;
  }>;
  // Paginate on the RAW page so the cursor always advances, mirroring
  // certificates.json.
  const nextCursor =
    rows.length === limit ? rows[rows.length - 1]?.created_at ?? null : null;

  return c.json({
    passports: rows
      .filter((r) => !!r.public_passport_slug)
      .map((r) => ({ slug: r.public_passport_slug as string, updated_at: r.created_at })),
    next_cursor: nextCursor,
  });
});

contentPublicRoutes.get("/certificates.json", async (c) => {
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? 1000) || 1000, 1),
    5000,
  );
  const cursor = c.req.query("cursor");

  // US-1680: join the parent submission's moderation state so WITHHELD certs
  // (flagged-but-unapproved, or still pending_review) never enter the sitemap —
  // they 404 on the public cert path, so listing them would create soft-404 /
  // crawl-bloat exactly as cert volume scales. Same predicate the single-cert
  // endpoint applies (isCertificateWithheld), so the sitemap can't drift from
  // what actually resolves.
  let q = supabaseAdmin
    .from("grade_reports")
    .select(
      "certificate_id, created_at, submissions!inner(status, flagged, moderation_status)",
    )
    .not("certificate_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (cursor) q = q.lt("created_at", cursor);

  const { data, error } = await q;
  if (error) return publicError(c, error, "query");

  const raw = data ?? [];
  // Paginate on the RAW page so a page that's entirely withheld still advances
  // the cursor (the crawler just sees a shorter page).
  const nextCursor =
    raw.length === limit ? raw[raw.length - 1]?.created_at ?? null : null;
  const rows = raw.filter((r) => {
    // supabase-js returns a to-one embed as an object (occasionally an array).
    const s = r as { submissions?: unknown };
    const sub = Array.isArray(s.submissions) ? s.submissions[0] : s.submissions;
    return !isCertificateWithheld(
      sub as { status?: string | null; flagged?: boolean | null; moderation_status?: string | null } | null,
    );
  });
  return c.json({
    certificates: rows.map((r) => ({
      id: r.certificate_id,
      updated_at: r.created_at,
    })),
    next_cursor: nextCursor,
  });
});

// ── GradeThread Verified — public seller profiles ─────────────────
// A seller's public trust page aggregates every CERTIFIED (public) grade they
// have earned. Two hard filters keep this safe on the RLS-bypassing service
// client: (1) the profile must be verified_enabled; (2) only reports with a
// non-null certificate_id are ever counted or exposed (US-268). We never leak
// a private report, an un-public profile, or the owner's user_id.

// How many recent certificates to surface on the profile page.
const SELLER_RECENT_CERTS = 12;
// Stats are computed over (at most) this many of the seller's most recent
// certified grades — bounds the work per request for prolific sellers.
const SELLER_STATS_SAMPLE = 1000;
// Cap on active listings surfaced on the storefront, newest first.
const SELLER_MAX_LISTINGS = 60;
// Cap on earned achievement badges surfaced on the profile (US-1850). The
// catalog is far smaller than this today; the bound is so a future catalog
// can't make the profile payload unbounded.
const SELLER_MAX_ACHIEVEMENTS = 60;

interface SellerCertRow {
  overall_score: number;
  grade_tier: string;
  certificate_id: string;
  created_at: string;
  submissions: { user_id: string; title: string | null; brand: string | null } | null;
}

// One active-listing card for the public storefront. A card is EITHER graded
// (has cert fields, links to /cert/:id) or non-graded (has listing_url, links
// out to the marketplace) — never both, never neither.
interface StorefrontListing {
  id: string;
  title: string;
  brand: string | null;
  price: number;
  photo_url: string | null;
  platform: string;
  certificate_id?: string;
  overall_score?: number;
  grade_tier?: string;
  listing_url?: string;
}

interface ListingJoinRow {
  id: string;
  inventory_item_id: string;
  listing_title: string | null;
  listing_price: number;
  listing_url: string | null;
  platform: string;
  primary_photo_id: string | null;
  inventory_items: {
    title: string | null;
    brand: string | null;
    grade_report_id: string | null;
  } | null;
}

// Build the storefront listing cards for a seller. PUBLIC + service-role, so
// every query is scoped to the seller's own rows (US-268): listings are reached
// through inventory_items.user_id; nothing else is exposed. Caller must already
// have confirmed verified_enabled + verified_show_listings.
async function loadStorefrontListings(
  sellerId: string,
): Promise<StorefrontListing[]> {
  const { data: listingRows, error } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, listing_title, listing_price, listing_url, platform, primary_photo_id, inventory_items!inner(user_id, title, brand, grade_report_id)",
    )
    .eq("inventory_items.user_id", sellerId)
    // US-2176: listing_status is the single source of truth for "live"; is_active
    // is now a derived mirror of it (trigger trg_listings_sync_is_active), so the
    // former defensive .eq("is_active", true) double-filter is dropped. Kept the
    // status filter rather than is_active because the storefront shows only
    // 'active' (not 'relisted'), which is_active would also admit.
    .eq("listing_status", "active")
    .order("listed_at", { ascending: false })
    .limit(SELLER_MAX_LISTINGS);
  if (error) throw error;
  const rows = (listingRows ?? []) as unknown as ListingJoinRow[];
  if (rows.length === 0) return [];

  // Public certs for the graded items, keyed by grade_report_id. Only reports
  // with a non-null certificate_id are "graded" on the storefront.
  const reportIds = [
    ...new Set(
      rows
        .map((r) => r.inventory_items?.grade_report_id)
        .filter((id): id is string => !!id),
    ),
  ];
  const certByReport = new Map<
    string,
    { certificate_id: string; overall_score: number; grade_tier: string }
  >();
  if (reportIds.length > 0) {
    const { data: certs } = await supabaseAdmin
      .from("grade_reports")
      .select("id, certificate_id, overall_score, grade_tier")
      .in("id", reportIds)
      .not("certificate_id", "is", null);
    for (const c of (certs ?? []) as Array<{
      id: string;
      certificate_id: string;
      overall_score: number;
      grade_tier: string;
    }>) {
      certByReport.set(c.id, {
        certificate_id: c.certificate_id,
        overall_score: c.overall_score,
        grade_tier: c.grade_tier,
      });
    }
  }

  // Cover photo per item: the listing's chosen primary photo if set, else the
  // item's lowest sort_order photo. One query, grouped in JS.
  const itemIds = [...new Set(rows.map((r) => r.inventory_item_id))];
  const photoById = new Map<string, string | null>();
  const firstPhotoByItem = new Map<string, string | null>();
  if (itemIds.length > 0) {
    const { data: photos } = await supabaseAdmin
      .from("item_photos")
      .select("id, inventory_item_id, photo_url, thumbnail_url, photo_type, photo_role, sort_order")
      .in("inventory_item_id", itemIds)
      .order("sort_order", { ascending: true });
    // US-1549: 'internal' photos (price tags, receipts) never appear on the
    // PUBLIC storefront.
    for (const p of filterListablePhotos((photos ?? []) as Array<{
      id: string;
      inventory_item_id: string;
      photo_url: string;
      thumbnail_url: string | null;
      photo_type: string | null;
      // US-2462: declared so the select above cannot lose it silently.
      photo_role: string | null;
    }>)) {
      const url = p.thumbnail_url ?? p.photo_url;
      photoById.set(p.id, url);
      if (!firstPhotoByItem.has(p.inventory_item_id)) {
        firstPhotoByItem.set(p.inventory_item_id, url);
      }
    }
  }

  const cards: StorefrontListing[] = [];
  for (const r of rows) {
    const item = r.inventory_items;
    const cert = item?.grade_report_id
      ? certByReport.get(item.grade_report_id)
      : undefined;
    // Nothing to link to → skip (e.g. a not-yet-published draft with no URL).
    if (!cert && !r.listing_url) continue;
    const photo =
      (r.primary_photo_id ? photoById.get(r.primary_photo_id) : undefined) ??
      firstPhotoByItem.get(r.inventory_item_id) ??
      null;
    cards.push({
      id: r.id,
      title: r.listing_title || item?.title || "Listed item",
      brand: item?.brand ?? null,
      price: r.listing_price,
      photo_url: photo,
      platform: r.platform,
      ...(cert
        ? {
            certificate_id: cert.certificate_id,
            overall_score: cert.overall_score,
            grade_tier: cert.grade_tier,
          }
        : { listing_url: r.listing_url ?? undefined }),
    });
  }
  return cards;
}

// ── GET /sellers/:handle ──────────────────────────────────────────
contentPublicRoutes.get("/sellers/:handle", async (c) => {
  const handle = c.req.param("handle").trim();
  if (!handle) return c.json({ error: "Not found" }, 404);

  // Public, enabled profile only. ilike (no wildcards) = case-insensitive exact.
  const { data: seller, error: sellerErr } = await supabaseAdmin
    .from("users")
    .select(
      "id, verified_handle, verified_display_name, verified_bio, verified_since, verified_show_listings",
    )
    .ilike("verified_handle", handle)
    .eq("verified_enabled", true)
    .maybeSingle();
  if (sellerErr) return publicError(c, sellerErr, "seller");
  if (!seller) return c.json({ error: "Not found" }, 404);

  // Certified grades for this seller, newest first. The inner join + the
  // submissions.user_id filter scope to the owner; the certificate_id filter
  // keeps it to public reports only.
  const { data: certRows, error: certErr } = await supabaseAdmin
    .from("grade_reports")
    .select(
      "overall_score, grade_tier, certificate_id, created_at, submissions!inner(user_id, title, brand)",
    )
    .eq("submissions.user_id", seller.id)
    .not("certificate_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(SELLER_STATS_SAMPLE);
  if (certErr) return publicError(c, certErr, "seller-certs");

  const rows = (certRows ?? []) as unknown as SellerCertRow[];
  const total = rows.length;
  const sum = rows.reduce((acc, r) => acc + Number(r.overall_score), 0);
  const average = total > 0 ? Math.round((sum / total) * 10) / 10 : 0;

  const tierDistribution: Record<string, number> = {};
  for (const r of rows) {
    tierDistribution[r.grade_tier] = (tierDistribution[r.grade_tier] ?? 0) + 1;
  }

  const recent = rows.slice(0, SELLER_RECENT_CERTS).map((r) => ({
    id: r.certificate_id,
    title: r.submissions?.title ?? "Graded garment",
    brand: r.submissions?.brand ?? null,
    overall_score: r.overall_score,
    grade_tier: r.grade_tier,
    created_at: r.created_at,
  }));

  // Storefront listings — only when the seller opted in. A failure here must not
  // take down the (more important) trust profile, so degrade to an empty shop.
  const showListings = seller.verified_show_listings === true;
  let listings: StorefrontListing[] = [];
  if (showListings) {
    try {
      listings = await loadStorefrontListings(seller.id);
    } catch (err) {
      console.error("[content-public] storefront listings failed:", err);
    }
  }

  // US-1850 AC3: earned achievement badges on the public profile. Scoped to
  // this seller's user_id (US-268) and projected through publicAchievements, so
  // only catalog metadata + earned_at leave — never the private `context`
  // snapshot. Best-effort: a failure degrades to no medals rather than taking
  // down the trust page.
  let achievements: PublicAchievement[] = [];
  try {
    const { data: badgeRows, error: badgeErr } = await supabaseAdmin
      .from("user_badges")
      .select("badge_key, earned_at")
      .eq("user_id", seller.id)
      .order("earned_at", { ascending: false })
      .limit(SELLER_MAX_ACHIEVEMENTS);
    if (badgeErr) throw badgeErr;
    achievements = publicAchievements(
      (badgeRows ?? []) as Array<{ badge_key: string; earned_at: string }>,
    );
  } catch (err) {
    console.error("[content-public] seller achievements failed:", err);
  }

  // US-1851 AC4: the seller's LEVEL FLAIR — tier name only. Projected through
  // publicLevelFlair, which deliberately drops XP: a tier is a rank anyone may
  // see, while an XP total is a business metric (how much they grade, how often
  // they list) that belongs to the seller. Same rule the achievement projection
  // follows. Fail-closed to Thrifter (level 0) on any read problem.
  const flair = publicLevelFlair(await rewardLevelFor(seller.id));

  // US-1912 AC3: the Grade Integrity tier. Projected through
  // loadPublicSellerIntegrity, which sends a tier NAME and nothing else — the
  // confirmed/disputed counts under it are the seller's business, and the
  // anti-gaming floor is enforced there, so a seller below it gets null and the
  // section simply does not render. Distinct from the level flair beside it:
  // level is how much they DO, integrity is how right they have been PROVEN.
  const integrity = await loadPublicSellerIntegrity(seller.id);

  return c.json({
    seller: {
      handle: seller.verified_handle,
      display_name: seller.verified_display_name ?? seller.verified_handle,
      bio: seller.verified_bio ?? null,
      verified_since: seller.verified_since ?? null,
    },
    achievements,
    level: flair,
    integrity,
    stats: {
      total_graded: total,
      // True when we hit the sample ceiling — the page can show "1,000+".
      total_is_capped: total >= SELLER_STATS_SAMPLE,
      average_grade: average,
      tier_distribution: tierDistribution,
    },
    recent_certificates: recent,
    show_listings: showListings,
    listings,
  });
});

// Upper bound on certified rows scanned when aggregating directory stats. The
// verified cohort is opt-in (a small, bounded set), so one query covers it; if
// it ever grows large this should move to a DB-side aggregate (materialized
// view / RPC).
const DIRECTORY_STATS_SAMPLE = 50000;

// ── GET /sellers.json ─────────────────────────────────────────────
// Compact list of public seller handles for the sitemap (verified profiles are
// indexable organic surfaces) AND the public /verified directory + leaderboard
// (US-863). Carries the headline trust stats the directory ranks by
// (total_graded, average_grade) alongside the handle + lastmod the sitemap
// reads. Same public projection as the per-seller profile: only verified_enabled
// profiles, and stats counted over CERTIFIED (public) reports only — no private
// data leaks. Capped; lastmod is the row's updated_at.
contentPublicRoutes.get("/sellers.json", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select(
      "id, verified_handle, verified_display_name, verified_since, updated_at",
    )
    .eq("verified_enabled", true)
    .not("verified_handle", "is", null)
    .order("updated_at", { ascending: false })
    .limit(5000);
  if (error) return publicError(c, error, "query");

  const sellers = (data ?? []) as Array<{
    id: string;
    verified_handle: string;
    verified_display_name: string | null;
    verified_since: string | null;
    updated_at: string | null;
  }>;

  // Headline stats per seller — count + average of their CERTIFIED (public)
  // grades — aggregated in ONE query over the whole verified set and grouped in
  // JS. The inner join + certificate_id filter keep it to public reports owned
  // by these sellers (US-268); we never read a private report or another tenant.
  const statById = new Map<string, { count: number; sum: number }>();
  if (sellers.length > 0) {
    const ids = sellers.map((s) => s.id);
    const { data: certRows, error: certErr } = await supabaseAdmin
      .from("grade_reports")
      .select("overall_score, submissions!inner(user_id)")
      .in("submissions.user_id", ids)
      .not("certificate_id", "is", null)
      .limit(DIRECTORY_STATS_SAMPLE);
    if (certErr) return publicError(c, certErr, "seller-stats");
    for (
      const r of (certRows ?? []) as unknown as Array<{
        overall_score: number;
        submissions: { user_id: string } | null;
      }>
    ) {
      const uid = r.submissions?.user_id;
      if (!uid) continue;
      const agg = statById.get(uid) ?? { count: 0, sum: 0 };
      agg.count += 1;
      agg.sum += Number(r.overall_score);
      statById.set(uid, agg);
    }
  }

  return c.json({
    truncated: warnIfCapped("sellers.json", sellers.length, 5000),
    sellers: sellers.map((s) => {
      const agg = statById.get(s.id);
      const total = agg?.count ?? 0;
      return {
        handle: s.verified_handle,
        display_name: s.verified_display_name ?? s.verified_handle,
        verified_since: s.verified_since ?? null,
        updated_at: s.updated_at,
        total_graded: total,
        average_grade: total > 0 ? Math.round((agg!.sum / total) * 10) / 10 : 0,
      };
    }),
  });
});

// ── GET /referral-leaderboard.json ────────────────────────────────
// Public, opt-in "top referrers" board (US-864). Renders ONLY a user-chosen
// display alias + their count of granted referrals — never an email, real name,
// or user id (no PII leaves this endpoint). Opt-in: only rows with
// referral_leaderboard_enabled = true are eligible, and only those with at least
// one GRANTED (rewarded) referral are ranked. Counts come from referral_events,
// which the service-role client can read; we expose only the aggregate.
contentPublicRoutes.get("/referral-leaderboard.json", async (c) => {
  const { data: optedIn, error } = await supabaseAdmin
    .from("users")
    .select("id, referral_display_name, verified_handle, verified_enabled")
    .eq("referral_leaderboard_enabled", true)
    .not("referral_display_name", "is", null)
    .limit(5000);
  if (error) return publicError(c, error, "leaderboard-users");

  const users = (optedIn ?? []) as Array<{
    id: string;
    referral_display_name: string | null;
    // US-1784: only a PUBLICLY-verified seller (verified_enabled) exposes a
    // handle here, so the leaderboard row can link to their /verified profile.
    verified_handle: string | null;
    verified_enabled: boolean | null;
  }>;
  if (users.length === 0) return c.json({ referrers: [] });

  const ids = users.map((u) => u.id);
  // Count granted (rewarded) referrals per opted-in referrer.
  const { data: grantedRows, error: gErr } = await supabaseAdmin
    .from("referral_events")
    .select("referrer_user_id")
    .in("referrer_user_id", ids)
    .eq("reward_status", "granted")
    .limit(DIRECTORY_STATS_SAMPLE);
  if (gErr) return publicError(c, gErr, "leaderboard-counts");

  const countById = new Map<string, number>();
  for (const r of (grantedRows ?? []) as Array<{ referrer_user_id: string }>) {
    countById.set(r.referrer_user_id, (countById.get(r.referrer_user_id) ?? 0) + 1);
  }

  // A leaderboard of zero-referral aliases isn't a leaderboard — rankReferrers
  // ranks by granted count desc, drops zero-referral rows, and caps the list.
  const referrers = rankReferrers(
    users.map((u) => ({
      id: u.id,
      display_name: u.referral_display_name as string,
      // Link only publicly-verified sellers; others stay alias-only (privacy).
      verified_handle: u.verified_enabled ? u.verified_handle : null,
    })),
    countById,
  );

  return c.json({ referrers });
});


// ── GET /buyer-profile/:handle ────────────────────────────────────
// US-1818: the PUBLIC, opt-in buyer Trust Score profile. Hard-filters to
// buyer_profile_enabled = true and emits ONLY the buyer's opted-in stats
// (buildPublicProfile is the PII chokepoint) — no email, user id, or purchase
// detail ever leaves here. 404 (not 403) when the handle isn't a public profile,
// so a private/absent handle is indistinguishable from a non-existent one.
contentPublicRoutes.get("/buyer-profile/:handle", async (c) => {
  const handle = c.req.param("handle");
  if (!handle) return c.json({ error: "Not found." }, 404);

  const { data: user } = await supabaseAdmin
    .from("users")
    .select("id, buyer_profile_handle, buyer_profile_show, rewards_display_name, created_at")
    .ilike("buyer_profile_handle", handle)
    .eq("buyer_profile_enabled", true)
    .maybeSingle();
  if (!user) return c.json({ error: "Not found." }, 404);
  const u = user as {
    id: string;
    buyer_profile_handle: string;
    buyer_profile_show: unknown;
    rewards_display_name: string | null;
    created_at: string;
  };

  const vis = normalizeVisibility(u.buyer_profile_show);

  // Trust level (only queried when the buyer opted to show it).
  let level = 0;
  let levelLabel = "new";
  if (vis.level) {
    const { data: trust } = await supabaseAdmin
      .from("buyer_trust_scores")
      .select("level, level_label")
      .eq("user_id", u.id)
      .maybeSingle();
    const t = trust as { level: number; level_label: string } | null;
    level = t?.level ?? 0;
    levelLabel = t?.level_label ?? "new";
  }

  // Confirmed-grade count (only when opted in).
  let confirmations = 0;
  if (vis.confirmations) {
    const { count } = await supabaseAdmin
      .from("grade_outcomes")
      .select("id", { count: "exact", head: true })
      .eq("buyer_user_id", u.id)
      .eq("source", "buyer_arrival")
      .eq("match_status", "confirmed");
    confirmations = count ?? 0;
  }

  const profile = buildPublicProfile(
    {
      handle: u.buyer_profile_handle,
      displayName: u.rewards_display_name ?? u.buyer_profile_handle,
      level,
      levelLabel,
      memberSince: u.created_at,
      confirmations,
    },
    vis,
  );
  return c.json({ profile });
});

// ── GET /finds.json ───────────────────────────────────────────────
// US-1855: the public Showcase / "Finds" feed. Anonymous; powers both the SSR
// Pages Function at /finds and the SPA route (Model B — one payload, two
// renderers, so neither can quietly describe something the other doesn't).
//
// EVERY row comes from the `public_showcase_finds` VIEW, never from
// grade_reports/submissions directly. That is the whole safety argument: the
// view carries the seller's per-item consent gate AND the certificate
// visibility rules (certified, review-approved, not moderation-withheld), and it
// projects no user id, no email and no private grading internals. Reading the
// base tables here would put those three guarantees in this handler's hands
// instead, where the next edit could drop one.
contentPublicRoutes.get("/finds.json", async (c) => {
  const query = parseFindsQuery(new URL(c.req.url).searchParams);

  let scan = supabaseAdmin
    .from("public_showcase_finds")
    .select(
      "grade_report_id, certificate_id, overall_score, grade_tier, graded_at, showcased_at, title, brand, brand_slug, category, garment_type, value_cents, seller_handle, seller_display_name",
    )
    .order("showcased_at", { ascending: false })
    .limit(FINDS_SCAN_LIMIT);
  if (query.brandSlug) scan = scan.eq("brand_slug", query.brandSlug);
  if (query.category) scan = scan.eq("category", query.category);
  if (query.minGrade != null) scan = scan.gte("overall_score", query.minGrade);

  const { data, error } = await scan;
  if (error) return publicError(c, error, "finds");
  const rows = (data ?? []) as unknown as ShowcaseFindRow[];

  // Reaction counts for the scanned window, in ONE query. Only aggregates leave
  // this endpoint — who reacted is never public (see the RLS note in 00546).
  const counts = new Map<string, number>();
  if (rows.length > 0) {
    const { data: reactionRows, error: reactionErr } = await supabaseAdmin
      .from("showcase_reactions")
      .select("grade_report_id")
      .in("grade_report_id", rows.map((r) => r.grade_report_id))
      .limit(FINDS_SCAN_LIMIT * 200);
    // Reactions are decoration on top of the feed; a failure here must not take
    // the feed down, so degrade to zero counts rather than 500.
    if (reactionErr) {
      console.error("[content-public] finds reactions failed:", reactionErr.message);
    } else {
      for (const r of (reactionRows ?? []) as Array<{ grade_report_id: string }>) {
        counts.set(r.grade_report_id, (counts.get(r.grade_report_id) ?? 0) + 1);
      }
    }
  }

  const projected = rows.map((r) =>
    projectFind(r, counts.get(r.grade_report_id) ?? 0, PUBLIC_SITE_URL)
  );
  const ranked = rankFinds(projected, query.sort, Date.now());

  return c.json({
    truncated: warnIfCapped("finds.json", rows.length, FINDS_SCAN_LIMIT),
    sort: query.sort,
    filters: {
      brand_slug: query.brandSlug,
      category: query.category,
      min_grade: query.minGrade,
    },
    total: ranked.length,
    finds: ranked.slice(0, query.limit),
    // Facets are computed over the UNSLICED window so the filter chips reflect
    // the whole feed, not just the page being rendered.
    facets: {
      brands: brandFacets(rows),
      categories: categoryFacets(rows),
    },
    // AC3: the community leaderboard the Showcase feeds. Ranked over the same
    // window, and only over sellers who run a public verified profile.
    leaderboard: showcaseLeaderboard(projected),
  });
});

// ── GET /leaderboards.json ────────────────────────────────────────
// US-1856: the public REWARD LEADERBOARDS. Anonymous; powers both the SSR Pages
// Function at /leaderboards and the SPA route (Model B — one payload, two
// renderers, so neither can rank someone the other doesn't).
//
// Two shapes from one path:
//   • no `metric` → the HUB: a short board for each of the four metrics.
//   • `metric=<key>` → ONE board, with its brand/category facets.
//
// Only opted-in accounts (00547) with a resolvable public alias are ever
// candidates, and only a nonzero score earns a row — see lib/leaderboards.ts for
// the identity gates and lib/leaderboards-data.ts for the per-board anti-gaming.
contentPublicRoutes.get("/leaderboards.json", async (c) => {
  const query = parseLeaderboardQuery(new URL(c.req.url).searchParams);

  try {
    const tz = await loadSeasonTimezone();
    const nowMs = Date.now();
    const window = boardWindow(query.period, nowMs, tz);
    const windowJson = {
      period: window.period,
      starts_at: window.startMs != null ? new Date(window.startMs).toISOString() : null,
      ends_at: window.endMs != null ? new Date(window.endMs).toISOString() : null,
    };

    // The current week's boundary travels with EVERY response, whichever window
    // was asked for. The sitemap needs a derived date for these pages (US-2100
    // forbids stamping today()), and this is the only real one they have: the
    // instant the live ranking window opened. Re-deriving it in the sitemap
    // would mean a second Monday calendar, which is exactly what boardWindow
    // exists to prevent.
    const week = boardWindow("weekly", nowMs, tz);
    const currentWeek = {
      starts_at: week.startMs != null ? new Date(week.startMs).toISOString() : null,
      ends_at: week.endMs != null ? new Date(week.endMs).toISOString() : null,
    };

    const cohort = await loadCohort();

    // The metric catalog travels with every response. It is what lets the SSR
    // page, the SPA and the sitemap agree on which boards exist and what each
    // column is called, without three copies of the same list.
    const metrics = LEADERBOARD_METRICS as readonly LeaderboardMetric[];

    if (!query.metric) {
      const boards = [];
      for (const m of metrics) {
        const data = await loadBoard(m.key, cohort, window, {
          brandSlug: null,
          category: null,
        });
        boards.push({
          metric: m,
          path: leaderboardPath(m.key),
          entries: rankLeaderboard(
            data.candidates,
            PUBLIC_SITE_URL,
            Math.min(query.limit, LEADERBOARD_HUB_LIMIT),
          ),
        });
      }
      return c.json({
        hub: true,
        window: windowJson,
        current_week: currentWeek,
        metrics,
        boards,
        listed: cohort.length,
      });
    }

    const metric = metrics.find((m) => m.key === query.metric) as LeaderboardMetric;
    // A facet on a board whose rows are not garments would be a filter that
    // silently did nothing. Report it rather than pretending it applied.
    const facetApplied = metric.facetable && !!(query.brandSlug || query.category);
    const filters = metric.facetable
      ? { brandSlug: query.brandSlug, category: query.category }
      : { brandSlug: null, category: null };

    const data = await loadBoard(query.metric as LeaderboardMetricKey, cohort, window, filters);
    const entries = rankLeaderboard(data.candidates, PUBLIC_SITE_URL, query.limit);

    return c.json({
      hub: false,
      metric,
      metrics,
      window: windowJson,
      current_week: currentWeek,
      path: leaderboardPath(metric.key, {
        brandSlug: filters.brandSlug,
        category: filters.category,
      }),
      filters: {
        brand_slug: filters.brandSlug,
        category: filters.category,
      },
      facet_applied: facetApplied,
      facet_supported: metric.facetable,
      truncated: data.truncated,
      total: data.candidates.filter((x) => x.score > 0).length,
      entries,
      facets: data.facets,
      listed: cohort.length,
    });
  } catch (err) {
    return publicError(c, err, "leaderboards");
  }
});
