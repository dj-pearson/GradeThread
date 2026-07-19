// US-1597 / AGENTIC-OS Phase 1 (Module T): the Trust & Safety agent's domain
// logic — triage the abuse / moderation / fraud / passport-integrity queues by
// severity and pattern, and summarize cross-account rings (shared signals across
// accounts). It RANKS and PROPOSES; account-level actions (suspend, step-up,
// claim denial) are HARD-CAPPED at L1 in the policy engine (vault/70-agent/agentic-os-map.md §2
// ladder note) — a human always approves them.
//
// Deterministic, fixture-tested core: severity ranking + ring detection. The
// tool supplies the reads. Evidence carries operator ids (uuids) — never emails,
// titles, image bytes, or any user PII.

// ── Severity ranking (abuse_signals) ─────────────────────────────────────────

export type AbuseSeverity = "low" | "medium" | "high" | "critical";

const SEVERITY_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export interface AbuseSignal {
  id: string;
  signal_type: string;
  severity: string;
  subject_user_id: string;
  evidence: Record<string, unknown>;
  first_seen_at: string;
}

export interface RankedSignal {
  id: string;
  signal_type: string;
  severity: string;
  subject_user_id: string;
  age_days: number;
  rank_score: number;
  rationale: string;
}

const DAY_MS = 24 * 3600_000;

// Rank open abuse signals: severity dominates, age breaks ties (an older
// unactioned high-severity signal is more urgent). Pure + deterministic.
export function rankAbuseSignals(signals: readonly AbuseSignal[], nowMs: number): RankedSignal[] {
  return signals
    .map((s) => {
      const weight = SEVERITY_WEIGHT[s.severity] ?? 0;
      const ageDays = Math.max(0, Math.floor((nowMs - Date.parse(s.first_seen_at)) / DAY_MS));
      return {
        id: s.id,
        signal_type: s.signal_type,
        severity: s.severity,
        subject_user_id: s.subject_user_id,
        age_days: ageDays,
        rank_score: weight * 1000 + Math.min(ageDays, 365),
        rationale: `${s.severity} ${s.signal_type}, ${ageDays}d open`,
      };
    })
    .sort((a, b) => b.rank_score - a.rank_score);
}

// ── Ring detection (cross-account shared signals) ────────────────────────────

// Derive the shared "ring key(s)" a signal contributes and the accounts it links.
// Only signal types whose evidence genuinely spans accounts produce a key; a
// single-account signal (e.g. submission_velocity) contributes nothing.
function ringContribution(s: AbuseSignal): { key: string; accounts: string[] } | null {
  const ev = s.evidence ?? {};
  switch (s.signal_type) {
    case "shared_payment": {
      const cust = typeof ev.stripe_customer_id === "string" ? ev.stripe_customer_id : null;
      if (!cust) return null;
      const accts = Array.isArray(ev.account_user_ids) ? ev.account_user_ids.filter((x): x is string => typeof x === "string") : [];
      return { key: `payment:${cust}`, accounts: [s.subject_user_id, ...accts] };
    }
    case "phash_collision": {
      const phash = typeof ev.phash === "string" ? ev.phash : null;
      if (!phash) return null;
      const counterpart = typeof ev.counterpart_user_id === "string" ? ev.counterpart_user_id : null;
      return { key: `phash:${phash}`, accounts: counterpart ? [s.subject_user_id, counterpart] : [s.subject_user_id] };
    }
    case "disposable_email": {
      const domain = typeof ev.email_domain === "string" ? ev.email_domain : null;
      if (!domain) return null;
      return { key: `email_domain:${domain}`, accounts: [s.subject_user_id] };
    }
    default:
      return null;
  }
}

export interface Ring {
  ring_key: string;
  signal_types: string[];
  account_count: number;
  accounts: string[];
}

export const RING_MIN_ACCOUNTS = 2;

// Cluster signals by shared ring key; a key touching >= RING_MIN_ACCOUNTS
// distinct accounts is a ring. Accounts accumulate across every signal sharing
// the key (so N accounts on one disposable domain surface together). Pure.
export function detectRings(signals: readonly AbuseSignal[]): Ring[] {
  const byKey = new Map<string, { accounts: Set<string>; types: Set<string> }>();
  for (const s of signals) {
    const c = ringContribution(s);
    if (!c) continue;
    const agg = byKey.get(c.key) ?? { accounts: new Set<string>(), types: new Set<string>() };
    for (const a of c.accounts) agg.accounts.add(a);
    agg.types.add(s.signal_type);
    byKey.set(c.key, agg);
  }
  const rings: Ring[] = [];
  for (const [key, { accounts, types }] of byKey) {
    if (accounts.size >= RING_MIN_ACCOUNTS) {
      rings.push({
        ring_key: key,
        signal_types: [...types].sort(),
        account_count: accounts.size,
        accounts: [...accounts].sort(),
      });
    }
  }
  return rings.sort((a, b) => b.account_count - a.account_count);
}

// ── The assembled memo ───────────────────────────────────────────────────────

export interface TrustSafetyTelemetry {
  abuseSignals: readonly AbuseSignal[];
  openModerationFlags: number;
  openPassportIntegritySignals: number;
  nowMs: number;
}

export interface TrustSafetyMemo {
  summary: string;
  ranked_queue: RankedSignal[];
  rings: Ring[];
  moderation_open: number;
  passport_integrity_open: number;
  all_clear: boolean;
}

const QUEUE_LIMIT = 25;

export function assembleTrustSafetyMemo(t: TrustSafetyTelemetry): TrustSafetyMemo {
  const ranked = rankAbuseSignals(t.abuseSignals, t.nowMs);
  const rings = detectRings(t.abuseSignals);
  const allClear = ranked.length === 0 && rings.length === 0 &&
    t.openModerationFlags === 0 && t.openPassportIntegritySignals === 0;

  const parts: string[] = [];
  if (allClear) {
    parts.push("Trust & Safety clear: no open abuse signals, no rings, empty moderation + passport-integrity queues.");
  } else {
    if (ranked.length) {
      const critHigh = ranked.filter((r) => r.severity === "critical" || r.severity === "high").length;
      parts.push(`${ranked.length} open abuse signal(s)${critHigh ? ` (${critHigh} high/critical)` : ""}`);
    }
    if (rings.length) parts.push(`${rings.length} cross-account ring(s)`);
    if (t.openModerationFlags) parts.push(`${t.openModerationFlags} open moderation flag(s)`);
    if (t.openPassportIntegritySignals) parts.push(`${t.openPassportIntegritySignals} passport-integrity signal(s)`);
  }

  return {
    summary: parts.join("; ") + ".",
    ranked_queue: ranked.slice(0, QUEUE_LIMIT),
    rings,
    moderation_open: t.openModerationFlags,
    passport_integrity_open: t.openPassportIntegritySignals,
    all_clear: allClear,
  };
}
