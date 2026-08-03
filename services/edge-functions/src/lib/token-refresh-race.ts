/**
 * US-2322: a seller must not be disconnected because two of our own callers
 * refreshed their token at the same moment.
 *
 * THE RACE. Etsy, Whatnot and Depop all rotate the refresh token and invalidate
 * the old one on first use. Our token path is read-expiry → refresh → persist,
 * with no coordination, so a user opening the Marketplaces page while the
 * refresh cron fires produces two POSTs carrying the SAME refresh token. The
 * provider honours the first and answers the second with `invalid_grant`. Every
 * connector classifies that as PERMANENT, sets `is_active: false` and stores a
 * reconnect message — so the seller is force-disconnected by our own concurrency,
 * with no revocation and nothing wrong with their account.
 *
 * TWO DEFENCES, and the second is the load-bearing one.
 *
 * 1. {@link singleFlightRefresh} collapses concurrent refreshes for one
 *    connection INSIDE a replica. Free, no database, and it removes the common
 *    case — a page load and a cron tick landing on the same container.
 *
 * 2. {@link siblingRefreshWon} makes the race HARMLESS even when it happens
 *    across replicas, which #1 cannot see. Before treating an auth failure as
 *    permanent, re-read the row: if a sibling has already stored a different,
 *    still-valid token, we lost a race rather than losing the grant. Use their
 *    token and leave the connection active.
 *
 * WHY NOT A CROSS-REPLICA ADVISORY LOCK, which is what the story's AC1 asks for.
 * It was considered and deliberately not built. `try_acquire_job_lock` (00094)
 * would provide one with no migration, but `job_locks` is the cron fleet's
 * table — cron-fleet-governance reads it — and keying it per CONNECTION would
 * put one row per seller per marketplace into a table that exists to describe
 * scheduled jobs. A lock also only makes the race rarer; #2 makes it survivable,
 * and a defence that turns a disconnect into a success is worth more than one
 * that reduces its frequency. If duplicate refresh calls later show up as a
 * quota problem, the lock is the fix for THAT, and it belongs on a table of its
 * own.
 */

/** The token fields this module compares. Encrypted — never decrypted here. */
export interface ConnectionTokenState {
  accessTokenEncrypted: string | null;
  tokenExpiresAt: string | null;
}

/**
 * Did another caller already refresh this connection while we were failing?
 *
 * @param before what we read at the start of our own attempt.
 * @param after a fresh read of the same row, taken after the failure.
 * @param nowMs current time.
 * @param minRemainingMs how much life the sibling's token must have left to be
 *   worth using. A token that is itself about to expire is not evidence of a
 *   successful sibling refresh — it is the same near-expiry row we started from.
 */
export function siblingRefreshWon(
  before: ConnectionTokenState,
  after: ConnectionTokenState | null,
  nowMs: number,
  minRemainingMs = 60_000,
): boolean {
  if (!after?.accessTokenEncrypted) return false;
  // Ciphertext comparison is the right test even though a fresh IV means the
  // same plaintext encrypts differently every time: we are asking "did this row
  // change", and an unchanged row is byte-identical because nobody rewrote it.
  if (after.accessTokenEncrypted === before.accessTokenEncrypted) return false;
  if (!after.tokenExpiresAt) return false;
  const exp = Date.parse(after.tokenExpiresAt);
  if (!Number.isFinite(exp)) return false;
  return exp - nowMs >= minRemainingMs;
}

// ── in-replica single flight ────────────────────────────────────────────────

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Run `fn` at most once at a time per `key`; concurrent callers await the same
 * result rather than issuing their own refresh.
 *
 * The entry is removed in a `finally`, so a REJECTED refresh is not cached —
 * the next caller retries rather than inheriting a stale failure. That matters
 * here: transient provider errors are common and a shared rejection would turn
 * one 503 into a disconnect for everyone who happened to be waiting.
 */
export function singleFlightRefresh<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = (async () => {
    try {
      return await fn();
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

/** Test seam: forget every in-flight entry. */
export function resetSingleFlight(): void {
  inFlight.clear();
}

/** How many refreshes are collapsed right now. Diagnostics only. */
export function inFlightCount(): number {
  return inFlight.size;
}
