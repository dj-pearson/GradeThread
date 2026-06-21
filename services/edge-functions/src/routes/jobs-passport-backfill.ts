// US-1124: Garment Passport backfill/repair cron.
//
// The 00257 migration backfill seeds the existing certificate back-catalogue
// once, at deploy. The grading pipeline then seeds each new grade synchronously
// (lib/passport-write.ts), and the listing builder self-heals lazily before it
// reads garment_id. This cron is the durable safety net for the remaining
// window: any certificated grade_report left with a NULL garment_id (a live
// seed that returned null, or a report created outside the seed path) gets its
// single-hop passport seeded here. Idempotent — repairMissingPassports only
// touches rows where garment_id IS NULL and reuses the idempotent ensure path.
//
// Mounted in main.ts as POST /api/jobs/passport-backfill, OUTSIDE the /api/*
// JWT groups, gated by the internal job secret (same pattern as the other
// crons) and job-locked so overlapping runs no-op.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { repairMissingPassports } from "../lib/passport-write.ts";

// Bounded per run so a large gap drains across ticks rather than one unbounded
// pass; the cron is frequent enough (every 15m) to catch up quickly.
const REPAIR_BATCH = 200;

export async function handlePassportBackfillCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("passport-backfill", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result = await repairMissingPassports(REPAIR_BATCH);
    return c.json({ ok: true, ...result });
  } finally {
    await lock.release();
  }
}
