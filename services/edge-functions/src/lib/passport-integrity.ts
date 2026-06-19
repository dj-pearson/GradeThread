// Garment Passport integrity-anomaly derivation (US-1103).
//
// Pure, unit-tested builders that turn raw passport rows into the durable
// passport_integrity_signals the admin console triages. Detection lives here (no
// DB, no IO, no clock beyond what the caller passes) so the fraud heuristics are
// deterministic and testable, and the SAFETY invariant — a signal's evidence
// carries only the anomaly FACT (garment / owner-node / event ids + hashes +
// counts), never image bytes or PII — is enforced and asserted in one place.
//
// Mirrors the abuse-signals module (US-888): one record per concern, a stable
// dedupe_key so the scan is idempotent, and assertSafePassportEvidence() as the
// runtime backstop. Where it differs: signals are keyed on garment_id (passport
// participants are pseudonymous owner_nodes, not user accounts).

import { hammingHex, REUSE_MAX_HAMMING_DEFAULT } from "./photo-reuse.ts";

export type PassportIntegrityType =
  | "wear_reversal" // condition improved across a 'same item' link
  | "duplicate_fingerprint" // same fingerprint on two active garments / owners
  | "rapid_reclaim" // a passport reclaimed many times in a short window
  | "token_replay"; // repeated redemption attempts on a used/expired token

export type IntegritySeverity = "low" | "medium" | "high" | "critical";

export type IntegrityStatus = "open" | "reviewing" | "actioned" | "dismissed";

// A signal record as the scan upserts it. `evidence` is an allow-listed object —
// see assertSafePassportEvidence below.
export interface IntegritySignalRecord {
  signal_type: PassportIntegrityType;
  severity: IntegritySeverity;
  garment_id: string;
  dedupe_key: string;
  evidence: Record<string, unknown>;
}

const HEX16 = /^[0-9a-f]{16}$/i;

// ── Safety: evidence may only carry the anomaly fact, never image bytes / PII ──
//
// Every key any builder may emit. assertSafePassportEvidence() is the runtime
// backstop (and the test hook) guaranteeing no photo bytes / data: URIs / storage
// URLs / emails slip into an operator-visible signal.
const EVIDENCE_KEY_ALLOWLIST = new Set<string>([
  // wear_reversal
  "from_wear_score",
  "to_wear_score",
  "drop",
  "from_event_id",
  "to_event_id",
  "from_grade_report_id",
  "to_grade_report_id",
  "link_event_id",
  "link_confidence",
  // duplicate_fingerprint
  "counterpart_garment_id",
  "counterpart_owner_node_id",
  "owner_node_id",
  "phash",
  "image_type",
  "distance",
  "matches",
  // rapid_reclaim
  "reclaim_count",
  "window_hours",
  "since",
  "first_at",
  "last_at",
  // token_replay
  "token_hash",
  "rejected_count",
  "attempt_count",
]);

// Keys permitted inside a duplicate_fingerprint evidence.matches[] entry.
const MATCH_KEY_ALLOWLIST = new Set<string>([
  "image_type",
  "phash",
  "distance",
  "counterpart_image_type",
]);

// A value looks like it could be image content / a fetchable photo reference / an
// email. (token_hash + phash are short lowercase hex and pass cleanly.)
function looksUnsafe(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  return (
    s.startsWith("data:image") ||
    s.startsWith("http://") ||
    s.startsWith("https://") ||
    s.includes("/storage/") ||
    s.includes("submission-images") ||
    s.includes("@") || // an email address
    s.length > 512 // no short id/hash is this long; a base64 blob would be
  );
}

/**
 * Throw if a signal's evidence carries anything outside the allow-list or that
 * looks like image bytes / a photo URL / an email. The operator-safety guarantee:
 * the only thing that ever crosses into a signal an admin sees is the anomaly
 * fact and opaque ids/hashes — never the photo itself or a participant's PII.
 * Pure; called by the builders and the tests.
 */
export function assertSafePassportEvidence(evidence: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(evidence)) {
    if (!EVIDENCE_KEY_ALLOWLIST.has(key)) {
      throw new Error(`passport-integrity: evidence key "${key}" is not allow-listed`);
    }
    if (key === "matches") {
      if (!Array.isArray(value)) {
        throw new Error("passport-integrity: evidence.matches must be an array");
      }
      for (const m of value) {
        if (!m || typeof m !== "object") {
          throw new Error("passport-integrity: evidence.matches entry must be an object");
        }
        for (const [mk, mv] of Object.entries(m as Record<string, unknown>)) {
          if (!MATCH_KEY_ALLOWLIST.has(mk)) {
            throw new Error(`passport-integrity: match key "${mk}" is not allow-listed`);
          }
          if (looksUnsafe(mv)) {
            throw new Error(`passport-integrity: match key "${mk}" looks unsafe`);
          }
        }
      }
      continue;
    }
    if (looksUnsafe(value)) {
      throw new Error(`passport-integrity: evidence key "${key}" looks unsafe`);
    }
  }
}

