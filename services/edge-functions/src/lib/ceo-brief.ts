// US-1603 / AGENTIC-OS Phase 1 (Module Y): the CEO Brief ("chief-analyst").
//
// The weekly north-star digest becomes a narrated decision memo: headline
// metrics vs last week, a narrative of causes that CITES which agent observed
// what, the fleet's actions taken/pending, "the one decision this week", and
// risks on the horizon. The chief-analyst agent narrates from the context this
// module assembles; the assembly is PURE (fixture-tested).
//
// HONESTY RULE (vault/70-agent/agentic-os-map.md §3.Y): attribution ONLY when an agent actually
// ran and observed a cause. When few agents have run, the brief degrades to
// metrics + an explicit "unattributed" note — it NEVER fabricates a cause.

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface MetricInput {
  name: string;
  current: number;
  prior: number;
}

export interface AgentLatestRun {
  agent_key: string;
  status: string; // succeeded | failed | ...
  summary: string | null; // outcome.summary of the latest run
  ran_at: string | null;
}

export interface PendingAction {
  id: string;
  agent_key: string;
  title: string;
}

export interface CeoBriefInput {
  nowMs: number;
  agents: Array<{ key: string; name: string }>; // the seeded fleet
  metrics: readonly MetricInput[];
  latestRuns: readonly AgentLatestRun[]; // latest run per agent that has one
  pendingProposals: readonly PendingAction[];
}

// ── Output model ─────────────────────────────────────────────────────────────

export interface HeadlineMetric {
  name: string;
  current: number;
  prior: number;
  delta_pct: number | null; // null when prior is 0/unknown
  direction: "up" | "down" | "flat" | "unknown";
}

export interface AgentObservation {
  agent_key: string;
  name: string;
  summary: string;
}

export interface CeoBriefContext {
  headline_metrics: HeadlineMetric[];
  // Only agents that actually RAN and produced a summary — the attributable set.
  observations: AgentObservation[];
  fleet_actions: { pending: PendingAction[] };
  coverage: { agents_total: number; agents_ran: number };
  // True when too few agents ran to attribute causes — the brief must fall back
  // to metrics + an "unattributed" note.
  degraded: boolean;
  attribution_allowed: boolean; // false ⇒ the narrator must not attribute causes
}

function deltaPct(current: number, prior: number): { delta_pct: number | null; direction: HeadlineMetric["direction"] } {
  if (!Number.isFinite(prior) || prior === 0) return { delta_pct: null, direction: "unknown" };
  const pct = Number((((current - prior) / prior)).toFixed(4));
  const direction = current > prior ? "up" : current < prior ? "down" : "flat";
  return { delta_pct: pct, direction };
}

// Assemble the brief CONTEXT from the week's rows (pure). Degrades gracefully:
// with no attributable agent runs, observations is empty and attribution_allowed
// is false, so the narrator reports metrics + an "unattributed" note rather than
// inventing a cause.
export function assembleCeoBriefContext(input: CeoBriefInput): CeoBriefContext {
  const nameByKey = new Map(input.agents.map((a) => [a.key, a.name]));

  const headlineMetrics: HeadlineMetric[] = input.metrics.map((m) => ({
    name: m.name,
    current: m.current,
    prior: m.prior,
    ...deltaPct(m.current, m.prior),
  }));

  // Attributable = ran AND succeeded AND left a summary. An agent that failed or
  // never ran contributes NO observation (honesty rule).
  const observations: AgentObservation[] = input.latestRuns
    .filter((r) => r.status === "succeeded" && r.summary && r.summary.trim().length > 0)
    .map((r) => ({ agent_key: r.agent_key, name: nameByKey.get(r.agent_key) ?? r.agent_key, summary: r.summary as string }))
    .sort((a, b) => a.agent_key.localeCompare(b.agent_key));

  const agentsTotal = input.agents.length;
  const agentsRan = observations.length;
  // Degraded when fewer than half the fleet produced an observation (or none).
  const degraded = agentsRan === 0 || agentsRan * 2 < agentsTotal;

  return {
    headline_metrics: headlineMetrics,
    observations,
    fleet_actions: { pending: [...input.pendingProposals] },
    coverage: { agents_total: agentsTotal, agents_ran: agentsRan },
    degraded,
    attribution_allowed: agentsRan > 0,
  };
}

// A one-line headline for the memo subject / preview (pure). Leads with the
// metric that moved most, or an all-quiet line.
export function ceoBriefHeadline(ctx: CeoBriefContext): string {
  const moved = ctx.headline_metrics
    .filter((m) => m.delta_pct !== null && m.direction !== "flat")
    .sort((a, b) => Math.abs(b.delta_pct ?? 0) - Math.abs(a.delta_pct ?? 0))[0];
  const coverage = `${ctx.coverage.agents_ran}/${ctx.coverage.agents_total} agents reported`;
  if (!moved) return `Metrics steady week over week · ${coverage}.`;
  const pct = Math.abs(Math.round((moved.delta_pct ?? 0) * 100));
  return `${moved.name} ${moved.direction} ${pct}% WoW · ${coverage}${ctx.degraded ? " (limited attribution)" : ""}.`;
}
