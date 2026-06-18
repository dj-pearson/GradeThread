// US-1072: scheduled keyword-research ingestion.
//
// Refreshes the keyword library from the Google Ads keyword planner on a
// schedule so demand metrics (volume, competition, CPC) stay current without
// the operator clicking "refresh". Mounted in main.ts as POST
// /api/jobs/keyword-research, OUTSIDE the /api/* JWT groups; the handler enforces
// X-Internal-Job-Secret itself (same pattern as the other Coolify crons).
//
// Suggested Coolify cron: weekly (search volumes update roughly monthly), e.g.
// `0 6 * * 1`. Cleanly no-ops (records a 'skipped' run) when Google Ads env
// isn't configured yet.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { ingestKeywordResearch } from "../lib/keyword-research.ts";

export async function handleKeywordResearchCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("keyword-research", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const result = await ingestKeywordResearch({ trigger: "scheduled" });
    const code = result.status === "error" ? 502 : 200;
    return c.json({ ok: result.status !== "error", ...result }, code);
  } finally {
    await lock.release();
  }
}
