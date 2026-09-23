// Customer webhook retry sweep (extensions-api plan, action 3; migration 00832).
//
// The first attempt of every event runs in-process right after the grade is
// final. Everything after that is this cron: it returns rows a dead worker left
// 'running' to 'pending', then attempts every pending row whose next_attempt_at
// has passed. Because the retry lives in webhook_deliveries rather than in a
// setTimeout, a deploy between attempts delays a retry instead of losing it.
//
// Every judgement (claim, backoff, attempts cap, signature) is in
// lib/webhook-delivery.ts. TENANCY (US-268): no request ids at all; each row's
// follow-up reads are keyed on that row's own user_id, and the door is
// requireJobSecret.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { sweepWebhookDeliveries } from "../lib/webhook-delivery.ts";

export async function handleWebhookRetryCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // 50 rows x 10s timeout is the worst case, well inside the lease.
  const lock = await acquireJobLock("webhook-retry", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const result = await sweepWebhookDeliveries();
    // `scanned` is read by the cron ledger as rows_processed (US-2312). The
    // counter for rows that ran out of attempts is `exhausted`, NOT `failed`:
    // the ledger treats a `failed` key as our failure and raises job.failed,
    // and a customer's endpoint being down is not an incident on our side.
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error(
      "[webhook-retry] run threw:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ ok: false, error: "run failed" }, 500);
  } finally {
    await lock.release();
  }
}
