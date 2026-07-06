import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { filterListablePhotos } from "../lib/item-photo-storage.ts";
import { verifyPreviewToken } from "../lib/preview-token.ts";
import { verifyCertIntegrity } from "../lib/cert-integrity.ts";
import { isCertificateWithheld } from "../lib/certificate-visibility.ts";
import {
  buildCertGallery,
  selectHeroUrl,
  type SubmissionImageRow as CertSubmissionImageRow,
} from "../lib/certificate-gallery.ts";
import { normalizeCertNumber } from "../lib/cert-number.ts";
import {
  type CertImageData,
  fetchImageDataUri,
  renderCertImage,
  type SlabFormat,
  SLAB_FORMATS,
} from "../lib/cert-image-render.ts";
import { FALLBACK_PNG_BASE64 } from "../lib/cert-og-template.ts";
import { captureException, readCtxVar } from "../lib/observability.ts";
import { rankReferrers } from "../lib/referral-rewards.ts";
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
  "reading_time_min, published_at, updated_at";

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
}
interface BlogFullRow extends BlogListRow {
  body_html: string | null;
  seo_title: string | null;
  seo_description: string | null;
  secondary_keywords: string[] | null;
  jsonld: unknown;
  author: unknown;
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

  let q = supabaseAdmin
    .from("blog_posts")
    .select(LIST_COLUMNS)
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(limit);
  if (cursor) q = q.lt("published_at", cursor);
  if (productFocus) q = q.eq("product_focus", productFocus);

  const { data, error } = await q;
  if (error) return publicError(c, error, "query");

  const rows = (data ?? []) as unknown as BlogListRow[];
  const nextCursor =
    rows.length === limit ? rows[rows.length - 1]?.published_at : null;
  return c.json({ posts: rows, next_cursor: nextCursor });
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
  return c.json({ authors });
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

