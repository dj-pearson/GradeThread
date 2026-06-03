import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { supabaseAdmin } from "../lib/supabase.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { adminAuthMiddleware } from "../middleware/admin-auth.ts";
import { verifyJobSecret } from "../lib/job-auth.ts";
import { generateBlogArticle } from "../lib/content-ai-blog.ts";
import { generateSocialPost } from "../lib/content-ai-social.ts";
import { researchTopics } from "../lib/content-ai-research.ts";
import { sanitizeHtml } from "../lib/content-sanitize.ts";
import { appendToHistoryIndex } from "../lib/content-history.ts";
import { dispatchContentWebhook } from "../lib/content-webhook.ts";
import {
  buildBlogPurgeFiles,
  purgeCloudflareCache,
} from "../lib/cloudflare-purge.ts";
import { writeSystemAuditLog } from "../lib/audit-log.ts";
import { buildContentSummary } from "../lib/content-summary.ts";

// Autonomous scheduler endpoint. Make.com hits this on a cron; the
// /tick handler decides what (if anything) to publish next.
//
// Auth is layered: EITHER the X-Internal-Job-Secret header matches
// CONTENT_INTERNAL_JOB_SECRET (Make.com path), OR the request carries
// a valid admin JWT (dashboard "Generate next" button). The
// schedulerAuth middleware below short-circuits on the secret and
// otherwise falls through to authMiddleware + adminAuthMiddleware.

type SchedulerEnv = { Variables: { userId?: string } };

export const contentSchedulerRoutes = new Hono<SchedulerEnv>();

const schedulerAuth = createMiddleware<SchedulerEnv>(async (c, next) => {
  // US-360: constant-time compare of the Make.com job secret.
  const headerSecret = c.req.header("X-Internal-Job-Secret");
  const envSecret = Deno.env.get("CONTENT_INTERNAL_JOB_SECRET")?.trim();
  if (await verifyJobSecret(headerSecret, envSecret ?? "")) {
    // Make.com path — no JWT.
    await next();
    return;
  }
  // Fall back to admin JWT auth. We compose the existing middlewares
  // manually so the chain still works.
  // The secret path leaves the context without a user, so SchedulerEnv is
  // looser than the AuthEnv/AdminEnv these middlewares expect. They only read
  // headers and call c.set, so reusing this context is sound at runtime — cast
  // to each middleware's own context type to express that.
  await authMiddleware(
    c as unknown as Parameters<typeof authMiddleware>[0],
    async () => {
      await adminAuthMiddleware(
        c as unknown as Parameters<typeof adminAuthMiddleware>[0],
        next,
      );
    },
  );
});

contentSchedulerRoutes.use("/*", schedulerAuth);

interface SettingsRow {
  auto_publish_blog: boolean;
  auto_publish_social: boolean;
  post_cadence_per_day_blog: number;
  post_cadence_per_day_social: number;
  min_topics_in_bank: number;
  topics_refill_batch: number;
  public_site_url: string;
}

type Surface = "blog" | "social";
type Product = "gradethread" | "flipdesk";

interface TickResult {
  skipped?: boolean;
  reason?: string;
  surface?: Surface;
  product_focus?: Product;
  post_id?: string;
  status?: "draft" | "published";
  refilled_topics?: number;
  published_scheduled?: number; // count of scheduled drafts promoted this tick
}

async function loadSettings(): Promise<SettingsRow | null> {
  const { data } = await supabaseAdmin
    .from("content_settings")
    .select(
      "auto_publish_blog, auto_publish_social, post_cadence_per_day_blog, " +
        "post_cadence_per_day_social, min_topics_in_bank, topics_refill_batch, public_site_url",
    )
    .eq("id", 1)
    .maybeSingle();
  return (data as SettingsRow | null) ?? null;
}

