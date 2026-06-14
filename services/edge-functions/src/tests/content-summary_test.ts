// Unit tests for the pure content-summary aggregation (US-260). No Supabase /
// Deno.env — runs standalone:
//   deno test src/tests/content-summary_test.ts

import { assertEquals, assert } from "@std/assert";
import { buildContentSummary, type SummaryInput } from "../lib/content-summary.ts";

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
