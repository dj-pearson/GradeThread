// US-1609: Experiments Governor pure logic — per-engine adapters + the three
// portfolio detectors (interference, underpowered, stale) + the assembled memo.
import { assert, assertEquals } from "@std/assert";
import {
  assembleExperimentsMemo,
  detectInterference,
  flagStale,
  flagUnderpowered,
  normalizeDripVariants,
  normalizeNewsletterAb,
  normalizePromptRollout,
  type RegistryEntry,
} from "../lib/experiments-governor.ts";

const T0 = Date.parse("2026-07-01T00:00:00.000Z");
const DAY = 86400_000;

// ── Adapters ─────────────────────────────────────────────────────────────────

Deno.test("normalizeNewsletterAb: keeps only 'testing' issues; maps window + read", () => {
  const out = normalizeNewsletterAb([
    {
      id: "iss-1",
      ab_phase: "testing",
      ab_metric: "open",
      subject_variants: [{ id: "a" }, { id: "b" }],
      ab_test_started_at: new Date(T0).toISOString(),
      ab_measurement_hours: 48,
      ab_winner_variant: "a",
      variant_stats: { a: { sample: 300, rate: 0.42 }, b: { sample: 290, rate: 0.31 } },
    },
    { id: "iss-2", ab_phase: "completed", ab_metric: "open", subject_variants: [], ab_test_started_at: null, ab_measurement_hours: null, ab_winner_variant: null },
    { id: "iss-3", ab_phase: "none", ab_metric: "click", subject_variants: [], ab_test_started_at: null, ab_measurement_hours: null, ab_winner_variant: null },
  ]);
  assertEquals(out.length, 1); // only the testing issue
  const e = out[0];
  assertEquals(e.id, "newsletter:iss-1");
  assertEquals(e.engine, "newsletter-ab");
  assertEquals(e.metric, "open");
  assertEquals(e.sample_size, 590); // 300 + 290
  assertEquals(e.decision_ms, T0 + 48 * 3600_000); // start + measurement window
  assertEquals(e.current_read, "leader a");
});

Deno.test("normalizePromptRollout: keeps only live canaries (0<pct<100)", () => {
  const rows = [
    { version_name: "v-canary", stage: "composite", garment_scope: null, is_canary: true, rollout_percentage: 20, rollout_started_at: new Date(T0).toISOString() },
    { version_name: "v-full", stage: "composite", garment_scope: null, is_canary: true, rollout_percentage: 100, rollout_started_at: null }, // 100% = not a canary slice
    { version_name: "v-off", stage: "per_image", garment_scope: null, is_canary: false, rollout_percentage: 0, rollout_started_at: null },
  ];
  const out = normalizePromptRollout(rows);
  assertEquals(out.length, 1);
  assertEquals(out[0].id, "prompt:v-canary");
  assertEquals(out[0].surface, "grading:composite");
  assertEquals(out[0].audience, "traffic:grading:composite");
  assertEquals(out[0].current_read, "canary 20%");
});

Deno.test("normalizeDripVariants: groups by campaign; needs >=2 variants", () => {
  const rows = [
    { campaign: "trial_conversion", variant: "a", sends: 500, conversions: 60, started_at: new Date(T0).toISOString() },
    { campaign: "trial_conversion", variant: "b", sends: 480, conversions: 40, started_at: new Date(T0 + DAY).toISOString() },
    { campaign: "solo", variant: "only", sends: 100, conversions: 10, started_at: new Date(T0).toISOString() }, // single arm → dropped
  ];
  const out = normalizeDripVariants(rows);
  assertEquals(out.length, 1);
  const e = out[0];
  assertEquals(e.id, "drip:trial_conversion");
  assertEquals(e.variants.length, 2);
  assertEquals(e.sample_size, 980);
  assertEquals(e.start_ms, T0); // earliest of the two arms
  assertEquals(e.variants[0].read, 0.12); // 60/500
});

// ── Detectors ────────────────────────────────────────────────────────────────

