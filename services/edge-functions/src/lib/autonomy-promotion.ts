// US-1608 / AGENTIC-OS Phase 2 (Modules D+V): earned autonomy promotion.
//
// Promotion/demotion is PER (agent, action-class). L1→L2 is EARNED — the ladder
// rule (vault/70-agent/agentic-os-map.md §2, exactly these numbers): ≥20 approved, ≥90% approval
// rate, the agent's eval suite passing (Module V / US-1607), and NO policy breach
// in the last 14 days. Hard-capped classes (US-1597 Trust & Safety account
// actions) are NEVER offered. Demotion is immediate on a rejection spike or a
// policy/budget breach. This module is the PURE math; the pass does the I/O and
// files the operator meta-proposals.

// ── Ladder thresholds (do not loosen — §2 is exact) ──────────────────────────

export const MIN_APPROVED = 20;
export const MIN_APPROVAL_RATE = 0.9;
export const BREACH_LOOKBACK_MS = 14 * 24 * 3600_000;

// A rejection spike: at least this many recent decisions, over half rejected.
export const REJECTION_SPIKE_MIN_RECENT = 6;
export const REJECTION_SPIKE_RATE = 0.5;

// ── Stats from agent_proposals history ───────────────────────────────────────

export interface ProposalStatRow {
  agent_id: string;
  action_class: string;
  status: string; // pending | approved | rejected | expired | executed | failed
  decided_at: string | null;
}

export interface ActionClassStats {
  agent_id: string;
  action_class: string;
  decided: number; // operator acted (approved-side or rejected)
  approved: number; // approved + executed + failed (the operator said YES)
  rejected: number;
  approval_rate: number | null; // approved / (approved + rejected)
  last_decision_ms: number | null;
}

// An operator "approved" the proposal when it left pending toward execution —
// executed/failed are POST-approval terminal states, so all count as approved.
const APPROVED_STATES = new Set(["approved", "executed", "failed"]);

export function computePromotionStats(rows: readonly ProposalStatRow[]): ActionClassStats[] {
  const byKey = new Map<string, ActionClassStats>();
  for (const r of rows) {
    const isApproved = APPROVED_STATES.has(r.status);
    const isRejected = r.status === "rejected";
    if (!isApproved && !isRejected) continue; // pending/expired aren't decisions
    const k = `${r.agent_id} ${r.action_class}`;
    const s = byKey.get(k) ??
      { agent_id: r.agent_id, action_class: r.action_class, decided: 0, approved: 0, rejected: 0, approval_rate: null, last_decision_ms: null };
    s.decided++;
    if (isApproved) s.approved++;
    else s.rejected++;
    const dt = r.decided_at ? Date.parse(r.decided_at) : NaN;
    if (Number.isFinite(dt) && (s.last_decision_ms === null || dt > s.last_decision_ms)) s.last_decision_ms = dt;
    byKey.set(k, s);
  }
  for (const s of byKey.values()) {
    const denom = s.approved + s.rejected;
    s.approval_rate = denom > 0 ? Number((s.approved / denom).toFixed(4)) : null;
  }
  return [...byKey.values()];
}

// ── Eligibility (L1 → L2) ────────────────────────────────────────────────────

export interface EligibilityInput {
  stats: ActionClassStats;
  currentLevel: number; // 0..3, from resolveAutonomy
  evalPassing: boolean; // Module V gate — false/unknown ⇒ NOT eligible (conservative)
  lastBreachMs: number | null; // most recent policy/budget breach for this (agent, class)
  hardCap?: number; // AUTONOMY_HARD_CAPS[agentKey]?.[action_class]
  nowMs: number;
}

export interface EligibilityResult {
  eligible: boolean;
  targetLevel: number;
  reasons: string[]; // why NOT eligible (empty ⇒ eligible)
}

// Earned L1→L2 only (L2→L3 is a distinct "sustained L2" track, out of scope).
export function promotionEligibility(i: EligibilityInput): EligibilityResult {
  const targetLevel = i.currentLevel + 1;
  const reasons: string[] = [];

  if (i.currentLevel !== 1) reasons.push("only L1→L2 is earned here (must be operator-granted L1 first)");
  if (i.hardCap !== undefined && targetLevel > i.hardCap) reasons.push(`action class is hard-capped at L${i.hardCap}`);
  if (i.stats.approved < MIN_APPROVED) reasons.push(`only ${i.stats.approved}/${MIN_APPROVED} approved`);
  if (i.stats.approval_rate === null || i.stats.approval_rate < MIN_APPROVAL_RATE) {
    reasons.push(`approval rate ${i.stats.approval_rate === null ? "n/a" : Math.round(i.stats.approval_rate * 100) + "%"} < ${MIN_APPROVAL_RATE * 100}%`);
  }
  if (!i.evalPassing) reasons.push("eval suite not passing (Module V)");
  if (i.lastBreachMs !== null && i.nowMs - i.lastBreachMs < BREACH_LOOKBACK_MS) reasons.push("policy/budget breach within the last 14 days");

  return { eligible: reasons.length === 0, targetLevel, reasons };
}

// ── Demotion trigger (rejection spike) ───────────────────────────────────────

// A run of RECENT decisions (most-recent-first or any order) demotes when there
// are enough of them and over half were rejected. Policy/budget breaches demote
// via recordPolicyBreach directly; this is the additional statistical trigger.
export function shouldDemoteForRejections(recentStatuses: readonly string[]): boolean {
  const decided = recentStatuses.filter((s) => APPROVED_STATES.has(s) || s === "rejected");
  if (decided.length < REJECTION_SPIKE_MIN_RECENT) return false;
  const rejected = decided.filter((s) => s === "rejected").length;
  return rejected / decided.length >= REJECTION_SPIKE_RATE;
}
