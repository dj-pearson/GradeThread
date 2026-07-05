// US-1591 / AGENTIC-OS Phase 0 (Module B): the budget governor.
//
// Each agent is leashed to a daily dollar cap (plus a fleet-wide cap), enforced
// on the EXISTING ai-budget rails — no parallel metering (AGENTIC_OS.md §3.B):
//   • METERING: agent runs tag the AI-feature context `agent:<key>` (kernel via
//     enterAiFeature), so every model call auto-records to the ai_usage_events
//     ledger under that feature — /admin/ai-spend?groupBy=feature shows one line
//     per agent + the fleet rolls up over the `agent:%` features.
//   • ENFORCEMENT: today's spend for the feature is read back from that SAME
//     ledger and compared to the cap from agents.config (per-agent) / a system
//     setting (fleet). The operator-configured ai_budgets kill rows are ALSO
//     honored (isAiBudgetExhausted) so an operator can hard-stop a feature the
//     usual way.
//
// SECURITY (US-268): ai_usage_events is an operator/analytics ledger; reads here
// are scoped by the agent feature key, not tenant data.

import type { AgentConfig } from "./agent-kernel.ts";
import { supabaseAdmin } from "./supabase.ts";
import { isAiBudgetExhausted } from "./ai-budget-gate.ts";
import { getSetting } from "./system-settings.ts";

// Conservative defaults — an un-configured agent is leashed tight until an
// operator raises it.
export const DEFAULT_AGENT_DAILY_CAP_USD = 2;
export const DEFAULT_FLEET_DAILY_CAP_USD = 25;
export const FLEET_DAILY_CAP_SETTING_KEY = "agents.fleet_daily_cap_usd";
export const AGENT_FEATURE_PREFIX = "agent:";

export function agentBudgetFeature(agentKey: string): string {
  return AGENT_FEATURE_PREFIX + agentKey;
}

// Per-agent daily cap from config, else the conservative default (pure).
export function agentDailyCapUsd(config: AgentConfig): number {
  const v = config?.budget_usd_daily;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_AGENT_DAILY_CAP_USD;
}

// Has spend reached/passed the cap? A 0/negative cap disables the check (pure).
export function capExceeded(spendUsd: number, capUsd: number): boolean {
  return capUsd > 0 && spendUsd >= capUsd;
}

// Start of the current UTC day (the budget window boundary), as an ISO string.
export function startOfUtcDayIso(nowMs: number): string {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function sumCost(rows: Array<{ cost_usd?: unknown }> | null): number {
  return (rows ?? []).reduce((acc, r) => {
    const n = typeof r.cost_usd === "number" ? r.cost_usd : Number(r.cost_usd);
    return acc + (Number.isFinite(n) ? n : 0);
  }, 0);
}

// ── Enforcement ──────────────────────────────────────────────────────────────

export type BudgetScope = "agent" | "fleet" | "operator";
export interface BudgetVerdict {
  exhausted: boolean;
  reason: string | null;
  scope: BudgetScope | null;
}

export interface BudgetDeps {
  spendTodayUsd: (feature: string) => Promise<number>;
  fleetSpendTodayUsd: () => Promise<number>;
  operatorKillExhausted: (feature: string) => Promise<boolean>;
  fleetCapUsd: () => Promise<number>;
}

export function prodBudgetDeps(): BudgetDeps {
  return {
    spendTodayUsd: async (feature) => {
      const since = startOfUtcDayIso(Date.now());
      const { data } = await supabaseAdmin
        .from("ai_usage_events")
        .select("cost_usd")
        .eq("feature", feature)
        .gte("created_at", since);
      return sumCost(data as Array<{ cost_usd?: unknown }> | null);
    },
    fleetSpendTodayUsd: async () => {
      const since = startOfUtcDayIso(Date.now());
      const { data } = await supabaseAdmin
        .from("ai_usage_events")
        .select("cost_usd")
        .like("feature", `${AGENT_FEATURE_PREFIX}%`)
        .gte("created_at", since);
      return sumCost(data as Array<{ cost_usd?: unknown }> | null);
    },
    operatorKillExhausted: (feature) => isAiBudgetExhausted(feature),
    fleetCapUsd: () => getSetting<number>(FLEET_DAILY_CAP_SETTING_KEY, DEFAULT_FLEET_DAILY_CAP_USD),
  };
}

// Is this agent over budget right now? Checks, in order: the operator kill row
// (existing guardrail) → the fleet-wide daily cap (independent) → the per-agent
// daily cap. Returns the first breach found.
export async function checkAgentBudget(
  agentKey: string,
  config: AgentConfig,
  deps: Partial<BudgetDeps> = {},
): Promise<BudgetVerdict> {
  const d = { ...prodBudgetDeps(), ...deps };
  const feature = agentBudgetFeature(agentKey);

  if (await d.operatorKillExhausted(feature)) {
    return { exhausted: true, reason: "operator_kill", scope: "operator" };
  }
  const [fleetSpend, fleetCap] = await Promise.all([d.fleetSpendTodayUsd(), d.fleetCapUsd()]);
  if (capExceeded(fleetSpend, fleetCap)) {
    return { exhausted: true, reason: "fleet_daily_cap", scope: "fleet" };
  }
  const spend = await d.spendTodayUsd(feature);
  if (capExceeded(spend, agentDailyCapUsd(config))) {
    return { exhausted: true, reason: "agent_daily_cap", scope: "agent" };
  }
  return { exhausted: false, reason: null, scope: null };
}
