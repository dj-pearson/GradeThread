// Cron: apply the eBay data retention policy (US-3042).
//
// Daily, off-peak. Every rule and the reasoning behind each one lives in
// lib/ebay-retention.ts; this route is the scheduler and the report.
//
// It reports a partial failure as a 500 even when most tables swept cleanly.
// A retention sweep that silently skips a table is worse than one that fails
// loudly: the policy is published on the privacy page, so a table that stops
// being swept turns a public commitment into an untrue statement, and nobody
// finds out from a green cron.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { sweepEbayRetention } from "../lib/ebay-retention.ts";
import { captureException, recordMetric } from "../lib/observability.ts";

const JOB_LOCK_LEASE_SECONDS = 600;

export async function handleEbayRetentionCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("ebay-retention", JOB_LOCK_LEASE_SECONDS);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const results = await sweepEbayRetention();
    const failed = results.filter((r) => r.error);
    const totalRows = results.reduce((n, r) => n + r.rows, 0);

    for (const r of results) {
      recordMetric("ebay.retention_rows", r.rows, {
        table: r.table,
        action: r.action,
      });
    }

    if (failed.length > 0) {
      captureException(
        new Error(
          `eBay retention sweep incomplete: ${
            failed.map((f) => `${f.table} (${f.error})`).join("; ")
          }`,
        ),
        { level: "error", route: "jobs-ebay-retention.cron" },
      );
      return c.json({ ok: false, totalRows, results }, 500);
    }

    return c.json({ ok: true, totalRows, results });
  } catch (err) {
    captureException(err, { route: "jobs-ebay-retention.cron" });
    return c.json({ error: "eBay retention sweep failed" }, 500);
  } finally {
    await lock.release();
  }
}
