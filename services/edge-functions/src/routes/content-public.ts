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
