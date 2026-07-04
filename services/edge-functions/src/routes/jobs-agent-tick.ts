// US-1588: the Agentic OS heartbeat — POST /api/jobs/agent-tick.
//
// Zero new infrastructure: the same X-Internal-Job-Secret gate, the same
// job_locks lease, the same cron_runs ledger + job.failed ops-event
// chokepoint (both via the /api/jobs/* middleware in main.ts). Every 10
// minutes it sweeps expired proposals and runs the due agents sequentially
// under a wall-clock budget; leftovers defer to the next tick.
//
// Individual agent-run failures never fail the tick (the kernel never
// throws); a NON-200 here means the tick's own bookkeeping broke.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { runAgentTick } from "../lib/agent-scheduler.ts";
import { redactError } from "../lib/log-redact.ts";

export async function handleAgentTickCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Lease slightly under the 10-minute cadence so a hung tick can't overlap
  // the next one, but a crashed holder frees up before two are missed.
  const lock = await acquireJobLock("agent-tick", 540);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const outcome = await runAgentTick();
    return c.json({ ok: true, ...outcome });
  } catch (err) {
    // Bookkeeping broke → 500 → the middleware records error + job.failed.
    console.error(`[agent-tick] ${redactError(err)}`);
    return c.json({ ok: false, error: "agent tick failed" }, 500);
  } finally {
    await lock.release();
  }
}
