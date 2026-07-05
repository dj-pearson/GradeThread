// US-1588 / AGENTIC-OS Phase 0 (Module J): the agent scheduler tick.
//
// Agents run on the SAME Coolify cron + job-secret + cron_runs rails as the
// other 54 jobs (AGENTIC_OS.md §3.J) — POST /api/jobs/agent-tick every ~10 min.
// The tick: honors the global pause, expires stale proposals, selects the
// enabled agents that are DUE per their schedule, and runs them sequentially
// via the kernel under a per-tick wall-clock budget. Leftover due agents defer
// to the next tick (recorded, never silently dropped); an individual agent-run
// failure never fails the tick.
//
// This module holds the pure due-selection + the injected-deps orchestration so
// the cadence logic is unit-testable; routes/jobs-agent-tick.ts is the thin
// job-secret + job-lock wrapper.

import type { AgentConfig } from "./agent-kernel.ts";
import { runAgent } from "./agent-kernel.ts";
import { expireProposals } from "./agent-proposals.ts";
import { getSetting } from "./system-settings.ts";
import { supabaseAdmin } from "./supabase.ts";
import { AGENTS_PAUSE_SETTING_KEY } from "./agent-kernel.ts";
import { runMemoryCuration } from "./agent-memory-curation.ts";
import { runAutonomyPromotionPass } from "./autonomy-promotion-pass.ts";

// The tick's own wall-clock budget — comfortably under the 10-min cadence and
// the job-lock lease so a slow batch never overruns into the next tick.
export const DEFAULT_TICK_BUDGET_MS = 8 * 60 * 1000;
const DEFAULT_SCHEDULE_MINUTES = 60;

// ── Due-selection (pure) ─────────────────────────────────────────────────────

// Interpret an agent's `config.schedule` as an INTERVAL between runs. Accepts
// "Nm"/"Nh"/"Nd", the named intervals hourly/daily/weekly, and "every-tick"
// (0 → always due). A full cron string isn't interpreted for due-ness in v1 and
// falls back to the default interval. Unknown/blank → default (hourly).
export function parseScheduleMinutes(schedule: string | undefined): number {
  if (!schedule) return DEFAULT_SCHEDULE_MINUTES;
  const s = schedule.trim().toLowerCase();
  const named: Record<string, number> = {
    "every-tick": 0,
    hourly: 60,
    daily: 1440,
    weekly: 10080,
  };
  if (s in named) return named[s];
  const m = s.match(/^(\d+)\s*([mhd])$/);
  if (m) {
    const n = Number.parseInt(m[1], 10);
    const unit = m[2];
    return unit === "m" ? n : unit === "h" ? n * 60 : n * 1440;
  }
  return DEFAULT_SCHEDULE_MINUTES;
}

// Is an agent due to run? Never-run → always due; else due once the interval
// since its last run has elapsed (pure).
export function isAgentDue(
  schedule: string | undefined,
  lastRunMs: number | null,
  nowMs: number,
): boolean {
  if (lastRunMs === null) return true;
  const intervalMs = parseScheduleMinutes(schedule) * 60_000;
  return nowMs - lastRunMs >= intervalMs;
}

export interface TickAgent {
  key: string;
  config: AgentConfig;
  lastRunMs: number | null;
}

