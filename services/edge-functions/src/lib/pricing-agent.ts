// US-1601 / AGENTIC-OS Phase 1 (Module P): the Pricing agent's domain logic —
// operator-side oversight of the repricing / automation engines. CROSS-TENANT
// AGGREGATES ONLY. It AUDITS and REPORTS; it NEVER edits a tenant's rules or
// prices (AGENTIC_OS.md §3.P + §5 — automations are user-owned).
//
// Deterministic, fixture-tested core: repricing efficacy, ping-pong detection
// (the canonical pathological pattern), automation-rule churn, and price-guide /
// condition-curve staleness. The tool supplies the reads.

// ── Repricing efficacy (repricing_suggestions) ───────────────────────────────

export interface SuggestionRow {
  listing_id: string;
  user_id: string;
  reason_code: string; // UNDERPRICED | OVERPRICED | STALE | OK | NO_COMPS
  status: string; // pending | applied | dismissed
  suggested_price_cents: number;
  applied_at: string | null;
  created_at: string;
}

export interface RepricingEfficacy {
  total: number;
  applied: number;
  dismissed: number;
  pending: number;
  // applied / (applied + dismissed) — the acted-on suggestions that stuck.
  apply_rate: number | null;
  by_reason: Record<string, { total: number; applied: number; dismissed: number }>;
}

export function computeRepricingEfficacy(suggestions: readonly SuggestionRow[]): RepricingEfficacy {
  const byReason: RepricingEfficacy["by_reason"] = {};
  let applied = 0, dismissed = 0, pending = 0;
  for (const s of suggestions) {
    const r = byReason[s.reason_code] ?? (byReason[s.reason_code] = { total: 0, applied: 0, dismissed: 0 });
    r.total++;
    if (s.status === "applied") {
      applied++;
      r.applied++;
    } else if (s.status === "dismissed") {
      dismissed++;
      r.dismissed++;
    } else {
      pending++;
    }
  }
  const decided = applied + dismissed;
  return {
    total: suggestions.length,
    applied,
    dismissed,
    pending,
    apply_rate: decided > 0 ? Number((applied / decided).toFixed(3)) : null,
    by_reason: byReason,
  };
}

// ── Ping-pong detection (pathological oscillation) ───────────────────────────

// A price is "ping-ponging" when the applied-price sequence for one listing
// reverses direction repeatedly (up, down, up, …) — a sign an automation rule is
// fighting itself or the comps. Two reversals over >=4 applied changes (raised →
// dropped → raised) is genuine oscillation, not a one-off correction. Pure.
// (A 4-point sequence has 3 steps, so at most 2 reversals — the two thresholds
// are chosen to be mutually satisfiable.)
export const PING_PONG_MIN_REVERSALS = 2;
const PING_PONG_MIN_POINTS = 4;

export interface PingPongFinding {
  listing_id: string;
  user_id: string;
  reversals: number;
  points: number;
  prices_cents: number[];
}

// Count direction reversals in a numeric sequence: each time a non-zero step
// flips sign relative to the previous non-zero step.
export function countReversals(prices: readonly number[]): number {
  let reversals = 0;
  let lastSign = 0;
  for (let i = 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff === 0) continue;
    const sign = diff > 0 ? 1 : -1;
    if (lastSign !== 0 && sign !== lastSign) reversals++;
    lastSign = sign;
  }
  return reversals;
}

// Group APPLIED suggestions by listing, order by applied time, and flag listings
// whose applied-price sequence reverses direction >= PING_PONG_MIN_REVERSALS.
export function detectPingPong(suggestions: readonly SuggestionRow[]): PingPongFinding[] {
  const byListing = new Map<string, SuggestionRow[]>();
  for (const s of suggestions) {
    if (s.status !== "applied") continue;
    const rows = byListing.get(s.listing_id);
    if (rows) rows.push(s);
    else byListing.set(s.listing_id, [s]);
  }
  const findings: PingPongFinding[] = [];
  for (const [listingId, rows] of byListing) {
    if (rows.length < PING_PONG_MIN_POINTS) continue;
    rows.sort((a, b) => Date.parse(a.applied_at ?? a.created_at) - Date.parse(b.applied_at ?? b.created_at));
    const prices = rows.map((r) => r.suggested_price_cents);
    const reversals = countReversals(prices);
    if (reversals >= PING_PONG_MIN_REVERSALS) {
      findings.push({ listing_id: listingId, user_id: rows[0].user_id, reversals, points: prices.length, prices_cents: prices });
    }
  }
  return findings.sort((a, b) => b.reversals - a.reversals);
}

// ── Automation-rule churn (flipdesk_automation_actions) ──────────────────────

export interface ActionRow {
  rule_id: string;
  user_id: string;
  listing_id: string | null;
  action_type: string;
  created_at: string;
}

