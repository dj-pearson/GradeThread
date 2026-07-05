// US-1596: Finance agent pure domain logic — reconciliation ranking, payout
// sanity, revenue delta, and the assembled memo. No env/DB (pure module).
import { assert, assertEquals } from "@std/assert";
import {
  assembleFinanceMemo,
  computeRevenueDelta,
  extractRevenueTotal,
  type PayoutRow,
  rankReconciliationFlags,
  type ReconFlag,
  summarizePayoutRuns,
} from "../lib/finance-agent.ts";

const NOW = Date.parse("2026-07-05T00:00:00.000Z");
const DAY = 86400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function flag(over: Partial<ReconFlag>): ReconFlag {
  return {
    subject_user_id: "u",
    kind: "plan_divergence",
    db_status: "active",
    expected_status: "active",
    db_plan: "pro",
    expected_plan: "starter",
    detected_at: ago(1),
    ...over,
  };
}

// ── Reconciliation ranking ───────────────────────────────────────────────────

Deno.test("rankReconciliationFlags: status divergence outranks plan divergence regardless of age", () => {
  const ranked = rankReconciliationFlags([
    flag({ subject_user_id: "plan_old", kind: "plan_divergence", detected_at: ago(30) }),
    flag({ subject_user_id: "status_new", kind: "status_divergence", detected_at: ago(1) }),
  ], NOW);
  assertEquals(ranked[0].subject_user_id, "status_new");
  assertEquals(ranked[1].subject_user_id, "plan_old");
});

Deno.test("rankReconciliationFlags: within a kind, older ranks first + carries evidence", () => {
  const ranked = rankReconciliationFlags([
    flag({ subject_user_id: "new", detected_at: ago(2) }),
    flag({ subject_user_id: "old", detected_at: ago(20) }),
  ], NOW);
  assertEquals(ranked[0].subject_user_id, "old");
  assertEquals(ranked[0].age_days, 20);
  assertEquals(ranked[0].evidence.expected_plan, "starter");
});

// ── Payout sanity ────────────────────────────────────────────────────────────

function payout(status: string, amount = 10): PayoutRow {
  return { status, amount, error: status === "failed" ? "transfer error" : null, created_at: ago(1) };
}

Deno.test("summarizePayoutRuns: any failed run → attention, with counts + failed amount", () => {
  const s = summarizePayoutRuns(
    [payout("paid"), payout("failed", 25)],
    [payout("paid")],
  );
  assertEquals(s.verdict, "attention");
  assertEquals(s.affiliate.failed, 1);
  assertEquals(s.affiliate.failed_amount, 25);
  assertEquals(s.consignor.failed, 0);
});

Deno.test("summarizePayoutRuns: all clean → ok", () => {
  const s = summarizePayoutRuns([payout("paid"), payout("processing")], []);
  assertEquals(s.verdict, "ok");
});

// ── Revenue delta ────────────────────────────────────────────────────────────

Deno.test("extractRevenueTotal: finds the headline across plausible key shapes", () => {
  assertEquals(extractRevenueTotal({ total_revenue: 500 }), 500);
  assertEquals(extractRevenueTotal({ totals: { revenue: 42 } }), 42);
  assertEquals(extractRevenueTotal({ nothing: 1 }), null);
});

Deno.test("computeRevenueDelta: flags an anomaly beyond the 25% band", () => {
  const up = computeRevenueDelta({ total_revenue: 200 }, { total_revenue: 100 });
  assertEquals(up.pct_change, 1);
  assertEquals(up.anomaly, true);
  const flat = computeRevenueDelta({ total_revenue: 105 }, { total_revenue: 100 });
  assertEquals(flat.anomaly, false);
  const unknown = computeRevenueDelta({ x: 1 }, { total_revenue: 100 });
  assertEquals(unknown.pct_change, null);
  assertEquals(unknown.anomaly, false);
});

// ── Assembled memo ───────────────────────────────────────────────────────────

Deno.test("assembleFinanceMemo: all-clear when nothing diverges", () => {
  const memo = assembleFinanceMemo({
    reconFlags: [],
    affiliatePayouts: [payout("paid")],
    consignorPayouts: [],
    revenueCurrent: { total_revenue: 100 },
    revenuePrior: { total_revenue: 95 },
    aiProfitability: { margin: 0.8 },
    nowMs: NOW,
  });
  assertEquals(memo.all_clear, true);
  assert(memo.summary.includes("healthy"));
});

Deno.test("assembleFinanceMemo: a seeded reconciliation delta appears ranked with evidence", () => {
  const memo = assembleFinanceMemo({
    reconFlags: [flag({ subject_user_id: "acct-9", kind: "status_divergence", expected_status: "canceled", detected_at: ago(3) })],
    affiliatePayouts: [payout("failed", 12)],
    consignorPayouts: [],
    revenueCurrent: { total_revenue: 60 },
    revenuePrior: { total_revenue: 100 }, // -40% → anomaly
    aiProfitability: {},
    nowMs: NOW,
  });
  assertEquals(memo.all_clear, false);
  assertEquals(memo.reconciliation.open, 1);
  assertEquals(memo.reconciliation.ranked[0].subject_user_id, "acct-9");
  assertEquals(memo.reconciliation.ranked[0].evidence.expected_status, "canceled");
  assertEquals(memo.payouts.verdict, "attention");
  assertEquals(memo.revenue.anomaly, true);
});
