// US-565 — post-publish performance suggestion logic. performance-signals.ts is
// pure (no DB/network), imported directly.
import { assert, assertEquals } from "@std/assert";
import {
  engagementSuggestsMarkdown,
  evaluatePerformance,
  type PerformanceMetrics,
} from "../lib/performance-signals.ts";
import { computeSuggestion } from "../lib/repricing.ts";

// A healthy baseline; tests override only the fields they exercise.
function metrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    impressions: 500,
    views: 50,
    watchers: 1,
    clickThroughRate: 0.05,
    listingAgeDays: 5,
    hasBestOffer: false,
    ...overrides,
  };
}

// ── evaluatePerformance ─────────────────────────────────────────────

Deno.test("healthy engagement yields no suggestion", () => {
  const s = evaluatePerformance(metrics());
  assertEquals(s.code, "HEALTHY");
  assert(!s.suggestsPriceDrop);
});

Deno.test("low CTR despite real exposure → fix title/photo", () => {
  const s = evaluatePerformance(
    metrics({ impressions: 1000, clickThroughRate: 0.005 }),
  );
  assertEquals(s.code, "LOW_CTR");
  assert(s.suggestsContentFix);
  assert(!s.suggestsPriceDrop);
});

Deno.test("low CTR ignored without enough impressions", () => {
  // Same poor CTR but only 30 impressions — not enough exposure to judge.
  const s = evaluatePerformance(
    metrics({ impressions: 30, clickThroughRate: 0.005, listingAgeDays: 3 }),
  );
  assertEquals(s.code, "HEALTHY");
});

Deno.test("high watchers, no sale → drop price / enable Best Offer", () => {
  const s = evaluatePerformance(
    metrics({ watchers: 6, listingAgeDays: 10 }),
  );
  assertEquals(s.code, "WATCHED_NO_SALE");
  assert(s.suggestsPriceDrop);
  assert(s.suggestsBestOffer); // hasBestOffer:false → offer the toggle
});

Deno.test("watched-no-sale drops the Best Offer nudge when already enabled", () => {
  const s = evaluatePerformance(
    metrics({ watchers: 6, listingAgeDays: 10, hasBestOffer: true }),
  );
  assertEquals(s.code, "WATCHED_NO_SALE");
  assert(s.suggestsPriceDrop);
  assert(!s.suggestsBestOffer);
});

Deno.test("no traffic after the age gate → promote/refresh", () => {
  const s = evaluatePerformance(
    metrics({ impressions: 5, views: 0, watchers: 0, clickThroughRate: null, listingAgeDays: 21 }),
  );
  assertEquals(s.code, "NO_TRAFFIC");
  assert(s.suggestsContentFix);
});

// ── engagementSuggestsMarkdown (the repricing signal) ───────────────

Deno.test("engagement markdown fires only for watched-but-unsold", () => {
  assert(engagementSuggestsMarkdown(metrics({ watchers: 5, listingAgeDays: 9 })));
  assert(!engagementSuggestsMarkdown(metrics({ impressions: 1000, clickThroughRate: 0.004 })));
  assert(!engagementSuggestsMarkdown(metrics()));
});

// ── repricing engine consumes the signal (US-565 AC #3) ─────────────

Deno.test("repricing fires a STALE drop for a young watched-but-unsold listing", () => {
  const stats = { count: 8, min: 18, p25: 20, median: 24, p75: 28, max: 34 };
  // Priced in line with comps so neither UNDER/OVER fires; only 8 days old so
  // the age-stale gate (30d) does NOT apply — the engagement signal must.
  const s = computeSuggestion({
    currentPriceCents: 2400,
    gradeValue: 6.5,
    stats,
    listingAgeDays: 8,
    watchers: 5,
    views: 40,
    impressions: 600,
    clickThroughRate: 0.04,
  });
  assertEquals(s.reasonCode, "STALE");
  assert(s.suggestedPriceCents < 2400);
  assert(s.message.includes("watchers"));
});

Deno.test("no engagement signal → young in-line listing stays OK", () => {
  const stats = { count: 8, min: 18, p25: 20, median: 24, p75: 28, max: 34 };
  const s = computeSuggestion({
    currentPriceCents: 2400,
    gradeValue: 6.5,
    stats,
    listingAgeDays: 8,
    watchers: 0,
    views: 40,
  });
  assertEquals(s.reasonCode, "OK");
});
