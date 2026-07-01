import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import { reviewContentSafety } from "../lib/content-safety.ts";
import { appendToHistoryIndex } from "../lib/content-history.ts";
import { applyInterlinks } from "../lib/content-interlink.ts";
import { generateBlogArticle, loadKnowledge } from "../lib/content-ai-blog.ts";
import { ensureHeroImage } from "../lib/openai-images.ts";
import { streamAnthropicText } from "../lib/content-ai-stream.ts";
import {
  buildBlogComposeStreamUserPrompt,
  buildSectionRegenStreamUserPrompt,
  buildStreamSystemPrompt,
} from "../lib/content-ai-prompts.ts";
import { sanitizeHtml } from "../lib/content-sanitize.ts";
import {
  buildBlogPurgeFiles,
  purgeCloudflareCache,
} from "../lib/cloudflare-purge.ts";
import { dispatchContentWebhook } from "../lib/content-webhook.ts";
import { mintPreviewToken } from "../lib/preview-token.ts";
import { submitUrls } from "../lib/indexnow.ts";
import { writeAuditLog } from "../lib/audit-log.ts";

// Submit blog-post URLs to IndexNow (US-296) — best-effort, fire-and-forget.
// Mirrors the cache-purge sites so Bing/Yandex re-index on publish/edit/archive.
function pingIndexNow(slugs: string[]): void {
  const base = (Deno.env.get("PUBLIC_SITE_URL") ?? "https://gradethread.com")
    .trim()
    .replace(/\/$/, "");
  submitUrls(slugs.map((s) => `${base}/blog/${s}`)).catch((e) =>
    console.warn("[content-blog] IndexNow submit failed:", e),
  );
}

// Blog posts CRUD + lifecycle endpoints.
//
// AI generation is LIVE (not a 501 stub): /generate and /regenerate-section call
// the generator lib (generateBlogArticle / streamAnthropicText). Publish handles
// the status transition + history-index append AND wires hero generation
// (ensureHeroImage) + the Make webhook (dispatchContentWebhook).

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
  // Blog GEO / E-E-A-T fields (US-304).
  author?: string | null;
  key_takeaways?: string[];
  faqs?: Array<{ q: string; a: string }>;
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
  if (error) return failSafe(c, 500, "Couldn't load blog posts.", error, "content.blog.list");
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
  if (error) return failSafe(c, 500, "Couldn't load the blog post.", error, "content.blog.get");
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
      // Sanitize on store so the "body_html in the DB is always clean" invariant
      // holds from creation (the public SSR injects it verbatim). Allowlist-based.
      body_html: sanitizeHtml(body.body_html ?? ""),
      excerpt: body.excerpt ?? null,
      primary_keyword: body.primary_keyword ?? null,
      secondary_keywords: body.secondary_keywords ?? [],
      hero_image_url: body.hero_image_url ?? null,
      generated_by: body.generated_by ?? "human",
      status: "draft",
    })
    .select("*")
    .single();
  if (error) return failSafe(c, 500, "Couldn't create the blog post.", error, "content.blog.create");
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

  // Stored-XSS defense: the public blog/cert SSR injects body_html verbatim,
  // trusting that everything in the DB was sanitized at publish time. Editing an
  // already-published post via this autosave path would otherwise persist RAW
  // HTML (and below we purge the SSR cache for published posts, so it goes live).
  // Sanitize here too so the "body_html in the DB is always clean" invariant
  // holds on EVERY write path, not just /publish. Allowlist-based, so legitimate
  // editor output is preserved.
  if (typeof (patch as { body_html?: unknown }).body_html === "string") {
    (patch as { body_html: string }).body_html = sanitizeHtml(
      (patch as { body_html: string }).body_html,
    );
  }

  const { data, error } = await supabaseAdmin
    .from("blog_posts")
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) return failSafe(c, 500, "Couldn't update the blog post.", error, "content.blog.update");
  if (!data) return c.json({ error: "Not found" }, 404);

  if (Array.isArray(tags)) await replaceTags(id, tags);

  // If the edit affected a live post, force-purge the SSR cache so
  // readers see the change instead of stale HTML. Includes slug
  // renames — purge BOTH the old and new slug if slug changed.
  if (data.status === "published") {
    const slugsToBust = new Set<string>([data.slug]);
    if (patch.slug && patch.slug !== data.slug) slugsToBust.add(patch.slug);
    (async () => {
      const allFiles: string[] = [];
      for (const slug of slugsToBust) {
        allFiles.push(...(await buildBlogPurgeFiles(slug)));
      }
      await purgeCloudflareCache({ files: allFiles });
    })().catch((e) => console.error("[content-blog] edit purge failed:", e));
    pingIndexNow([...slugsToBust]);
  }

  return c.json({ post: data });
});

