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
