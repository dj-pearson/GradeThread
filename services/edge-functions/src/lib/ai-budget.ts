// US-895: AI cost budget guardrails — evaluation + auto-throttle core.
//
// The DB does the spend math (ai_budget_status RPC, migration 00219, re-prices
// ai_usage_events from system_settings.ai_model_prices). This module decides what
// to DO about a breach and runs it: for action='kill' it flips the matching
// feature kill-switch off via the existing mechanism, records an ai_budget_breaches
// row, emits an ops alert, and writes a system audit entry — exactly once per
// breach (an OPEN breach suppresses re-action so a frequent cron can't re-alert or
// re-kill every tick).
//
// The decision logic is pure + dependency-injected so the "simulated over-budget
// feature gets killed and the event is audited" path (AC5) is unit-testable
// without a DB (see tests/ai-budget_test.ts). The real wiring lives in the cron
// route (routes/jobs-ai-budget.ts).

export type BudgetPeriod = "day" | "month";
export type BudgetAction = "alert" | "throttle" | "kill";

// One budget + its current period spend, as returned by ai_budget_status().
export interface BudgetStatus {
  id: string;
  feature: string;
  period: BudgetPeriod;
  limitUsd: number;
  action: BudgetAction;
  enabled: boolean;
  spendUsd: number;
  breached: boolean;
  pct: number;
  updatedAt: string;
}

// Map an ai_usage_events.feature to the feature_flags.key that gates it. Most are
// 1:1; only the exceptions are listed. A feature with no matching flag can't be
// auto-killed — the guardrail still alerts + records the breach (killed=false).
export const FEATURE_FLAG_MAP: Record<string, string> = {
  grading: "grading",
  autolister: "autolister",
  content: "content_ai",
  // US-2845. The mapping is 1:1, so this entry changes nothing at runtime and
  // is here to be READ: it is the line that says a comp_read budget breach
  // turns the comp_read worker off, which is otherwise only true by the
  // fallthrough in resolveFlagKey and easy to break by renaming one side.
  comp_read: "comp_read",
};

export function resolveFlagKey(feature: string): string {
  return FEATURE_FLAG_MAP[feature] ?? feature;
}

export interface PlannedAction {
  status: BudgetStatus;
  /** action === 'kill' — the guardrail should flip a feature flag off. */
  kill: boolean;
  /** The feature_flags.key to flip when kill; null otherwise. */
  flagKey: string | null;
}

/**
 * Decide which budgets to act on this run. Acts only on budgets that are enabled,
 * breached, and do NOT already have an open breach recorded — so a per-minute
 * cron records a breach + alerts ONCE and stays quiet until the operator
 * re-enables (which resolves the open breach). Pure — no I/O.
 */
export function decideBudgetActions(
  statuses: BudgetStatus[],
  openBreachBudgetIds: Set<string>,
): PlannedAction[] {
  const out: PlannedAction[] = [];
  for (const s of statuses) {
    if (!s.enabled || !s.breached) continue;
    if (openBreachBudgetIds.has(s.id)) continue;
    const kill = s.action === "kill";
    out.push({ status: s, kill, flagKey: kill ? resolveFlagKey(s.feature) : null });
  }
  return out;
}

// The breach record assembled per acted-on budget. Persisted to
// ai_budget_breaches AND passed to the audit writer.
export interface RecordedBreach {
  budgetId: string;
  feature: string;
  period: BudgetPeriod;
  action: BudgetAction;
  limitUsd: number;
  spendUsd: number;
  /** Whether a feature_flag was actually flipped off. */
  killed: boolean;
  /** Which feature_flags.key was targeted (null when action != kill). */
  flagKey: string | null;
  /** Whether an ops alert reached at least one channel. */
  alerted: boolean;
}

// Injected side-effects — the real impls (DB / flags / email / webhook / audit)
// live in routes/jobs-ai-budget.ts; tests pass spies.
export interface BudgetGuardrailDeps {
  loadStatuses: () => Promise<BudgetStatus[]>;
  loadOpenBreachBudgetIds: () => Promise<Set<string>>;
  /** Flip a feature flag off; returns true only if a row was actually flipped. */
  killFlag: (flagKey: string) => Promise<boolean>;
  /** Emit an ops alert; returns true if delivered to ≥1 channel. */
  alert: (b: RecordedBreach) => Promise<boolean>;
  insertBreach: (b: RecordedBreach) => Promise<void>;
  audit: (b: RecordedBreach) => Promise<void>;
  /** Optional error sink (defaults to console.error). */
  onError?: (where: string, err: unknown) => void;
}

export interface BudgetGuardrailResult {
  evaluated: number;
  acted: number;
  killed: number;
  alerted: number;
  breaches: RecordedBreach[];
}

/**
 * Evaluate every budget and act on fresh breaches. Order per breach: kill the
 * flag (so the bleed stops first), alert, persist the breach, audit. Each step
 * is best-effort — a failing alert/audit never blocks the kill — but a failed
 * persist is logged (the breach won't be suppressed next run, which is the safe
 * direction: it retries rather than silently dropping).
 */
export async function runBudgetGuardrails(
  deps: BudgetGuardrailDeps,
): Promise<BudgetGuardrailResult> {
  const onError = deps.onError ?? ((where, err) => {
    console.error(`[ai-budget] ${where}:`, err instanceof Error ? err.message : String(err));
  });

  const statuses = await deps.loadStatuses();
  const open = await deps.loadOpenBreachBudgetIds();
  const planned = decideBudgetActions(statuses, open);

  const breaches: RecordedBreach[] = [];
  let killed = 0;
  let alerted = 0;

  for (const p of planned) {
    let didKill = false;
    if (p.kill && p.flagKey) {
      try {
        didKill = await deps.killFlag(p.flagKey);
      } catch (err) {
        onError(`kill ${p.flagKey}`, err);
      }
    }
    if (didKill) killed++;

    const rec: RecordedBreach = {
      budgetId: p.status.id,
      feature: p.status.feature,
      period: p.status.period,
      action: p.status.action,
      limitUsd: p.status.limitUsd,
      spendUsd: p.status.spendUsd,
      killed: didKill,
      flagKey: p.kill ? p.flagKey : null,
      alerted: false,
    };

    try {
      rec.alerted = await deps.alert(rec);
    } catch (err) {
      onError(`alert ${p.status.feature}`, err);
    }
    if (rec.alerted) alerted++;

    try {
      await deps.insertBreach(rec);
    } catch (err) {
      onError(`insertBreach ${p.status.feature}`, err);
    }
    try {
      await deps.audit(rec);
    } catch (err) {
      onError(`audit ${p.status.feature}`, err);
    }

    breaches.push(rec);
  }

  return {
    evaluated: statuses.length,
    acted: planned.length,
    killed,
    alerted,
    breaches,
  };
}