// Count posts published today per (surface, product_focus). We use
// the user's day in UTC for simplicity; if scheduling around a
// specific timezone matters later, add a tz column to settings.
async function publishedTodayCounts(): Promise<Map<string, number>> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const isoSince = since.toISOString();
  const counts = new Map<string, number>();

  const [{ data: blog }, { data: social }] = await Promise.all([
    supabaseAdmin
      .from("blog_posts")
      .select("product_focus")
      .eq("status", "published")
      .gte("published_at", isoSince),
    supabaseAdmin
      .from("social_posts")
      .select("product_focus")
      .eq("status", "published")
      .gte("published_at", isoSince),
  ]);

  for (const row of blog ?? []) {
    const k = `blog:${row.product_focus}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const row of social ?? []) {
    const k = `social:${row.product_focus}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

// "Which product needs the next slot?" — picks whichever (gt vs fd)
// has fewer rows in the last 14 days for this surface so the two
// products stay balanced over time. Defaults to gradethread on ties.
async function pickProductFocus(surface: Surface): Promise<Product> {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const table = surface === "blog" ? "blog_posts" : "social_posts";
  const { data } = await supabaseAdmin
    .from(table)
    .select("product_focus")
    .eq("status", "published")
    .gte("published_at", since);
  let gt = 0, fd = 0;
  for (const row of data ?? []) {
    if (row.product_focus === "flipdesk") fd++;
    else if (row.product_focus === "gradethread") gt++;
  }
  return fd < gt ? "flipdesk" : "gradethread";
}

// Publishes any blog_posts/social_posts where status='scheduled' and
// scheduled_for <= now. Runs at the start of every tick so the cron
// doubles as the scheduled-post processor (no separate cron needed).
//
// Best-effort per row — a failure on one post doesn't abort the others.
// Returns the count of posts actually published.
async function publishDueScheduledPosts(): Promise<number> {
  const nowIso = new Date().toISOString();
  let published = 0;

  const { data: blogs } = await supabaseAdmin
    .from("blog_posts")
    .select("*")
    .eq("status", "scheduled")
    .lte("scheduled_for", nowIso);

  for (const post of blogs ?? []) {
    try {
      const { data: updated } = await supabaseAdmin
        .from("blog_posts")
        .update({ status: "published", published_at: nowIso })
        .eq("id", post.id)
        .eq("status", "scheduled") // optimistic concurrency: skip if someone else won
        .select("*")
        .maybeSingle();
      if (!updated) continue;

      // System-actor audit row: the scheduler (not a human) promoted this
      // scheduled draft to published. (US-269)
      await writeSystemAuditLog({
        action: "content.blog_publish",
        targetType: "blog_post",
        targetId: updated.id,
        before: { status: "scheduled" },
        after: { status: "published", published_at: nowIso, slug: updated.slug },
        details: { trigger: "scheduler_tick" },
      });

      if (updated.topic_id) {
        await supabaseAdmin
          .from("content_topics")
          .update({ status: "used", used_by_post_id: updated.id, used_at: nowIso })
          .eq("id", updated.topic_id);
      }

      const { data: tagRows } = await supabaseAdmin
        .from("blog_post_tags")
        .select("tag")
        .eq("post_id", updated.id);
      const tags = (tagRows ?? []).map((r) => r.tag as string);

      appendToHistoryIndex({
        surface: "blog",
        product_focus: updated.product_focus,
        post_id: updated.id,
        title: updated.title,
        primary_keyword: updated.primary_keyword ?? null,
        secondary_keywords: updated.secondary_keywords ?? [],
        summary_one_line: updated.excerpt ?? null,
        published_at: nowIso,
      }).catch((e) =>
        console.error("[scheduler] scheduled blog history failed:", e),
      );

      buildBlogPurgeFiles(updated.slug)
        .then((files) => purgeCloudflareCache({ files }))
        .catch((e) => console.error("[scheduler] scheduled blog purge failed:", e));

      const siteUrl =
        (await loadSettings())?.public_site_url ?? "https://gradethread.com";
      dispatchContentWebhook({
        event: "blog.published",
        timestamp: nowIso,
        data: {
          id: updated.id,
          url: `${siteUrl.replace(/\/$/, "")}/blog/${updated.slug}`,
          title: updated.title,
          excerpt: updated.excerpt ?? null,
          hero_image_url: updated.hero_image_url ?? null,
          primary_keyword: updated.primary_keyword ?? null,
          tags,
          product_focus: updated.product_focus,
        },
      }).catch((e) =>
        console.error("[scheduler] scheduled blog webhook failed:", e),
      );

      published++;
    } catch (e) {
      console.error(
        `[scheduler] scheduled blog publish failed for ${post.id}:`,
        e,
      );
    }
  }

  const { data: socials } = await supabaseAdmin
    .from("social_posts")
    .select("*")
    .eq("status", "scheduled")
    .lte("scheduled_for", nowIso);

  for (const post of socials ?? []) {
    try {
      const { data: updated } = await supabaseAdmin
        .from("social_posts")
        .update({ status: "published", published_at: nowIso })
        .eq("id", post.id)
        .eq("status", "scheduled")
        .select("*")
        .maybeSingle();
      if (!updated) continue;

      if (updated.topic_id) {
        await supabaseAdmin
          .from("content_topics")
          .update({ status: "used", used_by_post_id: updated.id, used_at: nowIso })
          .eq("id", updated.topic_id);
      }

      const summary =
        (updated.short_body || updated.long_body || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 140) || null;
      appendToHistoryIndex({
        surface: "social",
        product_focus: updated.product_focus,
        post_id: updated.id,
        title: summary ?? "social post",
        primary_keyword: null,
        secondary_keywords: updated.hashtags ?? [],
        summary_one_line: summary,
        published_at: nowIso,
      }).catch((e) =>
        console.error("[scheduler] scheduled social history failed:", e),
      );

      const fires: Promise<unknown>[] = [];
      if (updated.long_body?.trim()) {
        fires.push(
          dispatchContentWebhook({
            event: "social.published",
            format: "long",
            timestamp: nowIso,
            data: {
              id: updated.id,
              body: updated.long_body,
              hashtags: updated.hashtags ?? [],
              cta_url: updated.cta_url ?? null,
              product_focus: updated.product_focus,
            },
          }),
        );
      }
      if (updated.short_body?.trim()) {
        fires.push(
          dispatchContentWebhook({
            event: "social.published",
            format: "short",
            timestamp: nowIso,
            data: {
              id: updated.id,
              body: updated.short_body,
              hashtags: updated.hashtags ?? [],
              cta_url: updated.cta_url ?? null,
              product_focus: updated.product_focus,
            },
          }),
        );
      }
      Promise.all(fires).catch((e) =>
        console.error("[scheduler] scheduled social webhook failed:", e),
      );

      published++;
    } catch (e) {
      console.error(
        `[scheduler] scheduled social publish failed for ${post.id}:`,
        e,
      );
    }
  }

  return published;
}

async function pickNextTopic(surface: Surface, product: Product) {
  const { data } = await supabaseAdmin
    .from("content_topics")
    .select("*")
    .eq("surface", surface)
    .eq("product_focus", product)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

async function ensureBankAtLeast(
  surface: Surface,
  product: Product,
  minimum: number,
  refillBatch: number,
): Promise<number> {
  const { count } = await supabaseAdmin
    .from("content_topics")
    .select("id", { count: "exact", head: true })
    .eq("surface", surface)
    .eq("product_focus", product)
    .eq("status", "queued");
  const have = count ?? 0;
  if (have >= minimum) return 0;

  try {
    const result = await researchTopics({
      surface,
      productFocus: product,
      count: Math.max(refillBatch, minimum - have),
    });
    if (result.candidates.length === 0) return 0;
    const { data } = await supabaseAdmin
      .from("content_topics")
      .insert(
        result.candidates.map((c) => ({
          surface,
          product_focus: product,
          title: c.title,
          angle: c.angle,
          primary_keyword: c.primary_keyword,
          secondary_keywords: c.secondary_keywords,
          search_intent: c.search_intent,
          status: "queued" as const,
          generated_by: "ai" as const,
          source: "research" as const,
        })),
      )
      .select("id");
    return data?.length ?? 0;
  } catch (e) {
    console.error("[scheduler] bank refill failed:", e);
    return 0;
  }
}

async function uniqueSlug(base: string): Promise<string> {
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

async function runBlogTick(
  product: Product,
  autoPublish: boolean,
): Promise<TickResult> {
  const topic = await pickNextTopic("blog", product);
  if (!topic) return { skipped: true, reason: "no queued topics after refill" };

  // Mark assigned before generation so a concurrent tick can't pick it again.
  await supabaseAdmin
    .from("content_topics")
    .update({ status: "assigned" })
    .eq("id", topic.id);

  // Pre-create a draft row so the topic's used_by_post_id is set even
  // if generation fails.
  const slug = await uniqueSlug(
    topic.title
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || `post-${Date.now()}`,
  );
  const { data: draft, error: insErr } = await supabaseAdmin
    .from("blog_posts")
    .insert({
      title: topic.title,
      slug,
      product_focus: product,
      topic_id: topic.id,
      primary_keyword: topic.primary_keyword,
      secondary_keywords: topic.secondary_keywords ?? [],
      generated_by: "ai" as const,
      status: "draft" as const,
    })
    .select("*")
    .single();
  if (insErr || !draft) {
    return { skipped: true, reason: `draft insert failed: ${insErr?.message}` };
  }

  try {
    const { article, meta } = await generateBlogArticle({
      topic: {
        title: topic.title,
        angle: topic.angle,
        primary_keyword: topic.primary_keyword,
        secondary_keywords: topic.secondary_keywords ?? [],
        search_intent: topic.search_intent,
        product_focus: product,
      },
    });
    const cleanHtml = sanitizeHtml(article.body_html);
    await supabaseAdmin
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
        model_used: meta.model_used,
        prompt_tokens: meta.prompt_tokens,
        completion_tokens: meta.completion_tokens,
      })
      .eq("id", draft.id);

    if (article.tags && article.tags.length > 0) {
      await supabaseAdmin
        .from("blog_post_tags")
        .insert(
          article.tags.map((t) => ({ post_id: draft.id, tag: t })),
        );
    }
  } catch (e) {
    // Generation failed — mark the post as failed but leave the topic
    // 'assigned' so it doesn't get re-picked silently.
    await supabaseAdmin
      .from("blog_posts")
      .update({ status: "failed" })
      .eq("id", draft.id);
    return {
      skipped: true,
      reason: `generation failed: ${e instanceof Error ? e.message : String(e)}`,
      surface: "blog",
      product_focus: product,
      post_id: draft.id,
    };
  }

  if (!autoPublish) {
    return {
      surface: "blog",
      product_focus: product,
      post_id: draft.id,
      status: "draft",
    };
  }

  // Auto-publish path: stamp published_at, mark topic used, append
  // to history, fire webhook, purge cache. Hero generation is best-
  // effort and intentionally skipped here — too expensive per tick.
  // The dashboard's manual hero button covers it.
  const now = new Date().toISOString();
  const { data: published } = await supabaseAdmin
    .from("blog_posts")
    .update({ status: "published", published_at: now })
    .eq("id", draft.id)
    .select("*")
    .single();
  await supabaseAdmin
    .from("content_topics")
    .update({ status: "used", used_by_post_id: draft.id, used_at: now })
    .eq("id", topic.id);

  if (published) {
    const { data: tagRows } = await supabaseAdmin
      .from("blog_post_tags")
      .select("tag")
      .eq("post_id", published.id);
    const tags = (tagRows ?? []).map((r) => r.tag as string);

    appendToHistoryIndex({
      surface: "blog",
      product_focus: product,
      post_id: published.id,
      title: published.title,
      primary_keyword: published.primary_keyword,
      secondary_keywords: published.secondary_keywords ?? [],
      summary_one_line: published.excerpt,
      published_at: now,
    }).catch((e) => console.error("[scheduler] history append failed:", e));

    buildBlogPurgeFiles(published.slug)
      .then((files) => purgeCloudflareCache({ files }))
      .catch((e) => console.error("[scheduler] cache purge failed:", e));

    dispatchContentWebhook({
      event: "blog.published",
      timestamp: now,
      data: {
        id: published.id,
        url: `${(await loadSettings())?.public_site_url ?? "https://gradethread.com"}/blog/${published.slug}`,
        title: published.title,
        excerpt: published.excerpt ?? null,
        hero_image_url: published.hero_image_url ?? null,
        primary_keyword: published.primary_keyword ?? null,
        tags,
        product_focus: published.product_focus,
      },
    }).catch((e) =>
      console.error("[scheduler] webhook dispatch failed:", e),
    );
  }

  return {
    surface: "blog",
    product_focus: product,
    post_id: draft.id,
    status: "published",
  };
}

async function runSocialTick(
  product: Product,
  autoPublish: boolean,
): Promise<TickResult> {
  const topic = await pickNextTopic("social", product);
  if (!topic) return { skipped: true, reason: "no queued topics after refill" };

  await supabaseAdmin
    .from("content_topics")
    .update({ status: "assigned" })
    .eq("id", topic.id);

  const { data: draft, error: insErr } = await supabaseAdmin
    .from("social_posts")
    .insert({
      product_focus: product,
      topic_id: topic.id,
      generated_by: "ai" as const,
      status: "draft" as const,
    })
    .select("*")
    .single();
  if (insErr || !draft) {
    return { skipped: true, reason: `social draft insert failed: ${insErr?.message}` };
  }

  try {
    const result = await generateSocialPost({
      topic: {
        title: topic.title,
        angle: topic.angle,
        primary_keyword: topic.primary_keyword,
        product_focus: product,
      },
    });
    await supabaseAdmin
      .from("social_posts")
      .update({
        long_body: result.post.long_body,
        short_body: result.post.short_body,
        hashtags: result.post.hashtags,
        cta_url: result.ctaUrl,
        model_used: result.meta.model_used,
        prompt_tokens: result.meta.prompt_tokens,
        completion_tokens: result.meta.completion_tokens,
      })
      .eq("id", draft.id);
  } catch (e) {
    await supabaseAdmin
      .from("social_posts")
      .update({ status: "failed" })
      .eq("id", draft.id);
    return {
      skipped: true,
      reason: `social generation failed: ${e instanceof Error ? e.message : String(e)}`,
      surface: "social",
      product_focus: product,
      post_id: draft.id,
    };
  }

  if (!autoPublish) {
    return {
      surface: "social",
      product_focus: product,
      post_id: draft.id,
      status: "draft",
    };
  }

  const now = new Date().toISOString();
  const { data: published } = await supabaseAdmin
    .from("social_posts")
    .update({ status: "published", published_at: now })
    .eq("id", draft.id)
    .select("*")
    .single();
  await supabaseAdmin
    .from("content_topics")
    .update({ status: "used", used_by_post_id: draft.id, used_at: now })
    .eq("id", topic.id);

  if (published) {
    const summary =
      (published.short_body || published.long_body || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140) || null;
    appendToHistoryIndex({
      surface: "social",
      product_focus: product,
      post_id: published.id,
      title: summary ?? "social post",
      primary_keyword: null,
      secondary_keywords: published.hashtags ?? [],
      summary_one_line: summary,
      published_at: now,
    }).catch((e) => console.error("[scheduler] history append failed:", e));

    const fires: Promise<unknown>[] = [];
    if (published.long_body?.trim()) {
      fires.push(
        dispatchContentWebhook({
          event: "social.published",
          format: "long",
          timestamp: now,
          data: {
            id: published.id,
            body: published.long_body,
            hashtags: published.hashtags ?? [],
            cta_url: published.cta_url ?? null,
            product_focus: published.product_focus,
          },
        }),
      );
    }
    if (published.short_body?.trim()) {
      fires.push(
        dispatchContentWebhook({
          event: "social.published",
          format: "short",
          timestamp: now,
          data: {
            id: published.id,
            body: published.short_body,
            hashtags: published.hashtags ?? [],
            cta_url: published.cta_url ?? null,
            product_focus: published.product_focus,
          },
        }),
      );
    }
    Promise.all(fires).catch((e) =>
      console.error("[scheduler] social webhook fan-out failed:", e),
    );
  }

  return {
    surface: "social",
    product_focus: product,
    post_id: draft.id,
    status: "published",
  };
}

// ── POST /tick ──────────────────────────────────────────────
// Main entry point. Make.com hits this every hour on cron.
contentSchedulerRoutes.post("/tick", async (c) => {
  // Optional body lets callers force a surface/product (useful for the
  // dashboard's "Generate next" button if we ever want to scope it).
  const body = (await c.req.json().catch(() => ({}))) as {
    force_surface?: Surface;
    force_product?: Product;
  };

  const settings = await loadSettings();
  if (!settings) {
    return c.json({ error: "content_settings row missing" }, 500);
  }

  // First: pick up anything the admin scheduled (status='scheduled' with
  // scheduled_for in the past). This runs every tick regardless of
  // cadence, so a scheduled post fires within the cron interval of its
  // scheduled_for. Counts toward today's cadence below.
  const publishedScheduled = await publishDueScheduledPosts();

  const today = await publishedTodayCounts();

  // Decide which surface (if any) is due for a slot.
  let surface: Surface | null = body.force_surface ?? null;
  if (!surface) {
    // Sum today's counts per surface across both products to compare
    // to cadence (cadence is per-surface, not per-product).
    const blogToday =
      (today.get("blog:gradethread") ?? 0) +
      (today.get("blog:flipdesk") ?? 0) +
      (today.get("blog:both") ?? 0);
    const socialToday =
      (today.get("social:gradethread") ?? 0) +
      (today.get("social:flipdesk") ?? 0) +
      (today.get("social:both") ?? 0);
    if (blogToday < settings.post_cadence_per_day_blog) surface = "blog";
    else if (socialToday < settings.post_cadence_per_day_social) surface = "social";
  }
  if (!surface) {
    return c.json({
      skipped: true,
      reason: "cadence already met for today",
      published_scheduled: publishedScheduled,
    } satisfies TickResult);
  }

  const product: Product = body.force_product ?? (await pickProductFocus(surface));

  // Make sure the bank has something to pull.
  const refilled = await ensureBankAtLeast(
    surface,
    product,
    settings.min_topics_in_bank,
    settings.topics_refill_batch,
  );

  const autoPublish =
    surface === "blog"
      ? settings.auto_publish_blog
      : settings.auto_publish_social;

  const result =
    surface === "blog"
      ? await runBlogTick(product, autoPublish)
      : await runSocialTick(product, autoPublish);

  return c.json({
    ...result,
    refilled_topics: refilled,
    published_scheduled: publishedScheduled,
  } satisfies TickResult);
});

// ── GET /summary (US-260) ───────────────────────────────────────
// Weekly digest source. Make.com hits this every Monday and formats the JSON
// into an email: what published (per surface/focus), topics added/used, webhook
// success rate, current bank levels, and suggested doc edits when voice drift is
// signalled. Same auth as the rest of the scheduler routes (job secret OR admin
// JWT). The window is configurable via ?days= (default 7).
contentSchedulerRoutes.get("/summary", async (c) => {
  const days = Math.min(
    90,
    Math.max(1, Number(c.req.query("days")) || 7),
  );
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  const settings = await loadSettings();
  const minTopics = settings?.min_topics_in_bank ?? 3;

  const [
    blogPub,
    socialPub,
    blogAuthored,
    topicsAdded,
    topicsUsed,
    queuedTopics,
    webhookRows,
  ] = await Promise.all([
    supabaseAdmin
      .from("blog_posts")
      .select("product_focus")
      .eq("status", "published")
      .gte("published_at", since),
    supabaseAdmin
      .from("social_posts")
      .select("product_focus")
      .eq("status", "published")
      .gte("published_at", since),
    supabaseAdmin
      .from("blog_posts")
      .select("generated_by")
      .gte("created_at", since),
    supabaseAdmin
      .from("content_topics")
      .select("surface, product_focus")
      .gte("created_at", since),
    supabaseAdmin
      .from("content_topics")
      .select("surface, product_focus")
      .eq("status", "used")
      .gte("used_at", since),
    supabaseAdmin
      .from("content_topics")
      .select("surface, product_focus")
      .eq("status", "queued"),
    supabaseAdmin
      .from("content_webhook_log")
      .select("succeeded")
      .gte("created_at", since),
  ]);

  // Aggregate current queued topics into per-(surface,product) bank levels.
  const bankMap = new Map<string, { surface: string; product_focus: string; queued: number }>();
  for (const row of queuedTopics.data ?? []) {
    const key = `${row.surface}:${row.product_focus}`;
    const e = bankMap.get(key) ?? {
      surface: row.surface as string,
      product_focus: row.product_focus as string,
      queued: 0,
    };
    e.queued += 1;
    bankMap.set(key, e);
  }

  const summary = buildContentSummary({
    windowDays: days,
    generatedAt: now.toISOString(),
    blogPublished: (blogPub.data ?? []) as Array<{ product_focus: string }>,
    socialPublished: (socialPub.data ?? []) as Array<{ product_focus: string }>,
    blogAuthored: (blogAuthored.data ?? []) as Array<{ generated_by: string }>,
    topicsAdded: (topicsAdded.data ?? []) as Array<{ surface: string; product_focus: string }>,
    topicsUsed: (topicsUsed.data ?? []) as Array<{ surface: string; product_focus: string }>,
    bankLevels: [...bankMap.values()],
    webhookLog: (webhookRows.data ?? []) as Array<{ succeeded: boolean }>,
    minTopicsInBank: minTopics,
  });

  return c.json(summary);
});

// Lightweight ping — useful for Make.com to validate the secret + URL
// before turning on the cron.
contentSchedulerRoutes.post("/test", (c) => {
  return c.json({ ok: true, ts: new Date().toISOString() });
});