const entry = (over: Partial<RegistryEntry>): RegistryEntry => ({
  id: "x", engine: "e", surface: "s", audience: "aud", metric: "open",
  variants: [], start_ms: T0, decision_ms: T0 + 3 * DAY, sample_size: 500, current_read: "inconclusive",
  ...over,
});

Deno.test("detectInterference: same audience + metric + overlapping windows → a pair", () => {
  const reg = [
    entry({ id: "n1", audience: "newsletter-subscribers", metric: "open", start_ms: T0, decision_ms: T0 + 3 * DAY }),
    entry({ id: "n2", audience: "newsletter-subscribers", metric: "open", start_ms: T0 + DAY, decision_ms: T0 + 5 * DAY }),
    // Different metric on the same audience → no interference.
    entry({ id: "n3", audience: "newsletter-subscribers", metric: "click", start_ms: T0, decision_ms: T0 + 3 * DAY }),
    // Same audience+metric but a disjoint (earlier, closed) window → no overlap.
    entry({ id: "n4", audience: "newsletter-subscribers", metric: "open", start_ms: T0 - 10 * DAY, decision_ms: T0 - 5 * DAY }),
  ];
  const pairs = detectInterference(reg);
  assertEquals(pairs.length, 1);
  assertEquals(pairs[0].a, "n1");
  assertEquals(pairs[0].b, "n2");
  assertEquals(pairs[0].metric, "open");
});

Deno.test("flagUnderpowered: a leader under the sample floor is suspect; a big sample is not", () => {
  const reg = [
    entry({ id: "small", sample_size: 40, current_read: "leader a" }),
    entry({ id: "big", sample_size: 5000, current_read: "leader b" }),
    entry({ id: "small-nolead", sample_size: 30, current_read: "inconclusive" }),
  ];
  const flagged = flagUnderpowered(reg);
  assertEquals(flagged.map((e) => e.id), ["small"]);
});

Deno.test("flagStale: past decision_ms + grace flags; open-ended never does", () => {
  const now = T0 + 10 * DAY;
  const reg = [
    entry({ id: "stale", decision_ms: T0 + 3 * DAY }), // 7d past + grace → stale
    entry({ id: "fresh", decision_ms: now + DAY }), // decision still ahead
    entry({ id: "open", decision_ms: null }), // no decision date → never stale
  ];
  const flagged = flagStale(reg, now);
  assertEquals(flagged.map((e) => e.id), ["stale"]);
});

// ── Memo ─────────────────────────────────────────────────────────────────────

Deno.test("assembleExperimentsMemo: quiet portfolio is all_clear", () => {
  const reg = [entry({ id: "solo", audience: "a", metric: "open", sample_size: 900, current_read: "leader a", decision_ms: T0 + 30 * DAY })];
  const memo = assembleExperimentsMemo(reg, T0 + DAY);
  assertEquals(memo.all_clear, true);
  assertEquals(memo.interference.length, 0);
  assertEquals(memo.underpowered.length, 0);
  assertEquals(memo.stale.length, 0);
  assert(memo.summary.includes("no interference"));
});

Deno.test("assembleExperimentsMemo: surfaces every issue class at once", () => {
  const now = T0 + 20 * DAY;
  const reg = [
    entry({ id: "i1", audience: "aud", metric: "open", start_ms: T0, decision_ms: T0 + 3 * DAY }),
    entry({ id: "i2", audience: "aud", metric: "open", start_ms: T0 + DAY, decision_ms: T0 + 4 * DAY }), // interferes with i1 + both stale
    entry({ id: "u1", audience: "other", metric: "click", sample_size: 20, current_read: "leader x", decision_ms: now + DAY }), // underpowered
  ];
  const memo = assembleExperimentsMemo(reg, now);
  assertEquals(memo.all_clear, false);
  assertEquals(memo.interference.length, 1);
  assertEquals(memo.underpowered.length, 1);
  assert(memo.stale.length >= 2);
});
