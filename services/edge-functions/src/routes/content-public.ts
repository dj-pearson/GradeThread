import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { verifyPreviewToken } from "../lib/preview-token.ts";
import { verifyCertIntegrity } from "../lib/cert-integrity.ts";

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
  // Blog GEO / E-E-A-T fields (US-304).
  "author, key_takeaways, faqs";
const LIST_COLUMNS =
  "id, slug, title, excerpt, product_focus, hero_image_url, primary_keyword, " +
  "reading_time_min, published_at, updated_at";

// Max related posts surfaced on an article (US-304).
const MAX_RELATED = 3;

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
  key_takeaways: unknown;
  faqs: unknown;
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
  certificate_id: string;
  created_at: string;
  submission_id: string;
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
  if (error) return c.json({ error: error.message }, 500);

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
  if (error) return c.json({ error: error.message }, 500);
  if (!post) return c.json({ error: "Not found" }, 404);
  const row = post as unknown as BlogFullRow;

  const { data: tagRows } = await supabaseAdmin
    .from("blog_post_tags")
    .select("tag")
    .eq("post_id", row.id);
  const tags = (tagRows ?? []).map((r) => r.tag as string);

  // GEO enhancements (US-304): normalized FAQs + related posts (by shared tag).
  const related = await fetchRelated(row.id, tags);

  return c.json({
    post: {
      ...row,
      tags,
      faqs: normalizeFaqs(row.faqs),
      related,
    },
  });
});

