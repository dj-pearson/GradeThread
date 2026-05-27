import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { appendToHistoryIndex } from "../lib/content-history.ts";
import { generateBlogArticle } from "../lib/content-ai-blog.ts";
import { sanitizeHtml } from "../lib/content-sanitize.ts";

// Blog posts CRUD + lifecycle endpoints.
//
// AI-driven endpoints (/generate, /regenerate-section) return 501 here;
// they'll be wired up in Phase B when the generator lib lands. Publish
// also no-ops on hero generation + webhook dispatch until Phase B/E,
// but already handles the status transition + history-index append so
// the rest of the system can plug in without changing this file.

type Env = { Variables: { userId: string } };
export const contentBlogRoutes = new Hono<Env>();

type ContentStatus =
  | "draft"
  | "scheduled"
  | "published"
  | "archived"
  | "failed";
type ContentProduct = "gradethread" | "flipdesk" | "both";

interface CreateInput {
  title: string;
  slug?: string;
  product_focus?: ContentProduct;
  topic_id?: string | null;
  body_json?: unknown;
  body_html?: string;
  excerpt?: string;
  primary_keyword?: string;
  secondary_keywords?: string[];
  hero_image_url?: string;
  generated_by?: "ai" | "human";
}

interface UpdateInput extends Partial<CreateInput> {
  status?: ContentStatus;
  seo_title?: string | null;
  seo_description?: string | null;
  hero_image_path?: string | null;
  hero_prompt?: string | null;
  jsonld?: Record<string, unknown> | null;
  reading_time_min?: number | null;
  scheduled_for?: string | null;
  tags?: string[];
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function ensureUniqueSlug(base: string): Promise<string> {
  let candidate = base || `post-${Date.now()}`;
  for (let i = 0; i < 10; i++) {
    const { data } = await supabaseAdmin
      .from("blog_posts")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (!data) return candidate;
    candidate = `${base}-${i + 2}`;
  }
  return `${base}-${Date.now()}`;
}

async function fetchTags(postId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("blog_post_tags")
    .select("tag")
    .eq("post_id", postId);
  return (data ?? []).map((r) => r.tag as string);
}

async function replaceTags(postId: string, tags: string[]): Promise<void> {
  await supabaseAdmin.from("blog_post_tags").delete().eq("post_id", postId);
  const clean = Array.from(
    new Set(tags.map((t) => t.trim()).filter(Boolean)),
  );
  if (clean.length === 0) return;
  await supabaseAdmin
    .from("blog_post_tags")
    .insert(clean.map((tag) => ({ post_id: postId, tag })));
}

// ──────────────────────────────────────────────────────────
// LIST
// ──────────────────────────────────────────────────────────
contentBlogRoutes.get("/", async (c) => {
  const status = c.req.query("status");
  const productFocus = c.req.query("product_focus");
  const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200);

  let q = supabaseAdmin
    .from("blog_posts")
    .select(
      "id, slug, title, excerpt, product_focus, status, hero_image_url, primary_keyword, published_at, scheduled_for, generated_by, model_used, created_at, updated_at",
    )
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (status) q = q.eq("status", status);
  if (productFocus) q = q.eq("product_focus", productFocus);

  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ posts: data ?? [] });
});

// ──────────────────────────────────────────────────────────
// READ
// ──────────────────────────────────────────────────────────
contentBlogRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const { data, error } = await supabaseAdmin
    .from("blog_posts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "Not found" }, 404);
  const tags = await fetchTags(id);
  return c.json({ post: { ...data, tags } });
});

// ──────────────────────────────────────────────────────────
// CREATE
// ──────────────────────────────────────────────────────────
contentBlogRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CreateInput;
  if (!body.title || typeof body.title !== "string") {
    return c.json({ error: "title is required" }, 400);
  }
  const slug = await ensureUniqueSlug(body.slug ?? slugify(body.title));

  const { data, error } = await supabaseAdmin
    .from("blog_posts")
    .insert({
      title: body.title,
      slug,
      product_focus: body.product_focus ?? "both",
      topic_id: body.topic_id ?? null,
      body_json: body.body_json ?? {},
      body_html: body.body_html ?? "",
      excerpt: body.excerpt ?? null,
      primary_keyword: body.primary_keyword ?? null,
      secondary_keywords: body.secondary_keywords ?? [],
      hero_image_url: body.hero_image_url ?? null,
      generated_by: body.generated_by ?? "human",
      status: "draft",
    })
    .select("*")
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ post: data });
});

