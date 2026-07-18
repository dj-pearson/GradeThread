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

// US-2021: how long a DELIVERED email's record (including its full rendered
// html body) is kept. 90 days is well past any support window that would need
// to re-read what a user was actually sent, and short enough that the table
// stops being the largest thing in the backup.
const EMAIL_SENT_RETENTION_DAYS = 90;
// A dead-lettered email is an operator queue item, so the ROW is kept
// indefinitely for triage/replay — only its heavy PII-bearing body is dropped,
// and on a longer window so a real replay is still possible in practice.
const EMAIL_DEAD_LETTER_BODY_DAYS = 180;

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

  // Select the IMAGES to purge directly, joined to their submission's age.
  //
  // ⚠ THIS USED TO SELECT SUBMISSIONS FIRST, AND IT COULD NOT MAKE PROGRESS.
  // The old query took 200 arbitrary submissions past the cutoff with no filter
  // for whether any images REMAINED and no ORDER BY, then looked up their
  // images and returned early when there were none. So after the first run
  // purged those 200, every subsequent nightly run re-selected the SAME
  // already-purged submissions, found zero images, and returned
  // objects_deleted: 0 — newer expired submissions were never reached. GDPR
  // storage-limitation was silently unenforced from run two onward while the
  // cron reported ok:true forever.
  //
  // Driving off submission_images instead makes stalling structurally
  // impossible: the query only ever returns rows that still exist, and this
  // function's whole job is to delete them, so every run strictly advances.
  // Oldest-first so the longest-expired PII goes first and the sweep is
  // deterministic rather than dependent on Postgres row order.
  const { data: imgs, error: imgErr } = await supabaseAdmin
    .from("submission_images")
    .select("id, storage_path, submission_id, submissions!inner(created_at)")
    .lt("submissions.created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT);
  if (imgErr) {
    captureException(imgErr, { route: "data-retention.scan" });
    throw new Error(`retention scan failed: ${imgErr.message}`);
  }

  const rows = (imgs ?? []) as Array<{ id: string; storage_path: string; submission_id: string }>;
  if (rows.length === 0) {
    return { cutoff, submissions_processed: 0, objects_deleted: 0, rows_deleted: 0 };
  }
  // Distinct submissions touched by this batch — reported, not used as the
  // batch key, so the count stays meaningful without reintroducing the stall.
  const submissionIds = [...new Set(rows.map((r) => r.submission_id))];

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
    // US-584: keep the cron-run ledger bounded (30-day window). Best-effort —
    // a prune hiccup must not fail the PII purge that is this job's reason to run.
    const cronCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await supabaseAdmin.from("cron_runs").delete().lt("created_at", cronCutoff);

    // US-2021: bound email_deliveries. It stores the FULL rendered `html` body
    // of every critical email and had no purge anywhere, so it grew forever —
    // on track to become the largest table in the DB, inflating backup and
    // restore windows (i.e. worsening the RTO in the backup story) and forming
    // the single largest reservoir of un-erasable PII. Its partial index stays
    // healthy while the heap does not, so query latency never warns you.
    //
    // Two different rules, deliberately:
    //   • `sent` rows are pure history once delivered → delete outright.
    //   • `dead_letter` rows are an OPERATOR QUEUE — someone may still need to
    //     replay them — so the row survives and only the heavy PII-bearing
    //     `html` body is dropped, and only after a longer window. Deleting them
    //     would destroy evidence of undelivered mail, which is the opposite of
    //     what a dead-letter table is for.
    // Best-effort for the same reason as the cron prune above.
    const sentCutoff = new Date(Date.now() - EMAIL_SENT_RETENTION_DAYS * 86_400_000)
      .toISOString();
    const { error: sentErr } = await supabaseAdmin
      .from("email_deliveries")
      .delete()
      .eq("status", "sent")
      .lt("created_at", sentCutoff);
    if (sentErr) {
      captureException(sentErr, { route: "data-retention.email_sent" });
    }
    const deadCutoff = new Date(Date.now() - EMAIL_DEAD_LETTER_BODY_DAYS * 86_400_000)
      .toISOString();
    const { error: deadErr } = await supabaseAdmin
      .from("email_deliveries")
      .update({ html: "" })
      .eq("status", "dead_letter")
      .lt("created_at", deadCutoff)
      .neq("html", "");
    if (deadErr) {
      captureException(deadErr, { route: "data-retention.email_dead_letter" });
    }

    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "data-retention.cron" });
    return c.json({ error: "Data-retention purge failed" }, 500);
  } finally {
    await lock.release();
  }
}
