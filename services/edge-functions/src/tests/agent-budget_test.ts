// US-1591: budget governor — cap math + the agent/fleet/operator verdict order.
// Types erased; runtime values dynamic-imported after env prime (agent-budget.ts
// pulls in supabase.ts via prodBudgetDeps).
import { assertEquals } from "@std/assert";
import type { BudgetDeps } from "../lib/agent-budget.ts";
import type { AgentConfig } from "../lib/agent-kernel.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
const {
  DEFAULT_AGENT_DAILY_CAP_USD,
  agentBudgetFeature,
  agentDailyCapUsd,
  capExceeded,
  checkAgentBudget,
  startOfUtcDayIso,
} = await import("../lib/agent-budget.ts");

// ── Pure helpers ─────────────────────────────────────────────────────────────

Deno.test("agentBudgetFeature: prefixes the key", () => {
  assertEquals(agentBudgetFeature("sentinel"), "agent:sentinel");
});

Deno.test("agentDailyCapUsd: config value, else conservative default", () => {
  assertEquals(agentDailyCapUsd({ budget_usd_daily: 7 } as AgentConfig), 7);
  assertEquals(agentDailyCapUsd({} as AgentConfig), DEFAULT_AGENT_DAILY_CAP_USD);
  assertEquals(agentDailyCapUsd({ budget_usd_daily: -1 } as AgentConfig), DEFAULT_AGENT_DAILY_CAP_USD);
  assertEquals(agentDailyCapUsd({ budget_usd_daily: 0 } as AgentConfig), DEFAULT_AGENT_DAILY_CAP_USD);
});

Deno.test("capExceeded: at/over the cap; a 0/neg cap disables the check", () => {
  assertEquals(capExceeded(2, 2), true);
  assertEquals(capExceeded(2.01, 2), true);
  assertEquals(capExceeded(1.99, 2), false);
  assertEquals(capExceeded(1000, 0), false); // disabled
});

Deno.test("startOfUtcDayIso: truncates to the UTC day boundary", () => {
  const ms = Date.parse("2026-07-05T13:45:30.000Z");
  assertEquals(startOfUtcDayIso(ms), "2026-07-05T00:00:00.000Z");
});

// ── Verdict precedence ───────────────────────────────────────────────────────

function deps(over: Partial<BudgetDeps> = {}): Partial<BudgetDeps> {
  return {
    operatorKillExhausted: () => Promise.resolve(false),
    fleetSpendTodayUsd: () => Promise.resolve(0),
    fleetCapUsd: () => Promise.resolve(25),
    spendTodayUsd: () => Promise.resolve(0),
    ...over,
  };
}

const cfg: AgentConfig = { budget_usd_daily: 2 };

Deno.test("checkAgentBudget: operator kill row wins first", async () => {
  const v = await checkAgentBudget("a", cfg, deps({ operatorKillExhausted: () => Promise.resolve(true) }));
  assertEquals(v, { exhausted: true, reason: "operator_kill", scope: "operator" });
});

Deno.test("checkAgentBudget: fleet cap next (independent of the agent cap)", async () => {
  const v = await checkAgentBudget("a", cfg, deps({ fleetSpendTodayUsd: () => Promise.resolve(30) }));
  assertEquals(v, { exhausted: true, reason: "fleet_daily_cap", scope: "fleet" });
});

Deno.test("checkAgentBudget: per-agent daily cap", async () => {
  const v = await checkAgentBudget("a", cfg, deps({ spendTodayUsd: () => Promise.resolve(2.5) }));
  assertEquals(v, { exhausted: true, reason: "agent_daily_cap", scope: "agent" });
});

Deno.test("checkAgentBudget: all under cap → not exhausted", async () => {
  const v = await checkAgentBudget("a", cfg, deps({ spendTodayUsd: () => Promise.resolve(1) }));
  assertEquals(v, { exhausted: false, reason: null, scope: null });
});
