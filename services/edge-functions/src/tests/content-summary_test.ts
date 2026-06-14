// Unit tests for the pure content-summary aggregation (US-260). No Supabase /
// Deno.env — runs standalone:
//   deno test src/tests/content-summary_test.ts

import { assertEquals, assert } from "@std/assert";
import {
  buildContentSummary,
  buildDigestRecommendations,
  type SummaryInput,
} from "../lib/content-summary.ts";

const BASE: SummaryInput = {
  windowDays: 7,
  generatedAt: "2026-06-01T00:00:00.000Z",
  blogPublished: [],
  socialPublished: [],
  blogAuthored: [],
  topicsAdded: [],
  topicsUsed: [],
  bankLevels: [],
  webhookLog: [],
  minTopicsInBank: 3,
};

Deno.test("counts published posts per surface and product", () => {
  const s = buildContentSummary({
    ...BASE,
    blogPublished: [
      { product_focus: "gradethread" },
      { product_focus: "gradethread" },
      { product_focus: "flipdesk" },
    ],
    socialPublished: [{ product_focus: "both" }],
  });
  assertEquals(s.published.blog.gradethread, 2);
  assertEquals(s.published.blog.flipdesk, 1);
  assertEquals(s.published.blog.total, 3);
  assertEquals(s.published.social.both, 1);
  assertEquals(s.published.social.total, 1);
  assertEquals(s.published.total, 4);
});

Deno.test("topic flow is keyed by surface:product", () => {
  const s = buildContentSummary({
    ...BASE,
    topicsAdded: [
      { surface: "blog", product_focus: "gradethread" },
      { surface: "blog", product_focus: "gradethread" },
      { surface: "social", product_focus: "flipdesk" },
    ],
    topicsUsed: [{ surface: "blog", product_focus: "gradethread" }],
  });
  assertEquals(s.topics.added, 3);
  assertEquals(s.topics.used, 1);
  assertEquals(s.topics.by_surface_product["blog:gradethread"], {
    added: 2,
    used: 1,
  });
  assertEquals(s.topics.by_surface_product["social:flipdesk"].added, 1);
});

Deno.test("webhook success rate is 1.0 when there are no deliveries", () => {
  const s = buildContentSummary({ ...BASE });
  assertEquals(s.webhooks.total, 0);
  assertEquals(s.webhooks.success_rate, 1);
});

Deno.test("webhook success rate + failed count", () => {
  const s = buildContentSummary({
    ...BASE,
    webhookLog: [
      { succeeded: true },
      { succeeded: true },
      { succeeded: false },
      { succeeded: true },
    ],
  });
  assertEquals(s.webhooks.total, 4);
  assertEquals(s.webhooks.succeeded, 3);
  assertEquals(s.webhooks.failed, 1);
  assertEquals(s.webhooks.success_rate, 0.75);
});

Deno.test("bank below minimum is flagged and suggested", () => {
  const s = buildContentSummary({
    ...BASE,
    minTopicsInBank: 3,
    bankLevels: [
      { surface: "blog", product_focus: "gradethread", queued: 1 },
      { surface: "social", product_focus: "flipdesk", queued: 5 },
    ],
    // Add a published post so the "nothing published" suggestion doesn't fire.
    blogPublished: [{ product_focus: "gradethread" }],
  });
  const low = s.bank_levels.find((b) => b.surface === "blog")!;
  assert(low.below_min);
  const ok = s.bank_levels.find((b) => b.surface === "social")!;
  assert(!ok.below_min);
  assert(s.suggestions.some((x) => x.includes("Topic bank low for blog/gradethread")));
});

Deno.test("flags possible voice drift on high human-authored share", () => {
  const s = buildContentSummary({
    ...BASE,
    blogPublished: [{ product_focus: "gradethread" }],
    blogAuthored: [
      { generated_by: "human" },
      { generated_by: "human" },
      { generated_by: "ai" },
      { generated_by: "human" },
    ],
  });
  assertEquals(s.voice.blog_posts_created, 4);
  assertEquals(s.voice.human_authored, 3);
  assertEquals(s.voice.human_override_rate, 0.75);
  assert(s.suggestions.some((x) => x.includes("voice drift")));
});

Deno.test("clean week with content produces no suggestions", () => {
  const s = buildContentSummary({
    ...BASE,
    blogPublished: [{ product_focus: "gradethread" }],
    bankLevels: [{ surface: "blog", product_focus: "gradethread", queued: 10 }],
    webhookLog: [{ succeeded: true }],
    blogAuthored: [{ generated_by: "ai" }],
    refreshedPosts: 1,
  });
  assertEquals(s.suggestions, []);
});

Deno.test("US-875: counts refreshed posts and reports them", () => {
  const s = buildContentSummary({ ...BASE, refreshedPosts: 3 });
  assertEquals(s.refreshes.posts_refreshed, 3);
});

Deno.test("US-875: defaults refreshes to 0 when not provided", () => {
  const s = buildContentSummary({ ...BASE });
  assertEquals(s.refreshes.posts_refreshed, 0);
});

Deno.test("US-875: suggests checking the cron when posts published but none refreshed", () => {
  const s = buildContentSummary({
    ...BASE,
    blogPublished: [{ product_focus: "gradethread" }],
    bankLevels: [{ surface: "blog", product_focus: "gradethread", queued: 10 }],
    webhookLog: [{ succeeded: true }],
    blogAuthored: [{ generated_by: "ai" }],
    refreshedPosts: 0,
  });
  assert(s.suggestions.some((x) => x.includes("No posts were refreshed")));
});

