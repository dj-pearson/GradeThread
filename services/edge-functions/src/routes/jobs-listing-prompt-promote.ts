// US-547: scheduled A/B auto-promotion for the listing_gen prompt.
//
// The self-improving loop: an eval-passed listing_gen challenger flagged
// in_trial takes ~50% of generations; this cron periodically compares its
// seller keep-rate + sell-through against the champion and either promotes it
// (eval-gated, via activatePromptVersion) or ends the trial. Promotion is
// idempotent and no-ops when there's no challenger or not enough sample.
//
// Mounted in main.ts as POST /api/jobs/listing-prompt-promote, OUTSIDE the
// /api/* JWT groups, gated by X-Internal-Job-Secret (same pattern as the
// reprice / trial-expiry crons).

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { autoPromoteListingPrompt } from "../lib/listing-acceptance.ts";

export async function handleListingPromptPromoteCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("listing-prompt-promote", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const decision = await autoPromoteListingPrompt();
    if (decision.action === "promoted" || decision.action === "trial_ended") {
      console.log(
        `[listing-prompt-promote] ${decision.action}: ${decision.reason}`,
      );
    }
    return c.json({ ok: true, decision });
  } catch (err) {
    console.error(
      "[listing-prompt-promote] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Auto-promote failed" }, 500);
  } finally {
    await lock.release();
  }
}
