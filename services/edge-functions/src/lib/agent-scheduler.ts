// US-1588: the agent scheduler — the fleet runs on the SAME Coolify cron +
// job-secret + cron_runs rails as the other 54 jobs. One /api/jobs/agent-tick
// every 10 minutes selects the enabled agents that are due per their config
// schedule and runs them SEQUENTIALLY under a per-tick wall-clock budget;
// leftover due agents defer to the next tick (recorded, never silently
// dropped).

import { supabaseAdmin } from "./supabase.ts";
import { nextCronRun } from "./cron-runs.ts";
import { runAgent as kernelRunAgent, type RunResult } from "./agent-kernel.ts";
import { isGlobalAgentPause } from "./agent-policy.ts";
import { expireStaleProposals } from "./agent-proposals.ts";
import { redactError } from "./log-redact.ts";

export interface SchedulableAgent {
  id: string;
  key: string;
  status: string;
  config: Record<string, unknown>;
}

/**
 * Is this agent due at `now`, given when it last STARTED? Schedules come
 * from agents.config:
 *  - `schedule`: a 5-field cron expression (UTC) — due when the next fire
 *    after the last start is <= now;
 *  - `interval_minutes`: due when at least that long has passed;
 *  - NO schedule → never due (agents opt into a cadence explicitly).
 * A never-run agent with a schedule is due immediately.
 */
export function isAgentDue(
  agent: Pick<SchedulableAgent, "config">,
  lastStartedAt: string | null,
  now: Date,
): boolean {
  const config = agent.config ?? {};
  const cronExpr = typeof config.schedule === "string" ? config.schedule : null;
  const intervalMin = typeof config.interval_minutes === "number" &&
      config.interval_minutes > 0
    ? config.interval_minutes
    : null;
  if (!cronExpr && !intervalMin) return false;
  if (!lastStartedAt) return true; // has a cadence, never ran → due now

  const last = new Date(lastStartedAt);
  if (Number.isNaN(last.getTime())) return true;

  if (intervalMin) {
    return now.getTime() - last.getTime() >= intervalMin * 60_000;
  }
  const next = nextCronRun(cronExpr!, last);
  if (!next) return false; // unparseable cron → never due (visible in config)
  return next <= now.toISOString();
}

// ── The tick ─────────────────────────────────────────────────────────────────

export interface TickOutcome {
  paused: boolean;
  due: string[];
  ran: Array<{ agent: string; status: RunResult["status"] }>;
  /** Due agents the budget pushed to the next tick — recorded, not dropped. */
  deferred: string[];
  expiredProposals: number;
}

export interface TickDeps {
  loadEnabledAgents(): Promise<SchedulableAgent[]>;
  /** Latest started_at per agent id (absent = never ran). */
  loadLastStarts(agentIds: string[]): Promise<Map<string, string>>;
  runAgent(agentKey: string): Promise<RunResult>;
  sweepProposals(): Promise<number>;
  isPaused(): Promise<boolean>;
  now(): number;
  /** Per-tick wall-clock budget; leftovers defer. Default 8 min. */
  budgetMs: number;
}

const defaultDeps: TickDeps = {
  async loadEnabledAgents() {
    const { data, error } = await supabaseAdmin
      .from("agents")
      .select("id, key, status, config")
      .eq("status", "enabled")
      .order("key");
    if (error) throw new Error(`agent load failed: ${error.message}`);
    return (data ?? []) as SchedulableAgent[];
  },
  async loadLastStarts(agentIds) {
    const out = new Map<string, string>();
    if (agentIds.length === 0) return out;
    // Newest-first window; the first row seen per agent is its latest start.
    const { data, error } = await supabaseAdmin
      .from("agent_runs")
      .select("agent_id, started_at")
      .in("agent_id", agentIds)
      .not("started_at", "is", null)
      .order("started_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(`last-run load failed: ${error.message}`);
    for (const row of (data ?? []) as Array<{ agent_id: string; started_at: string }>) {
      if (!out.has(row.agent_id)) out.set(row.agent_id, row.started_at);
    }
    return out;
  },
  runAgent: (key) => kernelRunAgent(key, "schedule"),
  sweepProposals: () => expireStaleProposals(),
  isPaused: () => isGlobalAgentPause(),
  now: () => Date.now(),
  budgetMs: 8 * 60_000,
};

/**
 * One tick. Individual agent-run failures never fail the tick (the kernel
 * already never throws); only bookkeeping errors propagate to the route,
 * where the standard job.failed chokepoint picks them up.
 */
export async function runAgentTick(
  overrides: Partial<TickDeps> = {},
): Promise<TickOutcome> {
  const deps: TickDeps = { ...defaultDeps, ...overrides };

  // Global pause → a recorded no-op (the cron_runs ledger row still lands
  // via the /api/jobs/* middleware; the outcome says WHY nothing ran).
  if (await deps.isPaused()) {
    return { paused: true, due: [], ran: [], deferred: [], expiredProposals: 0 };
  }

  // Housekeeping first: the proposal-TTL sweep rides the tick (US-1587 AC5).
  let expiredProposals = 0;
  try {
    expiredProposals = await deps.sweepProposals();
  } catch (err) {
    console.error(`[agent-tick] proposal sweep failed: ${redactError(err)}`);
  }

  const agents = await deps.loadEnabledAgents();
  const lastStarts = await deps.loadLastStarts(agents.map((a) => a.id));
  const nowDate = new Date(deps.now());
  const due = agents.filter((a) =>
    isAgentDue(a, lastStarts.get(a.id) ?? null, nowDate)
  );

  const started = deps.now();
  const ran: TickOutcome["ran"] = [];
  const deferred: string[] = [];
  for (const agent of due) {
    if (deps.now() - started > deps.budgetMs) {
      // Budget spent: everything else waits for the next tick — RECORDED.
      deferred.push(agent.key);
      continue;
    }
    const result = await deps.runAgent(agent.key);
    ran.push({ agent: agent.key, status: result.status });
  }
  if (deferred.length > 0) {
    console.warn(
      `[agent-tick] budget exhausted; deferred to next tick: ${deferred.join(", ")}`,
    );
  }

  return {
    paused: false,
    due: due.map((a) => a.key),
    ran,
    deferred,
    expiredProposals,
  };
}
