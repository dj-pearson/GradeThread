// US-1601: Pricing agent pure domain logic — efficacy, ping-pong, rule churn,
// curve staleness, and the assembled memo. No env/DB (pure module).
import { assert, assertEquals } from "@std/assert";
import {
  type ActionRow,
  assemblePricingMemo,
  computeCurveStaleness,
  computeRepricingEfficacy,
  countReversals,
  detectPingPong,
  summarizeAutomationRules,
  type SuggestionRow,
} from "../lib/pricing-agent.ts";

const NOW = Date.parse("2026-07-05T00:00:00.000Z");
const DAY = 86400_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function sugg(over: Partial<SuggestionRow>): SuggestionRow {
  return {
    listing_id: "L", user_id: "u", reason_code: "UNDERPRICED", status: "applied",
    suggested_price_cents: 1000, applied_at: ago(DAY), created_at: ago(DAY), ...over,
  };
}

// ── Efficacy ─────────────────────────────────────────────────────────────────

Deno.test("computeRepricingEfficacy: apply-rate is applied / decided, by reason", () => {
  const e = computeRepricingEfficacy([
    sugg({ status: "applied", reason_code: "UNDERPRICED" }),
    sugg({ status: "dismissed", reason_code: "UNDERPRICED" }),
    sugg({ status: "applied", reason_code: "STALE" }),
    sugg({ status: "pending", reason_code: "OK" }),
  ]);
  assertEquals(e.total, 4);
  assertEquals(e.applied, 2);
  assertEquals(e.dismissed, 1);
  assertEquals(e.pending, 1);
  assertEquals(e.apply_rate, Number((2 / 3).toFixed(3)));
  assertEquals(e.by_reason.UNDERPRICED.applied, 1);
});

// ── Ping-pong ────────────────────────────────────────────────────────────────

Deno.test("countReversals: counts sign flips, ignoring flat steps", () => {
  assertEquals(countReversals([100, 120, 90, 130]), 2); // up, down, up
  assertEquals(countReversals([100, 110, 120, 130]), 0); // monotonic
  assertEquals(countReversals([100, 100, 120, 120, 90]), 1); // flats ignored
});

Deno.test("detectPingPong: flags an oscillating listing, orders by applied time", () => {
  const rows: SuggestionRow[] = [
    sugg({ listing_id: "L1", suggested_price_cents: 1000, applied_at: ago(4 * DAY) }),
    sugg({ listing_id: "L1", suggested_price_cents: 1300, applied_at: ago(1 * DAY) }),
    sugg({ listing_id: "L1", suggested_price_cents: 1200, applied_at: ago(3 * DAY) }),
    sugg({ listing_id: "L1", suggested_price_cents: 900, applied_at: ago(2 * DAY) }),
  ];
  const found = detectPingPong(rows);
  assertEquals(found.length, 1);
  assertEquals(found[0].listing_id, "L1");
  // Ordered 1000,1200,900,1300 → up,down,up = 2 reversals.
  assertEquals(found[0].reversals, 2);
  assertEquals(found[0].prices_cents, [1000, 1200, 900, 1300]);
});

Deno.test("detectPingPong: a monotonic sequence + a too-short one produce no findings", () => {
  const rows: SuggestionRow[] = [
    sugg({ listing_id: "mono", suggested_price_cents: 1000, applied_at: ago(4 * DAY) }),
    sugg({ listing_id: "mono", suggested_price_cents: 1100, applied_at: ago(3 * DAY) }),
    sugg({ listing_id: "mono", suggested_price_cents: 1200, applied_at: ago(2 * DAY) }),
    sugg({ listing_id: "mono", suggested_price_cents: 1300, applied_at: ago(1 * DAY) }),
    sugg({ listing_id: "short", suggested_price_cents: 1000, applied_at: ago(2 * DAY) }),
    sugg({ listing_id: "short", suggested_price_cents: 900, applied_at: ago(1 * DAY) }),
  ];
  assertEquals(detectPingPong(rows).length, 0);
});

Deno.test("detectPingPong: ignores non-applied suggestions", () => {
  const rows: SuggestionRow[] = [1000, 1200, 900, 1300].map((p, i) =>
    sugg({ listing_id: "L1", status: "pending", suggested_price_cents: p, applied_at: ago((4 - i) * DAY) })
  );
  assertEquals(detectPingPong(rows).length, 0);
});

// ── Rule churn ───────────────────────────────────────────────────────────────

Deno.test("summarizeAutomationRules: flags a rule re-acting on the same listing", () => {
  const actions: ActionRow[] = Array.from({ length: 4 }, () => ({
    rule_id: "R1", user_id: "u1", listing_id: "L1", action_type: "reprice", created_at: ago(DAY),
  }));
  const churn = summarizeAutomationRules(actions);
  assertEquals(churn.length, 1);
  assertEquals(churn[0].rule_id, "R1");
  assertEquals(churn[0].actions_per_listing, 4);
});

// ── Staleness ────────────────────────────────────────────────────────────────

Deno.test("computeCurveStaleness: counts curves past the threshold, reports the oldest", () => {
  const rep = computeCurveStaleness([
    { category_id: "fresh", refreshed_at: ago(1 * DAY) },
    { category_id: "stale", refreshed_at: ago(20 * DAY) },
  ], NOW);
  assertEquals(rep.total, 2);
  assertEquals(rep.stale, 1);
  assertEquals(rep.stale_samples[0].category_id, "stale");
  assertEquals(rep.oldest_age_days, 20);
});

// ── Memo ─────────────────────────────────────────────────────────────────────

Deno.test("assemblePricingMemo: all-clear with fresh curves + no pathology", () => {
  const memo = assemblePricingMemo({
    suggestions: [sugg({ status: "applied" }), sugg({ status: "dismissed" })],
    actions: [],
    curves: [{ category_id: "c", refreshed_at: ago(1 * DAY) }],
    nowMs: NOW,
  });
  assertEquals(memo.all_clear, true);
  assert(memo.summary.includes("apply-rate"));
});

Deno.test("assemblePricingMemo: ping-pong + stale curve break all-clear", () => {
  const ping: SuggestionRow[] = [1000, 1200, 900, 1300].map((p, i) =>
    sugg({ listing_id: "L1", suggested_price_cents: p, applied_at: ago((4 - i) * DAY) })
  );
  const memo = assemblePricingMemo({
    suggestions: ping,
    actions: [],
    curves: [{ category_id: "old", refreshed_at: ago(30 * DAY) }],
    nowMs: NOW,
  });
  assertEquals(memo.all_clear, false);
  assertEquals(memo.ping_pong.length, 1);
  assertEquals(memo.staleness.stale, 1);
});
