// US-1588 / AGENTIC-OS Phase 0 (Module J): the agent scheduler cron.
//
// POST /api/jobs/agent-tick — mounted OUTSIDE the /api/* JWT groups, gated by
// X-Internal-Job-Secret (same pattern as the other 54 crons). The /api/jobs/*
// middleware records the run to cron_runs automatically and emits the standard
// job.failed ops event on a non-2xx. The tick itself (lib/agent-tick.ts) honors
// the global pause, expires stale proposals, and runs due agents under a
// per-tick wall-clock budget; an individual agent-run failure never fails it.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { runAgentTick } from "../lib/agent-tick.ts";

export async function handleAgentTickCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Overlap guard: a 9-min lease (< the 10-min cadence) so two ticks can't run
  // the same agents concurrently.
  const lock = await acquireJobLock("agent-tick", 540);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const summary = await runAgentTick();
    if (summary.paused) {
      return c.json({ ok: true, skipped: true, reason: "paused" });
    }
    return c.json({ ok: true, ...summary });
  } catch (err) {
    console.error("[agent-tick] tick failed:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "Agent tick failed" }, 500);
  } finally {
    await lock.release();
  }
}
