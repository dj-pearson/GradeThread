// US-875: content-freshness loop.
//
// Content decay quietly loses rankings; Google rewards genuine updates. This
// cron keeps the highest-value posts fresh automatically. Each run it:
//   1. ranks published posts by staleness × importance (GSC impressions/clicks
//      when available, else a reading-time pillar fallback),
//   2. picks the top post that clears the thrash guard (not refreshed within the
//      configurable cooldown) and the minimum-staleness floor,
//   3. re-runs it through the model to expand/correct the body + answer blocks,
//   4. writes ONLY if the change is material — bumping updated_at +
//      last_refreshed_at so dateModified and the visible "Updated" date move,
//      purging the Cloudflare cache, and re-pinging IndexNow,
//   5. records the activity in content_scheduler_runs (surface='refresh') so the
//      weekly digest can count it.
//
// Mounted in main.ts as POST /api/jobs/content-refresh, OUTSIDE /api/* JWT
// groups; the handler enforces X-Internal-Job-Secret itself (same pattern as the
// other Coolify crons — content-watchdog, grading-monitor).

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { sanitizeHtml } from "../lib/content-sanitize.ts";
import { refreshBlogArticle } from "../lib/content-ai-refresh.ts";
import {
  type FreshnessPost,
  materialChangeRatio,
  pickStalePost,
  rankStalePosts,
} from "../lib/content-freshness.ts";
import { loadStrikingDistanceBySlug } from "../lib/content-search-signals-loaders.ts";
import {
  buildBlogPurgeFiles,
  purgeCloudflareCache,
} from "../lib/cloudflare-purge.ts";
import { submitUrls } from "../lib/indexnow.ts";
import { writeSystemAuditLog } from "../lib/audit-log.ts";
import type { ContentProduct } from "../lib/content-history.ts";

// GSC importance lookback — long enough to smooth daily noise.
const GSC_LOOKBACK_DAYS = 90;
// Bound the candidate scan; published posts ordered oldest-first cover the
// staleness frontier well before this.
const MAX_CANDIDATES = 500;

type RefreshOutcome = "success" | "skip" | "error";

interface PostRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  product_focus: ContentProduct;
  published_at: string | null;
  last_refreshed_at: string | null;
  updated_at: string | null;
  reading_time_min: number | null;
  refresh_count: number | null;
  body_html: string | null;
  excerpt: string | null;
  seo_description: string | null;
  primary_keyword: string | null;
  secondary_keywords: string[] | null;
  key_takeaways: string[] | null;
  faqs: Array<{ q: string; a: string }> | null;
}

interface SettingsRow {
  auto_refresh_enabled: boolean;
  content_refresh_cooldown_days: number;
  content_refresh_min_stale_days: number;
  public_site_url: string;
}

// One content_scheduler_runs heartbeat per run, surface='refresh' so the weekly
// digest can count refreshes without confusing them with publish ticks.
async function recordRun(
  outcome: RefreshOutcome,
  postId: string | null,
  reason: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin.from("content_scheduler_runs").insert({
    surface: "refresh",
    product_focus: null,
    outcome,
    post_id: postId,
    refilled_topics: 0,
    published_scheduled: 0,
    error: reason,
  });
  if (error) {
    console.warn("[content-refresh] heartbeat insert failed:", error.message);
  }
}

async function loadSettings(): Promise<SettingsRow | null> {
  const { data } = await supabaseAdmin
    .from("content_settings")
    .select(
      "auto_refresh_enabled, content_refresh_cooldown_days, " +
        "content_refresh_min_stale_days, public_site_url",
    )
    .eq("id", 1)
    .maybeSingle();
  return (data as SettingsRow | null) ?? null;
}

