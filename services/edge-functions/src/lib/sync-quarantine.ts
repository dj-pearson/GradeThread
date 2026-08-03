/**
 * US-2324 AC3: a record that fails every time stops being retried every time.
 *
 * THE SHAPE OF THE PROBLEM. The Etsy and Depop syncs keep no cursor — each run
 * re-reads the provider's recent window from the beginning. US-2324's per-record
 * try/catch stopped one bad record killing the tail behind it, but the record is
 * still attempted on every run, and its failure is only a log line. A malformed
 * order from three weeks ago costs an API call and an error entry forever, and
 * the noise is what makes the log unreadable when something new breaks.
 *
 * Quarantine is deliberately NOT "give up". The row stays, with its attempt
 * count and its last error, and clearing `quarantined_at` is the retry action.
 * Deleting the record's history to retry it would throw away the evidence of why
 * it was skipped, which is the thing an operator needs first.
 *
 * Pure: the threshold decision is testable without a database, and the database
 * work stays in the caller where it can be seen.
 */

/**
 * How many failures before a record is set aside.
 *
 * Three, not one: the syncs run against a live provider API, and a single
 * failure is far more likely to be a timeout or a 502 than a genuinely bad
 * record. Quarantining on the first failure would set aside real orders during
 * any provider blip — turning a transient outage into a silent backlog, which is
 * the failure this is supposed to prevent, not cause.
 *
 * Not higher, because the whole point is to stop paying for a record that will
 * never succeed, and by the third identical failure that is what it is.
 */
export const QUARANTINE_AFTER_ATTEMPTS = 3;

export interface FailureRow {
  external_id: string;
  attempts: number;
  quarantined_at: string | null;
}

/**
 * Should this record be skipped on this pass?
 *
 * Reads the STORED flag rather than re-deriving it from the count. The two can
 * legitimately disagree: an operator clearing `quarantined_at` to retry leaves
 * the attempt history intact on purpose, and a re-derived answer would ignore
 * that and skip the record anyway — making the retry button do nothing.
 */
export function isQuarantined(row: FailureRow | undefined): boolean {
  return Boolean(row?.quarantined_at);
}

/**
 * The next state for a record that just failed.
 *
 * Returns the new attempt count and whether this failure is the one that trips
 * the threshold. `justQuarantined` is separate from `quarantine` so the caller
 * can log the transition once instead of on every subsequent failure — a line
 * that repeats every run is the noise this exists to remove.
 */
export function nextFailureState(
  row: FailureRow | undefined,
  threshold = QUARANTINE_AFTER_ATTEMPTS,
): { attempts: number; quarantine: boolean; justQuarantined: boolean } {
  const attempts = (row?.attempts ?? 0) + 1;
  const alreadyQuarantined = Boolean(row?.quarantined_at);
  const quarantine = alreadyQuarantined || attempts >= threshold;
  return { attempts, quarantine, justQuarantined: quarantine && !alreadyQuarantined };
}

/**
 * Index a failure list by the provider's record id.
 *
 * Returned as a Map so the loop is one lookup per record rather than a scan per
 * record — the sync handles hundreds of records per pass, and an accidental
 * O(n²) here would be invisible until a seller got large.
 */
export function indexFailures(rows: readonly FailureRow[]): Map<string, FailureRow> {
  return new Map(rows.map((r) => [r.external_id, r]));
}

// ── the database half ───────────────────────────────────────────────────────
//
// Kept beside the decisions rather than in the route, because both connectors
// need exactly this and two copies of it would drift — which is how the Etsy and
// Depop syncs ended up with two copies of the same three-line loop and two
// copies of the same bug (US-2324 AC1/AC2).

import { supabaseAdmin } from "./supabase.ts";

const TABLE = "marketplace_sync_failures";

/** Every known failure for one seller's connection, indexed by provider id. */
export async function loadSyncFailures(
  ownerUserId: string,
  marketplace: string,
): Promise<Map<string, FailureRow>> {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("external_id, attempts, quarantined_at")
    .eq("owner_user_id", ownerUserId)
    .eq("marketplace", marketplace);
  if (error) {
    // FAIL OPEN, deliberately: an unreadable quarantine list must not stop the
    // sync. The cost of failing open is re-attempting a known-bad record for one
    // run; the cost of failing closed would be skipping every GOOD record on a
    // transient read error, which is the outage this feature is meant to avoid
    // causing.
    console.error(`[sync-quarantine] ${marketplace} failure load failed:`, error.message);
    return new Map();
  }
  return indexFailures((data ?? []) as FailureRow[]);
}

/**
 * Record one record's failure, quarantining it once it crosses the threshold.
 * Returns true when THIS call is the one that quarantined it, so the caller logs
 * the transition once rather than on every run afterwards.
 */
export async function recordSyncFailure(args: {
  ownerUserId: string;
  marketplace: string;
  externalId: string;
  message: string;
  prior: FailureRow | undefined;
}): Promise<boolean> {
  const { attempts, quarantine, justQuarantined } = nextFailureState(args.prior);
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from(TABLE)
    .upsert(
      {
        owner_user_id: args.ownerUserId,
        marketplace: args.marketplace,
        external_id: args.externalId,
        attempts,
        last_error: args.message.slice(0, 1000),
        last_failed_at: now,
        quarantined_at: quarantine ? (args.prior?.quarantined_at ?? now) : null,
      } as never,
      { onConflict: "owner_user_id,marketplace,external_id" },
    );
  if (error) {
    // Not fatal: the record already failed and the caller is already reporting
    // that. Losing the COUNT only means it gets retried a little longer.
    console.error(`[sync-quarantine] ${args.marketplace} failure write failed:`, error.message);
    return false;
  }
  return justQuarantined;
}

/**
 * A record that succeeded has no failure history worth keeping.
 *
 * Only called when a prior row EXISTS — a delete per successful record on every
 * run would be hundreds of pointless writes, and this sync re-reads its whole
 * window every time.
 */
export async function clearSyncFailure(
  ownerUserId: string,
  marketplace: string,
  externalId: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from(TABLE)
    .delete()
    .eq("owner_user_id", ownerUserId)
    .eq("marketplace", marketplace)
    .eq("external_id", externalId);
  if (error) {
    console.error(`[sync-quarantine] ${marketplace} failure clear failed:`, error.message);
  }
}
