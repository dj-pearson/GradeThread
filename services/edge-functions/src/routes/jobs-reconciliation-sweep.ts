// Cron: nightly payout reconciliation sweep (US-2617, closing US-2310).
//
// The last of the three crons US-2310 found unreachable. The registry pointed
// reconciliation-sweep at /api/flipdesk/reconciliation/run, a SELLER route that
// reads workspaceOwnerId ?? userId, so a scheduler holding only the job secret
// 401d before the handler ran — every night, leaving no ledger row because the
// entry was recorded:false.
//
// I checked for an existing equivalent before writing this, which is the rule
// the other two crons in this story produced: ebay-orders-sync turned out to be
// a duplicate of a job that already worked, photo-archive did not. Neither
// guarantee-pool (the guarantee accrual) nor ebay-notification-reconcile (eBay
// topic subscriptions) touches payout_imports. So this one is real.
//
// WHAT NOT RUNNING COSTS. Payout rows sit unmatched, so a seller's books show
// money arriving against no sale. The seller can still press "Auto-match" on the
// Reconciliation page, so nothing was lost outright — the sweep exists so they
// do not have to notice.
//
// TENANT ISOLATION (US-268). Owner ids come from the payout rows, never from the
// request. Each is passed to reconcilePayoutsForOwner, whose payout read, sale
// candidates and reconcile_payout_link call are all keyed on that id.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { captureException } from "../lib/observability.ts";
import {
  listOwnersWithUnreconciledPayouts,
  reconcilePayoutsForOwner,
} from "./flipdesk-reconciliation.ts";

/** Owners to reconcile per nightly tick. */
export const RECONCILE_MAX_OWNERS_PER_RUN = 50;

/**
 * Payout rows to scan when resolving those owners. One owner can hold many
 * unreconciled payouts, so a scan capped at the OWNER count could resolve a
 * single seller and report the fleet done.
 */
export const RECONCILE_SCAN_LIMIT = RECONCILE_MAX_OWNERS_PER_RUN * 20;

/**
 * Lease covers the sweep. Higher than the sync crons' because this one does the
 * work in-request: each owner is a payout read, a candidate-sales load and up to
 * QUEUE_LIMIT link RPCs.
 */
const JOB_LOCK_LEASE_SECONDS = 900;

export interface ReconcileSweepResult {
  owners: number;
  eligible_owners: number;
  auto_matched: number;
  ambiguous: number;
  no_candidates: number;
  scanned: number;
  failed_owners: number;
}

export async function handleReconciliationSweepCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("reconciliation-sweep", JOB_LOCK_LEASE_SECONDS);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const { owners: all, error } = await listOwnersWithUnreconciledPayouts(
      RECONCILE_SCAN_LIMIT,
    );
    if (error) {
      throw new Error(
        `load owners with unreconciled payouts failed: ${
          error instanceof Error ? error.message : JSON.stringify(error)
        }`,
      );
    }

    const owners = all.slice(0, RECONCILE_MAX_OWNERS_PER_RUN);
    const result: ReconcileSweepResult = {
      owners: owners.length,
      // The whole eligible fleet, not the slice. Pinned at the scan limit run
      // after run means the sweep is not keeping up.
      eligible_owners: all.length,
      auto_matched: 0,
      ambiguous: 0,
      no_candidates: 0,
      scanned: 0,
      failed_owners: 0,
    };

    for (const ownerId of owners) {
      // One seller's books must not stop another's. reconcilePayoutsForOwner
      // already swallows a candidate-load failure per owner; this catches the
      // rest so a single bad row cannot end the night.
      try {
        const counts = await reconcilePayoutsForOwner(ownerId);
        result.auto_matched += counts.auto_matched;
        result.ambiguous += counts.ambiguous;
        result.no_candidates += counts.no_candidates;
        result.scanned += counts.scanned;
      } catch (err) {
        result.failed_owners++;
        console.warn(
          `[reconciliation-sweep] owner ${ownerId} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "jobs-reconciliation-sweep.cron" });
    return c.json({ error: "Reconciliation sweep failed" }, 500);
  } finally {
    await lock.release();
  }
}
