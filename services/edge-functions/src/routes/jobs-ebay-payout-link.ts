// Cron: nightly eBay payout-link pass (US-3413).
//
// WHAT NOT RUNNING COSTS. Every payout report is wrong, and wrong in the
// direction that looks like bad news: sales whose deposit settled after the
// last sync carry no payout_reference, so the deposit appears to have paid for
// nothing. Measured on prod 2026-09-14 before this job existed: 84 of 228 sales
// linked, September 0 of 12, and two of four stored payouts matching no sale at
// all.
//
// WHY A SECOND PASS RATHER THAN A FIX TO THE SYNC. The sync is not wrong. eBay
// assigns a payout id when the deposit settles, days after the order, so at the
// moment the sync reads that transaction there is genuinely no id to write. The
// only fix is to look again later, which is what a cron is.
//
// I checked for an existing equivalent first, the rule US-2617 left behind.
// reconciliation-sweep is the closest by name and works a different table: it
// matches public.payout_imports rows (the CSV upload path) to sales. It never
// calls the Finances API and never writes payout_reference. ebay-order-backstop
// re-runs the SYNC, which re-reads transactions from the cursor and so
// reproduces the same blind spot rather than closing it. So this one is real.
//
// TENANT ISOLATION (US-268). Owner ids come from marketplace_connections rows,
// never from a request. Each is passed to linkPayoutsForOwner, whose payout
// upsert, sales read and sales write are all keyed on that id.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { captureException } from "../lib/observability.ts";
import { isEbayConfigured } from "../lib/ebay-client.ts";
import {
  linkPayoutsForOwner,
  PAYOUT_LINK_DEFAULT_DAYS,
} from "../lib/ebay-payout-link.ts";
import { supabaseAdmin } from "../lib/supabase.ts";

/** Owners per nightly tick. */
export const PAYOUT_LINK_MAX_OWNERS_PER_RUN = 50;

/**
 * Lease covers the run. Each owner is two eBay calls plus a sales read and up
 * to a few dozen single-row updates, so this is generous rather than tight:
 * the cost of a lease that expires mid-run is two ticks writing the same rows,
 * which the `.is("payout_reference", null)` guard makes harmless but noisy.
 */
const JOB_LOCK_LEASE_SECONDS = 900;

export interface PayoutLinkSweepResult {
  owners: number;
  eligible_owners: number;
  payouts_upserted: number;
  sales_linked: number;
  sales_still_unlinked: number;
  failed_owners: number;
}

export async function handleEbayPayoutLinkCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  // An env with no eBay keyset cannot call Finances at all. Skipped, not
  // failed: the ledger should not read red in staging for a missing secret
  // that is missing on purpose.
  if (!isEbayConfigured()) {
    return c.json({ ok: true, skipped: true, reason: "ebay_not_configured" });
  }

  const lock = await acquireJobLock("ebay-payout-link", JOB_LOCK_LEASE_SECONDS);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("marketplace_connections")
      .select("user_id")
      .eq("marketplace", "ebay")
      .eq("is_active", true)
      .limit(PAYOUT_LINK_MAX_OWNERS_PER_RUN * 4);
    if (error) {
      throw new Error(`load active eBay connections failed: ${error.message}`);
    }

    const all = [
      ...new Set(
        ((data ?? []) as unknown as Array<{ user_id: string }>).map((r) => r.user_id),
      ),
    ];
    const owners = all.slice(0, PAYOUT_LINK_MAX_OWNERS_PER_RUN);

    const result: PayoutLinkSweepResult = {
      owners: owners.length,
      // The whole connected fleet, not the slice. Pinned at the cap run after
      // run means the pass is not keeping up with the seller count.
      eligible_owners: all.length,
      payouts_upserted: 0,
      sales_linked: 0,
      sales_still_unlinked: 0,
      failed_owners: 0,
    };

    for (const ownerId of owners) {
      // One seller's books must not stop another's. linkPayoutsForOwner already
      // collects per-call failures as warnings; this catches the rest.
      try {
        const counts = await linkPayoutsForOwner(ownerId, PAYOUT_LINK_DEFAULT_DAYS);
        result.payouts_upserted += counts.payoutsUpserted;
        result.sales_linked += counts.salesLinked;
        result.sales_still_unlinked += counts.salesStillUnlinked;
        if (counts.warnings.length > 0) {
          console.warn(
            `[ebay-payout-link] owner ${ownerId}: ${counts.warnings.join("; ").slice(0, 400)}`,
          );
        }
      } catch (err) {
        result.failed_owners++;
        console.warn(
          `[ebay-payout-link] owner ${ownerId} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "jobs-ebay-payout-link.cron" });
    return c.json({ error: "eBay payout link pass failed" }, 500);
  } finally {
    await lock.release();
  }
}
