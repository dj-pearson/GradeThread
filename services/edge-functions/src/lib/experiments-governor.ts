// US-1609 / AGENTIC-OS Phase 2 (Module X): the Experiments Governor — one
// registry over every live A/B in the platform. The engines keep running their
// OWN A/B math; this governs the PORTFOLIO: interference (overlapping audiences
// on the same metric window), underpowered reads presented as wins, and stale
// experiments past their decision date.
//
// PURE + fixture-tested. Per-engine ADAPTERS normalize each engine's raw rows
// into one RegistryEntry shape; the tool feeds live rows. Detectors run on the
// unified registry.

export interface Variant {
  key: string;
  sample_size: number;
  read: number | null; // the engine's current metric read for this variant (0..1 or raw)
}

export interface RegistryEntry {
  id: string;
  engine: string; // newsletter-ab | drip-optimizer | prompt-rollout | listing-prompt
  surface: string; // where it runs (e.g. "newsletter:subject")
  audience: string; // the audience key (interference = same audience)
  metric: string; // the outcome metric (interference = same metric)
  variants: Variant[];
  start_ms: number | null;
  decision_ms: number | null; // when a call is due (null = open-ended)
  sample_size: number; // total across variants
  current_read: string; // a short human read (leader / inconclusive / …)
}

const DAY = 86400_000;

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// ── Adapters (raw engine rows → RegistryEntry). Each is pure + fixture-tested. ─

export interface NewsletterAbRow {
  id: string;
  ab_phase: string; // none | testing | complete
  ab_metric: string; // open | click | …
  subject_variants: Array<{ id: string; subject?: string }>;
  ab_test_started_at: string | null;
  ab_measurement_hours: number | null;
  ab_winner_variant: string | null;
  variant_stats?: Record<string, { sample: number; rate: number }>;
}

export function normalizeNewsletterAb(rows: readonly NewsletterAbRow[]): RegistryEntry[] {
  return rows
    .filter((r) => r.ab_phase === "testing") // only LIVE experiments
    .map((r) => {
      const variants: Variant[] = (r.subject_variants ?? []).map((v) => ({
        key: v.id,
        sample_size: r.variant_stats?.[v.id]?.sample ?? 0,
        read: r.variant_stats?.[v.id]?.rate ?? null,
      }));
      const startMs = toMs(r.ab_test_started_at);
      const decisionMs = startMs !== null && r.ab_measurement_hours
        ? startMs + r.ab_measurement_hours * 3600_000
        : null;
      return {
        id: `newsletter:${r.id}`,
        engine: "newsletter-ab",
        surface: "newsletter:subject",
        audience: "newsletter-subscribers",
        metric: r.ab_metric,
        variants,
        start_ms: startMs,
        decision_ms: decisionMs,
        sample_size: variants.reduce((s, v) => s + v.sample_size, 0),
        current_read: r.ab_winner_variant ? `leader ${r.ab_winner_variant}` : "inconclusive",
      };
    });
}

// Real ai_prompt_versions columns (US-896 staged rollout, 00221). A canary is a
// live grading-traffic slice; is_canary marks the challenger, rollout_percentage
// is its share, and (stage, garment_scope) is its slot.
export interface PromptRolloutRow {
  version_name: string;
  stage: string; // per_image | composite | …
  garment_scope: string | null; // null = global
  is_canary: boolean;
  rollout_percentage: number | null; // >0 and <100 ⇒ a live canary slice
  rollout_started_at: string | null;
  sample_size?: number; // best-effort graded-count over the window (may be absent)
}

export function normalizePromptRollout(rows: readonly PromptRolloutRow[]): RegistryEntry[] {
  return rows
    .filter((r) => r.is_canary && typeof r.rollout_percentage === "number" && r.rollout_percentage > 0 && r.rollout_percentage < 100)
    .map((r) => {
      const slot = `grading:${r.stage}${r.garment_scope ? `:${r.garment_scope}` : ""}`;
      const pct = r.rollout_percentage!;
      const total = r.sample_size ?? 0;
      return {
        id: `prompt:${r.version_name}`,
        engine: "prompt-rollout",
        surface: slot,
        // Same slot = same live grading traffic → interference axis.
        audience: `traffic:${slot}`,
        metric: "eval-agreement",
        variants: [
          { key: "canary", sample_size: Math.round(total * (pct / 100)), read: null },
          { key: "control", sample_size: Math.round(total * (1 - pct / 100)), read: null },
        ],
        start_ms: toMs(r.rollout_started_at),
        decision_ms: null,
        sample_size: total,
        current_read: `canary ${pct}%`,
      };
    });
}