// ──────────────────────────────────────────────────────────
// UPDATE (autosave)
// ──────────────────────────────────────────────────────────
contentBlogRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as UpdateInput;
  const tags = body.tags;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { tags: _ignored, ...patch } = body;

  if (patch.slug) patch.slug = slugify(patch.slug);

  const { data, error } = await supabaseAdmin
    .from("blog_posts")
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "Not found" }, 404);

  if (Array.isArray(tags)) await replaceTags(id, tags);

  return c.json({ post: data });
});

// ──────────────────────────────────────────────────────────
// DELETE
// ──────────────────────────────────────────────────────────
contentBlogRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const { error } = await supabaseAdmin.from("blog_posts").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

// ──────────────────────────────────────────────────────────
// PUBLISH
// ──────────────────────────────────────────────────────────
// Sets status='published', stamps published_at, appends to the
// history index. Hero generation + webhook dispatch land in Phase B/E.
contentBlogRoutes.post("/:id/publish", async (c) => {
  const id = c.req.param("id");
  const { data: post, error: loadErr } = await supabaseAdmin
    .from("blog_posts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) return c.json({ error: loadErr.message }, 500);
  if (!post) return c.json({ error: "Not found" }, 404);
  if (!post.title || !post.body_html) {
    return c.json({ error: "title and body required to publish" }, 400);
  }

  // Sanitize body_html server-side before exposing publicly. The Tiptap
  // editor already outputs structured HTML; this strips any unsafe
  // tags/attrs that slipped through (script, on*, javascript:, etc.).
  const cleanHtml = sanitizeHtml(post.body_html);

  const now = new Date().toISOString();
  const { data: updated, error: upErr } = await supabaseAdmin
    .from("blog_posts")
    .update({ status: "published", published_at: now, body_html: cleanHtml })
    .eq("id", id)
    .select("*")
    .single();
  if (upErr) return c.json({ error: upErr.message }, 500);

  // Mark the originating topic as used.
  if (updated.topic_id) {
    await supabaseAdmin
      .from("content_topics")
      .update({ status: "used", used_by_post_id: updated.id, used_at: now })
      .eq("id", updated.topic_id);
  }

  await appendToHistoryIndex({
    surface: "blog",
    product_focus: updated.product_focus,
    post_id: updated.id,
    title: updated.title,
    primary_keyword: updated.primary_keyword ?? null,
    secondary_keywords: updated.secondary_keywords ?? [],
    summary_one_line: updated.excerpt ?? null,
    published_at: now,
  }).catch((e) => console.error("[content-blog] history append failed:", e));

  // TODO Phase E: dispatchContentWebhook('blog.published', { ... }).
  // TODO Phase C: Cloudflare cache purge for /blog/<slug>, /sitemap.xml, /rss.xml.

  return c.json({ post: updated });
});

// ──────────────────────────────────────────────────────────
// SCHEDULE
// ──────────────────────────────────────────────────────────
contentBlogRoutes.post("/:id/schedule", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    scheduled_for?: string;
  };
  if (!body.scheduled_for) {
    return c.json({ error: "scheduled_for (ISO timestamp) is required" }, 400);
  }
  const { data, error } = await supabaseAdmin
    .from("blog_posts")
    .update({ status: "scheduled", scheduled_for: body.scheduled_for })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json({ post: data });
});

// ──────────────────────────────────────────────────────────
// ARCHIVE
// ──────────────────────────────────────────────────────────
contentBlogRoutes.post("/:id/archive", async (c) => {
  const id = c.req.param("id");
  const { data, error } = await supabaseAdmin
    .from("blog_posts")
    .update({ status: "archived" })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json({ post: data });
});