// ──────────────────────────────────────────────────────────
// DELETE
// ──────────────────────────────────────────────────────────
contentBlogRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  // Capture a snapshot for the audit trail before the row is gone.
  const { data: prior } = await supabaseAdmin
    .from("blog_posts")
    .select("id, slug, title, status")
    .eq("id", id)
    .maybeSingle();
  const { error } = await supabaseAdmin.from("blog_posts").delete().eq("id", id);
  if (error) return failSafe(c, 500, "Couldn't delete the blog post.", error, "content.blog.delete");
  await writeAuditLog(c, {
    action: "content.blog_delete",
    targetType: "blog_post",
    targetId: id,
    before: prior ?? null,
  });
  return c.json({ ok: true });
});

// ──────────────────────────────────────────────────────────
// PUBLISH
// ──────────────────────────────────────────────────────────
// Sets status='published', stamps published_at, appends to the history index,
// generates the hero, and dispatches the Make webhook (all live).
// Shared blog publish — the single transition that takes a draft live: sanitize
// the body, ensure a hero image (so the OG/webhook carry it), stamp
// status=published + published_at, mark the originating topic used, append to
// the history index, interlink the topic cluster, purge the CDN, ping IndexNow,
// and fire the Make webhook. Used by the manual /publish endpoint AND the
// auto-publish-on-generate path so the two can't drift. `extra` carries optional
// columns (e.g. safety_status/safety_checked_at from the safety gate).
async function publishBlogPost(
  c: Context<Env>,
  post: { id: string; status: string; body_html: string | null },
  extra: Record<string, unknown> = {},
) {
  // Sanitize body_html server-side before exposing publicly. The Tiptap editor
  // already outputs structured HTML; this strips any unsafe tags/attrs that
  // slipped through (script, on*, javascript:, etc.).
  const cleanHtml = sanitizeHtml(post.body_html ?? "");

  // US-853: ensure a hero image exists before we publish so the OG/webhook
  // payload below carries hero_image_url. Best-effort + idempotent — a failure
  // logs and never blocks publish; an existing hero is left untouched.
  const hero = await ensureHeroImage({ postId: post.id, surface: "blog" });
  if (hero.status === "failed") {
    console.warn("[content-blog] hero generation failed (publishing anyway):", hero.reason);
  }

  const now = new Date().toISOString();
  const { data: updated, error: upErr } = await supabaseAdmin
    .from("blog_posts")
    .update({ status: "published", published_at: now, body_html: cleanHtml, ...extra })
    .eq("id", post.id)
    .select("*")
    .single();
  if (upErr) throw new Error(upErr.message);

  await writeAuditLog(c, {
    action: "content.blog_publish",
    targetType: "blog_post",
    targetId: post.id,
    before: { status: post.status },
    after: { status: "published", published_at: now, slug: updated.slug },
  });

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

  // US-873: topic-cluster interlinking. Infer the pillar + rebuild the
  // related-links graph (blog_post_links) so the post interlinks within its
  // cluster and ladders up to its cornerstone page. Best-effort + idempotent;
  // a failure logs and never rolls back the publish.
  await applyInterlinks({
    id: updated.id,
    slug: updated.slug,
    title: updated.title,
    product_focus: updated.product_focus,
    primary_keyword: updated.primary_keyword ?? null,
    secondary_keywords: updated.secondary_keywords ?? [],
    topic_id: updated.topic_id ?? null,
    pillar: updated.pillar ?? null,
  }).catch((e) => console.error("[content-blog] interlink failed:", e));

  // Cloudflare cache purge — best-effort, doesn't block the response.
  // The SSR pages serve with s-maxage=3600; without this, readers would
  // see stale HTML for up to an hour after a publish.
  buildBlogPurgeFiles(updated.slug)
    .then((files) => purgeCloudflareCache({ files }))
    .catch((e) => console.error("[content-blog] cache purge failed:", e));
  pingIndexNow([updated.slug]);

  // Resolve tags then fire the Make.com webhook. Best-effort; failures
  // log and surface in content_webhook_log but never roll back publish.
  (async () => {
    const tags = await fetchTags(updated.id);
    const siteUrl = await loadSiteUrl();
    await dispatchContentWebhook({
      event: "blog.published",
      timestamp: now,
      data: {
        id: updated.id,
        url: `${siteUrl}/blog/${updated.slug}`,
        title: updated.title,
        excerpt: updated.excerpt ?? null,
        hero_image_url: updated.hero_image_url ?? null,
        primary_keyword: updated.primary_keyword ?? null,
        tags,
        product_focus: updated.product_focus,
      },
    });
  })().catch((e) => console.error("[content-blog] webhook dispatch failed:", e));

  return updated;
}