// ── wear reversal (condition improved across a 'same item' link) ──────────────
//
// wear_score is bounded [0,10] and INCREASES with wear (10 − condition), so a
// real later sighting of the same garment should be >= an earlier one (the
// US-1098 wear-monotonicity gate). A LATER fingerprint that is materially LOWER
// (condition improved) is physically impossible without a swap — the headline
// "impossible chain" signal. We compare consecutive fingerprints ordered by time.

export interface FingerprintRow {
  id: string;
  garment_id: string;
  grade_report_id: string | null;
  wear_score: number;
  created_at: string | null;
}

// Default tolerance: a drop must exceed this many wear points to flag, so grading
// noise (±0.5) doesn't trip it. 1.0 ≈ a full condition point of "improvement".
export const WEAR_REVERSAL_TOLERANCE = 1.0;

function wearSeverity(drop: number): IntegritySeverity {
  if (drop >= 4) return "critical";
  if (drop >= 2.5) return "high";
  return "medium";
}

export function wearReversalDedupeKey(
  garmentId: string,
  fromId: string,
  toId: string,
): string {
  return `wear_reversal:${garmentId}:${fromId}->${toId}`;
}

/**
 * Flag garments whose condition IMPROVED across consecutive fingerprints. One
 * signal per offending adjacent pair (the largest reversal on a garment is
 * surfaced first via severity). `rows` may be unsorted and span many garments.
 * Pure.
 */
export function buildWearReversalSignals(
  rows: FingerprintRow[],
  opts: { tolerance?: number } = {},
): IntegritySignalRecord[] {
  const tolerance = opts.tolerance ?? WEAR_REVERSAL_TOLERANCE;
  const byGarment = new Map<string, FingerprintRow[]>();
  for (const r of rows) {
    if (!r.garment_id || typeof r.wear_score !== "number") continue;
    const list = byGarment.get(r.garment_id) ?? [];
    list.push(r);
    byGarment.set(r.garment_id, list);
  }

  const records: IntegritySignalRecord[] = [];
  for (const [garmentId, list] of byGarment) {
    if (list.length < 2) continue;
    // Oldest → newest; stable id tiebreak when timestamps collide.
    list.sort((a, b) => {
      const at = a.created_at ?? "";
      const bt = b.created_at ?? "";
      if (at === bt) return a.id.localeCompare(b.id);
      return at < bt ? -1 : 1;
    });
    for (let i = 1; i < list.length; i++) {
      const from = list[i - 1]!;
      const to = list[i]!;
      const drop = from.wear_score - to.wear_score; // >0 means condition improved
      if (drop <= tolerance) continue;
      const evidence: Record<string, unknown> = {
        from_wear_score: from.wear_score,
        to_wear_score: to.wear_score,
        drop: Math.round(drop * 10) / 10,
        from_event_id: from.id,
        to_event_id: to.id,
        from_grade_report_id: from.grade_report_id,
        to_grade_report_id: to.grade_report_id,
      };
      assertSafePassportEvidence(evidence);
      records.push({
        signal_type: "wear_reversal",
        severity: wearSeverity(drop),
        garment_id: garmentId,
        dedupe_key: wearReversalDedupeKey(garmentId, from.id, to.id),
        evidence,
      });
    }
  }
  // Worst (largest drop) first; stable dedupe_key tiebreak.
  records.sort((x, y) => {
    const d = (y.evidence.drop as number) - (x.evidence.drop as number);
    if (d !== 0) return d;
    return x.dedupe_key.localeCompare(y.dedupe_key);
  });
  return records;
}

// ── duplicate fingerprint across active owners ────────────────────────────────
//
// The SAME physical garment can't be in two ACTIVE passport chains held by
// DIFFERENT owner nodes at once. We compare each active garment's fingerprint
// hashes against every other's (cross-product best, by image_type when present),
// and flag a near-collision between DIFFERENT garments whose CURRENT owner nodes
// differ. Reuses the shared dHash Hamming space + threshold.

export interface ActiveGarmentFingerprint {
  garment_id: string;
  owner_node_id: string | null;
  // image_type -> phash (16-hex). Junk silently ignored.
  phashes: Record<string, string>;
}

