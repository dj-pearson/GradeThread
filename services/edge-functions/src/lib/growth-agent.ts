// US-1602 / AGENTIC-OS Phase 1 (Module R): the Growth agent's domain logic —
// funnel/retention anomaly narration and referral/affiliate program health, feeding
// a ranked experiment slate the agent revisits week over week. It GENERATES and
// RANKS ideas; it does NOT start experiments (that governance is Module X /
// US-1609, vault/70-agent/agentic-os-map.md §3.R). Proposals are admin-task experiment briefs.
//
// Deterministic, fixture-tested core: funnel conversion + the week-over-week
// cliff comparison. The tool supplies the reads (funnel_metrics current + prior,
// referral counts, and the PRIOR run's slate for continuity).

// ── Funnel (funnel_metrics RPC → normalized steps) ───────────────────────────

export interface FunnelStep {
  key: string;
  label: string;
  count: number;
}

// Defensively pull the ordered steps out of the funnel_metrics doc
// ({ period, steps: [{key,label,count}] }). Returns [] on any unexpected shape
// so the agent degrades to "no funnel data" rather than crashing.
export function normalizeFunnel(doc: unknown): FunnelStep[] {
  if (!doc || typeof doc !== "object") return [];
  const steps = (doc as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      key: typeof s.key === "string" ? s.key : String(s.label ?? ""),
      label: typeof s.label === "string" ? s.label : String(s.key ?? ""),
      count: typeof s.count === "number" && Number.isFinite(s.count) ? s.count : 0,
    }));
}

export interface StepConversion {
  from: string;
  to: string;
  from_count: number;
  to_count: number;
  conversion: number; // to/from, 0..1 (0 when from is 0)
}

// Step-to-step conversion across the funnel. Pure.
export function computeFunnelConversion(steps: readonly FunnelStep[]): StepConversion[] {
  const out: StepConversion[] = [];
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1], cur = steps[i];
    out.push({
      from: prev.key,
      to: cur.key,
      from_count: prev.count,
      to_count: cur.count,
      conversion: prev.count > 0 ? Number((cur.count / prev.count).toFixed(4)) : 0,
    });
  }
  return out;
}

// The worst drop-off — the funnel's "cliff" (lowest conversion transition). Pure.
export function funnelCliff(conversions: readonly StepConversion[]): StepConversion | null {
  if (conversions.length === 0) return null;
  return conversions.reduce((worst, c) => (c.conversion < worst.conversion ? c : worst));
}

export interface ConversionRegression {
  from: string;
  to: string;
  current: number;
  prior: number;
  drop: number; // prior - current (positive = worse)
}

// A conversion is REGRESSED enough to flag when it dropped by more than this
// (absolute conversion-rate points) vs the prior window.
export const CONVERSION_REGRESSION_BAND = 0.05;

// Week-over-week: which step conversions regressed materially. Pure.
export function compareFunnels(
  current: readonly StepConversion[],
  prior: readonly StepConversion[],
): ConversionRegression[] {
  const priorBy = new Map(prior.map((c) => [`${c.from}->${c.to}`, c.conversion]));
  const regressions: ConversionRegression[] = [];
  for (const c of current) {
    const p = priorBy.get(`${c.from}->${c.to}`);
    if (p === undefined) continue;
    const drop = Number((p - c.conversion).toFixed(4));
    if (drop >= CONVERSION_REGRESSION_BAND) {
      regressions.push({ from: c.from, to: c.to, current: c.conversion, prior: p, drop });
    }
  }
  return regressions.sort((a, b) => b.drop - a.drop);
}

// ── Program health (referral / affiliate) ────────────────────────────────────

export interface ProgramHealth {
  referrals_current: number;
  referrals_prior: number;
  delta_pct: number | null;
  verdict: "growing" | "flat" | "declining" | "unknown";
}

export function summarizeProgramHealth(current: number, prior: number): ProgramHealth {
  let deltaPct: number | null = null;
  let verdict: ProgramHealth["verdict"] = "unknown";
  if (prior > 0) {
    deltaPct = Number(((current - prior) / prior).toFixed(4));
    verdict = deltaPct > 0.05 ? "growing" : deltaPct < -0.05 ? "declining" : "flat";
  } else if (current > 0) {
    verdict = "growing";
  }
  return { referrals_current: current, referrals_prior: prior, delta_pct: deltaPct, verdict };
}

// ── The assembled memo ───────────────────────────────────────────────────────

export interface GrowthTelemetry {
  currentFunnel: unknown; // funnel_metrics doc, current window
  priorFunnel: unknown; // funnel_metrics doc, trailing window
  referralsCurrent: number;
  referralsPrior: number;
  priorSlate: unknown; // the previous growth run's outcome (for slate continuity)
}

export interface GrowthMemo {
  funnel: FunnelStep[];
  conversions: StepConversion[];
  cliff: StepConversion | null;
  regressions: ConversionRegression[];
  program_health: ProgramHealth;
  prior_slate: unknown;
  notable: boolean;
}

export function assembleGrowthMemo(t: GrowthTelemetry): GrowthMemo {
  const funnel = normalizeFunnel(t.currentFunnel);
  const conversions = computeFunnelConversion(funnel);
  const priorConversions = computeFunnelConversion(normalizeFunnel(t.priorFunnel));
  const regressions = compareFunnels(conversions, priorConversions);
  const cliff = funnelCliff(conversions);
  const programHealth = summarizeProgramHealth(t.referralsCurrent, t.referralsPrior);

  const notable = regressions.length > 0 || programHealth.verdict === "declining";

  return {
    funnel,
    conversions,
    cliff,
    regressions,
    program_health: programHealth,
    prior_slate: t.priorSlate ?? null,
    notable,
  };
}
