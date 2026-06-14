// Abuse-signal derivation (US-888).
//
// Pure, unit-tested builders that turn raw, cross-tenant rows into the durable
// abuse_signals records the scheduled scan upserts. Keeping the detection logic
// here (no DB, no IO) means the fraud heuristics are deterministic and testable,
// and the SAFETY invariant — a signal's evidence carries only the collision
// FACT (ids + hashes + counts), never image bytes or signed URLs (US-888 AC4) —
// is enforced and asserted in one place.

import { hammingHex, REUSE_MAX_HAMMING_DEFAULT } from "./photo-reuse.ts";

export type AbuseSignalType =
  | "phash_collision"
  | "submission_velocity"
  | "shared_payment"
  | "disposable_email";

export type AbuseSignalSeverity = "low" | "medium" | "high" | "critical";

export type AbuseSignalStatus = "open" | "reviewing" | "actioned" | "dismissed";

// A signal record as the scan upserts it. `evidence` is intentionally a plain
// allow-listed object — see assertSafeEvidence below.
export interface AbuseSignalRecord {
  signal_type: AbuseSignalType;
  severity: AbuseSignalSeverity;
  subject_user_id: string;
  dedupe_key: string;
  evidence: Record<string, unknown>;
}

const HEX16 = /^[0-9a-f]{16}$/i;

// ── Safety: evidence may only carry the collision fact, never image bytes ─────
//
// Every key that may appear in any signal's evidence. The build functions only
// ever emit these; assertSafeEvidence() is the runtime backstop (and the test
// hook) guaranteeing no photo bytes / data: URIs / storage URLs slip in.
const EVIDENCE_KEY_ALLOWLIST = new Set<string>([
  // phash_collision
  "phash",
  "distance",
  "counterpart_user_id",
  "reused_count",
  "matches",
  // submission_velocity
  "count",
  "window_hours",
  "since",
  // shared_payment
  "stripe_customer_id",
  "account_count",
  "account_user_ids",
  // disposable_email
  "email_domain",
]);

// Keys permitted inside a phash_collision evidence.matches[] entry — ids + the
// hash + the distance, nothing that could reconstruct or transit image content.
const MATCH_KEY_ALLOWLIST = new Set<string>([
  "subject_submission_id",
  "subject_image_id",
  "counterpart_submission_id",
  "counterpart_image_id",
  "image_type",
  "phash",
  "distance",
]);

// A value looks like it could be image content / a fetchable photo reference.
function looksLikeImagePayload(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  return (
    s.startsWith("data:image") ||
    s.startsWith("http://") ||
    s.startsWith("https://") ||
    s.includes("/storage/") ||
    s.includes("submission-images") ||
    s.length > 512 // no short id/hash is this long; a base64 blob would be
  );
}

/**
 * Throw if a signal's evidence carries anything outside the allow-list or that
 * looks like image bytes / a photo URL. The cross-tenant safety guarantee
 * (AC4): the only thing that ever crosses from one tenant's row into a signal an
 * operator (or another tenant's investigation) sees is the collision fact and
 * opaque ids — never the photo itself. Pure; called by the builders and the
 * tests.
 */
export function assertSafeEvidence(evidence: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(evidence)) {
    if (!EVIDENCE_KEY_ALLOWLIST.has(key)) {
      throw new Error(`abuse-signals: evidence key "${key}" is not allow-listed`);
    }
    if (key === "matches") {
      if (!Array.isArray(value)) {
        throw new Error("abuse-signals: evidence.matches must be an array");
      }
      for (const m of value) {
        if (!m || typeof m !== "object") {
          throw new Error("abuse-signals: evidence.matches entry must be an object");
        }
        for (const [mk, mv] of Object.entries(m as Record<string, unknown>)) {
          if (!MATCH_KEY_ALLOWLIST.has(mk)) {
            throw new Error(`abuse-signals: match key "${mk}" is not allow-listed`);
          }
          if (looksLikeImagePayload(mv)) {
            throw new Error(`abuse-signals: match key "${mk}" looks like image content`);
          }
        }
      }
      continue;
    }
    if (looksLikeImagePayload(value)) {
      throw new Error(`abuse-signals: evidence key "${key}" looks like image content`);
    }
  }
}

// ── phash collision (cross-account photo reuse) ──────────────────────────────

export interface PhashImageRow {
  image_id: string;
  submission_id: string;
  user_id: string;
  image_type: string | null;
  phash: string | null;
  created_at: string | null;
}

interface CollisionMatch {
  subject_submission_id: string;
  subject_image_id: string;
  counterpart_submission_id: string;
  counterpart_image_id: string;
  image_type: string | null;
  phash: string;
  distance: number;
}

// Severity grows with how many distinct photos one account reused from another.
function phashSeverity(reusedCount: number): AbuseSignalSeverity {
  if (reusedCount >= 4) return "critical";
  if (reusedCount >= 2) return "high";
  return "medium";
}

// Stable, direction-independent dedupe key for a pair of accounts so a re-scan
// updates the same signal regardless of which side is "subject" this run.
export function phashCollisionDedupeKey(userA: string, userB: string): string {
  const [a, b] = [userA, userB].sort();
  return `phash_collision:${a}|${b}`;
}