// ── GET /tags/:tag ────────────────────────────────────────
contentPublicRoutes.get("/tags/:tag", async (c) => {
  const tag = c.req.param("tag").toLowerCase();
  const { data: tagRows, error: tagErr } = await supabaseAdmin
    .from("blog_post_tags")
    .select("post_id")
    .eq("tag", tag);
  if (tagErr) return c.json({ error: tagErr.message }, 500);
  const ids = (tagRows ?? []).map((r) => r.post_id as string);
  if (ids.length === 0) return c.json({ posts: [] });

  const { data, error } = await supabaseAdmin
    .from("blog_posts")
    .select(LIST_COLUMNS)
    .eq("status", "published")
    .in("id", ids)
    .order("published_at", { ascending: false })
    .limit(MAX_LIMIT);
  if (error) return c.json({ error: error.message }, 500);
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
  if (error) return c.json({ error: error.message }, 500);
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
    .select("slug, published_at, updated_at, title, excerpt")
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(1000);
  if (error) return c.json({ error: error.message }, 500);

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
// A grade report is PUBLIC iff it has a non-null certificate_id — this is
// exactly the signal the RLS policy "Public can view grade reports with
// certificates" uses (00001_initial_schema.sql). The service-role client
// bypasses RLS, so EVERY query here MUST carry .not("certificate_id","is",null)
// (and look up BY certificate_id, never by the internal report id). A private,
// uncertified report must be unreachable through these endpoints (US-268).

// Columns safe to expose publicly. We deliberately omit confidence_score,
// detailed_notes, model_version internals, and the owner user_id.
const CERT_REPORT_COLUMNS =
  "overall_score, grade_tier, fabric_condition_score, structural_integrity_score, " +
  "cosmetic_appearance_score, functional_elements_score, odor_cleanliness_score, " +
  "ai_summary, certificate_id, created_at, submission_id";

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
  if (error) return c.json({ error: error.message }, 500);
  if (!report) return c.json({ error: "Not found" }, 404);
  const rep = report as unknown as CertReportRow;

  // Garment metadata from the parent submission (title/brand/category +
  // the seller's buyer-facing description, US-760).
  const { data: submission } = await supabaseAdmin
    .from("submissions")
    .select("title, brand, garment_type, garment_category, description")
    .eq("id", rep.submission_id)
    .maybeSingle();

  // A representative image (front, else lowest display_order) → signed URL so
  // the SSR/OG card can show it without exposing the private bucket wholesale.
  let heroImageUrl: string | null = null;
  const { data: images } = await supabaseAdmin
    .from("submission_images")
    .select("storage_path, image_type, display_order")
    .eq("submission_id", rep.submission_id)
    .order("display_order", { ascending: true });
  const hero =
    (images ?? []).find((i) => i.image_type === "front") ?? (images ?? [])[0];
  if (hero?.storage_path) {
    const { data: signed } = await supabaseAdmin.storage
      .from("submission-images")
      .createSignedUrl(hero.storage_path as string, CERT_IMAGE_TTL);
    heroImageUrl = signed?.signedUrl ?? null;
  }

  // Strip the internal submission_id from the public payload.
  const publicReport: Record<string, unknown> = { ...rep };
  delete publicReport.submission_id;

  return c.json({
    certificate: {
      ...publicReport,
      id: rep.certificate_id,
      title: submission?.title ?? "Graded garment",
      brand: submission?.brand ?? null,
      garment_type: submission?.garment_type ?? null,
      garment_category: submission?.garment_category ?? null,
      description: submission?.description ?? null,
      hero_image_url: heroImageUrl,
    },
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
      "certificate_id, overall_score, grade_tier, fabric_condition_score, " +
        "structural_integrity_score, cosmetic_appearance_score, " +
        "functional_elements_score, odor_cleanliness_score, ai_summary, " +
        "content_hash, content_signature, integrity_version, created_at",
    )
    .eq("certificate_id", certId)
    .not("certificate_id", "is", null)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!report) return c.json({ error: "Not found" }, 404);

  const r = report as unknown as {
    certificate_id: string;
    overall_score: number | string;
    grade_tier: string;
    fabric_condition_score: number | string;
    structural_integrity_score: number | string;
    cosmetic_appearance_score: number | string;
    functional_elements_score: number | string;
    odor_cleanliness_score: number | string;
    ai_summary: string | null;
    content_hash: string | null;
    content_signature: string | null;
    integrity_version: number | null;
    created_at: string;
  };

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
    },
    r.content_hash,
    r.content_signature,
    r.integrity_version,
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

  let q = supabaseAdmin
    .from("grade_reports")
    .select("certificate_id, created_at")
    .not("certificate_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (cursor) q = q.lt("created_at", cursor);

  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);

  const rows = data ?? [];
  const nextCursor =
    rows.length === limit ? rows[rows.length - 1]?.created_at ?? null : null;
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

interface SellerCertRow {
  overall_score: number;
  grade_tier: string;
  certificate_id: string;
  created_at: string;
  submissions: { user_id: string; title: string | null; brand: string | null } | null;
}

// ── GET /sellers/:handle ──────────────────────────────────────────
contentPublicRoutes.get("/sellers/:handle", async (c) => {
  const handle = c.req.param("handle").trim();
  if (!handle) return c.json({ error: "Not found" }, 404);

  // Public, enabled profile only. ilike (no wildcards) = case-insensitive exact.
  const { data: seller, error: sellerErr } = await supabaseAdmin
    .from("users")
    .select("id, verified_handle, verified_display_name, verified_bio, verified_since")
    .ilike("verified_handle", handle)
    .eq("verified_enabled", true)
    .maybeSingle();
  if (sellerErr) return c.json({ error: sellerErr.message }, 500);
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
  if (certErr) return c.json({ error: certErr.message }, 500);

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
  });
});

// ── GET /sellers.json ─────────────────────────────────────────────
// Compact list of public seller handles for the sitemap (verified profiles
// are indexable organic surfaces). Capped; lastmod is the row's updated_at.
contentPublicRoutes.get("/sellers.json", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("verified_handle, updated_at")
    .eq("verified_enabled", true)
    .not("verified_handle", "is", null)
    .order("updated_at", { ascending: false })
    .limit(5000);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({
    sellers: (data ?? []).map((r) => ({
      handle: r.verified_handle,
      updated_at: r.updated_at,
    })),
  });
});

