// US-1596 / AGENTIC-OS Phase 1 (Module F): the Finance agent's domain logic —
// billing-reconciliation deltas, payout-run sanity, revenue-vs-baseline, and AI
// spend vs revenue. READ-HEAVY by design: at L0/L1 this agent narrates and files
// admin tasks; it NEVER moves money or credits (AGENTIC_OS.md §3.F, §5).
//
// The deterministic, fixture-tested core lives here (reconciliation ranking +
// payout sanity + all-clear); the revenue/AI-profitability docs are passed
// through for the agent to narrate a plain-language hypothesis against.

// ── Reconciliation deltas (billing_reconciliation_flags) ─────────────────────

export interface ReconFlag {
  subject_user_id: string;
  kind: string; // status_divergence | plan_divergence
  db_status: string | null;
  expected_status: string | null;
  db_plan: string | null;
  expected_plan: string | null;
  detected_at: string;
}

export interface RankedReconFlag {
  subject_user_id: string;
  kind: string;
  age_days: number;
  materiality: number;
  // Redacted evidence: the account id + the two sides of the divergence. No PII
  // beyond the operator-scoped subject id (this is operator billing data).
  evidence: {
    db_status: string | null;
    expected_status: string | null;
    db_plan: string | null;
    expected_plan: string | null;
    detected_at: string;
  };
}

const DAY_MS = 24 * 3600_000;

// A status divergence (a subscription believed active/inactive incorrectly) is
// more material than a plan divergence (right tier is cosmetic vs right access).
function kindWeight(kind: string): number {
  return kind === "status_divergence" ? 2 : 1;
}

// Rank open reconciliation flags by materiality = kind weight, then age (an
// unresolved divergence that has sat longer is more urgent). Pure.
export function rankReconciliationFlags(
  flags: readonly ReconFlag[],
  nowMs: number,
): RankedReconFlag[] {
  return flags
    .map((f) => {
      const ageDays = Math.max(0, Math.floor((nowMs - Date.parse(f.detected_at)) / DAY_MS));
      // Weight dominates; age (capped at 60d) breaks ties within a kind.
      const materiality = kindWeight(f.kind) * 100 + Math.min(ageDays, 60);
      return {
        subject_user_id: f.subject_user_id,
        kind: f.kind,
        age_days: ageDays,
        materiality,
        evidence: {
          db_status: f.db_status,
          expected_status: f.expected_status,
          db_plan: f.db_plan,
          expected_plan: f.expected_plan,
          detected_at: f.detected_at,
        },
      };
    })
    .sort((a, b) => b.materiality - a.materiality);
}

// ── Payout-run sanity (affiliate_payouts + consignor_payouts) ────────────────

export interface PayoutRow {
  status: string; // pending | processing | paid | failed | canceled
  amount: number;
  error: string | null;
  created_at: string;
}

export interface PayoutSummary {
  total: number;
  by_status: Record<string, number>;
  failed: number;
  failed_amount: number;
}

export interface PayoutSanity {
  affiliate: PayoutSummary;
  consignor: PayoutSummary;
  verdict: "ok" | "attention"; // any failed run → attention
}

function summarizeOnePayoutSet(rows: readonly PayoutRow[]): PayoutSummary {
  const byStatus: Record<string, number> = {};
  let failed = 0, failedAmount = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.status === "failed") {
      failed++;
      failedAmount += Number.isFinite(r.amount) ? r.amount : 0;
    }
  }
  return { total: rows.length, by_status: byStatus, failed, failed_amount: Number(failedAmount.toFixed(2)) };
}

export function summarizePayoutRuns(
  affiliate: readonly PayoutRow[],
  consignor: readonly PayoutRow[],
): PayoutSanity {
  const a = summarizeOnePayoutSet(affiliate);
  const c = summarizeOnePayoutSet(consignor);
  return { affiliate: a, consignor: c, verdict: a.failed + c.failed > 0 ? "attention" : "ok" };
}

// ── Revenue baseline (best-effort delta over the opaque dashboard doc) ────────

