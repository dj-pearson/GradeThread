// US-1705: hard guardrails on any applied ads change.
//
// Enforced in the apply path (US-1703) BEFORE the real mutate — a recommendation
// that breaches a guardrail is blocked with a clear reason even if it was
// approved, so an aggressive or glitchy recommendation can't blow the budget.
// Thresholds live in system_settings (tunable without a deploy). Pure check +
// config resolution are unit-tested.

import { getSetting } from "./system-settings.ts";

export const ADS_GUARDRAILS_SETTING_KEY = "ads_guardrails";

export interface Guardrails {
  /** Max |Δ| budget change per apply, as a percentage of the current budget. */
  maxBudgetChangePct: number;
  /** Absolute daily account-spend ceiling (dollars); 0 = disabled. */
  dailySpendCeiling: number;
  /** Max real applies allowed in one run/day; 0 = disabled. */
  maxAppliesPerRun: number;
}

export const DEFAULT_GUARDRAILS: Guardrails = {
  maxBudgetChangePct: 50,
  dailySpendCeiling: 0,
  maxAppliesPerRun: 10,
};

export async function getGuardrails(): Promise<Guardrails> {
  const g = await getSetting<Partial<Guardrails>>(ADS_GUARDRAILS_SETTING_KEY, {});
  return {
    maxBudgetChangePct: numOr(g.maxBudgetChangePct, DEFAULT_GUARDRAILS.maxBudgetChangePct),
    dailySpendCeiling: numOr(g.dailySpendCeiling, DEFAULT_GUARDRAILS.dailySpendCeiling),
    maxAppliesPerRun: numOr(g.maxAppliesPerRun, DEFAULT_GUARDRAILS.maxAppliesPerRun),
  };
}

function numOr(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface GuardrailContext {
  /** Account spend so far today (dollars). */
  todaySpend: number;
  /** Real applies already done in this run/day. */
  appliesThisRun: number;
}

export interface GuardrailCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether a change may be applied. `before`/`after` are the mutate's
 * captured values (e.g. { amountMicros }). Checks (in order): applies-per-run
 * cap, daily-spend ceiling, then the per-action budget-change cap.
 */
export function checkGuardrails(
  changeType: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  guardrails: Guardrails,
  ctx: GuardrailContext,
): GuardrailCheck {
  if (guardrails.maxAppliesPerRun > 0 && ctx.appliesThisRun >= guardrails.maxAppliesPerRun) {
    return { allowed: false, reason: `applies-per-run cap reached (${guardrails.maxAppliesPerRun}).` };
  }
  if (guardrails.dailySpendCeiling > 0 && ctx.todaySpend > guardrails.dailySpendCeiling) {
    return {
      allowed: false,
      reason: `daily spend $${ctx.todaySpend.toFixed(2)} is over the $${guardrails.dailySpendCeiling} ceiling — changes are frozen.`,
    };
  }
  if (changeType === "adjust_budget" || changeType === "reallocate_budget") {
    const beforeMicros = Number(before.amountMicros) || 0;
    const afterMicros = Number(after.amountMicros) || 0;
    if (beforeMicros > 0) {
      const pct = (Math.abs(afterMicros - beforeMicros) / beforeMicros) * 100;
      if (pct > guardrails.maxBudgetChangePct) {
        return {
          allowed: false,
          reason: `budget change of ${pct.toFixed(0)}% exceeds the ${guardrails.maxBudgetChangePct}% per-action cap.`,
        };
      }
    }
  }
  return { allowed: true };
}