/**
 * Detect cross-account perceptual-hash collisions among the supplied images.
 * Only DIFFERENT-account matches within the Hamming threshold count (a
 * same-account relist is not abuse). Produces one signal per offending account
 * PAIR, with the reuser (most-recent colliding image) as the subject. O(n^2)
 * over the bounded candidate set — the caller limits how many rows it passes.
 * Pure: no DB, no clock; the dedupe key carries the cross-run identity.
 */
export function buildPhashCollisionSignals(
  images: PhashImageRow[],
  opts: { maxHamming?: number } = {},
): AbuseSignalRecord[] {
  const threshold = opts.maxHamming ?? REUSE_MAX_HAMMING_DEFAULT;
  const hashed = images.filter(
    (i): i is PhashImageRow & { phash: string } =>
      typeof i.phash === "string" && HEX16.test(i.phash) && !!i.user_id,
  );

  // Per account-pair aggregation of every colliding image pair between them.
  interface PairAgg {
    userA: string;
    userB: string;
    matches: CollisionMatch[];
  }
  const pairs = new Map<string, PairAgg>();

  for (let i = 0; i < hashed.length; i++) {
    for (let j = i + 1; j < hashed.length; j++) {
      const a = hashed[i]!;
      const b = hashed[j]!;
      if (a.user_id === b.user_id) continue; // same-account relist: not abuse
      const distance = hammingHex(a.phash, b.phash);
      if (distance > threshold) continue;

      // Subject = the account whose image is NEWER (the likely reuser); fall
      // back to a stable id ordering when timestamps are equal/absent.
      const aNewer = (a.created_at ?? "") === (b.created_at ?? "")
        ? a.image_id > b.image_id
        : (a.created_at ?? "") > (b.created_at ?? "");
      const subject = aNewer ? a : b;
      const counterpart = aNewer ? b : a;

      const key = phashCollisionDedupeKey(subject.user_id, counterpart.user_id);
      let agg = pairs.get(key);
      if (!agg) {
        agg = { userA: subject.user_id, userB: counterpart.user_id, matches: [] };
        pairs.set(key, agg);
      }
      agg.matches.push({
        subject_submission_id: subject.submission_id,
        subject_image_id: subject.image_id,
        counterpart_submission_id: counterpart.submission_id,
        counterpart_image_id: counterpart.image_id,
        image_type: subject.image_type,
        phash: subject.phash,
        distance,
      });
    }
  }

  const records: AbuseSignalRecord[] = [];
  for (const agg of pairs.values()) {
    const reusedCount = agg.matches.length;
    const evidence: Record<string, unknown> = {
      counterpart_user_id: agg.userB,
      reused_count: reusedCount,
      matches: agg.matches,
    };
    assertSafeEvidence(evidence);
    records.push({
      signal_type: "phash_collision",
      severity: phashSeverity(reusedCount),
      subject_user_id: agg.userA,
      dedupe_key: phashCollisionDedupeKey(agg.userA, agg.userB),
      evidence,
    });
  }
  // Deterministic ordering (worst first) for stable output + tests.
  records.sort((x, y) => {
    const rc = (y.evidence.reused_count as number) - (x.evidence.reused_count as number);
    if (rc !== 0) return rc;
    return x.dedupe_key.localeCompare(y.dedupe_key);
  });
  return records;
}

// ── submission velocity ──────────────────────────────────────────────────────

export interface SubmissionRow {
  user_id: string;
  created_at: string | null;
}

function velocitySeverity(count: number, threshold: number): AbuseSignalSeverity {
  if (count >= threshold * 3) return "critical";
  if (count >= threshold * 2) return "high";
  return "medium";
}

// One signal per account per UTC day so each day's burst is independently
// triageable and a re-scan the same day updates the running count.
export function velocityDedupeKey(userId: string, sinceIso: string): string {
  const day = sinceIso.slice(0, 10); // YYYY-MM-DD (UTC)
  return `submission_velocity:${userId}:${day}`;
}

/**
 * Flag accounts that created at least `threshold` submissions inside the window.
 * `recent` must already be the submissions within [since, now). Pure.
 */
export function buildVelocitySignals(
  recent: SubmissionRow[],
  opts: { threshold: number; sinceIso: string; windowHours: number },
): AbuseSignalRecord[] {
  const counts = new Map<string, number>();
  for (const s of recent) {
    if (!s.user_id) continue;
    counts.set(s.user_id, (counts.get(s.user_id) ?? 0) + 1);
  }
  const records: AbuseSignalRecord[] = [];
  for (const [userId, count] of counts) {
    if (count < opts.threshold) continue;
    const evidence: Record<string, unknown> = {
      count,
      window_hours: opts.windowHours,
      since: opts.sinceIso,
    };
    assertSafeEvidence(evidence);
    records.push({
      signal_type: "submission_velocity",
      severity: velocitySeverity(count, opts.threshold),
      subject_user_id: userId,
      dedupe_key: velocityDedupeKey(userId, opts.sinceIso),
      evidence,
    });
  }
  records.sort((x, y) => (y.evidence.count as number) - (x.evidence.count as number));
  return records;
}
