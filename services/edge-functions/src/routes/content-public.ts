import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { verifyPreviewToken } from "../lib/preview-token.ts";

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
  "reading_time_min, published_at, updated_at, jsonld";
const LIST_COLUMNS =
  "id, slug, title, excerpt, product_focus, hero_image_url, primary_keyword, " +
  "reading_time_min, published_at, updated_at";

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

  const nextCursor =
    data && data.length === limit ? data[data.length - 1]?.published_at : null;
  return c.json({ posts: data ?? [], next_cursor: nextCursor });
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

  const { data: tagRows } = await supabaseAdmin
    .from("blog_post_tags")
    .select("tag")
    .eq("post_id", post.id);
  const tags = (tagRows ?? []).map((r) => r.tag as string);

  return c.json({ post: { ...post, tags } });
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

  const { data: tagRows } = await supabaseAdmin
    .from("blog_post_tags")
    .select("tag")
    .eq("post_id", post.id);
  const tags = (tagRows ?? []).map((r) => r.tag as string);

  return c.json({
    post: { ...post, tags },
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
const CERT_IMAGE_TTL = 60 * 60 * 6;

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

  // Garment metadata from the parent submission (title/brand/category).
  const { data: submission } = await supabaseAdmin
    .from("submissions")
    .select("title, brand, garment_type, garment_category")
    .eq("id", report.submission_id)
    .maybeSingle();

  // A representative image (front, else lowest display_order) → signed URL so
  // the SSR/OG card can show it without exposing the private bucket wholesale.
  let heroImageUrl: string | null = null;
  const { data: images } = await supabaseAdmin
    .from("submission_images")
    .select("storage_path, image_type, display_order")
    .eq("submission_id", report.submission_id)
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
  const publicReport: Record<string, unknown> = { ...report };
  delete publicReport.submission_id;

  return c.json({
    certificate: {
      ...publicReport,
      id: report.certificate_id,
      title: submission?.title ?? "Graded garment",
      brand: submission?.brand ?? null,
      garment_type: submission?.garment_type ?? null,
      garment_category: submission?.garment_category ?? null,
      hero_image_url: heroImageUrl,
    },
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

