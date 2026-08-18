// US-1607 (Module V): the weekly agent-eval cron.
//
// POST /api/jobs/agent-eval — mounted OUTSIDE the JWT groups, gated by
// X-Internal-Job-Secret (same pattern as the other crons); the /api/jobs/*
// middleware records the run + emits job.failed on a non-2xx. Runs every agent's
// golden-scenario suite against the REAL model (frozen tools), then:
//   • writes agents.eval_pass (Record<key,bool>) — consumed by the autonomy-
//     promotion gate (US-1608) so a failing/un-eval'd agent is never promoted;
//   • writes agents.eval_results (pass rate per agent) — read by Mission Control;
//   • emits an agent.eval.failed warning ops event for each failing agent.
//
// Schedule weekly via a Coolify scheduled task (like the other crons); the
// harness is fast (frozen tools → 1–2 text calls per scenario).

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { runFleetEval } from "../lib/agent-eval.ts";
import { supabaseAdmin } from "../lib/supabase.ts";
import { bustSettingCache } from "../lib/system-settings.ts";
import { emitOpsEvent } from "../lib/ops-events.ts";

export async function handleAgentEvalCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  // A 30-min lease: the fleet suite makes real model calls; well under any weekly cadence.
  const lock = await acquireJobLock("agent-eval", 1800);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const summary = await runFleetEval();

    // Persist the gate map + the Mission Control results (upsert, like the
    // admin settings writes). No user actor — this is a cron.
    //
    // `value_type` IS REQUIRED and was the reason this job wrote nothing for its
    // entire life. system_settings.value_type is NOT NULL with no default, so a
    // {key, value} upsert is rejected with 23502 — and supabase-js RETURNS that
    // as `.error` rather than throwing, so an unchecked call looks identical to
    // a successful one. Four recorded runs (two logged `success`, 393-506s of
    // real model calls) and neither key ever existed in the table; the
    // autonomy-promotion gate (US-1608) has never had an eval_pass map to read.
    // Hence the explicit error checks below: a write this job exists to perform
    // must fail loudly, not return ok:true over a no-op.
    const passWrite = await supabaseAdmin.from("system_settings").upsert(
      {
        key: "agents.eval_pass",
        value: summary.passMap,
        value_type: "json",
        category: "agents",
      },
      { onConflict: "key" },
    );
    if (passWrite.error) {
      throw new Error(`agents.eval_pass upsert failed: ${passWrite.error.message}`);
    }
    const resultsWrite = await supabaseAdmin.from("system_settings").upsert(
      {
        key: "agents.eval_results",
        value: {
          ran_at: new Date().toISOString(),
          agents: summary.agents,
          failed: summary.failed,
        },
        value_type: "json",
        category: "agents",
      },
      { onConflict: "key" },
    );
    if (resultsWrite.error) {
      throw new Error(`agents.eval_results upsert failed: ${resultsWrite.error.message}`);
    }
    // Invalidate the settings cache so the autonomy-promotion gate reads the
    // fresh eval_pass map on its next run.
    bustSettingCache("agents.eval_pass");
    bustSettingCache("agents.eval_results");

    // Flag each failing agent for re-verification (and to block its promotion).
    for (const a of summary.agents) {
      if (!a.ok) {
        await emitOpsEvent("agent.eval.failed", "warning", {
          title: `Agent eval failed: ${a.agentKey} (${a.passed}/${a.total})`,
          source: "agent-eval",
          data: { agentKey: a.agentKey, passed: a.passed, total: a.total },
        });
      }
    }

    return c.json({ ok: true, ...summary });
  } catch (err) {
    console.error("[agent-eval] fleet eval failed:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "Agent eval failed" }, 500);
  } finally {
    await lock.release();
  }
}
