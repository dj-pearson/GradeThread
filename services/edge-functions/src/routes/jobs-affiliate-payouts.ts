// US-1295: affiliate-payout sweep cron.
//
// The batched mechanism behind automatic affiliate payouts: accrue recent
// affiliate conversions → pay each affiliate their eligible (past-hold) balance
// over Stripe Connect once they've onboarded and cleared the minimum-payout
// threshold. Onboarded affiliates get an immediate transfer; not-yet-onboarded
// or below-threshold balances keep accruing. Idempotent (see lib/affiliate-payout.ts).
//
// Mounted in main.ts as POST /api/jobs/affiliate-payouts, OUTSIDE /api/* JWT
// groups, gated by X-Internal-Job-Secret (same pattern as the other crons). The
// /api/jobs/* middleware records the run to cron_runs automatically.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { getAffiliatePayoutMode, sweepAffiliatePayouts } from "../lib/affiliate-payout.ts";

export async function handleAffiliatePayoutsCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Config flag: 'off' disables the engine entirely.
  const mode = await getAffiliatePayoutMode();
  if (mode === "off") {
    return c.json({ ok: true, skipped: true, reason: "disabled" });
  }

  // Overlap guard: the sweep is idempotent, but the lock keeps two runs from
  // contending and double-attempting the same transfer. 5-min lease.
  const lock = await acquireJobLock("affiliate-payouts", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const summary = await sweepAffiliatePayouts();
    if (summary.accrued > 0 || summary.scanned > 0 || summary.stale > 0) {
      console.log(
        `[affiliate-payouts] accrued=${summary.accrued} scanned=${summary.scanned} ` +
          `transferred=${summary.transferred} queued=${summary.queued} ` +
          `failed=${summary.failed} skipped=${summary.skipped} stale=${summary.stale}`,
      );
    }
    return c.json({ ok: true, ...summary });
  } catch (err) {
    console.error(
      "[affiliate-payouts] sweep failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Affiliate payout sweep failed" }, 500);
  } finally {
    await lock.release();
  }
}
