// US-1599: Marketing Portfolio pure logic — per-channel scoring, the three
// cross-channel detectors, focus ranking, and memo assembly.
import { assert, assertEquals } from "@std/assert";
import {
  assembleMarketingPortfolioMemo,
  type ChannelScore,
  type ChannelWeek,
  detectCannibalization,
  detectCollision,
  detectFatigue,
  rankFocus,
  scoreChannel,
  type TopicItem,
} from "../lib/marketing-portfolio.ts";

// ── Scoring ──────────────────────────────────────────────────────────────────

Deno.test("scoreChannel: relative engagement change → trend, ±10% band is flat", () => {
  assertEquals(scoreChannel({ channel: "newsletter", volume: 3, prior_volume: 3, engagement_rate: 0.5, prior_engagement_rate: 0.4, conversions: null }).trend, "up");
  assertEquals(scoreChannel({ channel: "newsletter", volume: 3, prior_volume: 3, engagement_rate: 0.3, prior_engagement_rate: 0.4, conversions: null }).trend, "down");
  assertEquals(scoreChannel({ channel: "drip", volume: 3, prior_volume: 3, engagement_rate: 0.41, prior_engagement_rate: 0.4, conversions: 1 }).trend, "flat");
  assertEquals(scoreChannel({ channel: "content", volume: 3, prior_volume: 0, engagement_rate: null, prior_engagement_rate: null, conversions: null }).trend, "unknown");
});

// ── Cannibalization ──────────────────────────────────────────────────────────

Deno.test("detectCannibalization: blog + newsletter sharing keywords flags", () => {
  const topics: TopicItem[] = [
    { channel: "content", label: "How to price sneakers", keywords: ["pricing", "sneakers", "comps"] },
    { channel: "newsletter", label: "Pricing your kicks with comps", keywords: ["pricing", "comps", "sneakers"] },
    { channel: "newsletter", label: "Photography basics", keywords: ["photography", "lighting"] }, // unrelated
  ];
  const signals = detectCannibalization(topics);
  assertEquals(signals.length, 1);
  assertEquals(signals[0].type, "topic_cannibalization");
  assert((signals[0].evidence.shared as string[]).includes("pricing"));
});

Deno.test("detectCannibalization: two blog topics don't collide with each other", () => {
  // Cannibalization is cross-CHANNEL only (blog vs newsletter), never within one.
  const topics: TopicItem[] = [
    { channel: "content", label: "A", keywords: ["pricing", "comps"] },
    { channel: "content", label: "B", keywords: ["pricing", "comps"] },
  ];
  assertEquals(detectCollision([]).length, 0);
  assertEquals(detectCannibalization(topics).length, 0);
});

// ── Collision ────────────────────────────────────────────────────────────────

Deno.test("detectCollision: ≥2 broadcast channels on the same day flags", () => {
  const signals = detectCollision([
    { date: "2026-07-01", channels: ["newsletter"] },
    { date: "2026-07-02", channels: ["newsletter", "drip"] }, // collision
    { date: "2026-07-03", channels: ["drip", "drip"] }, // dedups to one → no collision
  ]);
  assertEquals(signals.length, 1);
  assertEquals(signals[0].evidence.date, "2026-07-02");
});

// ── Fatigue ──────────────────────────────────────────────────────────────────

Deno.test("detectFatigue: peak sends over the cap flags", () => {
  const channels: ChannelScore[] = [];
  const signals = detectFatigue({ cap_per_day: 1, max_observed_per_day: 3, deferred_or_dropped: 12 }, channels);
  assertEquals(signals.length, 1);
  assertEquals(signals[0].type, "audience_fatigue");
});

Deno.test("detectFatigue: both audience channels declining flags even under the cap", () => {
  const channels: ChannelScore[] = [
    { channel: "newsletter", volume: 3, engagement_rate: 0.2, conversions: null, trend: "down", note: "" },
    { channel: "drip", volume: 40, engagement_rate: 0.1, conversions: 2, trend: "down", note: "" },
  ];
  const signals = detectFatigue({ cap_per_day: 5, max_observed_per_day: 1, deferred_or_dropped: 0 }, channels);
  assertEquals(signals.length, 1);
  assertEquals(signals[0].type, "audience_fatigue");
});

Deno.test("detectFatigue: one channel down (the other up) does NOT flag fatigue", () => {
  const channels: ChannelScore[] = [
    { channel: "newsletter", volume: 3, engagement_rate: 0.2, conversions: null, trend: "down", note: "" },
    { channel: "drip", volume: 40, engagement_rate: 0.3, conversions: 2, trend: "up", note: "" },
  ];
  assertEquals(detectFatigue({ cap_per_day: 5, max_observed_per_day: 1, deferred_or_dropped: 0 }, channels).length, 0);
});

// ── Focus + memo ─────────────────────────────────────────────────────────────

Deno.test("rankFocus: signals rank ahead of a down-trending channel", () => {
  const channels: ChannelScore[] = [
    { channel: "content", volume: 1, engagement_rate: 0.1, conversions: null, trend: "down", note: "content dip" },
  ];
  const focus = rankFocus(channels, [{ type: "channel_collision", detail: "x", evidence: {} }]);
  assertEquals(focus[0].focus, "channel_collision");
  assertEquals(focus[1].focus, "revive content");
  assertEquals(focus.map((f) => f.rank), [1, 2]);
});

Deno.test("assembleMarketingPortfolioMemo: clean week is all_clear", () => {
  const weeks: ChannelWeek[] = [
    { channel: "newsletter", volume: 2, prior_volume: 2, engagement_rate: 0.4, prior_engagement_rate: 0.4, conversions: null },
    { channel: "drip", volume: 30, prior_volume: 30, engagement_rate: 0.2, prior_engagement_rate: 0.2, conversions: 6 },
  ];
  const memo = assembleMarketingPortfolioMemo(weeks, [], [], { cap_per_day: 2, max_observed_per_day: 1, deferred_or_dropped: 0 });
  assertEquals(memo.all_clear, true);
  assertEquals(memo.scorecard.length, 2);
  assert(memo.summary.includes("no cross-channel"));
});

Deno.test("assembleMarketingPortfolioMemo: collects every signal type", () => {
  const weeks: ChannelWeek[] = [
    { channel: "newsletter", volume: 3, prior_volume: 2, engagement_rate: 0.2, prior_engagement_rate: 0.4, conversions: null },
    { channel: "drip", volume: 50, prior_volume: 30, engagement_rate: 0.1, prior_engagement_rate: 0.2, conversions: 3 },
  ];
  const topics: TopicItem[] = [
    { channel: "content", label: "Pricing comps", keywords: ["pricing", "comps"] },
    { channel: "newsletter", label: "Comps and pricing", keywords: ["pricing", "comps"] },
  ];
  const sendDays = [{ date: "2026-07-02", channels: ["newsletter" as const, "drip" as const] }];
  const memo = assembleMarketingPortfolioMemo(weeks, topics, sendDays, { cap_per_day: 1, max_observed_per_day: 4, deferred_or_dropped: 9 });
  const types = new Set(memo.signals.map((s) => s.type));
  assert(types.has("audience_fatigue"));
  assert(types.has("topic_cannibalization"));
  assert(types.has("channel_collision"));
  assertEquals(memo.all_clear, false);
});
