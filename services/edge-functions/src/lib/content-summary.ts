// Pure aggregation for the weekly content-summary digest (US-260).
//
// The /api/content/scheduler/summary endpoint fetches a week of raw rows and
// hands them here; keeping the math pure (no Supabase, no Deno.env) makes it
// unit-testable with fixtures (content-summary_test.ts). Make.com hits the
// endpoint every Monday and formats this JSON into the digest email.

export type Surface = "blog" | "social";

export interface SummaryInput {
  windowDays: number;
  generatedAt: string; // ISO
  /** Posts published within the window. */
  blogPublished: Array<{ product_focus: string }>;
  socialPublished: Array<{ product_focus: string }>;
  /** Posts created within the window, split by author, for voice-drift signal. */
  blogAuthored: Array<{ generated_by: string }>;
  /** Topics created within the window. */
  topicsAdded: Array<{ surface: string; product_focus: string }>;
  /** Topics consumed (used_at) within the window. */
  topicsUsed: Array<{ surface: string; product_focus: string }>;
  /** Current queued topic counts per (surface, product_focus). */
  bankLevels: Array<{ surface: string; product_focus: string; queued: number }>;
  /** Publish-time webhook deliveries within the window. */
  webhookLog: Array<{ succeeded: boolean }>;
  /** content_settings.min_topics_in_bank — the refill floor. */
  minTopicsInBank: number;
  /**
   * US-875: material content refreshes applied by the freshness job within the
   * window (content_scheduler_runs surface='refresh', outcome='success').
   * Optional — defaults to 0 so older callers/fixtures stay valid.
   */
  refreshedPosts?: number;
  /**
   * US-879: GSC closed-loop opportunities. Optional — defaults to all-empty so
   * older callers/fixtures stay valid and the digest degrades gracefully when
   * Search Console data is absent. Structurally mirrors content-search-signals
   * .ts `SearchOpportunities` (kept inline so this pure module pulls no IO deps).
   */
  searchOpportunities?: SearchOpportunities;
}

export interface SearchOpportunities {
  /** Posts ranking ~5-20 with rising impressions — refresh-priority targets. */
  striking_pages: Array<{
    page: string;
    slug: string | null;
    position: number;
    impressions: number;
    clicks: number;
  }>;
  /** High-impression queries with no dedicated post. */
  content_gaps: Array<{ query: string; impressions: number; position: number }>;
  /** High-impression / low-CTR queries — title + meta rewrite candidates. */
  title_meta: Array<{
    query: string;
    impressions: number;
    clicks: number;
    ctr: number;
    position: number;
  }>;
}

export interface ContentSummary {
  window_days: number;
  generated_at: string;
  published: {
    blog: Record<string, number> & { total: number };
    social: Record<string, number> & { total: number };
    total: number;
  };
  topics: {
    added: number;
    used: number;
    by_surface_product: Record<string, { added: number; used: number }>;
  };
  webhooks: {
    total: number;
    succeeded: number;
    failed: number;
    success_rate: number; // 0..1, 1 when no deliveries
  };
  bank_levels: Array<{
    surface: string;
    product_focus: string;
    queued: number;
    min: number;
    below_min: boolean;
  }>;
  voice: {
    blog_posts_created: number;
    human_authored: number;
    human_override_rate: number; // 0..1
  };
  /** US-875: freshness-loop activity within the window. */
  refreshes: {
    posts_refreshed: number;
  };
  /** US-879: GSC closed-loop opportunities surfaced for the owner. */
  opportunities: SearchOpportunities;
  suggestions: string[];
}

const EMPTY_OPPORTUNITIES: SearchOpportunities = {
  striking_pages: [],
  content_gaps: [],
  title_meta: [],
};

