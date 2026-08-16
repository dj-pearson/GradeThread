// Cron: nightly photo archive sweep (US-2617, closing half of US-2310).
//
// WHY THIS ROUTE EXISTS AT ALL. The cron registry has pointed photo-archive at
// /api/flipdesk/images/archive since it was written. That is a SELLER route: it
// reads workspaceOwnerId ?? userId from the JWT, so a scheduler holding only the
// job secret 401s before the handler runs. The task has therefore never once
// archived a photo, and because the entry was recorded:false it left no ledger
// row either — it could neither run nor be seen not running.
//
// The fix is not a job-secret branch on the seller route. One cron POST has to
// cover every tenant and that route has exactly one by design, so this walks the
// fleet and re-enters the per-owner function once per owner.
//
// TENANT ISOLATION (US-268). The owner ids come from the photo rows themselves,
// never from the request — there is no caller identity to take them from. Every
// write then goes through archiveOwnerPhotos(ownerId), whose reads are scoped by
// that id and whose updates are keyed on rows those reads returned.
//
// Herd control: archival is N downloads + N R2 PUTs per owner, so the sweep is
// bounded per tick. Missing owners are picked up on the next nightly run, and
// ARCHIVE_BATCH already caps the work per owner. The seller's own /archive
// button is unchanged and still available for anyone who wants it now.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isR2Configured } from "../lib/r2-client.ts";
import { captureException } from "../lib/observability.ts";
import {
  archiveOwnerPhotos,
  listOwnersWithArchivablePhotos,
} from "./flipdesk-images.ts";

/** Owners to sweep per nightly tick. */
export const PHOTO_ARCHIVE_MAX_OWNERS_PER_RUN = 25;

/**
 * Rows to scan when resolving those owners. Larger than the owner cap because
 * one owner can hold many eligible photos, and a scan that stopped at 25 ROWS
 * could resolve a single owner and report the fleet as done.
 */
export const PHOTO_ARCHIVE_SCAN_LIMIT = PHOTO_ARCHIVE_MAX_OWNERS_PER_RUN * 20;

/** Lease covers the whole sweep — unlike the sync crons, this one does the work. */
const JOB_LOCK_LEASE_SECONDS = 900;

export interface PhotoArchiveSweepResult {
  owners: number;
  eligible_owners: number;
  archived: number;
  freed_bytes: number;
  failed_owners: number;
  photo_errors: number;
}

export async function handlePhotoArchiveCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  // Not an error: R2 is optional, and a nightly 500 for an unconfigured
  // integration is how an on-call learns to ignore the ledger.
  if (!isR2Configured()) {
    return c.json({ ok: true, skipped: true, reason: "r2_not_configured" });
  }

  const lock = await acquireJobLock("photo-archive", JOB_LOCK_LEASE_SECONDS);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const { owners: all, error } = await listOwnersWithArchivablePhotos(
      PHOTO_ARCHIVE_SCAN_LIMIT,
    );
    if (error) {
      throw new Error(
        `load archivable owners failed: ${
          error instanceof Error ? error.message : JSON.stringify(error)
        }`,
      );
    }

    const owners = all.slice(0, PHOTO_ARCHIVE_MAX_OWNERS_PER_RUN);
    const result: PhotoArchiveSweepResult = {
      owners: owners.length,
      // The whole eligible fleet, not the slice. Pinned at the scan limit run
      // after run means the sweep is not keeping up and the cap should move.
      eligible_owners: all.length,
      archived: 0,
      freed_bytes: 0,
      failed_owners: 0,
      photo_errors: 0,
    };

    for (const ownerId of owners) {
      // One owner's failure must not end the sweep — the next owner's photos
      // are unrelated, and a nightly job that stops at the first bad row
      // archives nothing for everyone behind it.
      try {
        const out = await archiveOwnerPhotos(ownerId);
        if (!out.ok) {
          result.failed_owners++;
          continue;
        }
        result.archived += out.result.archived;
        result.freed_bytes += out.result.freed_bytes;
        result.photo_errors += out.result.errors.length;
      } catch (err) {
        result.failed_owners++;
        console.warn(
          `[photo-archive] owner ${ownerId} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "jobs-photo-archive.cron" });
    return c.json({ error: "Photo archive sweep failed" }, 500);
  } finally {
    await lock.release();
  }
}
