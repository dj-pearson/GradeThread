// Data-retention / PII purge (US-521).
//
// Grading photos (submission-images) are personal data and accumulate forever
// today. This scheduled job enforces the storage-limitation principle: for
// submissions past the retention window it DELETES the image objects + their
// submission_images rows (the PII), while KEEPING the grade_report (the grade
// itself is the non-PII product, needed for the public certificate + accuracy
// analytics). I.e. we anonymize old grades rather than destroy them.
//
// Retention window is env-tunable (DATA_RETENTION_DAYS, default 730 = 2 years)
// and documented in the Privacy Policy + DATA_RETENTION.md.

import { supabaseAdmin } from "./supabase.ts";
import { requireJobSecret } from "./job-auth.ts";
import { acquireJobLock } from "./job-lock.ts";
import { captureException, logEvent, recordMetric } from "./observability.ts";

const BUCKET = "submission-images";
const BATCH_LIMIT = 200;

function retentionDays(): number {
  const raw = Number(Deno.env.get("DATA_RETENTION_DAYS"));
  return Number.isFinite(raw) && raw > 0 ? raw : 730;
}

export interface RetentionResult {
  cutoff: string;
  submissions_processed: number;
  objects_deleted: number;
  rows_deleted: number;
}

export async function purgeExpiredGradingPii(): Promise<RetentionResult> {
  const cutoff = new Date(Date.now() - retentionDays() * 86_400_000).toISOString();

  // Submissions past the window that still have images to purge.
  const { data: subs, error } = await supabaseAdmin
    .from("submissions")
    .select("id")
    .lt("created_at", cutoff)
    .limit(BATCH_LIMIT);
  if (error) {
    captureException(error, { route: "data-retention.scan" });
    throw new Error(`retention scan failed: ${error.message}`);
  }

  const submissionIds = (subs ?? []).map((s) => (s as { id: string }).id);
  if (submissionIds.length === 0) {
    return { cutoff, submissions_processed: 0, objects_deleted: 0, rows_deleted: 0 };
  }

  // Pull the storage paths for those submissions' images.
  const { data: imgs, error: imgErr } = await supabaseAdmin
    .from("submission_images")
    .select("id, storage_path, submission_id")
    .in("submission_id", submissionIds);
  if (imgErr) {
    captureException(imgErr, { route: "data-retention.images" });
    throw new Error(`retention image lookup failed: ${imgErr.message}`);
  }

  const rows = (imgs ?? []) as Array<{ id: string; storage_path: string; submission_id: string }>;
  if (rows.length === 0) {
    return { cutoff, submissions_processed: submissionIds.length, objects_deleted: 0, rows_deleted: 0 };
  }

  // Delete the storage objects (PII) in chunks, then the index rows. Storage
  // first: if the row delete fails we retry next run and re-delete (idempotent);
  // if we deleted rows first and storage failed, the objects would be orphaned.
  const paths = rows.map((r) => r.storage_path);
  let objectsDeleted = 0;
  const CHUNK = 100;
  for (let i = 0; i < paths.length; i += CHUNK) {
    const slice = paths.slice(i, i + CHUNK);
    const { error: rmErr } = await supabaseAdmin.storage.from(BUCKET).remove(slice);
    if (rmErr) {
      // Report but continue — partial progress is fine; next run retries the rest.
      captureException(rmErr, { route: "data-retention.storage_remove" });
    } else {
      objectsDeleted += slice.length;
    }
  }

  // Remove the index rows (their submissions keep the grade_report).
  const idsToDelete = rows.map((r) => r.id);
  let rowsDeleted = 0;
  for (let i = 0; i < idsToDelete.length; i += CHUNK) {
    const slice = idsToDelete.slice(i, i + CHUNK);
    const { error: delErr, count } = await supabaseAdmin
      .from("submission_images")
      .delete({ count: "exact" })
      .in("id", slice);
    if (delErr) {
      captureException(delErr, { route: "data-retention.row_delete" });
    } else {
      rowsDeleted += count ?? slice.length;
    }
  }

  recordMetric("retention.objects_purged", objectsDeleted, {});
  logEvent("info", "retention.sweep", {
    cutoff,
    submissions: submissionIds.length,
    objectsDeleted,
    rowsDeleted,
  });

  return {
    cutoff,
    submissions_processed: submissionIds.length,
    objects_deleted: objectsDeleted,
    rows_deleted: rowsDeleted,
  };
}

export async function handleDataRetentionCron(c: {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("data-retention", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result = await purgeExpiredGradingPii();
    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "data-retention.cron" });
    return c.json({ error: "Data-retention purge failed" }, 500);
  } finally {
    await lock.release();
  }
}
