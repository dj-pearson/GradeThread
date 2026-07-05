// US-1608: autonomy promotion pure core — stats from proposal history,
// eligibility math (the exact ladder rule), hard-cap exclusion, and the
// rejection-spike demotion trigger. No env/DB (pure module).
import { assert, assertEquals } from "@std/assert";
import {
  computePromotionStats,
  MIN_APPROVED,
  type ProposalStatRow,
  promotionEligibility,
  shouldDemoteForRejections,
} from "../lib/autonomy-promotion.ts";

const NOW = Date.parse("2026-07-05T00:00:00.000Z");
const day = (d: number) => new Date(NOW - d * 86400_000).toISOString();

function rows(spec: Array<[string, number]>): ProposalStatRow[] {
  // spec: [status, count] for one (agent, class).
  const out: ProposalStatRow[] = [];
  for (const [status, n] of spec) {
    for (let i = 0; i < n; i++) out.push({ agent_id: "a1", action_class: "retry_job", status, decided_at: day(1) });
  }
  return out;
}

// ── Stats ────────────────────────────────────────────────────────────────────

Deno.test("computePromotionStats: approved-side states + rejected; ignores pending/expired", () => {
  const s = computePromotionStats(rows([["executed", 18], ["approved", 2], ["failed", 1], ["rejected", 2], ["pending", 5], ["expired", 3]]))[0];
  assertEquals(s.approved, 21); // executed + approved + failed
  assertEquals(s.rejected, 2);
  assertEquals(s.decided, 23);
  assertEquals(s.approval_rate, Number((21 / 23).toFixed(4)));
});

// ── Eligibility (the exact ladder rule) ──────────────────────────────────────

const goodStats = { agent_id: "a1", action_class: "retry_job", decided: 25, approved: 24, rejected: 1, approval_rate: 0.96, last_decision_ms: NOW };

Deno.test("promotionEligibility: L1 with ≥20 approved, ≥90%, eval passing, no breach → eligible", () => {
  const r = promotionEligibility({ stats: goodStats, currentLevel: 1, evalPassing: true, lastBreachMs: null, nowMs: NOW });
  assertEquals(r.eligible, true);
  assertEquals(r.targetLevel, 2);
  assertEquals(r.reasons, []);
});

Deno.test("promotionEligibility: each unmet condition blocks with a reason", () => {
  // Too few approved.
  assertEquals(promotionEligibility({ stats: { ...goodStats, approved: 10 }, currentLevel: 1, evalPassing: true, lastBreachMs: null, nowMs: NOW }).eligible, false);
  // Approval rate too low.
  assertEquals(promotionEligibility({ stats: { ...goodStats, approval_rate: 0.8 }, currentLevel: 1, evalPassing: true, lastBreachMs: null, nowMs: NOW }).eligible, false);
  // Eval not passing (conservative gate — the US-1607 dependency).
  assertEquals(promotionEligibility({ stats: goodStats, currentLevel: 1, evalPassing: false, lastBreachMs: null, nowMs: NOW }).eligible, false);
  // Breach within 14 days.
  assertEquals(promotionEligibility({ stats: goodStats, currentLevel: 1, evalPassing: true, lastBreachMs: NOW - 3 * 86400_000, nowMs: NOW }).eligible, false);
  // A breach 20 days ago no longer blocks.
  assertEquals(promotionEligibility({ stats: goodStats, currentLevel: 1, evalPassing: true, lastBreachMs: NOW - 20 * 86400_000, nowMs: NOW }).eligible, true);
  // Not at L1 (L0 must be operator-granted to L1 first).
  assertEquals(promotionEligibility({ stats: goodStats, currentLevel: 0, evalPassing: true, lastBreachMs: null, nowMs: NOW }).eligible, false);
});

Deno.test("promotionEligibility: a HARD-CAPPED class is never eligible (US-1597)", () => {
  // trust-safety account actions cap at L1 → target L2 > cap → excluded.
  const r = promotionEligibility({ stats: goodStats, currentLevel: 1, evalPassing: true, lastBreachMs: null, hardCap: 1, nowMs: NOW });
  assertEquals(r.eligible, false);
  assert(r.reasons.some((x) => x.includes("hard-capped")));
});

// ── Demotion trigger ─────────────────────────────────────────────────────────

Deno.test("shouldDemoteForRejections: over-half rejected with enough volume → demote", () => {
  assertEquals(shouldDemoteForRejections(["rejected", "rejected", "rejected", "rejected", "approved", "executed"]), true); // 4/6
  assertEquals(shouldDemoteForRejections(["rejected", "approved", "executed", "executed", "approved", "approved"]), false); // 1/6
  assertEquals(shouldDemoteForRejections(["rejected", "rejected"]), false); // too few decisions
  assertEquals(shouldDemoteForRejections(["rejected", "rejected", "rejected", "pending", "pending", "expired"]), false); // only 3 decided
});

Deno.test("computePromotionStats + eligibility: an exactly-threshold agent qualifies", () => {
  const stats = computePromotionStats(rows([["executed", MIN_APPROVED], ["rejected", 0]]))[0];
  assertEquals(stats.approved, MIN_APPROVED);
  assertEquals(stats.approval_rate, 1);
  assertEquals(promotionEligibility({ stats, currentLevel: 1, evalPassing: true, lastBreachMs: null, nowMs: NOW }).eligible, true);
});