// ──────────────────────────────────────────────────────────
// AI GENERATE — fills a draft from its topic context
// ──────────────────────────────────────────────────────────
// Body:
//   { topic?: { title, angle?, primary_keyword, secondary_keywords?, search_intent?, product_focus? } }
// If `topic` is omitted, we read the linked content_topic row.
contentBlogRoutes.post("/:id/generate", async (c) => {
  const id = c.req.param("id");
  const overrideBody = (await c.req.json().catch(() => ({}))) as {
    topic?: {
      title?: string;
      angle?: string;
      primary_keyword?: string;
      secondary_keywords?: string[];
      search_intent?: string;
      product_focus?: "gradethread" | "flipdesk" | "both";
    };
    model?: string;
  };

  const { data: post, error: loadErr } = await supabaseAdmin
    .from("blog_posts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) return c.json({ error: loadErr.message }, 500);
  if (!post) return c.json({ error: "Not found" }, 404);

  // Build the topic input. Priority: explicit override → linked topic → post fields.
  let topicTitle = overrideBody.topic?.title ?? post.title;
  let topicAngle: string | null = overrideBody.topic?.angle ?? null;
  let primaryKw = overrideBody.topic?.primary_keyword ?? post.primary_keyword ?? "";
  let secondaryKw =
    overrideBody.topic?.secondary_keywords ?? post.secondary_keywords ?? [];
  let intent: string | null = overrideBody.topic?.search_intent ?? null;
  const productFocus = overrideBody.topic?.product_focus ?? post.product_focus;

  if (
    (!primaryKw || !topicAngle || !intent) &&
    post.topic_id
  ) {
    const { data: topic } = await supabaseAdmin
      .from("content_topics")
      .select("title, angle, primary_keyword, secondary_keywords, search_intent")
      .eq("id", post.topic_id)
      .maybeSingle();
    if (topic) {
      topicTitle = overrideBody.topic?.title ?? topic.title;
      topicAngle = topicAngle ?? topic.angle ?? null;
      primaryKw = primaryKw || topic.primary_keyword;
      secondaryKw = secondaryKw.length > 0 ? secondaryKw : topic.secondary_keywords ?? [];
      intent = intent ?? topic.search_intent ?? null;
    }
  }

  if (!topicTitle || !primaryKw) {
    return c.json(
      { error: "title and primary_keyword required to generate" },
      400,
    );
  }

  try {
    const { article, meta } = await generateBlogArticle({
      topic: {
        title: topicTitle,
        angle: topicAngle,
        primary_keyword: primaryKw,
        secondary_keywords: secondaryKw,
        search_intent: intent,
        product_focus: productFocus,
      },
      model: overrideBody.model,
    });

    // Persist the generated draft. Status stays 'draft' — the user
    // reviews and clicks Publish themselves.
    const cleanHtml = sanitizeHtml(article.body_html);
    const { data: updated, error: upErr } = await supabaseAdmin
      .from("blog_posts")
      .update({
        title: article.title,
        slug: article.slug,
        excerpt: article.excerpt,
        body_html: cleanHtml,
        seo_title: article.seo_title,
        seo_description: article.seo_description,
        primary_keyword: article.primary_keyword,
        secondary_keywords: article.secondary_keywords,
        hero_prompt: article.hero_prompt,
        reading_time_min: article.reading_time_min,
        generated_by: "ai" as const,
        model_used: meta.model_used,
        prompt_tokens: meta.prompt_tokens,
        completion_tokens: meta.completion_tokens,
      })
      .eq("id", id)
      .select("*")
      .single();
    if (upErr) return c.json({ error: upErr.message }, 500);

    if (Array.isArray(article.tags) && article.tags.length > 0) {
      await replaceTags(id, article.tags);
    }

    return c.json({ post: updated, meta });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[content-blog] generate failed:", msg);
    return c.json({ error: msg }, 500);
  }
});

contentBlogRoutes.post("/:id/regenerate-section", (c) =>
  c.json(
    { error: "Not implemented yet — section regenerator lands in Phase F" },
    501,
  ),
);