function countByProduct(
  rows: Array<{ product_focus: string }>,
): Record<string, number> & { total: number } {
  const out: Record<string, number> & { total: number } = { total: 0 };
  for (const r of rows) {
    out[r.product_focus] = (out[r.product_focus] ?? 0) + 1;
    out.total += 1;
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function buildContentSummary(input: SummaryInput): ContentSummary {
  const blog = countByProduct(input.blogPublished);
  const social = countByProduct(input.socialPublished);

  // Topic flow keyed "surface:product".
  const bySp: Record<string, { added: number; used: number }> = {};
  const bump = (k: string, field: "added" | "used") => {
    bySp[k] ??= { added: 0, used: 0 };
    bySp[k][field] += 1;
  };
  for (const t of input.topicsAdded) bump(`${t.surface}:${t.product_focus}`, "added");
  for (const t of input.topicsUsed) bump(`${t.surface}:${t.product_focus}`, "used");

  const webhookTotal = input.webhookLog.length;
  const webhookOk = input.webhookLog.filter((w) => w.succeeded).length;
  const successRate = webhookTotal === 0 ? 1 : round(webhookOk / webhookTotal);

  const bankLevels = input.bankLevels.map((b) => ({
    surface: b.surface,
    product_focus: b.product_focus,
    queued: b.queued,
    min: input.minTopicsInBank,
    below_min: b.queued < input.minTopicsInBank,
  }));

  const blogCreated = input.blogAuthored.length;
  const humanAuthored = input.blogAuthored.filter(
    (p) => p.generated_by === "human",
  ).length;
  const overrideRate = blogCreated === 0 ? 0 : round(humanAuthored / blogCreated);

  // Operational suggestions + a voice-drift proxy. We don't run an AI tone
  // comparison here; instead a high human-authored share of recent posts is a
  // legitimate signal that the AI voice needed correcting, which usually means
  // the knowledge docs (CLAUDE.md-style) should be tightened.
  const suggestions: string[] = [];
  for (const b of bankLevels) {
    if (b.below_min) {
      suggestions.push(
        `Topic bank low for ${b.surface}/${b.product_focus} (${b.queued}/${b.min}) — add seed topics or raise the refill batch.`,
      );
    }
  }
  if (webhookTotal > 0 && successRate < 0.95) {
    suggestions.push(
      `Webhook delivery at ${Math.round(successRate * 100)}% over the last ${input.windowDays}d — check the Make.com endpoints.`,
    );
  }
  if (blog.total === 0) {
    suggestions.push(
      `No blog posts published in the last ${input.windowDays}d — check cadence and auto-publish settings.`,
    );
  }
  if (blogCreated >= 3 && overrideRate >= 0.5) {
    suggestions.push(
      `${Math.round(overrideRate * 100)}% of recent blog posts were human-authored rather than AI — possible voice drift; consider updating the content knowledge docs so the AI matches your edits.`,
    );
  }

  const refreshedPosts = input.refreshedPosts ?? 0;
  if (refreshedPosts === 0 && blog.total > 0) {
    suggestions.push(
      `No posts were refreshed in the last ${input.windowDays}d — verify the content-refresh cron is scheduled and auto_refresh_enabled is on.`,
    );
  }

  // US-879: turn the GSC opportunities into plain-language nudges.
  const opportunities = input.searchOpportunities ?? EMPTY_OPPORTUNITIES;
  if (opportunities.content_gaps.length > 0) {
    const top = opportunities.content_gaps[0];
    suggestions.push(
      `${opportunities.content_gaps.length} high-demand search ${
        opportunities.content_gaps.length === 1 ? "query has" : "queries have"
      } no dedicated post (e.g. "${top.query}" at ${top.impressions} impressions) — these are auto-queued as gsc_opportunity topics.`,
    );
  }
  if (opportunities.title_meta.length > 0) {
    const top = opportunities.title_meta[0];
    suggestions.push(
      `${opportunities.title_meta.length} page-1-ish ${
        opportunities.title_meta.length === 1 ? "query gets" : "queries get"
      } impressions but few clicks (e.g. "${top.query}" at ${
        Math.round(top.ctr * 100)
      }% CTR) — rewrite the title + meta description to win the click.`,
    );
  }
  if (opportunities.striking_pages.length > 0) {
    suggestions.push(
      `${opportunities.striking_pages.length} post(s) are in striking distance (ranking ~5-20 with rising impressions) — the freshness loop is prioritizing them for a refresh.`,
    );
  }

  return {
    window_days: input.windowDays,
    generated_at: input.generatedAt,
    published: { blog, social, total: blog.total + social.total },
    topics: {
      added: input.topicsAdded.length,
      used: input.topicsUsed.length,
      by_surface_product: bySp,
    },
    webhooks: {
      total: webhookTotal,
      succeeded: webhookOk,
      failed: webhookTotal - webhookOk,
      success_rate: successRate,
    },
    bank_levels: bankLevels,
    voice: {
      blog_posts_created: blogCreated,
      human_authored: humanAuthored,
      human_override_rate: overrideRate,
    },
    refreshes: {
      posts_refreshed: refreshedPosts,
    },
    opportunities,
    suggestions,
  };
}

// US-880: a structured, actionable recommendation. Unlike the free-text
// `suggestions` strings (which the digest renders verbatim), each recommendation
// carries an admin deep-link so the owner can act on it in one click. `code` is
// stable so the digest tests + email rendering can key off it without parsing
// prose. `action_path` is a RELATIVE app path; the email layer prefixes the
// configured site URL (keeping this module IO-free and unit-testable).
export interface DigestRecommendation {
  code: string;
  title: string;
  detail: string;
  action_label: string;
  action_path: string;
}

// Admin deep-link targets (mirror src/routes/index.tsx `/admin/content/*`).
const ADMIN = {
  settings: "/admin/content/settings",
  knowledge: "/admin/content/knowledge",
  topics: "/admin/content/topics",
  blog: "/admin/content/blog",
  analytics: "/admin/content/analytics",
} as const;

/**
 * US-880: turn a ContentSummary into concrete, linked tuning actions for the
 * weekly digest. Pure (no IO) so the rule set is unit-tested against fixtures.
 * Covers the four families the story calls out: cadence up/down vs. output &
 * quality, knowledge-doc edits on voice drift, underperforming surfaces, and
 * posts flagged for refresh — plus the GSC closed-loop opportunities (US-879).
 */
export function buildDigestRecommendations(
  summary: ContentSummary,
): DigestRecommendation[] {
  const recs: DigestRecommendation[] = [];
  const d = summary.window_days;

  // Voice drift → tighten the knowledge docs AND ease cadence so the engine
  // isn't out-running the owner's corrections. A high human-authored share of
  // recent posts means the AI voice is being overridden by hand.
  if (
    summary.voice.blog_posts_created >= 3 &&
    summary.voice.human_override_rate >= 0.5
  ) {
    recs.push({
      code: "voice_drift",
      title: "Tune the voice docs (and consider easing blog cadence)",
      detail:
        `${Math.round(summary.voice.human_override_rate * 100)}% of the ` +
        `${summary.voice.blog_posts_created} blog posts created in the last ${d}d ` +
        `were human-authored rather than AI — a voice-drift signal. Update the ` +
        `content knowledge docs so generations match your edits; if you're ` +
        `rewriting most drafts, lower the blog cadence until the voice settles.`,
      action_label: "Edit knowledge docs",
      action_path: ADMIN.knowledge,
    });
  }

  // No blog output over the window → cadence/auto-publish likely misconfigured
  // or paused. (When output IS healthy we deliberately do NOT auto-suggest
  // raising cadence — that's a judgement call we leave to the owner.)
  if (summary.published.blog.total === 0) {
    recs.push({
      code: "no_blog_output",
      title: "No blog posts published — check cadence & auto-publish",
      detail:
        `Nothing went live on the blog in the last ${d}d. Confirm the blog ` +
        `cadence is above zero, auto-publish is on, and publishing isn't paused.`,
      action_label: "Open content settings",
      action_path: ADMIN.settings,
    });
  }

  // Underperforming surface: blog is producing but social went silent. Either
  // the social cadence is off or its topic supply is starving.
  if (summary.published.social.total === 0 && summary.published.blog.total > 0) {
    recs.push({
      code: "social_underperforming",
      title: "Social published nothing while the blog did",
      detail:
        `${summary.published.blog.total} blog post(s) shipped but no social ` +
        `posts in the last ${d}d. Check the social cadence/auto-publish toggle ` +
        `and that the social topic bank has supply.`,
      action_label: "Open content settings",
      action_path: ADMIN.settings,
    });
  }

  // Topic supply starving a specific slice — it can't publish what it doesn't
  // have queued. Link straight to the bank to seed/research more.
  for (const b of summary.bank_levels) {
    if (b.below_min) {
      recs.push({
        code: `bank_low:${b.surface}:${b.product_focus}`,
        title: `Topic bank low: ${b.surface} / ${b.product_focus}`,
        detail:
          `${b.queued}/${b.min} topics queued for ${b.surface}/${b.product_focus}. ` +
          `Research or add seed topics, or raise the refill batch, so the ` +
          `scheduler doesn't stall this slice.`,
        action_label: "Open topic bank",
        action_path: ADMIN.topics,
      });
    }
  }

  // Publish-webhook reliability — syndication is silently dropping posts.
  if (summary.webhooks.total > 0 && summary.webhooks.success_rate < 0.95) {
    recs.push({
      code: "webhook_failures",
      title: "Publish-webhook delivery is degraded",
      detail:
        `Webhook delivery at ${Math.round(summary.webhooks.success_rate * 100)}% ` +
        `over the last ${d}d (${summary.webhooks.failed}/${summary.webhooks.total} ` +
        `failed). Inspect the delivery log and retry/repoint the Make.com endpoints.`,
      action_label: "Review webhook log",
      action_path: ADMIN.settings,
    });
  }

  // Posts flagged for refresh — striking-distance pages the freshness loop is
  // prioritizing (US-875/US-879). Surface them so the owner can also refresh by
  // hand if the loop is paused.
  if (summary.opportunities.striking_pages.length > 0) {
    const top = summary.opportunities.striking_pages
      .slice(0, 5)
      .map((p) => p.slug ?? p.page)
      .join(", ");
    recs.push({
      code: "refresh_candidates",
      title: `${summary.opportunities.striking_pages.length} post(s) flagged for refresh`,
      detail:
        `These rank ~5-20 with rising impressions and are prime refresh targets ` +
        `(e.g. ${top}). The freshness loop prioritizes them; refresh by hand if ` +
        `it's paused.`,
      action_label: "View content analytics",
      action_path: ADMIN.analytics,
    });
  }

  // Freshness loop appears inactive despite a live blog.
  if (summary.refreshes.posts_refreshed === 0 && summary.published.blog.total > 0) {
    recs.push({
      code: "refresh_inactive",
      title: "No posts refreshed — verify the freshness loop",
      detail:
        `Nothing was refreshed in the last ${d}d. Confirm the content-refresh ` +
        `cron is scheduled and auto_refresh_enabled is on.`,
      action_label: "Open content settings",
      action_path: ADMIN.settings,
    });
  }

  // GSC content gaps — high-demand queries with no dedicated post (auto-queued
  // as gsc_opportunity topics; surface them so the owner can prioritize).
  if (summary.opportunities.content_gaps.length > 0) {
    const top = summary.opportunities.content_gaps[0];
    recs.push({
      code: "content_gaps",
      title: `${summary.opportunities.content_gaps.length} search gap(s) with no post`,
      detail:
        `High-demand queries have no dedicated post (e.g. "${top.query}" at ` +
        `${top.impressions} impressions). These are auto-queued as ` +
        `gsc_opportunity topics — promote the best ones to drafts.`,
      action_label: "Open topic bank",
      action_path: ADMIN.topics,
    });
  }

  // GSC title/meta rewrites — page-1-ish queries leaking clicks.
  if (summary.opportunities.title_meta.length > 0) {
    const top = summary.opportunities.title_meta[0];
    recs.push({
      code: "title_meta",
      title: `${summary.opportunities.title_meta.length} page(s) leaking clicks`,
      detail:
        `Page-1-ish queries get impressions but few clicks (e.g. "${top.query}" ` +
        `at ${Math.round(top.ctr * 100)}% CTR). Rewrite the title + meta ` +
        `description to win the click.`,
      action_label: "Open blog posts",
      action_path: ADMIN.blog,
    });
  }

  return recs;
}
