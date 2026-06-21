// US-1112: consignor auto-payout sweep cron.
//
// The batched mechanism behind automatic consignor payouts: sweep recently-sold
// consigned items (and any sale still carrying an unsettled auto payout) →
// compute each consignor's share → record/fire the payout. Onboarded consignors
// get an immediate Stripe transfer; not-yet-onboarded ones are left queued
// (pending) and retried on a later run. Idempotent (see lib/consignor-payout.ts).
//
// Mounted in main.ts as POST /api/jobs/consignor-payouts, OUTSIDE /api/* JWT
// groups, gated by X-Internal-Job-Secret (same pattern as the other crons). The
// /api/jobs/* middleware records the run to cron_runs automatically.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { getAutoPayoutMode, sweepConsignorPayouts } from "../lib/consignor-payout.ts";

export async function handleConsignorPayoutsCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Config flag: 'off' disables the engine entirely (manual POST /payouts only).
  // 'batched' and 'immediate' both run the sweep here — in 'immediate' the
  // eBay-ingest hook fires sooner but the sweep stays the catch-all.
  const mode = await getAutoPayoutMode();
  if (mode === "off") {
    return c.json({ ok: true, skipped: true, reason: "disabled" });
  }

  // Overlap guard: the sweep is idempotent, but the lock keeps two runs from
  // contending and double-attempting the same transfer. 5-min lease.
  const lock = await acquireJobLock("consignor-payouts", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const summary = await sweepConsignorPayouts();
    if (summary.scanned > 0) {
      console.log(
        `[consignor-payouts] scanned=${summary.scanned} transferred=${summary.transferred} ` +
          `queued=${summary.queued} failed=${summary.failed} skipped=${summary.skipped}`,
      );
    }
    return c.json({ ok: true, ...summary });
  } catch (err) {
    console.error(
      "[consignor-payouts] sweep failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Consignor payout sweep failed" }, 500);
  } finally {
    await lock.release();
  }
}