interface DupMatch {
  image_type: string;
  phash: string;
  distance: number;
  counterpart_image_type: string;
}

function dupSeverity(matchCount: number): IntegritySeverity {
  if (matchCount >= 3) return "critical";
  if (matchCount >= 2) return "high";
  return "medium";
}

// Direction-independent key for a garment pair so a re-scan updates one signal.
export function duplicateFingerprintDedupeKey(
  garmentA: string,
  garmentB: string,
): string {
  const [a, b] = [garmentA, garmentB].sort();
  return `duplicate_fingerprint:${a}|${b}`;
}

/**
 * Detect the same visual fingerprint on two ACTIVE garments held by DIFFERENT
 * owner nodes. One signal per offending garment PAIR (subject = the
 * lexicographically-smaller garment id for stability). O(n^2) over the bounded
 * candidate set — the caller limits how many rows it passes. Pure.
 */
export function buildDuplicateFingerprintSignals(
  garments: ActiveGarmentFingerprint[],
  opts: { maxHamming?: number } = {},
): IntegritySignalRecord[] {
  const threshold = opts.maxHamming ?? REUSE_MAX_HAMMING_DEFAULT;
  // Pre-normalize each garment's hash entries to valid 16-hex.
  const norm = garments.map((g) => ({
    garment_id: g.garment_id,
    owner_node_id: g.owner_node_id,
    entries: Object.entries(g.phashes ?? {}).filter(
      ([, v]) => typeof v === "string" && HEX16.test(v),
    ) as Array<[string, string]>,
  })).filter((g) => g.garment_id && g.entries.length > 0);

  const records: IntegritySignalRecord[] = [];
  for (let i = 0; i < norm.length; i++) {
    for (let j = i + 1; j < norm.length; j++) {
      const a = norm[i]!;
      const b = norm[j]!;
      if (a.garment_id === b.garment_id) continue;
      // Both must have a CURRENT owner and they must DIFFER (same owner relisting
      // their own item is not a duplicate-owner anomaly).
      if (!a.owner_node_id || !b.owner_node_id) continue;
      if (a.owner_node_id === b.owner_node_id) continue;

      // Best per-image-type collision across the cross-product.
      const matches: DupMatch[] = [];
      for (const [atype, ahash] of a.entries) {
        let best: DupMatch | null = null;
        for (const [btype, bhash] of b.entries) {
          const distance = hammingHex(ahash, bhash);
          if (distance > threshold) continue;
          if (!best || distance < best.distance) {
            best = { image_type: atype, phash: ahash, distance, counterpart_image_type: btype };
          }
        }
        if (best) matches.push(best);
      }
      if (matches.length === 0) continue;

      const [subject, counterpart] = a.garment_id < b.garment_id ? [a, b] : [b, a];
      matches.sort((x, y) => x.distance - y.distance || x.image_type.localeCompare(y.image_type));
      const evidence: Record<string, unknown> = {
        counterpart_garment_id: counterpart.garment_id,
        owner_node_id: subject.owner_node_id,
        counterpart_owner_node_id: counterpart.owner_node_id,
        matches,
      };
      assertSafePassportEvidence(evidence);
      records.push({
        signal_type: "duplicate_fingerprint",
        severity: dupSeverity(matches.length),
        garment_id: subject.garment_id,
        dedupe_key: duplicateFingerprintDedupeKey(a.garment_id, b.garment_id),
        evidence,
      });
    }
  }
  records.sort((x, y) => {
    const ma = (x.evidence.matches as DupMatch[]).length;
    const mb = (y.evidence.matches as DupMatch[]).length;
    if (mb !== ma) return mb - ma;
    return x.dedupe_key.localeCompare(y.dedupe_key);
  });
  return records;
}

// ── rapid re-claim (passport churn) ───────────────────────────────────────────
//
// A garment whose passport was CLAIMED (ownership handed off) many times in a
// short window is suspicious — claim-link churn / resale laundering. We count
// successful claim attempts per garment inside the window.

export interface ClaimAttemptRow {
  garment_id: string | null;
  token_hash: string;
  outcome: "claimed" | "rejected";
  created_at: string | null;
}

function reclaimSeverity(count: number, threshold: number): IntegritySeverity {
  if (count >= threshold * 3) return "critical";
  if (count >= threshold * 2) return "high";
  return "medium";
}

export function rapidReclaimDedupeKey(garmentId: string, sinceIso: string): string {
  const day = sinceIso.slice(0, 10); // YYYY-MM-DD (UTC) — one signal per window-day
  return `rapid_reclaim:${garmentId}:${day}`;
}

/**
 * Flag garments with at least `threshold` SUCCESSFUL claims inside the window.
 * `attempts` must already be the claim attempts within [since, now). Pure.
 */
