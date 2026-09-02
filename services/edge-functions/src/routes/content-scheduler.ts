import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { supabaseAdmin } from "../lib/supabase.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { adminAuthMiddleware } from "../middleware/admin-auth.ts";
import { verifyJobSecret, verifySignedJobRequest } from "../lib/job-auth.ts";
import { generateBlogArticle } from "../lib/content-ai-blog.ts";
import { generateSocialPost } from "../lib/content-ai-social.ts";
import { researchTopics } from "../lib/content-ai-research.ts";
import { sanitizeHtml } from "../lib/content-sanitize.ts";
import { hasAnySocialWebhookConfigured } from "../lib/content-webhook.ts";
import { appendToHistoryIndex } from "../lib/content-history.ts";
import { dispatchContentWebhook } from "../lib/content-webhook.ts";
import {
  fireSocialWebhooks,
  persistSocialVariants,
} from "../lib/content-social-publish.ts";
import {
  buildBlogPurgeFiles,
  purgeCloudflareCache,
} from "../lib/cloudflare-purge.ts";
import { writeSystemAuditLog } from "../lib/audit-log.ts";
import {
  buildContentSummary,
  buildDigestRecommendations,
  type ContentSummary,
} from "../lib/content-summary.ts";
import { sendContentDigestEmail } from "../lib/email.ts";
import { captureException, recordMetric } from "../lib/observability.ts";
import { reviewContentSafety } from "../lib/content-safety.ts";
import { ensureHeroImage } from "../lib/openai-images.ts";
import {
  loadSearchOpportunities,
  queueGscGapTopics,
} from "../lib/content-search-signals-loaders.ts";

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
  // US-487: overlap rotation — both the current secret and (during a rotation
  // window) the previous one in CONTENT_INTERNAL_JOB_SECRET_OLD are accepted,
  // so the secret can be rotated with zero downtime: set the new value, move
  // the old one to _OLD, update the Make.com scenario, then drop _OLD.
  const secrets = [
    Deno.env.get("CONTENT_INTERNAL_JOB_SECRET"),
    Deno.env.get("CONTENT_INTERNAL_JOB_SECRET_OLD"),
  ];

  // Preferred path (US-487): signed timestamped request — HMAC bound to
  // method+path with a freshness window and single-use signatures (replay
  // rejected). The secret never crosses the wire. A request that PRESENTS a
  // signature but fails verification is rejected outright rather than falling
  // through to weaker auth paths.
  if (c.req.header("X-Internal-Job-Signature")) {
    if (await verifySignedJobRequest(c, secrets)) {
      await next();
      return;
    }
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Legacy Make.com path: static header secret (US-360 constant-time compare).
  if (await verifyJobSecret(c.req.header("X-Internal-Job-Secret"), secrets)) {
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
  // RETURN the response through the chain. Hono finalizes a context from the
  // middleware's RETURN VALUE, so discarding it here meant a rejected request
  // produced no response at all: authMiddleware built its 401, this wrapper
  // dropped it, the context never finalized, and Hono threw "Context is not
  // finalized" -> onError -> HTTP 500. A clean 401 was being turned into a 500,
  // and the real cause (a job secret that no longer verifies) was hidden behind
  // a framework error with no stack.
  // Hono's Next type is `() => Promise<void>`, so the inner rejection cannot be
  // returned directly — capture it and propagate.
  let innerResponse: Response | void = undefined;
  const outerResponse = await authMiddleware(
    c as unknown as Parameters<typeof authMiddleware>[0],
    async () => {
      innerResponse = await adminAuthMiddleware(
        c as unknown as Parameters<typeof adminAuthMiddleware>[0],
        next,
      );
    },
  );
  // adminAuthMiddleware's 403 wins when it produced one; otherwise
  // authMiddleware's 401. Both undefined => the handler ran and finalized.
  return innerResponse ?? outerResponse;
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
  // US-486: kill-switch + weekly ceiling beyond per-day cadence.
  publishing_paused: boolean;
  max_auto_publishes_per_week: number;
}

type Surface = "blog" | "social";
type Product = "gradethread" | "flipdesk";

interface TickResult {
  skipped?: boolean;
  reason?: string;
  surface?: Surface;
  product_focus?: Product;
  post_id?: string;
  status?: "draft" | "published" | "held";
  refilled_topics?: number;
  published_scheduled?: number; // count of scheduled drafts promoted this tick
}

async function loadSettings(): Promise<SettingsRow | null> {
  const { data } = await supabaseAdmin
    .from("content_settings")
    .select(
      "auto_publish_blog, auto_publish_social, post_cadence_per_day_blog, " +
        "post_cadence_per_day_social, min_topics_in_bank, topics_refill_batch, public_site_url, " +
        "publishing_paused, max_auto_publishes_per_week",
    )
    .eq("id", 1)
    .maybeSingle();
  return (data as SettingsRow | null) ?? null;
}

// Count today's used cadence slots per (surface, product_focus). We use
// the user's day in UTC for simplicity; if scheduling around a
// specific timezone matters later, add a tz column to settings.
//
// A slot is used by a post PUBLISHED today **or** by one the scheduler
// AUTHORED today. Counting only publishes starves the second surface whenever
// the first one's auto_publish_* flag is off — which is exactly the state the
// documented rollout asks for ("turn on social autopilot first, keep blog
// manual", vault/40-growth/content-scheduler.md). With auto_publish_blog=false
// the blog draft never publishes, blogToday stays 0 forever, the surface pick
// below chooses "blog" on every single tick, and the social surface never gets
// a slot at all — no social post is ever generated, let alone auto-published.
// It also meant an hourly cron authored a fresh blog article (and burned a
// topic + an AI call) every hour instead of once a day.
//
// Deduped by post id so an auto-published post — authored AND published in the
// same tick — still consumes exactly one slot, keeping behaviour identical to
// the previous logic once auto-publish is on. 'failed' generations don't count:
// nothing was produced, so the slot is still open.
async function slotsUsedTodayCounts(): Promise<Map<string, number>> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const isoSince = since.toISOString();

  const [
    { data: blogPub },
    { data: socialPub },
    { data: blogMade },
    { data: socialMade },
  ] = await Promise.all([
    supabaseAdmin
      .from("blog_posts")
      .select("id, product_focus")
      .eq("status", "published")
      .gte("published_at", isoSince),
    supabaseAdmin
      .from("social_posts")
      .select("id, product_focus")
      .eq("status", "published")
      .gte("published_at", isoSince),
    supabaseAdmin
      .from("blog_posts")
      .select("id, product_focus")
      .eq("generated_by", "ai")
      .neq("status", "failed")
      .gte("created_at", isoSince),
    supabaseAdmin
      .from("social_posts")
      .select("id, product_focus")
      .eq("generated_by", "ai")
      .neq("status", "failed")
      .gte("created_at", isoSince),
  ]);

  return tallySlots([
    ...(blogPub ?? []).map((r) => ({ surface: "blog" as const, ...r })),
    ...(blogMade ?? []).map((r) => ({ surface: "blog" as const, ...r })),
    ...(socialPub ?? []).map((r) => ({ surface: "social" as const, ...r })),
    ...(socialMade ?? []).map((r) => ({ surface: "social" as const, ...r })),
  ]);
}