export interface DripVariantRow {
  campaign: string;
  variant: string;
  sends: number;
  conversions: number;
  started_at: string | null;
}

// Group a campaign's variant rows into one experiment entry.
export function normalizeDripVariants(rows: readonly DripVariantRow[]): RegistryEntry[] {
  const byCampaign = new Map<string, DripVariantRow[]>();
  for (const r of rows) {
    const list = byCampaign.get(r.campaign);
    if (list) list.push(r);
    else byCampaign.set(r.campaign, [r]);
  }
  const out: RegistryEntry[] = [];
  for (const [campaign, vs] of byCampaign) {
    if (vs.length < 2) continue; // not an A/B unless >=2 variants
    const variants: Variant[] = vs.map((v) => ({
      key: v.variant,
      sample_size: v.sends,
      read: v.sends > 0 ? Number((v.conversions / v.sends).toFixed(4)) : null,
    }));
    const start = vs.map((v) => toMs(v.started_at)).filter((x): x is number => x !== null).sort()[0] ?? null;
    out.push({
      id: `drip:${campaign}`,
      engine: "drip-optimizer",
      surface: `drip:${campaign}`,
      audience: `drip:${campaign}`,
      metric: "conversion",
      variants,
      start_ms: start,
      decision_ms: null,
      sample_size: variants.reduce((s, v) => s + v.sample_size, 0),
      current_read: "running",
    });
  }
  return out;
}

// ── Detectors ────────────────────────────────────────────────────────────────

export const UNDERPOWERED_MIN_SAMPLE = 200;
export const STALE_GRACE_DAYS = 3;

export interface InterferencePair {
  a: string;
  b: string;
  audience: string;
  metric: string;
}

// Two live experiments interfere when they share an audience AND a metric AND
// their time windows overlap — a subject reacting to both confounds each read.
export function detectInterference(registry: readonly RegistryEntry[]): InterferencePair[] {
  const pairs: InterferencePair[] = [];
  for (let i = 0; i < registry.length; i++) {
    for (let j = i + 1; j < registry.length; j++) {
      const a = registry[i], b = registry[j];
      if (a.audience !== b.audience || a.metric !== b.metric) continue;
      // Overlapping windows (open start/decision = unbounded on that side).
      const aStart = a.start_ms ?? -Infinity, aEnd = a.decision_ms ?? Infinity;
      const bStart = b.start_ms ?? -Infinity, bEnd = b.decision_ms ?? Infinity;
      if (aStart <= bEnd && bStart <= aEnd) {
        pairs.push({ a: a.id, b: b.id, audience: a.audience, metric: a.metric });
      }
    }
  }
  return pairs;
}

export function flagUnderpowered(registry: readonly RegistryEntry[], minSample = UNDERPOWERED_MIN_SAMPLE): RegistryEntry[] {
  // Presented as a win (a leader) but under the sample floor → suspect.
  return registry.filter((e) => e.sample_size < minSample && /leader/i.test(e.current_read));
}

export function flagStale(registry: readonly RegistryEntry[], nowMs: number, graceDays = STALE_GRACE_DAYS): RegistryEntry[] {
  return registry.filter((e) => e.decision_ms !== null && nowMs > e.decision_ms + graceDays * DAY);
}

// ── The assembled memo ───────────────────────────────────────────────────────

export interface ExperimentsMemo {
  summary: string;
  registry: RegistryEntry[];
  interference: InterferencePair[];
  underpowered: RegistryEntry[];
  stale: RegistryEntry[];
  all_clear: boolean;
}

export function assembleExperimentsMemo(registry: readonly RegistryEntry[], nowMs: number): ExperimentsMemo {
  const interference = detectInterference(registry);
  const underpowered = flagUnderpowered(registry);
  const stale = flagStale(registry, nowMs);
  const allClear = interference.length === 0 && underpowered.length === 0 && stale.length === 0;
  const parts: string[] = [`${registry.length} live experiment(s) across ${new Set(registry.map((e) => e.engine)).size} engine(s)`];
  if (!allClear) {
    if (interference.length) parts.push(`${interference.length} interfering pair(s)`);
    if (underpowered.length) parts.push(`${underpowered.length} underpowered "win(s)"`);
    if (stale.length) parts.push(`${stale.length} stale past decision date`);
  } else {
    parts.push("no interference, all reads adequately powered and on-schedule");
  }
  return { summary: parts.join("; ") + ".", registry: [...registry], interference, underpowered, stale, all_clear: allClear };
}