contentBlogRoutes.post("/:id/publish", async (c) => {
  const id = c.req.param("id");
  const { data: post, error: loadErr } = await supabaseAdmin
    .from("blog_posts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) return failSafe(c, 500, "Couldn't load the blog post.", loadErr, "content.blog.publish.load");
  if (!post) return c.json({ error: "Not found" }, 404);
  if (!post.title || !post.body_html) {
    return c.json({ error: "title and body required to publish" }, 400);
  }

  try {
    const updated = await publishBlogPost(c, post);
    return c.json({ post: updated });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// Reads public_site_url from content_settings. Shared with the social
// publish path; minimal cache via process-local memoization could be
// added later but a single SELECT per publish is fine.
async function loadSiteUrl(): Promise<string> {
  const { data } = await supabaseAdmin
    .from("content_settings")
    .select("public_site_url")
    .eq("id", 1)
    .maybeSingle();
  const fromDb = (data?.public_site_url as string | undefined)?.trim();
  if (fromDb) return fromDb.replace(/\/$/, "");
  return "https://gradethread.com";
}

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
  if (error) return failSafe(c, 500, "Couldn't schedule the blog post.", error, "content.blog.schedule");
  if (!data) return c.json({ error: "Not found" }, 404);
  await writeAuditLog(c, {
    action: "content.blog_schedule",
    targetType: "blog_post",
    targetId: id,
    after: { status: "scheduled", scheduled_for: body.scheduled_for },
  });
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
  if (error) return failSafe(c, 500, "Couldn't archive the blog post.", error, "content.blog.archive");
  if (!data) return c.json({ error: "Not found" }, 404);

  await writeAuditLog(c, {
    action: "content.blog_archive",
    targetType: "blog_post",
    targetId: id,
    after: { status: "archived", slug: data.slug },
  });

  // Archiving a previously-published post needs a purge too — the SSR
  // worker should start returning 404 for the slug.
  buildBlogPurgeFiles(data.slug)
    .then((files) => purgeCloudflareCache({ files }))
    .catch((e) => console.error("[content-blog] archive purge failed:", e));
  pingIndexNow([data.slug]);

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
  if (loadErr) return failSafe(c, 500, "Couldn't load the blog post.", loadErr, "content.blog.generate.load");
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
        // US-876: store the AI-authored hero alt/caption now so the hero
        // pipeline (kicked off below) sees an alt already set and skips the
        // extra fallback alt-generation call.
        hero_image_alt: article.hero_image_alt || null,
        hero_image_caption: article.hero_image_caption || null,
        reading_time_min: article.reading_time_min,
        generated_by: "ai" as const,
        model_used: meta.model_used,
        prompt_tokens: meta.prompt_tokens,
        completion_tokens: meta.completion_tokens,
      })
      .eq("id", id)
      .select("*")
      .single();
    if (upErr) return failSafe(c, 500, "Couldn't save the generated content.", upErr, "content.blog.generate.save");

    if (Array.isArray(article.tags) && article.tags.length > 0) {
      await replaceTags(id, article.tags);
    }

    // Publish on completion (product decision 2026-06): a generated article goes
    // live immediately rather than sitting in draft. The AI content safety gate
    // still runs first — a flagged article is HELD as a draft (safety_status
    // 'held') for manual review instead of publishing. (The manual /publish path
    // has a human in the loop, so it skips this gate.)
    const safety = await reviewContentSafety({
      surface: "blog",
      title: updated.title,
      body: updated.body_html ?? cleanHtml,
      productFocus: updated.product_focus,
    });
    const checkedAt = new Date().toISOString();

    if (safety.verdict !== "pass") {
      await supabaseAdmin
        .from("blog_posts")
        .update({
          safety_status: "held",
          safety_notes: safety.reasons.join("; ").slice(0, 2000) || null,
          safety_checked_at: checkedAt,
        })
        .eq("id", id);
      // Still warm the hero so the held draft is publish-ready once cleared.
      ensureHeroImage({ postId: id, surface: "blog" })
        .then((r) => {
          if (r.status === "failed") {
            console.warn("[content-blog] generate hero failed:", r.reason);
          }
        })
        .catch((e) => console.error("[content-blog] generate hero error:", e));
      return c.json({
        post: { ...updated, status: "draft", safety_status: "held" },
        meta,
        title_suggestions: article.titleSuggestions,
        held: true,
        hold_reason: safety.reasons.join("; ") || null,
      });
    }

    // Safety passed — publish (publishBlogPost ensures the hero before going
    // live so the OG/webhook carry it, then runs the full publish side-effects).
    const published = await publishBlogPost(c, updated, {
      safety_status: "passed",
      safety_checked_at: checkedAt,
    });

    // US-254: surface the A/B title candidates so the editor can offer them
    // as radio options. The chosen one is saved back via PATCH /:id (title).
    return c.json({
      post: published,
      meta,
      title_suggestions: article.titleSuggestions,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[content-blog] generate failed:", msg);
    return c.json({ error: msg }, 500);
  }
});

// ──────────────────────────────────────────────────────────
// AI COMPOSE (STREAMING) — US-251
// ──────────────────────────────────────────────────────────
// Streams an article body into the editor as Server-Sent Events. Each `delta`
// event carries an HTML text chunk the client inserts live; `done` closes it.
// A client disconnect (Stop button → fetch abort) propagates to the upstream
// Anthropic request via c.req.raw.signal, so we stop burning tokens.
// Body: { instruction?: string }
contentBlogRoutes.post("/:id/compose-stream", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    instruction?: string;
  };

  const { data: post } = await supabaseAdmin
    .from("blog_posts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!post) return c.json({ error: "Not found" }, 404);

  // Resolve topic context: post fields, falling back to the linked topic.
  let angle: string | null = null;
  let intent: string | null = null;
  let primaryKw = (post.primary_keyword as string | null) ?? "";
  let secondaryKw = (post.secondary_keywords as string[] | null) ?? [];
  if (post.topic_id && (!primaryKw || secondaryKw.length === 0)) {
    const { data: topic } = await supabaseAdmin
      .from("content_topics")
      .select("angle, primary_keyword, secondary_keywords, search_intent")
      .eq("id", post.topic_id)
      .maybeSingle();
    if (topic) {
      angle = (topic.angle as string | null) ?? null;
      intent = (topic.search_intent as string | null) ?? null;
      primaryKw = primaryKw || (topic.primary_keyword as string);
      secondaryKw =
        secondaryKw.length > 0
          ? secondaryKw
          : (topic.secondary_keywords as string[] | null) ?? [];
    }
  }
  if (!post.title || !primaryKw) {
    return c.json(
      { error: "title and primary_keyword required to compose" },
      400,
    );
  }

  const knowledge = await loadKnowledge(post.product_focus);
  const system = buildStreamSystemPrompt({ ...knowledge, task: "compose-article" });
  const user = buildBlogComposeStreamUserPrompt({
    title: post.title,
    angle,
    primary_keyword: primaryKw,
    secondary_keywords: secondaryKw,
    search_intent: intent,
    product_focus: post.product_focus,
    instruction: body.instruction,
  });

  return streamSSE(c, async (stream) => {
    try {
      for await (const delta of streamAnthropicText({
        system,
        user,
        maxTokens: 8192,
        signal: c.req.raw.signal,
      })) {
        await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: delta }) });
      }
      await stream.writeSSE({ event: "done", data: JSON.stringify({ ok: true }) });
    } catch (e) {
      if (c.req.raw.signal.aborted) return; // client hit Stop — quiet exit
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[content-blog] compose-stream failed:", msg);
      await stream.writeSSE({ event: "error", data: JSON.stringify({ message: msg }) });
    }
  });
});

