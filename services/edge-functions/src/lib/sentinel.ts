// US-1593 / AGENTIC-OS Phase 1 (Module H — Sentinel): incident correlation.
//
// The health & incident agent's job is to turn a storm of low-level failures
// (cron failures, dead letters, warning ops events) into a SMALL number of
// incidents — one root-cause hypothesis, not ten alerts (AGENTIC_OS.md §3.H).
// The correlation is DETERMINISTIC + pure (fixture-tested) so the agent's LLM
// pass only has to review + propose, keeping a healthy run a cheap no-op.
//
// A `get_incidents` read tool (agent-tools.ts) runs this over the ops signals
// and hands the agent pre-correlated incidents.

export interface Signal {
  subsystem: string; // the failing surface (job name, provider, event source)
  kind: string; // "cron_failure" | "dead_letter" | "ops_event"
  ref: string; // a stable id the agent can act on (job key, dead-letter id)
  at: string; // ISO timestamp
  detail?: string;
}

export interface Incident {
  subsystem: string;
  kinds: string[];
  signals: Signal[];
  count: number;
  firstAt: string;
  lastAt: string;
  rootCauseHypothesis: string;
}

export const DEFAULT_CORRELATION_WINDOW_MS = 30 * 60 * 1000; // 30 min

function toIncident(subsystem: string, cluster: Signal[]): Incident {
  const kinds = [...new Set(cluster.map((s) => s.kind))].sort();
  const times = cluster.map((s) => Date.parse(s.at)).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const firstAt = new Date(times[0] ?? 0).toISOString();
  const lastAt = new Date(times[times.length - 1] ?? 0).toISOString();
  const spanMin = times.length > 1 ? Math.round((times[times.length - 1] - times[0]) / 60_000) : 0;
  const rootCauseHypothesis = cluster.length === 1
    ? `Single ${kinds.join("/")} in "${subsystem}".`
    : `${cluster.length} ${kinds.join("/")} signals in "${subsystem}" within ${spanMin}m — likely a shared ${subsystem} fault.`;
  return { subsystem, kinds, signals: cluster, count: cluster.length, firstAt, lastAt, rootCauseHypothesis };
}

// Correlate raw signals into incidents (pure): group by subsystem, then split a
// subsystem's signals into temporal clusters (a gap larger than `windowMs`
// starts a new incident). N related failures (same subsystem, same window) →
// ONE incident; unrelated failures (different subsystems) → separate incidents.
// Incidents are returned most-signals-first.
export function correlateIncidents(
  signals: Signal[],
  windowMs: number = DEFAULT_CORRELATION_WINDOW_MS,
): Incident[] {
  const bySub = new Map<string, Signal[]>();
  for (const s of signals) {
    const list = bySub.get(s.subsystem);
    if (list) list.push(s);
    else bySub.set(s.subsystem, [s]);
  }

  const incidents: Incident[] = [];
  for (const [sub, sigs] of bySub) {
    const sorted = [...sigs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    let cluster: Signal[] = [];
    for (const s of sorted) {
      if (
        cluster.length > 0 &&
        Date.parse(s.at) - Date.parse(cluster[cluster.length - 1].at) > windowMs
      ) {
        incidents.push(toIncident(sub, cluster));
        cluster = [];
      }
      cluster.push(s);
    }
    if (cluster.length > 0) incidents.push(toIncident(sub, cluster));
  }

  return incidents.sort((a, b) => b.count - a.count || a.subsystem.localeCompare(b.subsystem));
}