// ── US-879: GSC opportunities ────────────────────────────────────

Deno.test("opportunities default to empty and add no suggestions when absent", () => {
  const s = buildContentSummary({ ...BASE });
  assertEquals(s.opportunities.striking_pages, []);
  assertEquals(s.opportunities.content_gaps, []);
  assertEquals(s.opportunities.title_meta, []);
});

Deno.test("opportunities are passed through and produce digest suggestions", () => {
  const s = buildContentSummary({
    ...BASE,
    searchOpportunities: {
      striking_pages: [
        { page: "/blog/wool-coat", slug: "wool-coat", position: 11, impressions: 200, clicks: 4 },
      ],
      content_gaps: [
        { query: "leather boot care", impressions: 500, position: 18 },
        { query: "consign denim", impressions: 300, position: 22 },
      ],
      title_meta: [
        { query: "thrift flipping", impressions: 1000, clicks: 5, ctr: 0.005, position: 6 },
      ],
    },
  });
  assertEquals(s.opportunities.content_gaps.length, 2);
  assertEquals(s.opportunities.striking_pages[0].slug, "wool-coat");
  // one suggestion per non-empty opportunity bucket
  assert(s.suggestions.some((x) => x.includes("no dedicated post")));
  assert(s.suggestions.some((x) => x.includes("rewrite the title")));
  assert(s.suggestions.some((x) => x.includes("striking distance")));
});

// ── US-880: structured digest recommendations ────────────────────

Deno.test("digest: a fully idle window recommends checking cadence", () => {
  const s = buildContentSummary({ ...BASE });
  const recs = buildDigestRecommendations(s);
  assert(recs.some((r) => r.code === "no_blog_output"));
  // every recommendation carries an admin deep-link
  assert(recs.every((r) => r.action_path.startsWith("/admin/content/")));
});

Deno.test("digest: a healthy week produces no recommendations", () => {
  const s = buildContentSummary({
    ...BASE,
    blogPublished: [{ product_focus: "gradethread" }],
    socialPublished: [{ product_focus: "gradethread" }],
    blogAuthored: [{ generated_by: "ai" }, { generated_by: "ai" }],
    bankLevels: [
      { surface: "blog", product_focus: "gradethread", queued: 10 },
    ],
    webhookLog: [{ succeeded: true }, { succeeded: true }],
    refreshedPosts: 2,
  });
  assertEquals(buildDigestRecommendations(s), []);
});

Deno.test("digest: high human-override share flags voice drift → knowledge docs", () => {
  const s = buildContentSummary({
    ...BASE,
    blogPublished: [{ product_focus: "gradethread" }],
    socialPublished: [{ product_focus: "gradethread" }],
    blogAuthored: [
      { generated_by: "human" },
      { generated_by: "human" },
      { generated_by: "ai" },
    ],
    bankLevels: [{ surface: "blog", product_focus: "gradethread", queued: 10 }],
    refreshedPosts: 1,
  });
  const drift = buildDigestRecommendations(s).find((r) => r.code === "voice_drift");
  assert(drift);
  assertEquals(drift.action_path, "/admin/content/knowledge");
});

Deno.test("digest: a below-min topic bank links to the topic bank", () => {
  const s = buildContentSummary({
    ...BASE,
    blogPublished: [{ product_focus: "gradethread" }],
    socialPublished: [{ product_focus: "gradethread" }],
    blogAuthored: [{ generated_by: "ai" }],
    bankLevels: [{ surface: "social", product_focus: "flipdesk", queued: 1 }],
    minTopicsInBank: 3,
    refreshedPosts: 1,
  });
  const low = buildDigestRecommendations(s).find(
    (r) => r.code === "bank_low:social:flipdesk",
  );
  assert(low);
  assertEquals(low.action_path, "/admin/content/topics");
});

Deno.test("digest: silent social surface is flagged when the blog publishes", () => {
  const s = buildContentSummary({
    ...BASE,
    blogPublished: [{ product_focus: "gradethread" }],
    blogAuthored: [{ generated_by: "ai" }],
    bankLevels: [{ surface: "blog", product_focus: "gradethread", queued: 10 }],
    refreshedPosts: 1,
  });
  assert(
    buildDigestRecommendations(s).some((r) => r.code === "social_underperforming"),
  );
});

Deno.test("digest: GSC opportunities become linked refresh/gap/title recommendations", () => {
  const s = buildContentSummary({
    ...BASE,
    blogPublished: [{ product_focus: "gradethread" }],
    socialPublished: [{ product_focus: "gradethread" }],
    blogAuthored: [{ generated_by: "ai" }],
    bankLevels: [{ surface: "blog", product_focus: "gradethread", queued: 10 }],
    refreshedPosts: 1,
    searchOpportunities: {
      striking_pages: [
        { page: "/blog/wool-coat", slug: "wool-coat", position: 11, impressions: 200, clicks: 4 },
      ],
      content_gaps: [{ query: "leather boot care", impressions: 500, position: 18 }],
      title_meta: [
        { query: "thrift flipping", impressions: 1000, clicks: 5, ctr: 0.005, position: 6 },
      ],
    },
  });
  const recs = buildDigestRecommendations(s);
  assertEquals(
    recs.find((r) => r.code === "refresh_candidates")?.action_path,
    "/admin/content/analytics",
  );
  assertEquals(
    recs.find((r) => r.code === "content_gaps")?.action_path,
    "/admin/content/topics",
  );
  assertEquals(
    recs.find((r) => r.code === "title_meta")?.action_path,
    "/admin/content/blog",
  );
});