// ──────────────────────────────────────────────────────────
// AI SECTION REGEN (STREAMING) — US-252
// ──────────────────────────────────────────────────────────
// Streams a replacement passage for a selected section. The toolbar AI submenu
// posts the current selection HTML + a mode; we stream the rewritten HTML back.
// Body: { mode: "regenerate"|"expand"|"rewrite-for-keyword", selectionHtml, keyword? }
contentBlogRoutes.post("/:id/regenerate-section", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    mode?: "regenerate" | "expand" | "rewrite-for-keyword";
    selectionHtml?: string;
    keyword?: string;
  };

  const mode = body.mode ?? "regenerate";
  const selectionHtml = (body.selectionHtml ?? "").trim();
  if (!selectionHtml) {
    return c.json({ error: "selectionHtml is required" }, 400);
  }
  if (mode === "rewrite-for-keyword" && !body.keyword?.trim()) {
    return c.json({ error: "keyword is required for rewrite-for-keyword" }, 400);
  }

  const { data: post } = await supabaseAdmin
    .from("blog_posts")
    .select("product_focus, primary_keyword")
    .eq("id", id)
    .maybeSingle();
  if (!post) return c.json({ error: "Not found" }, 404);

  const knowledge = await loadKnowledge(post.product_focus);
  const system = buildStreamSystemPrompt({
    ...knowledge,
    task: "regenerate-section",
  });
  const user = buildSectionRegenStreamUserPrompt({
    mode,
    selection_html: selectionHtml,
    primary_keyword: body.keyword?.trim() || (post.primary_keyword as string | null) || undefined,
  });

  return streamSSE(c, async (stream) => {
    try {
      for await (const delta of streamAnthropicText({
        system,
        user,
        maxTokens: 4096,
        signal: c.req.raw.signal,
      })) {
        await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: delta }) });
      }
      await stream.writeSSE({ event: "done", data: JSON.stringify({ ok: true }) });
    } catch (e) {
      if (c.req.raw.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[content-blog] regenerate-section failed:", msg);
      await stream.writeSSE({ event: "error", data: JSON.stringify({ message: msg }) });
    }
  });
});

// ──────────────────────────────────────────────────────────
// PREVIEW LINK
// ──────────────────────────────────────────────────────────
// Mints a signed, time-limited URL the admin can share with a reviewer
// without giving them dashboard access. The SSR worker at
// /blog/preview/<token> verifies it before rendering.
contentBlogRoutes.post("/:id/preview-link", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { ttl_seconds?: number };

  const { data: post, error } = await supabaseAdmin
    .from("blog_posts")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (error) return failSafe(c, 500, "Couldn't create the preview link.", error, "content.blog.preview-link");
  if (!post) return c.json({ error: "Not found" }, 404);

  try {
    const { token, expiresAt } = await mintPreviewToken(id, body.ttl_seconds);
    const { data: settings } = await supabaseAdmin
      .from("content_settings")
      .select("public_site_url")
      .eq("id", 1)
      .maybeSingle();
    const base =
      (settings?.public_site_url as string | undefined)?.replace(/\/$/, "") ||
      "https://gradethread.com";
    return c.json({
      url: `${base}/blog/preview/${token}`,
      token,
      expires_at: expiresAt,
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});