// The due subset (pure) — order preserved from the input for a stable run order.
export function selectDueAgents(agents: TickAgent[], nowMs: number): TickAgent[] {
  return agents.filter((a) => isAgentDue(a.config.schedule, a.lastRunMs, nowMs));
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface AgentTickDeps {
  isGloballyPaused: () => Promise<boolean>;
  loadEnabledAgents: () => Promise<TickAgent[]>;
  runAgent: (key: string) => Promise<{ status: string }>;
  expireProposals: () => Promise<number>;
  // US-1606: kernel-side weekly memory curation (gated by a watermark, so it
  // runs at most once/week even though the tick fires every 10 min). Returns the
  // pruned count, or null when skipped this tick.
  maybeCurateMemory: () => Promise<number | null>;
  // US-1608: kernel-side DAILY autonomy promotion/demotion pass (watermark-gated).
  // Returns { promotions_proposed, demotions } or null when skipped this tick.
  maybePromoteAutonomy: () => Promise<{ promotions_proposed: number; demotions: number } | null>;
  now: () => number;
  budgetMs: number;
}

export interface AgentTickSummary {
  paused: boolean;
  due: number;
  ran: number;
  deferred: number;
  failed: number;
  expiredProposals: number;
  curatedMemory: number | null;
  autonomy: { promotions_proposed: number; demotions: number } | null;
  results: Array<{ key: string; status: string }>;
}

export async function runAgentTick(deps: Partial<AgentTickDeps> = {}): Promise<AgentTickSummary> {
  const d = { ...prodAgentTickDeps(), ...deps };
  const empty: AgentTickSummary = {
    paused: false,
    due: 0,
    ran: 0,
    deferred: 0,
    failed: 0,
    expiredProposals: 0,
    curatedMemory: null,
    autonomy: null,
    results: [],
  };

  // Global kill switch → a recorded no-op (fail-closed on an unreadable switch).
  let paused: boolean;
  try {
    paused = await d.isGloballyPaused();
  } catch {
    paused = true;
  }
  if (paused) return { ...empty, paused: true };

  const expiredProposals = await d.expireProposals().catch(() => 0);
  const curatedMemory = await d.maybeCurateMemory().catch(() => null);
  const autonomy = await d.maybePromoteAutonomy().catch(() => null);
  const agents = await d.loadEnabledAgents();
  const nowMs = d.now();
  const due = selectDueAgents(agents, nowMs);

  const results: Array<{ key: string; status: string }> = [];
  let ran = 0;
  let failed = 0;
  const start = d.now();
  let i = 0;
  for (; i < due.length; i++) {
    // Per-tick budget: leftover due agents defer to the next tick.
    if (d.now() - start > d.budgetMs) break;
    const agent = due[i];
    try {
      const r = await d.runAgent(agent.key);
      results.push({ key: agent.key, status: r.status });
      ran++;
      if (r.status === "failed") failed++;
    } catch {
      // An individual agent-run failure NEVER fails the tick.
      results.push({ key: agent.key, status: "error" });
      ran++;
      failed++;
    }
  }
  const deferred = due.length - i;
  return { paused: false, due: due.length, ran, deferred, failed, expiredProposals, curatedMemory, autonomy, results };
}

export function prodAgentTickDeps(): AgentTickDeps {
  return {
    isGloballyPaused: () => getSetting<boolean>(AGENTS_PAUSE_SETTING_KEY, false),
    loadEnabledAgents: async () => {
      const { data: agentRows } = await supabaseAdmin
        .from("agents")
        .select("id, key, config")
        .eq("status", "enabled");
      const agents = (agentRows ?? []) as Array<{ id: string; key: string; config: AgentConfig | null }>;
      if (!agents.length) return [];
      // Latest run per agent (started_at desc; first seen per agent = latest).
      const { data: runRows } = await supabaseAdmin
        .from("agent_runs")
        .select("agent_id, started_at")
        .order("started_at", { ascending: false })
        .limit(1000);
      const lastByAgent = new Map<string, number>();
      for (const r of (runRows ?? []) as Array<{ agent_id: string; started_at: string | null }>) {
        if (!r.started_at || lastByAgent.has(r.agent_id)) continue;
        const t = Date.parse(r.started_at);
        if (Number.isFinite(t)) lastByAgent.set(r.agent_id, t);
      }
      return agents.map((a) => ({
        key: a.key,
        config: a.config ?? {},
        lastRunMs: lastByAgent.get(a.id) ?? null,
      }));
    },
    runAgent: (key) => runAgent(key, "cron"),
    expireProposals: () => expireProposals(),
    maybeCurateMemory: async () => {
      // Weekly gate via a system_settings watermark — the tick fires every 10
      // min, but curation runs at most once a week.
      const key = "agents.memory_curation_last";
      const last = await getSetting<number>(key, 0);
      const nowMs = Date.now();
      if (nowMs - (typeof last === "number" ? last : 0) < 7 * 24 * 3600_000) return null;
      const summary = await runMemoryCuration();
      await supabaseAdmin.from("system_settings").upsert(
        {
          key,
          value: nowMs,
          value_type: "number",
          default_value: 0,
          description: "US-1606 last kernel-side agent-memory curation (epoch ms)",
          category: "agents",
        },
        { onConflict: "key" },
      );
      return summary.pruned;
    },
    maybePromoteAutonomy: async () => {
      // Daily gate via a system_settings watermark.
      const key = "agents.autonomy_pass_last";
      const last = await getSetting<number>(key, 0);
      const nowMs = Date.now();
      if (nowMs - (typeof last === "number" ? last : 0) < 24 * 3600_000) return null;
      const summary = await runAutonomyPromotionPass(nowMs);
      await supabaseAdmin.from("system_settings").upsert(
        {
          key,
          value: nowMs,
          value_type: "number",
          default_value: 0,
          description: "US-1608 last kernel-side autonomy promotion/demotion pass (epoch ms)",
          category: "agents",
        },
        { onConflict: "key" },
      );
      return summary;
    },
    now: () => Date.now(),
    budgetMs: DEFAULT_TICK_BUDGET_MS,
  };
}