  return c.json({
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
const CERT_REPORT_COLUMNS =
  "overall_score, grade_tier, fabric_condition_score, structural_integrity_score, " +
  "cosmetic_appearance_score, functional_elements_score, odor_cleanliness_score, " +
  "ai_summary, buyer_writeup, certificate_id, certificate_number, created_at, submission_id, verified_capture, original_photos, live_capture, verified_360";

// Signed-URL TTL for certificate images (seconds). Long enough for an edge
// cache window; the cert SSR caches the HTML, not the URL, so this just needs
// to outlive a render.
// submission-images is private; reads use short-lived signed URLs (US-276,
// ≤15 min). The cert SSR/OG HTML is itself CDN-cached, so the URL only needs to
// outlive a single render.
const CERT_IMAGE_TTL = 15 * 60;

// ── GET /certificates/:id ─────────────────────────────────────────
// Public certificate by certificate_id. Returns 404 for any id that doesn't
// map to a certified (public) report — never leaks a private report.
contentPublicRoutes.get("/certificates/:id", async (c) => {
  const certId = c.req.param("id");

  const { data: report, error } = await supabaseAdmin
    .from("grade_reports")
    .select(CERT_REPORT_COLUMNS)
    .eq("certificate_id", certId)
    .not("certificate_id", "is", null)
    .maybeSingle();
  if (error) return publicError(c, error, "query");
  if (!report) return c.json({ error: "Not found" }, 404);
  const rep = report as unknown as CertReportRow;

  // Garment metadata from the parent submission (title/brand/category +
  // the seller's buyer-facing description, US-760).
  const { data: submission } = await supabaseAdmin
    .from("submissions")
    .select(
      "title, brand, garment_type, garment_category, description, flagged, moderation_status, status",
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

  return c.json({
    certificate: {
      ...publicReport,
      verified_capture_passed: rep.verified_capture?.verified === true,
      // US-1283: positive-only. True iff the submission earned the strongest
      // fraud-proof "Live-Verified" badge; the downgrade reasons stay server-side.
      live_capture_verified: rep.live_capture?.badge === "live_verified",
      // US-1281: positive-only. True iff the submission earned the premium
      // '360-Verified' badge; the raw capture metrics stay server-side.
      verified_360_badge: rep.verified_360?.badge === "verified_360",
      // US-861: positive-only. True iff the photo-reuse scan ran and found no
      // cross-account match. Never leaks hashes/distances.
      original_photos_verified: rep.original_photos?.verified === true,
      id: rep.certificate_id,
      title: submission?.title ?? "Graded garment",
      brand: submission?.brand ?? null,
      garment_type: submission?.garment_type ?? null,
      garment_category: submission?.garment_category ?? null,
      description: submission?.description ?? null,
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

// Marketplace/OG reachability probes HEAD before fetching — always answer 200.
contentPublicRoutes.on("HEAD", "/cert-image/:id", () =>
  new Response(null, { status: 200, headers: certImageHeaders(CERT_IMG_CACHE) }));

contentPublicRoutes.get("/cert-image/:id", async (c) => {
  const certId = c.req.param("id");
  const kindRaw = (c.req.query("kind") ?? "slab").toLowerCase();
  const kind = kindRaw === "og" || kindRaw === "badge" ? kindRaw : "slab";
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
      .select("title, brand, flagged, moderation_status, status")
      .eq("id", rep.submission_id)
      .maybeSingle();
    const sub = submission as
      | { title?: string | null; brand?: string | null; flagged?: boolean | null; moderation_status?: string | null; status?: string | null }
      | null;
    if (isCertificateWithheld(sub)) return serveFallback();

    // Cache: render once, then serve the stored PNG. Path keyed by certificate_id
    // (its stable public identity); invalidated by deleteCertImages on re-grade.
    const key = kind === "slab" ? `slab-${format}` : kind;
    const path = `${certId}/${key}.png`;
    const { data: cached } = await supabaseAdmin.storage
      .from("cert-assets")
      .download(path);
    if (cached) {
      return new Response(await cached.arrayBuffer(), {
        status: 200,
        headers: certImageHeaders(CERT_IMG_CACHE),
      });
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
      title: sub?.title ?? "Graded garment",
      brand: sub?.brand ?? null,
      score: Number(rep.overall_score),
      gradeTier: rep.grade_tier,
      heroDataUri,
      certUrl: `${PUBLIC_SITE_URL}/cert/${certId}?s=qr`,
    };
    const png = await renderCertImage(kind, format, data);

    // Store durably (best-effort — a store failure still serves this render).
    await supabaseAdmin.storage
      .from("cert-assets")
      .upload(path, png, { contentType: "image/png", upsert: true, cacheControl: "31536000" })
      .catch(() => {});

    return new Response(new Uint8Array(png), { status: 200, headers: certImageHeaders(CERT_IMG_CACHE) });
  } catch (err) {
    captureException(err, { route: "cert-image", tags: { certId, kind } });
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
  if (!report) return c.json({ found: false }, 404);
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

  // Same RLS-safe access as the cert endpoint: BY certificate_id, and only
  // certified (public) reports. A private report must stay unreachable (US-268).
  const { data: report, error } = await supabaseAdmin
    .from("grade_reports")
    .select(
      "certificate_id, submission_id, overall_score, grade_tier, fabric_condition_score, " +
        "structural_integrity_score, cosmetic_appearance_score, " +
        "functional_elements_score, odor_cleanliness_score, ai_summary, " +
        "buyer_writeup, coverage, content_hash, content_signature, integrity_version, created_at",
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

// ── GET /certificates.json ────────────────────────────────────────
// Compact list for the sitemap (US-293): every public certificate's id +
// lastmod. Capped + cursor-paginated by created_at so a crawler can't pull the
// whole table at once.
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
    .eq("is_active", true)
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
      .select("id, inventory_item_id, photo_url, thumbnail_url, photo_type, sort_order")
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

  return c.json({
    seller: {
      handle: seller.verified_handle,
      display_name: seller.verified_display_name ?? seller.verified_handle,
      bio: seller.verified_bio ?? null,
      verified_since: seller.verified_since ?? null,
    },
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
    .select("id, referral_display_name")
    .eq("referral_leaderboard_enabled", true)
    .not("referral_display_name", "is", null)
    .limit(5000);
  if (error) return publicError(c, error, "leaderboard-users");

  const users = (optedIn ?? []) as Array<{
    id: string;
    referral_display_name: string | null;
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
    users.map((u) => ({ id: u.id, display_name: u.referral_display_name as string })),
    countById,
  );

  return c.json({ referrers });
});