// The revenue_dashboard RPC returns an aggregate doc; pull a headline total
// defensively across the plausible keys so we can compute a current-vs-prior
// delta. Returns null when no numeric total is found (the agent then narrates
// straight from the passed-through docs).
export function extractRevenueTotal(doc: unknown): number | null {
  if (!doc || typeof doc !== "object") return null;
  const o = doc as Record<string, unknown>;
  for (const key of ["total_revenue", "totalRevenue", "gross_revenue", "grossRevenue", "revenue", "total"]) {
    const v = o[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  // A nested {totals:{revenue}} shape.
  const totals = o.totals;
  if (totals && typeof totals === "object") {
    const t = totals as Record<string, unknown>;
    for (const key of ["revenue", "total", "gross"]) {
      const v = t[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
  }
  return null;
}

export interface RevenueDelta {
  current: number | null;
  prior: number | null;
  pct_change: number | null; // null when either side is unknown or prior is 0
  anomaly: boolean; // |pct_change| beyond the band
}

const REVENUE_ANOMALY_BAND = 0.25; // 25% swing vs the trailing window is notable

export function computeRevenueDelta(currentDoc: unknown, priorDoc: unknown): RevenueDelta {
  const current = extractRevenueTotal(currentDoc);
  const prior = extractRevenueTotal(priorDoc);
  if (current === null || prior === null || prior === 0) {
    return { current, prior, pct_change: null, anomaly: false };
  }
  const pct = (current - prior) / prior;
  return { current, prior, pct_change: Number(pct.toFixed(4)), anomaly: Math.abs(pct) >= REVENUE_ANOMALY_BAND };
}

// ── The assembled memo ───────────────────────────────────────────────────────

export interface FinanceTelemetry {
  reconFlags: readonly ReconFlag[];
  affiliatePayouts: readonly PayoutRow[];
  consignorPayouts: readonly PayoutRow[];
  revenueCurrent: unknown; // revenue_dashboard doc, current window
  revenuePrior: unknown; // revenue_dashboard doc, trailing window
  aiProfitability: unknown; // ai_profitability RPC doc (US-1065 / AC4 reuse)
  nowMs: number;
}

export interface FinanceMemo {
  summary: string;
  reconciliation: { open: number; ranked: RankedReconFlag[] };
  payouts: PayoutSanity;
  revenue: RevenueDelta;
  ai_profitability: unknown;
  all_clear: boolean;
}

// How many ranked reconciliation deltas to surface as evidence (top by materiality).
const RECON_EVIDENCE_LIMIT = 20;

export function assembleFinanceMemo(t: FinanceTelemetry): FinanceMemo {
  const ranked = rankReconciliationFlags(t.reconFlags, t.nowMs);
  const payouts = summarizePayoutRuns(t.affiliatePayouts, t.consignorPayouts);
  const revenue = computeRevenueDelta(t.revenueCurrent, t.revenuePrior);

  const allClear = ranked.length === 0 && payouts.verdict === "ok" && !revenue.anomaly;

  const parts: string[] = [];
  if (allClear) {
    parts.push("Finance healthy: no open reconciliation divergences, no failed payouts, revenue within its trailing band.");
  } else {
    if (ranked.length) parts.push(`${ranked.length} open reconciliation divergence(s)`);
    if (payouts.verdict === "attention") {
      parts.push(`${payouts.affiliate.failed + payouts.consignor.failed} failed payout run(s)`);
    }
    if (revenue.anomaly && revenue.pct_change !== null) {
      parts.push(`revenue ${revenue.pct_change >= 0 ? "up" : "down"} ${Math.abs(Math.round(revenue.pct_change * 100))}% vs trailing`);
    }
  }

  return {
    summary: parts.join("; ") + ".",
    reconciliation: { open: ranked.length, ranked: ranked.slice(0, RECON_EVIDENCE_LIMIT) },
    payouts,
    revenue,
    ai_profitability: t.aiProfitability ?? null,
    all_clear: allClear,
  };
}