export interface RuleChurn {
  rule_id: string;
  user_id: string;
  actions: number;
  distinct_listings: number;
  // actions per distinct listing — a high ratio = a rule re-acting on the same
  // items (churn), a soft pathological signal complementing ping-pong.
  actions_per_listing: number;
}

export const RULE_CHURN_MIN_RATIO = 3;

export function summarizeAutomationRules(actions: readonly ActionRow[]): RuleChurn[] {
  const byRule = new Map<string, { user_id: string; actions: number; listings: Set<string> }>();
  for (const a of actions) {
    const agg = byRule.get(a.rule_id) ?? { user_id: a.user_id, actions: 0, listings: new Set<string>() };
    agg.actions++;
    if (a.listing_id) agg.listings.add(a.listing_id);
    byRule.set(a.rule_id, agg);
  }
  return [...byRule.entries()]
    .map(([ruleId, { user_id, actions: n, listings }]) => {
      const distinct = Math.max(1, listings.size);
      return { rule_id: ruleId, user_id, actions: n, distinct_listings: listings.size, actions_per_listing: Number((n / distinct).toFixed(2)) };
    })
    .filter((r) => r.actions_per_listing >= RULE_CHURN_MIN_RATIO)
    .sort((a, b) => b.actions_per_listing - a.actions_per_listing);
}

// ── Staleness (condition price curves = the price guide) ─────────────────────

export interface CurveRow {
  category_id: string;
  refreshed_at: string;
}

export interface StalenessReport {
  total: number;
  stale: number;
  threshold_days: number;
  oldest_refreshed_at: string | null;
  oldest_age_days: number | null;
  stale_samples: Array<{ category_id: string; age_days: number }>;
}

export const CURVE_STALE_DAYS = 7;
const DAY_MS = 24 * 3600_000;

export function computeCurveStaleness(
  curves: readonly CurveRow[],
  nowMs: number,
  thresholdDays: number = CURVE_STALE_DAYS,
): StalenessReport {
  let oldestMs = Infinity;
  let oldestCat: string | null = null;
  const staleSamples: Array<{ category_id: string; age_days: number }> = [];
  for (const c of curves) {
    const t = Date.parse(c.refreshed_at);
    if (!Number.isFinite(t)) continue;
    const ageDays = Math.floor((nowMs - t) / DAY_MS);
    if (t < oldestMs) {
      oldestMs = t;
      oldestCat = c.category_id;
    }
    if (ageDays >= thresholdDays) staleSamples.push({ category_id: c.category_id, age_days: ageDays });
  }
  staleSamples.sort((a, b) => b.age_days - a.age_days);
  return {
    total: curves.length,
    stale: staleSamples.length,
    threshold_days: thresholdDays,
    oldest_refreshed_at: oldestCat !== null && Number.isFinite(oldestMs) ? new Date(oldestMs).toISOString() : null,
    oldest_age_days: Number.isFinite(oldestMs) ? Math.floor((nowMs - oldestMs) / DAY_MS) : null,
    stale_samples: staleSamples.slice(0, 15),
  };
}

// ── The assembled memo ───────────────────────────────────────────────────────

export interface PricingTelemetry {
  suggestions: readonly SuggestionRow[];
  actions: readonly ActionRow[];
  curves: readonly CurveRow[];
  nowMs: number;
}

export interface PricingMemo {
  summary: string;
  efficacy: RepricingEfficacy;
  ping_pong: PingPongFinding[];
  rule_churn: RuleChurn[];
  staleness: StalenessReport;
  all_clear: boolean;
}

export function assemblePricingMemo(t: PricingTelemetry): PricingMemo {
  const efficacy = computeRepricingEfficacy(t.suggestions);
  const pingPong = detectPingPong(t.suggestions);
  const ruleChurn = summarizeAutomationRules(t.actions);
  const staleness = computeCurveStaleness(t.curves, t.nowMs);

  const allClear = pingPong.length === 0 && ruleChurn.length === 0 && staleness.stale === 0;

  const parts: string[] = [];
  if (allClear) {
    parts.push("Pricing healthy: no ping-ponging listings, no churning rules, price curves fresh.");
    if (efficacy.apply_rate !== null) parts.push(`repricing apply-rate ${Math.round(efficacy.apply_rate * 100)}%`);
  } else {
    if (pingPong.length) parts.push(`${pingPong.length} listing(s) ping-ponging`);
    if (ruleChurn.length) parts.push(`${ruleChurn.length} rule(s) churning`);
    if (staleness.stale) parts.push(`${staleness.stale} stale price curve(s)`);
  }

  return {
    summary: parts.join("; ") + ".",
    efficacy,
    ping_pong: pingPong,
    rule_churn: ruleChurn,
    staleness,
    all_clear: allClear,
  };
}