export function buildRapidReclaimSignals(
  attempts: ClaimAttemptRow[],
  opts: { threshold: number; sinceIso: string; windowHours: number },
): IntegritySignalRecord[] {
  interface Agg {
    count: number;
    first: string;
    last: string;
  }
  const byGarment = new Map<string, Agg>();
  for (const a of attempts) {
    if (a.outcome !== "claimed" || !a.garment_id) continue;
    const at = a.created_at ?? "";
    const agg = byGarment.get(a.garment_id) ?? { count: 0, first: at, last: at };
    agg.count += 1;
    if (at && (!agg.first || at < agg.first)) agg.first = at;
    if (at && (!agg.last || at > agg.last)) agg.last = at;
    byGarment.set(a.garment_id, agg);
  }

  const records: IntegritySignalRecord[] = [];
  for (const [garmentId, agg] of byGarment) {
    if (agg.count < opts.threshold) continue;
    const evidence: Record<string, unknown> = {
      reclaim_count: agg.count,
      window_hours: opts.windowHours,
      since: opts.sinceIso,
      first_at: agg.first || null,
      last_at: agg.last || null,
    };
    assertSafePassportEvidence(evidence);
    records.push({
      signal_type: "rapid_reclaim",
      severity: reclaimSeverity(agg.count, opts.threshold),
      garment_id: garmentId,
      dedupe_key: rapidReclaimDedupeKey(garmentId, opts.sinceIso),
      evidence,
    });
  }
  records.sort((x, y) =>
    (y.evidence.reclaim_count as number) - (x.evidence.reclaim_count as number) ||
    x.dedupe_key.localeCompare(y.dedupe_key)
  );
  return records;
}

// ── token replay ──────────────────────────────────────────────────────────────
//
// Repeated REJECTED redemption attempts against a token that maps to a REAL
// garment (an already-claimed / expired token being replayed) is a probe. We
// count rejected attempts per (garment, token_hash) within the window; the caller
// supplies only attempts whose token_hash resolved to a known token + garment.

export interface ReplayAttemptRow {
  garment_id: string;
  token_hash: string;
  outcome: "claimed" | "rejected";
  created_at: string | null;
}

function replaySeverity(count: number, threshold: number): IntegritySeverity {
  if (count >= threshold * 4) return "critical";
  if (count >= threshold * 2) return "high";
  return "medium";
}

export function tokenReplayDedupeKey(
  garmentId: string,
  tokenHash: string,
  sinceIso: string,
): string {
  const day = sinceIso.slice(0, 10);
  // The token hash is opaque; truncate it in the key for readability.
  return `token_replay:${garmentId}:${tokenHash.slice(0, 12)}:${day}`;
}

/**
 * Flag tokens that received at least `threshold` REJECTED redemption attempts in
 * the window — a replay/brute probe against a known (used/expired) token. Pure.
 */
export function buildTokenReplaySignals(
  attempts: ReplayAttemptRow[],
  opts: { threshold: number; sinceIso: string; windowHours: number },
): IntegritySignalRecord[] {
  interface Agg {
    garmentId: string;
    tokenHash: string;
    rejected: number;
    total: number;
  }
  const byToken = new Map<string, Agg>();
  for (const a of attempts) {
    if (!a.garment_id || !a.token_hash) continue;
    const key = `${a.garment_id}:${a.token_hash}`;
    const agg = byToken.get(key) ??
      { garmentId: a.garment_id, tokenHash: a.token_hash, rejected: 0, total: 0 };
    agg.total += 1;
    if (a.outcome === "rejected") agg.rejected += 1;
    byToken.set(key, agg);
  }

  const records: IntegritySignalRecord[] = [];
  for (const agg of byToken.values()) {
    if (agg.rejected < opts.threshold) continue;
    const evidence: Record<string, unknown> = {
      token_hash: agg.tokenHash,
      rejected_count: agg.rejected,
      attempt_count: agg.total,
      window_hours: opts.windowHours,
      since: opts.sinceIso,
    };
    assertSafePassportEvidence(evidence);
    records.push({
      signal_type: "token_replay",
      severity: replaySeverity(agg.rejected, opts.threshold),
      garment_id: agg.garmentId,
      dedupe_key: tokenReplayDedupeKey(agg.garmentId, agg.tokenHash, opts.sinceIso),
      evidence,
    });
  }
  records.sort((x, y) =>
    (y.evidence.rejected_count as number) - (x.evidence.rejected_count as number) ||
    x.dedupe_key.localeCompare(y.dedupe_key)
  );
  return records;
}