// Pure tally (unit-tested): fold rows into `surface:product_focus` counts,
// counting each post id at most once.
export function tallySlots(
  rows: Array<{ surface: Surface; id: string; product_focus: string }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const k = `${row.surface}:${row.product_focus}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

// US-486: hard weekly ceiling, independent of per-day cadence. Counts every
// AI-generated SOCIAL post published in the last 7 days — deliberately
// conservative (manual publishes of AI drafts count too) so a cadence
// misconfiguration or a runaway tick loop can't flood the channels.
//
// Social only, on purpose. Until 2026-09-02 this summed blog_posts as well,
// while the gate below applies to social alone and blog is uncapped by product
// decision (2026-06). Blog autopilot at 2/day put 14+ rows in the window
// against a cap of 10, so every social tick generated a post and then demoted
// it to draft with the run log reading "success" — the ceiling was permanently
// closed before the first social post ever published. Exported for the test
// that pins this (content-weekly-ceiling_test.ts).
export async function aiPublishedLast7Days(): Promise<number> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabaseAdmin
    .from("social_posts")
    .select("id", { count: "exact", head: true })
    .eq("status", "published")
    .eq("generated_by", "ai")
    .gte("published_at", since);
  return count ?? 0;
}

// "Which product needs the next slot?" — picks whichever (gt vs fd)
// has fewer rows in the last 14 days for this surface so the two
// products stay balanced over time. Defaults to gradethread on ties.
//
// Counts AUTHORED, not published, for the same reason as slotsUsedTodayCounts:
// with auto-publish off nothing is ever published, every window is empty, and
// the tie-break would hand every slot to gradethread forever — the two products
// would drift apart precisely while the engine runs in draft-only mode.
async function pickProductFocus(surface: Surface): Promise<Product> {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const table = surface === "blog" ? "blog_posts" : "social_posts";
  const { data } = await supabaseAdmin
    .from(table)
    .select("product_focus")
    .eq("generated_by", "ai")
    .neq("status", "failed")
    .gte("created_at", since);
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
//
// US-487: settings are loaded ONCE in /tick and passed in — this used to
// re-query content_settings per published blog post.
async function publishDueScheduledPosts(settings: SettingsRow): Promise<number> {
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

      const siteUrl = settings.public_site_url || "https://gradethread.com";
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

  // US-2104 AC3: the same false-success guard as the manual publish route, and
  // it matters MORE here. Unattended, this loop would drain the entire scheduled
  // queue to status='published' — a terminal state — while every fan-out skipped
  // silently for want of a configured webhook. One operator click publishes one
  // post into nothing; one cron tick publishes the whole backlog into nothing.
  //
  // Checked ONCE per tick rather than per post: it is the same global settings
  // row, and re-reading it per post would turn a batch into N queries for an
  // answer that cannot change mid-loop.
  //
  // Posts stay 'scheduled' so they publish for real once a webhook is set —
  // they are deferred, not dropped, and no scheduled_for is rewritten.
  if ((socials?.length ?? 0) > 0 && !(await hasAnySocialWebhookConfigured())) {
    console.warn(
      `[scheduler] ${socials!.length} social post(s) are due but NO social webhook ` +
        `is configured (make_webhook_social / _long / _short all unset) — leaving them ` +
        `scheduled rather than marking them published with nothing sent.`,
    );
    return published;
  }

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

      // System-actor audit row, mirroring the blog scheduled path (US-486).
      await writeSystemAuditLog({
        action: "content.social_publish",
        targetType: "social_post",
        targetId: updated.id,
        before: { status: "scheduled" },
        after: { status: "published", published_at: nowIso },
        details: { trigger: "scheduler_tick" },
      });

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

      // US-870: platform-aware fan-out (falls back to long/short).
      fireSocialWebhooks(updated, nowIso).catch((e) =>
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

  const deficit = Math.max(refillBatch, minimum - have);

  // US-879 closed loop: fill the bank first from REAL search demand — GSC
  // content gaps (high-impression queries with no dedicated post), tagged
  // source='gsc_opportunity'. Best-effort: degrades to 0 when GSC is absent, so
  // the AI brainstorm below always covers the remainder. Blog only (search-gap
  // detection is meaningless for the social surface).
  let queued = 0;
  if (surface === "blog") {
    const gapResult = await queueGscGapTopics({
      surface,
      productFocus: product,
      limit: deficit,
    });
    queued += gapResult.queued;
    if (gapResult.queued > 0) {
      console.log(
        `[scheduler] queued ${gapResult.queued} GSC content-gap topic(s) for ` +
          `blog/${product}: ${gapResult.gaps.join(", ")}`,
      );
    }
  }

  const remaining = deficit - queued;
  if (remaining <= 0) return queued;

  try {
    const result = await researchTopics({
      surface,
      productFocus: product,
      count: remaining,
    });
    if (result.candidates.length === 0) return queued;
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
    return queued + (data?.length ?? 0);
  } catch (e) {
    console.error("[scheduler] bank refill failed:", e);
    return queued;
  }
}

// US-977: byline autonomously-generated blog posts to a real content_authors
// Person entity (E-E-A-T) instead of leaving author_id null — a null link makes
// the Article render a generic Organization author, which Google/AI weight far
// less than a credentialed Person with a dedicated /authors profile page.
//
// Resolution order: the CONTENT_DEFAULT_AUTHOR_SLUG env override (lets an
// operator point the engine at a named human author) → the seeded house author
// 'gradethread-team' (a real Person row with bio + credentials + profile page)
// → the oldest author row. Returns null only when NO author exists at all, in
// which case the post falls back to the legacy byline string, exactly as before.
async function resolveDefaultAuthorId(): Promise<string | null> {
  const preferredSlug =
    Deno.env.get("CONTENT_DEFAULT_AUTHOR_SLUG")?.trim() || "gradethread-team";
  const { data: bySlug } = await supabaseAdmin
    .from("content_authors")
    .select("id")
    .eq("slug", preferredSlug)
    .maybeSingle();
  if (bySlug?.id) return bySlug.id as string;
  const { data: anyAuthor } = await supabaseAdmin
    .from("content_authors")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (anyAuthor?.id as string | undefined) ?? null;
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
  settings: SettingsRow,
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
  // US-977: link a real Person author so the published Article carries a
  // Person/author-page byline for E-E-A-T (set on the pre-create so it survives
  // the generation update, which never touches author_id).
  const authorId = await resolveDefaultAuthorId();
  const { data: draft, error: insErr } = await supabaseAdmin
    .from("blog_posts")
    .insert({
      title: topic.title,
      slug,
      product_focus: product,
      topic_id: topic.id,
      primary_keyword: topic.primary_keyword,
      secondary_keywords: topic.secondary_keywords ?? [],
      author_id: authorId,
      generated_by: "ai" as const,
      status: "draft" as const,
    })
    .select("*")
    .single();
  if (insErr || !draft) {
    return { skipped: true, reason: `draft insert failed: ${insErr?.message}` };
  }

  // Captured out of the try block so the safety gate below can review the
  // exact text that would go live.
  let generatedTitle = topic.title;
  let generatedHtml = "";
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
    generatedTitle = article.title;
    generatedHtml = cleanHtml;
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

  // US-486 safety/claims review — ADVISORY as of 2026-07. The fully autonomous
  // path is the only one with no human in the loop, so it still runs the review,
  // but a non-pass verdict no longer holds the post: it publishes and is tagged
  // safety_status='flagged' (reasons in safety_notes) for after-the-fact review,
  // instead of sitting in draft.
  const safety = await reviewContentSafety({
    surface: "blog",
    title: generatedTitle,
    body: generatedHtml,
    productFocus: product,
  });
  const checkedAt = new Date().toISOString();
  const flagged = safety.verdict !== "pass";
  if (flagged) {
    console.warn(
      `[scheduler] publishing blog with safety flag | post=${draft.id} | ` +
        `reasons=${JSON.stringify(safety.reasons)}`,
    );
    await writeSystemAuditLog({
      action: "content.blog_safety_flagged",
      targetType: "blog_post",
      targetId: draft.id,
      details: {
        trigger: "auto_publish_safety_review",
        reasons: safety.reasons,
        model_used: safety.model_used,
      },
    });
  }

  // US-853: generate the hero image before publishing so the webhook + OG
  // image carry hero_image_url. Best-effort + idempotent — a failure logs and
  // the post still publishes (heroless).
  const hero = await ensureHeroImage({ postId: draft.id, surface: "blog" });
  if (hero.status === "failed") {
    console.warn("[scheduler] hero generation failed (publishing anyway):", hero.reason);
  }

  // Auto-publish path: stamp published_at, mark topic used, append
  // to history, fire webhook, purge cache.
  const now = new Date().toISOString();
  const { data: published } = await supabaseAdmin
    .from("blog_posts")
    .update({
      status: "published",
      published_at: now,
      safety_status: flagged ? "flagged" : "passed",
      safety_notes: flagged
        ? safety.reasons.join("; ").slice(0, 2000) || null
        : null,
      safety_checked_at: checkedAt,
    })
    .eq("id", draft.id)
    .select("*")
    .single();
  await supabaseAdmin
    .from("content_topics")
    .update({ status: "used", used_by_post_id: draft.id, used_at: now })
    .eq("id", topic.id);

  if (published) {
    // Attributable system audit row (US-486): records that the scheduler —
    // not a human — published this AI post, and that it passed safety review.
    await writeSystemAuditLog({
      action: "content.blog_publish",
      targetType: "blog_post",
      targetId: published.id,
      after: { status: "published", published_at: now, slug: published.slug },
      details: {
        trigger: "auto_publish",
        safety: flagged ? "flagged" : "passed",
        safety_model: safety.model_used,
        generated_by: "ai",
        model_used: published.model_used,
      },
    });

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
        url: `${settings.public_site_url || "https://gradethread.com"}/blog/${published.slug}`,
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

  // Captured out of the try block for the safety gate below.
  let generatedBody = "";
  try {
    const result = await generateSocialPost({
      topic: {
        title: topic.title,
        angle: topic.angle,
        primary_keyword: topic.primary_keyword,
        product_focus: product,
      },
    });
    generatedBody =
      `LONG FORMAT:\n${result.post.long_body}\n\n` +
      `SHORT FORMAT:\n${result.post.short_body}\n\n` +
      `HASHTAGS: ${result.post.hashtags.join(" ")}`;
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
    // US-870: (re)write the per-platform variant rows so the publish fan-out
    // can dispatch by platform.
    await persistSocialVariants(draft.id, result.post.variants);
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

  // US-2104 AC3, third path. The guard was wired into the manual publish route
  // and the scheduled-queue drain but NOT here — the AI-creation path, which is
  // both unattended and the one that runs on every tick. With every
  // make_webhook_social* unset it would flip a freshly generated post straight
  // to 'published' (terminal) while the fan-out skipped with attempts:0, no
  // webhook log and no dead letter: one silently lost post per tick, forever,
  // with the engine reporting success. Leave it a draft instead — it is
  // publishable by hand the moment a destination exists.
  if (!(await hasAnySocialWebhookConfigured())) {
    console.warn(
      `[scheduler] generated social post ${draft.id} but NO social webhook is ` +
        `configured (make_webhook_social / _long / _short all unset) — leaving it ` +
        `as a draft rather than marking it published with nothing sent.`,
    );
    return {
      surface: "social",
      product_focus: product,
      post_id: draft.id,
      status: "draft",
      reason: "no social webhook configured — left as draft",
    };
  }

  // US-486 safety/claims review before the autonomous publish — ADVISORY as of
  // 2026-07 (see blog path). A non-pass verdict no longer holds the post: it
  // publishes and is tagged safety_status='flagged' for after-the-fact review.
  const safety = await reviewContentSafety({
    surface: "social",
    title: topic.title,
    body: generatedBody,
    productFocus: product,
  });
  const checkedAt = new Date().toISOString();
  const flagged = safety.verdict !== "pass";
  if (flagged) {
    console.warn(
      `[scheduler] publishing social with safety flag | post=${draft.id} | ` +
        `reasons=${JSON.stringify(safety.reasons)}`,
    );
    await writeSystemAuditLog({
      action: "content.social_safety_flagged",
      targetType: "social_post",
      targetId: draft.id,
      details: {
        trigger: "auto_publish_safety_review",
        reasons: safety.reasons,
        model_used: safety.model_used,
      },
    });
  }

  const now = new Date().toISOString();
  const { data: published } = await supabaseAdmin
    .from("social_posts")
    .update({
      status: "published",
      published_at: now,
      safety_status: flagged ? "flagged" : "passed",
      safety_notes: flagged
        ? safety.reasons.join("; ").slice(0, 2000) || null
        : null,
      safety_checked_at: checkedAt,
    })
    .eq("id", draft.id)
    .select("*")
    .single();
  await supabaseAdmin
    .from("content_topics")
    .update({ status: "used", used_by_post_id: draft.id, used_at: now })
    .eq("id", topic.id);

  if (published) {
    // Attributable system audit row (US-486) — mirrors the blog path.
    await writeSystemAuditLog({
      action: "content.social_publish",
      targetType: "social_post",
      targetId: published.id,
      after: { status: "published", published_at: now },
      details: {
        trigger: "auto_publish",
        safety: flagged ? "flagged" : "passed",
        safety_model: safety.model_used,
        generated_by: "ai",
        model_used: published.model_used,
      },
    });

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

    // US-870: platform-aware fan-out (falls back to long/short).
    fireSocialWebhooks(published, now).catch((e) =>
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

// ── Heartbeat (US-869) ───────────────────────────────────────
// One content_scheduler_runs row per tick so the content-watchdog cron can
// prove the autonomous engine is still alive. A "non-error tick" (success OR a
// benign skip) is the heartbeat; an error outcome does NOT count as alive.
type RunOutcome = "success" | "skip" | "error";

// Benign skips (paused, cadence met, no queued topics) → 'skip'. A skip whose
// reason signals a failure mid-tick (generation/insert failed) → 'error' so it
// neither counts as a healthy heartbeat nor hides the failure from the log.
function classifyOutcome(result: TickResult): RunOutcome {
  if (result.skipped) {
    return /fail|error/i.test(result.reason ?? "") ? "error" : "skip";
  }
  return "success";
}

async function recordSchedulerRun(
  outcome: RunOutcome,
  result: Partial<TickResult>,
): Promise<void> {
  const { error } = await supabaseAdmin.from("content_scheduler_runs").insert({
    surface: result.surface ?? null,
    product_focus: result.product_focus ?? null,
    outcome,
    post_id: result.post_id ?? null,
    refilled_topics: result.refilled_topics ?? 0,
    published_scheduled: result.published_scheduled ?? 0,
    // The `error` column doubles as the human-readable reason for skips too —
    // it's the only free-text column and is invaluable when debugging a stall.
    error: result.reason ?? null,
  });
  if (error) {
    // Never let a heartbeat failure break a tick — log and move on.
    console.warn("[scheduler] heartbeat insert failed:", error.message);
  }
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
    // Misconfiguration that wedges the whole engine — record it as an error
    // heartbeat (NOT a healthy tick) so the watchdog flags the stall.
    await recordSchedulerRun("error", {
      reason: "content_settings row missing",
    });
    return c.json({ error: "content_settings row missing" }, 500);
  }

  // US-486 kill-switch: when paused, the tick does NOTHING — no scheduled-
  // draft promotion, no generation, no auto-publish. One toggle stops the
  // whole autonomous pipeline; manual dashboard publishes still work.
  if (settings.publishing_paused) {
    const result: TickResult = {
      skipped: true,
      reason: "publishing paused (kill-switch)",
    };
    // A deliberate pause is a healthy heartbeat — the scheduler ran fine.
    await recordSchedulerRun("skip", result);
    return c.json(result satisfies TickResult);
  }

  // First: pick up anything the admin scheduled (status='scheduled' with
  // scheduled_for in the past). This runs every tick regardless of
  // cadence, so a scheduled post fires within the cron interval of its
  // scheduled_for. Counts toward today's cadence below.
  const publishedScheduled = await publishDueScheduledPosts(settings);

  const today = await slotsUsedTodayCounts();

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
    const result: TickResult = {
      skipped: true,
      reason: "cadence already met for today",
      published_scheduled: publishedScheduled,
    };
    await recordSchedulerRun("skip", result);
    return c.json(result satisfies TickResult);
  }

  const product: Product = body.force_product ?? (await pickProductFocus(surface));

  // Make sure the bank has something to pull.
  const refilled = await ensureBankAtLeast(
    surface,
    product,
    settings.min_topics_in_bank,
    settings.topics_refill_batch,
  );

  let autoPublish =
    surface === "blog"
      ? settings.auto_publish_blog
      : settings.auto_publish_social;

  // US-486 weekly ceiling: a hard cap on autonomous publishes that holds even
  // if the per-day cadence is misconfigured. At the ceiling we still generate
  // the draft (content keeps flowing) but demote to draft instead of
  // publishing.
  //
  // Per product decision (2026-06): BLOG articles publish on completion with NO
  // weekly cap. The content-safety review is advisory (2026-07) — it flags but
  // no longer holds — so the ceiling is the only auto-throttle, and it still
  // guards SOCIAL auto-posts (higher volume, more spam-prone). Raise
  // "Max auto-publishes per week" in Content Settings to lift it.
  if (autoPublish && surface === "social") {
    const weeklyCount = await aiPublishedLast7Days();
    if (weeklyCount >= settings.max_auto_publishes_per_week) {
      console.warn(
        `[scheduler] weekly auto-publish ceiling reached ` +
          `(${weeklyCount}/${settings.max_auto_publishes_per_week}) — generating as draft`,
      );
      autoPublish = false;
    }
  }

  const result =
    surface === "blog"
      ? await runBlogTick(product, autoPublish, settings)
      : await runSocialTick(product, autoPublish);

  const fullResult: TickResult = {
    ...result,
    refilled_topics: refilled,
    published_scheduled: publishedScheduled,
  };
  await recordSchedulerRun(classifyOutcome(fullResult), fullResult);
  return c.json(fullResult satisfies TickResult);
});

// ── GET /summary (US-260) ───────────────────────────────────────
// Weekly digest source. Make.com hits this every Monday and formats the JSON
// into an email: what published (per surface/focus), topics added/used, webhook
// success rate, current bank levels, and suggested doc edits when voice drift is
// signalled. Same auth as the rest of the scheduler routes (job secret OR admin
// JWT). The window is configurable via ?days= (default 7).
// Build the weekly content summary. Shared by GET /summary (read) and POST
// /digest (deliver) so the two never drift. `days` is the trailing window.
async function computeContentSummary(days: number): Promise<ContentSummary> {
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
    refreshRuns,
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
    // US-875: count material content refreshes in the window for the digest.
    supabaseAdmin
      .from("content_scheduler_runs")
      .select("id", { count: "exact", head: true })
      .eq("surface", "refresh")
      .eq("outcome", "success")
      .gte("ran_at", since),
  ]);

  // US-879: GSC opportunities (striking-distance pages, content gaps, title/meta
  // rewrites) for the digest. Best-effort — empty when GSC has no data. Uses a
  // 28-day window regardless of `days` so trends aren't lost on a 7-day digest.
  const searchOpportunities = await loadSearchOpportunities({
    days: 28,
    surface: "blog",
    productFocus: "both",
  });

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

  return buildContentSummary({
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
    refreshedPosts: refreshRuns.count ?? 0,
    searchOpportunities,
  });
}

contentSchedulerRoutes.get("/summary", async (c) => {
  const days = Math.min(
    90,
    Math.max(1, Number(c.req.query("days")) || 7),
  );
  const summary = await computeContentSummary(days);
  return c.json(summary);
});

// ── POST /digest (US-880) ───────────────────────────────────────
// Deliver the weekly readout + tuning recommendations to the owner by email,
// and act on the data (recommendations link into the admin content UI). Same
// auth as the rest of the scheduler routes: the Coolify weekly cron calls it
// with the job secret, and an admin can trigger it on demand from the dashboard
// (US-852 schedule, AC#5). Window via ?days= (default 7). Failures are reported
// (Sentry + metric), never silent (AC#4). Recipient resolves from
// CONTENT_DIGEST_EMAIL → CONTENT_ALERT_EMAIL → SMTP_ADMIN_EMAIL.
contentSchedulerRoutes.post("/digest", async (c) => {
  const days = Math.min(90, Math.max(1, Number(c.req.query("days")) || 7));
  const summary = await computeContentSummary(days);
  const recommendations = buildDigestRecommendations(summary);

  const to = Deno.env.get("CONTENT_DIGEST_EMAIL")?.trim() ||
    Deno.env.get("CONTENT_ALERT_EMAIL")?.trim() ||
    Deno.env.get("SMTP_ADMIN_EMAIL")?.trim() ||
    "";

  if (!to) {
    // A digest that can reach no one must be reported, not dropped silently.
    recordMetric("content_digest.no_recipient", 1);
    captureException(
      new Error(
        "content digest has no recipient — set CONTENT_DIGEST_EMAIL, " +
          "CONTENT_ALERT_EMAIL, or SMTP_ADMIN_EMAIL.",
      ),
      { level: "warn", route: "content-scheduler.digest" },
    );
    return c.json(
      {
        ok: false,
        delivered: false,
        reason: "no_recipient",
        window_days: days,
        recommendations: recommendations.length,
      },
      // 200 for the cron (it ran fine; config is the gap) but flag undelivered.
      200,
    );
  }

  const bankLow = summary.bank_levels
    .filter((b) => b.below_min)
    .map((b) => ({
      surface: b.surface,
      product_focus: b.product_focus,
      queued: b.queued,
      min: b.min,
    }));

  let delivered = false;
  try {
    delivered = await sendContentDigestEmail(to, {
      windowDays: summary.window_days,
      generatedAt: summary.generated_at,
      published: {
        blog: summary.published.blog.total,
        social: summary.published.social.total,
        total: summary.published.total,
      },
      topics: { added: summary.topics.added, used: summary.topics.used },
      webhooks: {
        total: summary.webhooks.total,
        succeeded: summary.webhooks.succeeded,
        failed: summary.webhooks.failed,
        successRate: summary.webhooks.success_rate,
      },
      refreshedPosts: summary.refreshes.posts_refreshed,
      bankLow,
      contentGaps: summary.opportunities.content_gaps.map((g) => ({
        query: g.query,
        impressions: g.impressions,
      })),
      recommendations,
    });
  } catch (err) {
    captureException(err, { route: "content-scheduler.digest.email" });
  }

  if (!delivered) {
    recordMetric("content_digest.undelivered", 1);
    captureException(
      new Error(`content digest to ${to} was not delivered`),
      { level: "warn", route: "content-scheduler.digest" },
    );
  } else {
    recordMetric("content_digest.delivered", 1);
  }

  return c.json({
    ok: true,
    delivered,
    window_days: days,
    recommendations: recommendations.length,
    recommendation_codes: recommendations.map((r) => r.code),
  });
});

// Lightweight ping — useful for Make.com to validate the secret + URL
// before turning on the cron.
contentSchedulerRoutes.post("/test", (c) => {
  return c.json({ ok: true, ts: new Date().toISOString() });
});