// Aggregate GSC impressions+clicks by blog slug over the lookback window.
// Best-effort: returns an empty map when GSC has no data or the query fails, so
// the selector degrades gracefully to the reading-time fallback (US-879 is an
// optional input).
async function loadGscScores(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const since = new Date(Date.now() - GSC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const { data, error } = await supabaseAdmin
      .from("gsc_performance")
      .select("page, impressions, clicks")
      .not("page", "is", null)
      .gte("date", since);
    if (error || !data) return out;
    for (const row of data as Array<{ page: string; impressions: number; clicks: number }>) {
      const m = /\/blog\/([a-z0-9-]+)/i.exec(row.page);
      if (!m) continue;
      const slug = m[1];
      const score = (row.impressions ?? 0) + (row.clicks ?? 0);
      out.set(slug, (out.get(slug) ?? 0) + score);
    }
  } catch (e) {
    console.warn("[content-refresh] GSC load failed (degrading):", e);
  }
  return out;
}

function estimateReadingTime(html: string): number {
  const words = html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 225));
}

export async function handleContentRefreshCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("content-refresh", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const settings = await loadSettings();
    if (!settings) {
      await recordRun("error", null, "content_settings row missing");
      return c.json({ error: "content_settings row missing" }, 500);
    }

    if (!settings.auto_refresh_enabled) {
      await recordRun("skip", null, "auto_refresh_enabled=false");
      return c.json({ ok: true, skipped: true, reason: "auto-refresh disabled" });
    }

    // Pull the published frontier (oldest first) plus everything the selector
    // and the refresh need, so the chosen post needs no second fetch.
    const { data: postsRaw, error: postsErr } = await supabaseAdmin
      .from("blog_posts")
      .select(
        "id, slug, title, status, product_focus, published_at, last_refreshed_at, " +
          "updated_at, reading_time_min, refresh_count, body_html, excerpt, " +
          "seo_description, primary_keyword, secondary_keywords, key_takeaways, faqs",
      )
      .eq("status", "published")
      .order("published_at", { ascending: true })
      .limit(MAX_CANDIDATES);
    if (postsErr) {
      await recordRun("error", null, `posts query failed: ${postsErr.message}`);
      return c.json({ error: postsErr.message }, 500);
    }
    const posts = (postsRaw ?? []) as unknown as PostRow[];
    if (posts.length === 0) {
      await recordRun("skip", null, "no published posts");
      return c.json({ ok: true, skipped: true, reason: "no published posts" });
    }

    // GSC importance (impressions+clicks) and the US-879 striking-distance boost
    // are both best-effort optional inputs — empty maps degrade to the
    // reading-time fallback / no-boost ranking.
    const [gsc, striking] = await Promise.all([
      loadGscScores(),
      loadStrikingDistanceBySlug(GSC_LOOKBACK_DAYS),
    ]);
    const candidates: FreshnessPost[] = posts.map((p) => ({
      id: p.id,
      slug: p.slug,
      published_at: p.published_at,
      last_refreshed_at: p.last_refreshed_at,
      reading_time_min: p.reading_time_min,
    }));
    const ranked = rankStalePosts(candidates, gsc, Date.now(), {
      cooldownDays: settings.content_refresh_cooldown_days,
      minStaleDays: settings.content_refresh_min_stale_days,
    }, striking);
    const top = pickStalePost(ranked);
    if (!top) {
      await recordRun("skip", null, "no eligible stale posts");
      return c.json({ ok: true, skipped: true, reason: "no eligible stale posts" });
    }

    const post = posts.find((p) => p.id === top.id)!;
    const oldHtml = post.body_html ?? "";

    // Generate the refreshed candidate.
    let refreshed;
    let meta;
    try {
      const result = await refreshBlogArticle({
        product_focus: post.product_focus,
        refresh: {
          title: post.title,
          primary_keyword: post.primary_keyword ?? "",
          secondary_keywords: post.secondary_keywords ?? [],
          product_focus: post.product_focus,
          current_html: oldHtml,
          current_excerpt: post.excerpt,
          current_key_takeaways: post.key_takeaways ?? [],
          current_faqs: post.faqs ?? [],
          published_at: post.published_at,
        },
      });
      refreshed = result.refreshed;
      meta = result.meta;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await recordRun("error", post.id, `generation failed: ${msg}`);
      return c.json({ ok: false, post_id: post.id, error: msg }, 502);
    }

    const newHtml = sanitizeHtml(refreshed.body_html);
    const change = materialChangeRatio(oldHtml, newHtml);
    const nowIso = new Date().toISOString();

    if (!change.material) {
      // Trivial diff — don't move dateModified or re-ping crawlers. Still stamp
      // last_refreshed_at so the cooldown advances and the next run moves on to
      // the next stale post instead of thrashing this one.
      await supabaseAdmin
        .from("blog_posts")
        .update({ last_refreshed_at: nowIso })
        .eq("id", post.id);
      await recordRun(
        "skip",
        post.id,
        `trivial diff (changed=${change.changedRatio.toFixed(3)}, growth=${change.growthRatio.toFixed(3)})`,
      );
      return c.json({
        ok: true,
        skipped: true,
        reason: "trivial diff",
        post_id: post.id,
        change,
      });
    }

    // Material refresh — write the new body + answer blocks, bump the freshness
    // stamps. updated_at is set explicitly (and also by the trigger) so the
    // SSR "Updated <date>" + JSON-LD dateModified move.
    const { error: updErr } = await supabaseAdmin
      .from("blog_posts")
      .update({
        body_html: newHtml,
        excerpt: refreshed.excerpt || post.excerpt,
        seo_description: refreshed.seo_description || post.seo_description,
        key_takeaways: refreshed.key_takeaways,
        faqs: refreshed.faqs,
        reading_time_min: estimateReadingTime(newHtml),
        model_used: meta.model_used,
        prompt_tokens: meta.prompt_tokens,
        completion_tokens: meta.completion_tokens,
        last_refreshed_at: nowIso,
        updated_at: nowIso,
        refresh_count: (post.refresh_count ?? 0) + 1,
      })
      .eq("id", post.id);
    if (updErr) {
      await recordRun("error", post.id, `update failed: ${updErr.message}`);
      return c.json({ ok: false, post_id: post.id, error: updErr.message }, 500);
    }

    // System-actor audit row (US-269): the freshness job — not a human —
    // refreshed this post.
    await writeSystemAuditLog({
      action: "content.blog_refresh",
      targetType: "blog_post",
      targetId: post.id,
      after: { last_refreshed_at: nowIso, slug: post.slug },
      details: {
        trigger: "content_refresh_job",
        change_summary: refreshed.change_summary,
        changed_ratio: Number(change.changedRatio.toFixed(4)),
        growth_ratio: Number(change.growthRatio.toFixed(4)),
        importance: Number(top.importance.toFixed(3)),
        age_days: Number(top.ageDays.toFixed(1)),
        model_used: meta.model_used,
      },
    });

    const siteUrl = (settings.public_site_url || "https://gradethread.com").replace(/\/$/, "");
    const blogUrl = `${siteUrl}/blog/${post.slug}`;

    // Re-ping crawlers + purge the edge cache (best-effort, never blocks).
    buildBlogPurgeFiles(post.slug)
      .then((files) => purgeCloudflareCache({ files }))
      .catch((e) => console.error("[content-refresh] cache purge failed:", e));
    submitUrls([blogUrl]).catch((e) =>
      console.warn("[content-refresh] IndexNow submit failed:", e)
    );

    await recordRun("success", post.id, refreshed.change_summary || null);

    return c.json({
      ok: true,
      refreshed: true,
      post_id: post.id,
      slug: post.slug,
      url: blogUrl,
      change,
      importance: top.importance,
      age_days: top.ageDays,
      change_summary: refreshed.change_summary,
    });
  } finally {
    await lock.release();
  }
}
