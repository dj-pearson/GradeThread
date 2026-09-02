import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
// US-2677: a batch of nine template-written titles is only visible as a problem
// when the whole batch is looked at at once.
import { findDuplicatesWithinBatch } from "../lib/title-similarity.ts";
import { generateListing, generatePlatformVariants } from "../lib/ai-listing.ts";
import { generateKitForDraft } from "../lib/cross-list-kit.ts";
import { assemblePublishContext, publishItemForOwner } from "./flipdesk-ebay.ts";
import { notifyUser } from "../lib/notify.ts";
import {
  type AutoPublishSkips,
  buildAutoPublishNotification,
  emptySkips,
  isGreenDraft,
} from "../lib/auto-publish-green.ts";
import {
  getMarketplaceSpec,
  type MarketplacePlatform,
} from "../lib/marketplace-specs.ts";
import { classifyPhotoRoles } from "../lib/ai-photo-roles.ts";
import {
  type ItemPhotoUrlRow,
  itemPhotoAiUrls,
} from "../lib/item-photo-storage.ts";
import {
  type VerifyGroup,
  verifyGroupBoundaries,
} from "../lib/ai-group-verify.ts";
import {
  type ProposePhoto,
  proposeItemGroups,
} from "../lib/ai-group-propose.ts";
import { assessPhotoQuality } from "../lib/ai-photo-qa.ts";
import { checkQuota } from "./flipdesk-ai.ts";
import {
  enqueueGenerationBatch,
  registerBatchRunner,
} from "../lib/autolister-enqueue.ts";
import {
  AiQuotaExhaustedError,
  QUOTA_EXHAUSTED_MESSAGE,
  refundAiAction,
  reserveAiAction,
  reserveAiActionSafe,
  withAiAction,
} from "../lib/ai-metering.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { roleAtLeast } from "../lib/workspace-roles.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isBatchHeartbeatFresh } from "../lib/batch-heartbeat.ts";
import {
  buildTemplateListingPatch,
  type ListingTemplateRow,
} from "../lib/listing-template.ts";
import {
  buildMergeWrites,
  buildReconcileDiff,
  type ReconcileItemRow,
  type ReconcileListingRow,
} from "../lib/reconcile-fields.ts";
import { validateImageUpload } from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";
import { applyAutoDefectAnnotations } from "../lib/defect-annotations.ts";

// Columns the template overlay needs to patch a generated draft (US-674).
const TEMPLATE_OVERLAY_COLUMNS =
  "description_template, ebay_condition, condition_description, item_specifics, " +
  "ebay_category_id, return_policy_id, shipping_policy_id, payment_policy_id";

// FlipDesk AutoLister batch generation (US-313).
// Mounted at /api/flipdesk/autolister (authed + workspace context).
//
// POST /batch       — enqueue many items for AI listing generation; returns
//                     202 + batch_id and processes in the background.
// GET  /batch/:id   — poll batch + per-job status for the queue view (US-318).
//
// Durability (US-525): generation state is durable in the batches/jobs tables.
// Each job is CLAIMED with a conditional update before it runs, every progress
// roll-up bumps the batch's updated_at (a heartbeat), and the batch always
// terminalizes from the authoritative jobs table (finalizeBatch). A cron sweep
// (handleAutolisterReclaimCron, mounted at /api/jobs/autolister-reclaim) resumes
// any batch whose worker died mid-run, so nothing is stranded by a restart.
//
// Tenant safety (CLAUDE.md US-268): the service-role client bypasses RLS, so
// every query here is scoped to the workspace owner. Items are verified owned
// before any job is created; batch/job reads join through batch.user_id.

// US-1545: a 600-photo shoot is ~100–150 items, so the old 100 cap dead-ended
// exactly the flagship bulk-intake case. The route returns 202 and the durable
// worker (CONCURRENCY=3, per-item atomic reserveAiAction, reclaim cron)
// processes in the background, so item count never affects request latency —
// there is no per-request reason to cap lower. Exported for the CI guard test.
export const MAX_BATCH_ITEMS = 300;
// US-533: a single group's photo set passed to the cover/role vision pass.
// One item rarely has more than a handful of shots; the cap bounds the vision
// cost (and request size) of one classify call.
const MAX_CLASSIFY_PHOTOS = 40;
// US-1544: photo budget for one group-boundary verification call. The route
// SAMPLES each group down to its boundary shots (first/middle/last) and takes
// groups in order until this budget runs out, so the response says how far it
// got instead of rejecting a big session.
const MAX_VERIFY_PHOTOS = 40;
// US-537: cap on photo-QA scope. One item's gallery is small; cap photos per
// item, and cap items per request to bound vision cost.
const MAX_QA_ITEMS = 100;
const MAX_QA_PHOTOS = 12;
const CONCURRENCY = 3; // vision calls are heavy; mirror flipdesk-ai bulk-extract

// US-526: hard wall-clock cap on a single item's generation. generateListing
// makes several sequential Anthropic + eBay calls; only the SDK socket timeout
// protected it before, so one hung item could pin a concurrency slot.
// US-1552: raised 90s → 240s — the pipeline has grown to 3-4 sequential vision
// calls (tag-OCR, main generation incl. cascade escalation, aspects second
// pass) and 90s made photo-heavy items time out wholesale. This is a hung-call
// backstop, not a target duration; keep it comfortably under JOB_STALE_MS.
const GENERATION_TIMEOUT_MS = 240_000;
// US-525: a job started this many times (incl. reclaim resumes) is failed
// terminally rather than resumed forever.
export const MAX_JOB_ATTEMPTS = 5;
// US-525: a 'running' job whose updated_at is older than this was left by a
// dead worker and is eligible for reclaim. Must exceed GENERATION_TIMEOUT_MS so
// a live, generating job is never reclaimed out from under its worker.
const JOB_STALE_MS = 6 * 60_000;
// US-525: a 'running' batch whose updated_at (bumped on every progress roll-up)
// is older than this is presumed abandoned and is swept.
const BATCH_STALE_MS = 15 * 60_000;

// ── US-559: durable bulk publish ─────────────────────────────────────
// A single, bounded concurrency for the publish worker. eBay returns 429 under
// burst publishing, so the rate budget is centralized here (not multiplied by
// however many browser tabs were looping /push). publishItemForOwner already
// retries the eBay publish call internally — the durable worker deliberately
// does NOT add a second retry layer on top (the old client loop did, which
// compounded the server's own withRetry); a genuine failure surfaces on the
// job for an explicit retry-failed instead.
const PUBLISH_CONCURRENCY = 3;
// One bulk-publish run is capped at the same size as a generation batch
// (US-1545: raised together so a fully-green big batch publishes in one run;
// the active-listing plan cap still gates each publish server-side).
export const MAX_PUBLISH_BATCH_ITEMS = 300;
// Hard wall-clock cap on a single item's publish. publishItemForOwner makes
// several sequential eBay calls (inventory PUT → offer POST → publish), so cap
// it generously so a hung call can't pin a concurrency slot forever (US-526).
const PUBLISH_ITEM_TIMEOUT_MS = 120_000;
// A publish job started this many times (incl. reclaim resumes) is failed
// terminally rather than resumed forever (US-525).
const MAX_PUBLISH_JOB_ATTEMPTS = 5;
// A 'running' publish job whose updated_at is older than this was left by a
// dead worker and is eligible for reclaim. Must exceed PUBLISH_ITEM_TIMEOUT_MS
// so a live publish is never reclaimed out from under its worker.
const PUBLISH_JOB_STALE_MS = 5 * 60_000;
// A 'running' publish batch whose heartbeat (updated_at) is older than this is
// presumed abandoned and is swept by the reclaim cron.
const PUBLISH_BATCH_STALE_MS = 15 * 60_000;

export const flipdeskAutolisterRoutes = new Hono<{
  Variables: {
    userId: string;
    workspaceOwnerId: string;
    workspaceRole:
      | "viewer"
      | "member"
      | "listing_manager"
      | "admin"
      | "owner";
  };
}>();

// ── Helpers ─────────────────────────────────────────────────────────

export type BatchTerminalStatus = "completed" | "failed" | "partial";

/**
 * US-525: terminal status of a batch given its job tallies, or null if jobs are
 * still open. Pure, so the terminalization rule is unit-tested without a DB.
 */
export function deriveBatchStatus(
  succeeded: number,
  failed: number,
  open: number,
): BatchTerminalStatus | null {
  if (open > 0) return null;
  return failed === 0 ? "completed" : succeeded === 0 ? "failed" : "partial";
}

// US-1923: a batch only reaches a terminal status once no jobs are open. During
// a normal run the worker's not-yet-dispatched jobs are still 'pending' (open),
// so a terminal status observed WHILE the worker still has jobs to dispatch can
// only mean an operator cancel flipped every open job to 'failed'. The worker
// polls this between concurrency slices to halt promptly instead of spending
// quota on the rest.
export function isHaltedBatchStatus(status: string | null | undefined): boolean {
  return status === "completed" || status === "failed" || status === "partial";
}

// US-1923: decide the follow-up after generateListing returns, given whether the
// conditional (status='running') success write actually claimed the job. When it
// didn't (`won=false`), an operator cancel flipped the job to 'failed' mid-flight
// — don't advance the item, and refund the AI action reserved for it so the cap
// isn't charged for cancelled work.
export function settleAfterGeneration(
  won: boolean,
): { advanceItem: boolean; refundReservation: boolean } {
  return won
    ? { advanceItem: true, refundReservation: false }
    : { advanceItem: false, refundReservation: true };
}

/**
 * US-1931: decide whether runJob must reserve an AI action for this job.
 *
 * The reservation is IDEMPOTENT per job id, keyed off the persisted
 * `ai_reserved` flag (migration 00445). A job that already holds a reservation
 * from a prior (crashed) attempt REUSES it on reclaim rather than charging the
 * owner's monthly cap again — so a crash loop consumes at most ONE reservation
 * per item, not one per attempt (up to MAX_JOB_ATTEMPTS before). This is also
 * what keeps `insufficientAiActionsBody`'s `used` snapshot in agreement with
 * the authoritative per-item reservations under a reserved-then-reclaimed run.
 */
export function needsAiReservation(
  job: { ai_reserved?: boolean | null },
): boolean {
  return job.ai_reserved !== true;
}

// US-9115: moved to lib/autolister-enqueue.ts with the enqueue guards it
// belongs to, and re-exported here for the call sites and unit test that
// already import it from this path.
export { insufficientAiActionsBody } from "../lib/autolister-enqueue.ts";

/** Reject with a clear error if `promise` doesn't settle within `ms` (US-526). */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

// US-527/US-1581: the atomic reserve/refund primitives live in
// lib/ai-metering.ts — one contract for every route. The batch worker uses the
// THROWING reserve variant (an rpc failure marks the job failed rather than
// reading as "cap reached"); the interactive vision endpoints below use
// withAiAction (fail-closed).

async function markJobFailed(jobId: string, message: string): Promise<void> {
  // US-1552: also log it — job failures used to be DB-row-only, which made a
  // wholesale batch failure (e.g. every item timing out) completely invisible
  // in the edge logs.
  console.error(`[flipdesk-autolister] job ${jobId} failed: ${message}`);
  await supabaseAdmin
    .from("listing_generation_jobs")
    .update({ status: "failed", error: message.slice(0, 1000) })
    .eq("id", jobId);
}

// US-1931: per-job AI-reservation flag writes. `markJobReserved` is persisted
// immediately after a successful reserve and BEFORE the long generateListing
// call, so a crash mid-generation is resumed (via reclaim) without a second
// charge — the reclaimed job sees ai_reserved=true and reuses the reservation.
// `releaseJobReservation` clears the flag whenever the reservation is refunded
// (generation failure, cancel mid-flight, terminal abandonment) so a later
// retry/reclaim reserves afresh rather than reusing a now-refunded slot.
async function markJobReserved(jobId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("listing_generation_jobs")
    .update({ ai_reserved: true })
    .eq("id", jobId);
  if (error) {
    console.error(
      `[flipdesk-autolister] job ${jobId} reserve-flag write failed: ${error.message}`,
    );
  }
}

async function releaseJobReservation(jobId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("listing_generation_jobs")
    .update({ ai_reserved: false })
    .eq("id", jobId);
  if (error) {
    console.error(
      `[flipdesk-autolister] job ${jobId} release-flag write failed: ${error.message}`,
    );
  }
}

/**
 * US-525: recompute counts from the authoritative jobs table and terminalize
 * the batch when no jobs remain open. Idempotent — also serves as the live
 * progress roll-up (which bumps batch.updated_at, the heartbeat the reclaim
 * sweeper watches). Called after every slice and once in `finally`, so a batch
 * always reaches a terminal status even if the worker was interrupted.
 */
async function finalizeBatch(batchId: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from("listing_generation_jobs")
    .select("status")
    .eq("batch_id", batchId);
  const rows = (data ?? []) as Array<{ status: string }>;
  const succeeded = rows.filter((r) => r.status === "success").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const open = rows.filter((r) => r.status === "pending" || r.status === "running").length;
  const patch: Record<string, unknown> = {
    succeeded_count: succeeded,
    failed_count: failed,
  };
  const terminal = deriveBatchStatus(succeeded, failed, open);
  if (terminal) patch.status = terminal;
  await supabaseAdmin.from("listing_generation_batches").update(patch).eq("id", batchId);
  // US-955: once the batch terminalizes, fire the optional auto-publish of its
  // green, clean drafts. The trigger is claim-guarded (once-only), so calling it
  // from every finalize path — slice roll-up, worker finally, reclaim, admin
  // cancel — is safe and ensures it isn't missed if the worker dies at the end.
  if (terminal) await maybeAutoPublishGreen(batchId);
}

/**
 * US-674: load the listing template attached to a batch (if any) for the
 * generated-draft overlay. Returns null when the batch has no template or the
 * lookup fails — the overlay is best-effort and never blocks generation.
 */
async function loadBatchTemplate(
  batchId: string,
): Promise<ListingTemplateRow | null> {
  const { data: batchRow } = await supabaseAdmin
    .from("listing_generation_batches")
    .select("template_id")
    .eq("id", batchId)
    .maybeSingle();
  const templateId = (batchRow as { template_id?: string | null } | null)?.template_id;
  if (!templateId) return null;
  const { data: tpl } = await supabaseAdmin
    .from("listing_templates")
    .select(TEMPLATE_OVERLAY_COLUMNS)
    .eq("id", templateId)
    .maybeSingle();
  return (tpl as ListingTemplateRow | null) ?? null;
}

/**
 * Background worker: generate a listing for each job with bounded concurrency.
 * Partial failures never abort the batch — each job records its own
 * status/error/attempts. Quota is enforced atomically per item (US-527); a
 * per-item timeout caps a hung generation (US-526); jobs are claimed so a
 * resumed/concurrent run can't double-process one (US-525).
 */
// US-9115: wire the worker into lib/autolister-enqueue.ts.
//
// Registered rather than imported, because lib must never import a route. If
// this ever stopped running, an enqueued batch would not be lost — it is
// written as 'running' with pending jobs, which is the state the reclaim cron
// resumes — but it would wait BATCH_STALE_MS first, and nothing would say so.
// autolister-enqueue_test.ts asserts the registration happens.
registerBatchRunner((batchId, ownerId, jobs, useComps, limit) =>
  processBatch(batchId, ownerId, jobs, useComps, limit)
);

async function processBatch(
  batchId: string,
  ownerId: string,
  jobs: Array<
    { id: string; inventory_item_id: string; attempts?: number; ai_reserved?: boolean | null }
  >,
  useComps: boolean,
  limit: number,
): Promise<void> {
  const jobStaleBefore = new Date(Date.now() - JOB_STALE_MS).toISOString();

  // US-674: load the batch's template once (covers the initial run, retry, and
  // reclaim/resume paths, which all call processBatch). Best-effort — a missing
  // template just means no overlay; generation proceeds unchanged.
  const template = await loadBatchTemplate(batchId);

  /**
   * Overlay the template's NON-description fields onto a generated draft.
   *
   * US-2967: the description used to be part of this patch, appended onto the
   * rendered string after a read of the row. It is a block now, handed to
   * `generateListing` so it lands in the same upsert as everything else it
   * renders from — which is why this no longer reads the listing first.
   */
  async function applyTemplate(listingId: string): Promise<void> {
    if (!template) return;
    const patch = buildTemplateListingPatch(template);
    if (Object.keys(patch).length === 0) return;
    await supabaseAdmin.from("listings").update(patch).eq("id", listingId);
  }

  async function runJob(
    job: { id: string; inventory_item_id: string; attempts?: number; ai_reserved?: boolean | null },
  ): Promise<void> {
    const attempts = job.attempts ?? 0;
    // US-525: don't resume a job forever.
    if (attempts >= MAX_JOB_ATTEMPTS) {
      // US-1931: if this abandoned job still holds a reservation from an earlier
      // attempt, release it — a terminally-failed item must not keep an AI action
      // charged against the owner's monthly cap.
      if (job.ai_reserved === true) {
        await refundAiAction(ownerId);
        await releaseJobReservation(job.id);
      }
      await markJobFailed(
        job.id,
        "Generation abandoned after repeated interruptions. Retry from the queue if needed.",
      );
      return;
    }

    // US-525: atomically CLAIM the job. Eligible = still 'pending', or a
    // 'running' job left stale by a dead worker. If a live worker already owns
    // it (fresh 'running'), the conditional update matches nothing and we skip.
    // US-1552: TWO sequential conditional updates, NOT one with `.or()` —
    // the self-hosted prod PostgREST rejects logical operators on mutations
    // (42703 "column <table>.status does not exist" from the update-CTE alias),
    // which stranded a whole batch. Plain column filters on PATCH are safe.
    const claimPatch = { status: "running", attempts: attempts + 1, error: null };
    let { data: claimed, error: claimErr } = await supabaseAdmin
      .from("listing_generation_jobs")
      .update(claimPatch)
      .eq("id", job.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimErr && !claimed) {
      // Not pending — claim it only if it's a stale 'running' orphan.
      ({ data: claimed, error: claimErr } = await supabaseAdmin
        .from("listing_generation_jobs")
        .update(claimPatch)
        .eq("id", job.id)
        .eq("status", "running")
        .lt("updated_at", jobStaleBefore)
        .select("id")
        .maybeSingle());
    }
    // US-1552: a DB error here used to read as "someone else owns it" and the
    // job was skipped SILENTLY — with a persistent error (e.g. schema drift)
    // every job skipped and the batch sat 'running' forever with no log trail.
    if (claimErr) {
      console.error(
        `[flipdesk-autolister] job ${job.id} claim failed (left pending): ${claimErr.message}`,
      );
      return;
    }
    if (!claimed) return;

    // US-527/US-1931: atomic, cap-aware, IDEMPOTENT-per-job reservation. If this
    // job already reserved on a prior attempt (crash-interrupted, now reclaimed),
    // reuse that reservation instead of charging the cap again — see
    // needsAiReservation. Otherwise reserve once and persist the flag BEFORE the
    // long generateListing call, so a crash mid-generation resumes without a
    // second charge.
    if (needsAiReservation(job)) {
      let reserved = false;
      try {
        reserved = await reserveAiAction(ownerId, limit);
      } catch (err) {
        await markJobFailed(job.id, err instanceof Error ? err.message : "Quota check failed");
        return;
      }
      if (!reserved) {
        await markJobFailed(
          job.id,
          "Monthly AI action limit reached — this item was not generated. Your allowance resets next month.",
        );
        return;
      }
      await markJobReserved(job.id);
    }

    try {
      const result = await withTimeout(
        generateListing(job.inventory_item_id, ownerId, {
          batchId,
          useComps,
          // US-2967: the boilerplate has to be present when the blocks are
          // first written, not bolted onto the rendered string afterwards.
          templateBoilerplate: template?.description_template ?? null,
        }),
        GENERATION_TIMEOUT_MS,
        "Listing generation",
      );
      // US-1923: the success write is CONDITIONAL on the job still being
      // 'running'. If an operator cancel (adminCancelGenerationBatch) flipped
      // this job to 'failed' while generation was in flight, this update matches
      // nothing — we must NOT flip the cancelled job back to 'success', advance
      // its item, or (via the worker's finalizeBatch) re-terminalize the batch
      // out of its cancelled state. Sequential `.eq` (no `.or()` on a mutation,
      // US-1552). `.select().maybeSingle()` tells us whether we actually won it.
      const { data: won, error: winErr } = await supabaseAdmin
        .from("listing_generation_jobs")
        .update({ status: "success", listing_id: result.listingId, error: null })
        .eq("id", job.id)
        .eq("status", "running")
        .select("id")
        .maybeSingle();
      if (winErr) {
        // Uncertain write — leave the job for the reclaim sweeper rather than
        // refunding paid-for work or advancing the item on a shaky result.
        console.error(
          `[flipdesk-autolister] job ${job.id} success write failed: ${winErr.message}`,
        );
        return;
      }
      const settle = settleAfterGeneration(won != null);
      if (settle.refundReservation) {
        // Cancelled mid-flight: the job stays 'failed'. Reconcile the AI action
        // we reserved for it and stop — no item advance, no batch re-terminalize.
        console.log(
          `[flipdesk-autolister] job ${job.id}: cancelled mid-generation — refunding reservation`,
        );
        await refundAiAction(ownerId);
        await releaseJobReservation(job.id);
        return;
      }
      // Auto-advance the item to 'drafted' so a generated listing lands in the
      // Drafts tab directly — no manual "move to draft" step (web + iOS). Guarded
      // to pre-publish statuses so re-generating a live/sold item isn't regressed.
      await supabaseAdmin
        .from("inventory_items")
        .update({ status: "drafted" })
        .eq("id", job.inventory_item_id)
        .eq("user_id", ownerId)
        .in("status", [
          "sourced",
          "cataloged",
          "measured",
          "photographed",
          "comped",
        ]);
      // US-674: apply the batch's template to the generated draft (no-op when
      // none was selected). Best-effort — overlay failure must not fail the job.
      try {
        await applyTemplate(result.listingId);
      } catch (overlayErr) {
        console.error("[flipdesk-autolister] template overlay failed:", overlayErr);
      }
      // 2026-09-02: the cross-list copy kit, in the same action. Runs AFTER
      // the template overlay so a boilerplate the seller attached to the batch
      // is in the copy the other channels get, and OUTSIDE the generation
      // timeout so a slow kit pass cannot fail a draft that already exists.
      // Best-effort: the draft is the deliverable, the kit is the convenience.
      try {
        const kit = await generateKitForDraft(job.inventory_item_id, ownerId);
        if (kit.platforms.length > 0) {
          console.log(
            `[flipdesk-autolister] kit filled for item ${job.inventory_item_id}: ` +
              `${kit.platforms.join(",")} ($${(kit.costUsd ?? 0).toFixed(4)})`,
          );
        }
      } catch (kitErr) {
        console.error("[flipdesk-autolister] cross-list kit failed:", kitErr);
      }
      // US-538: for an opted-in, graded item, composite the verified grade's
      // defect annotations (bbox callouts + legend) onto the grading photos
      // and append them to the listing photo set. Best-effort + idempotent —
      // an annotation failure must never fail the generation job.
      try {
        await applyAutoDefectAnnotations(ownerId, job.inventory_item_id);
      } catch (annErr) {
        console.error("[flipdesk-autolister] defect annotation failed:", annErr);
      }
    } catch (err) {
      // Generation failed (incl. timeout) — give the reserved quota slot back
      // and clear the per-job reservation flag so a later reclaim/retry reserves
      // afresh rather than reusing a now-refunded reservation (US-1931).
      await refundAiAction(ownerId);
      await releaseJobReservation(job.id);
      await markJobFailed(job.id, err instanceof Error ? err.message : "Generation failed");
    }
  }

  try {
    // US-1552: bookend logs — the worker was previously silent end-to-end on
    // the happy path AND on per-job failures, so a dead/stalled batch was
    // indistinguishable from a healthy one in the edge logs.
    console.log(
      `[flipdesk-autolister] batch ${batchId}: worker started, ${jobs.length} job(s)`,
    );
    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
      // US-1923: stop promptly if the batch was cancelled while we were working
      // (its status went terminal with jobs still queued). The claim guard
      // already skips the now-'failed' pending jobs, but bailing here avoids the
      // wasted claim round-trips for the remainder.
      if (i > 0) {
        const { data: b } = await supabaseAdmin
          .from("listing_generation_batches")
          .select("status")
          .eq("id", batchId)
          .maybeSingle();
        if (isHaltedBatchStatus((b as { status?: string } | null)?.status)) {
          console.log(
            `[flipdesk-autolister] batch ${batchId}: cancelled — skipping remaining ${jobs.length - i} job(s)`,
          );
          break;
        }
      }
      await Promise.all(jobs.slice(i, i + CONCURRENCY).map((j) => runJob(j)));
      // Live progress + heartbeat for the reclaim sweeper.
      await finalizeBatch(batchId);
      console.log(
        `[flipdesk-autolister] batch ${batchId}: ${Math.min(i + CONCURRENCY, jobs.length)}/${jobs.length} dispatched`,
      );
    }
  } catch (err) {
    console.error("[flipdesk-autolister] batch worker crashed:", err);
  } finally {
    // US-525: always terminalize from the jobs table, even on a crash/resume.
    await finalizeBatch(batchId).catch((e) =>
      console.error("[flipdesk-autolister] finalizeBatch failed:", e)
    );
    console.log(`[flipdesk-autolister] batch ${batchId}: worker finished`);
  }
}

// ════════════════════════════════════════════════════════════════════
// US-955: auto-publish green drafts on batch completion
// ════════════════════════════════════════════════════════════════════
//
// When a generation batch opted in (auto_publish_green), publish ONLY its
// high-confidence (green) + pre-flight-clean drafts as soon as generation
// finishes — fire-and-forget. amber/red/blocked/scheduled drafts never
// auto-publish. The clean set is handed to the SAME durable publish worker
// (US-559) the manual "Publish green" path uses, and the plan/capacity gate is
// the SAME as the manual bulk-publish endpoint (US-955 AC5). The publish batch
// is tagged so its completion emits ONE notification with published-vs-skipped
// counts (the generation-time skips are stored on it).

// requireFlipdesk only ever reads c.get and (on a block/warn) calls c.json /
// c.header. Auto-publish runs in the background with no HTTP request, so this
// minimal stub context lets it reuse the IDENTICAL plan/capacity gate logic the
// manual bulk-publish endpoint uses and read the decision back.
interface GateDecision {
  blocked: boolean;
  body: Record<string, unknown> | null;
}
function evaluateGate(
  ownerId: string,
  opts: Parameters<typeof requireFlipdesk>[1],
): Promise<GateDecision> {
  let captured: Record<string, unknown> | null = null;
  const c = {
    get: (k: string) => (k === "userId" || k === "workspaceOwnerId" ? ownerId : undefined),
    json: (b: unknown) => {
      captured = b as Record<string, unknown>;
      return {} as Response;
    },
    header: () => {},
  } as unknown as Parameters<typeof requireFlipdesk>[0];
  return requireFlipdesk(c, { ...opts, userId: ownerId }).then((res) => ({
    blocked: res !== null,
    body: captured,
  }));
}

/**
 * Claim-guarded auto-publish trigger. The conditional UPDATE stamps
 * auto_published_at exactly once for an opted-in, terminal batch, so a repeated
 * finalize, the reclaim sweeper, or an admin cancel can each call this without
 * double-publishing. Restricted to completed/partial — a fully 'failed' batch
 * produced no green drafts.
 */
async function maybeAutoPublishGreen(batchId: string): Promise<void> {
  try {
    const { data: claimed } = await supabaseAdmin
      .from("listing_generation_batches")
      .update({ auto_published_at: new Date().toISOString() })
      .eq("id", batchId)
      .eq("auto_publish_green", true)
      .is("auto_published_at", null)
      .in("status", ["completed", "partial"])
      .select("id, user_id")
      .maybeSingle();
    if (!claimed) return;
    await autoPublishGreenDrafts(batchId, (claimed as { user_id: string }).user_id);
  } catch (err) {
    console.error("[flipdesk-autolister] auto-publish trigger failed:", err);
  }
}

/**
 * Triage the batch's succeeded drafts, publish the green + clean + unscheduled
 * + within-cap set via the durable publish worker, and account for everything
 * skipped (with reasons). Tenant-scoped (US-268): every read is bound to ownerId
 * or reached through the already-owned generation batch.
 */
async function autoPublishGreenDrafts(batchId: string, ownerId: string): Promise<void> {
  const skips: AutoPublishSkips = emptySkips();

  // Succeeded drafts only — failed (red) jobs never produced a draft.
  const { data: jobRows } = await supabaseAdmin
    .from("listing_generation_jobs")
    .select("inventory_item_id, listing_id")
    .eq("batch_id", batchId)
    .eq("status", "success");
  const jobs = ((jobRows ?? []) as Array<
    { inventory_item_id: string; listing_id: string | null }
  >).filter((j) => !!j.listing_id);
  if (jobs.length === 0) {
    await notifyAutoPublishOutcome(ownerId, { published: 0, failed: 0, skipped: skips });
    return;
  }

  const listingIds = jobs.map((j) => j.listing_id as string);
  const itemIds = jobs.map((j) => j.inventory_item_id);

  // needs_review + scheduled_publish_at per draft (listings reached via the owned
  // batch's jobs). photo_qa_score + status per item (tenant-scoped by user_id).
  const { data: listingRows } = await supabaseAdmin
    .from("listings")
    .select("id, needs_review, scheduled_publish_at")
    .in("id", listingIds);
  const listingById = new Map(
    ((listingRows ?? []) as Array<
      { id: string; needs_review: boolean | null; scheduled_publish_at: string | null }
    >).map((r) => [r.id, r]),
  );
  const { data: itemRows } = await supabaseAdmin
    .from("inventory_items")
    .select("id, status, photo_qa_score")
    .eq("user_id", ownerId)
    .in("id", itemIds);
  const itemById = new Map(
    ((itemRows ?? []) as Array<
      { id: string; status: string; photo_qa_score: number | null }
    >).map((r) => [r.id, r]),
  );

  // 1) Tier (green vs amber) + scheduling.
  const greenUnscheduled: Array<{ itemId: string; status: string }> = [];
  for (const job of jobs) {
    const listing = listingById.get(job.listing_id as string);
    const item = itemById.get(job.inventory_item_id);
    if (!item) continue; // not owned / vanished — drop silently
    const green = isGreenDraft({
      needsReview: !!listing?.needs_review,
      photoQaScore: item.photo_qa_score,
    });
    if (!green) {
      skips.needs_review += 1;
      continue;
    }
    // A scheduled draft waits for the scheduled-publish worker (US-322).
    if (listing?.scheduled_publish_at) {
      skips.scheduled += 1;
      continue;
    }
    greenUnscheduled.push({ itemId: job.inventory_item_id, status: item.status });
  }

  // 2) Publish pre-flight: only drafts the manual publish would accept (no eBay
  //    blockers / missing policies) are clean enough to auto-publish.
  const clean: Array<{ itemId: string; status: string }> = [];
  for (const candidate of greenUnscheduled) {
    try {
      const ctx = await assemblePublishContext(ownerId, candidate.itemId);
      const blocked = !ctx.ok || ctx.blockers.length > 0 || !ctx.policies;
      if (blocked) skips.blocked += 1;
      else clean.push(candidate);
    } catch (err) {
      console.error("[flipdesk-autolister] auto-publish pre-flight failed:", err);
      skips.blocked += 1;
    }
  }
  if (clean.length === 0) {
    await notifyAutoPublishOutcome(ownerId, { published: 0, failed: 0, skipped: skips });
    return;
  }

  // 3) Plan/capacity gate — exactly as the manual bulk-publish endpoint. Feature
  //    gate first; then the active-listing cap counts only NEWLY-live items
  //    (re-publish of an already-'listed' item doesn't add to the cap). On an
  //    over-cap result, publish up to the remaining capacity and report the rest.
  let toPublish = clean;
  const feature = await evaluateGate(ownerId, { feature: "autolister" });
  if (feature.blocked) {
    skips.plan_limit += clean.length;
    await notifyAutoPublishOutcome(ownerId, { published: 0, failed: 0, skipped: skips });
    return;
  }
  const newLive = clean.filter((c) => c.status !== "listed");
  if (newLive.length > 0) {
    const cap = await evaluateGate(ownerId, {
      capacity: { kind: "activeListings", delta: newLive.length },
    });
    if (cap.blocked) {
      const used = Number(cap.body?.used ?? 0);
      const limit = Number(cap.body?.limit ?? 0);
      const remaining = Math.max(0, limit - used);
      // Keep already-live re-publishes (free) + as many new-live as fit.
      const keepNewLive = newLive.slice(0, remaining).map((c) => c.itemId);
      const keep = new Set([
        ...clean.filter((c) => c.status === "listed").map((c) => c.itemId),
        ...keepNewLive,
      ]);
      skips.plan_limit += clean.length - keep.size;
      toPublish = clean.filter((c) => keep.has(c.itemId));
    }
  }
  if (toPublish.length === 0) {
    await notifyAutoPublishOutcome(ownerId, { published: 0, failed: 0, skipped: skips });
    return;
  }

  // 4) Enqueue the durable publish batch. Tagged auto_published + the generation
  //    skip breakdown so finalizePublishBatch emits ONE completion notification
  //    folding in the live published/failed counts.
  const { data: pubBatch, error: pubErr } = await supabaseAdmin
    .from("listing_publish_batches")
    .insert({
      user_id: ownerId,
      status: "running",
      item_count: toPublish.length,
      auto_published: true,
      generation_batch_id: batchId,
      auto_skipped: skips,
    })
    .select("id")
    .single();
  if (pubErr || !pubBatch) {
    console.error("[flipdesk-autolister] auto-publish batch insert failed:", pubErr);
    // Fall back to reporting the skips (nothing was published).
    await notifyAutoPublishOutcome(ownerId, { published: 0, failed: 0, skipped: skips });
    return;
  }
  const pubBatchId = (pubBatch as { id: string }).id;

  const { data: pubJobRows, error: pubJobsErr } = await supabaseAdmin
    .from("listing_publish_jobs")
    .insert(
      toPublish.map((c) => ({
        batch_id: pubBatchId,
        inventory_item_id: c.itemId,
        status: "pending" as const,
      })),
    )
    .select("id, inventory_item_id");
  if (pubJobsErr || !pubJobRows) {
    await supabaseAdmin
      .from("listing_publish_batches")
      .update({ status: "failed", error: "Failed to enqueue auto-publish jobs." })
      .eq("id", pubBatchId);
    await notifyAutoPublishOutcome(ownerId, { published: 0, failed: 0, skipped: skips });
    return;
  }

  const pubJobs = pubJobRows as Array<{ id: string; inventory_item_id: string }>;
  void processPublishBatch(pubBatchId, ownerId, pubJobs).catch((err) =>
    console.error("[flipdesk-autolister] auto-publish worker crashed:", err)
  );
}

/** Best-effort completion notification (never throws — notifyUser swallows). */
async function notifyAutoPublishOutcome(
  ownerId: string,
  outcome: { published: number; failed: number; skipped: AutoPublishSkips },
): Promise<void> {
  const { title, message } = buildAutoPublishNotification(outcome);
  await notifyUser(ownerId, {
    type: "system",
    title,
    message,
    link: "/dashboard/flipdesk/inventory?mode=listings",
  });
}

// ── US-529: validated staging upload ────────────────────────────────
// POST /staging/upload — multipart { session_id, full, thumb? }.
//
// AutoLister photos used to be uploaded by the browser straight into the
// item-photos bucket, bypassing the US-276 upload hardening. This endpoint is
// now the only upload path the AutoLister page uses: it sniffs the real magic
// bytes (allowlist jpeg/png/webp — HEIC is transcoded client-side), caps byte
// size + pixel dimensions, rejects unusably small images (eBay's 500px
// long-side floor), and strips EXIF/GPS before the bytes land in storage —
// including the client's compress-failure fallback, which previously shipped
// the raw original with metadata intact.

const STAGING_THUMB_MAX_BYTES = 2 * 1024 * 1024;
// eBay rejects pictures under 500px on the longest side — anything smaller is
// unusable as a listing photo, so reject it before storage + AI spend.
const STAGING_MIN_LONG_SIDE = 500;

flipdeskAutolisterRoutes.post("/staging/upload", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json(
      { error: "Invalid form data. Expected multipart/form-data." },
      400,
    );
  }

  // The staging session id becomes a storage path segment — accept only a
  // UUID-ish token so it can't traverse or inject path separators.
  const sessionId = form.get("session_id");
  if (
    typeof sessionId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(sessionId)
  ) {
    return c.json({ error: "Invalid session_id" }, 400);
  }

  const full = form.get("full");
  if (!(full instanceof File) || full.size === 0) {
    return c.json({ error: "Missing image file" }, 400);
  }

  const rawBytes = new Uint8Array(await full.arrayBuffer());
  const verdict = validateImageUpload(rawBytes, {
    allow: ["jpeg", "png", "webp"],
    minDimension: STAGING_MIN_LONG_SIDE,
  });
  if (!verdict.ok) {
    return c.json({ error: `Invalid image: ${verdict.reason}` }, 400);
  }
  const { bytes: cleanBytes } = stripImageMetadata(rawBytes, verdict.format);

  const id = crypto.randomUUID();
  const base = `${ownerId}/_staging/${sessionId}/${id}`;
  const path = `${base}.${verdict.ext}`;
  const { error: upErr } = await supabaseAdmin.storage
    .from("item-photos")
    .upload(path, cleanBytes, {
      upsert: false,
      contentType: verdict.contentType,
    });
  if (upErr) {
    return failSafe(
      c,
      500,
      "Could not upload that photo.",
      upErr,
      "autolister.staging-photo.upload",
    );
  }
  // item-photo-url-ok: a staging/just-uploaded object in the public bucket,
  // not an item_photos row — there is no private variant to resolve.
  const url = supabaseAdmin.storage.from("item-photos").getPublicUrl(path)
    .data.publicUrl;

  // Thumbnail: optional + best-effort (the UI falls back to the full image).
  // Same sniff/strip pipeline; no min-resolution gate (it's deliberately tiny).
  let thumbnailStoragePath: string | null = null;
  let thumbnailUrl: string | null = null;
  const thumb = form.get("thumb");
  if (thumb instanceof File && thumb.size > 0) {
    const thumbBytes = new Uint8Array(await thumb.arrayBuffer());
    const thumbVerdict = validateImageUpload(thumbBytes, {
      allow: ["jpeg", "png", "webp"],
      maxBytes: STAGING_THUMB_MAX_BYTES,
    });
    if (thumbVerdict.ok) {
      const cleanThumb = stripImageMetadata(thumbBytes, thumbVerdict.format);
      const tpath = `${base}_thumb.${thumbVerdict.ext}`;
      const { error: tErr } = await supabaseAdmin.storage
        .from("item-photos")
        .upload(tpath, cleanThumb.bytes, {
          upsert: false,
          contentType: thumbVerdict.contentType,
        });
      if (!tErr) {
        thumbnailStoragePath = tpath;
        // item-photo-url-ok: a staging/just-uploaded object in the public bucket,
        // not an item_photos row — there is no private variant to resolve.
        thumbnailUrl = supabaseAdmin.storage.from("item-photos")
          .getPublicUrl(tpath).data.publicUrl;
      }
    }
  }

  return c.json({
    storage_path: path,
    url,
    thumbnail_storage_path: thumbnailStoragePath,
    thumbnail_url: thumbnailUrl,
    width: verdict.width,
    height: verdict.height,
    bytes: cleanBytes.length,
  });
});

// ── US-2374: phone → desktop handoff sessions ───────────────────────
//
// The desktop AutoLister session (staged photos + grouping) lives in the
// BROWSER — IndexedDB, localStorage fallback — so a batch shot and grouped on
// the phone had nowhere to go except that phone. These routes are the shared
// shelf: the mobile app uploads its photos through /staging/upload exactly like
// the web uploader does, then writes ONE row holding the photo list and the
// grouping. The desktop lists what's waiting, loads one, and claims it.
//
// Nothing here runs AI or creates inventory rows — this is strictly the
// pre-generation review state, handed from one screen to another.
//
// Tenant safety (CLAUDE.md US-268): `autolister_handoff_sessions` is a
// multi-tenant table, so every query below is `.eq("user_id", ownerId)`. On top
// of that, every storage path in the payload must sit under the caller's own
// `${ownerId}/_staging/` prefix — the same check verify-groups makes — so a
// forged path can't park another tenant's photo in the seller's desktop grid.

// A batch is capped at 200 photos on iOS; leave room for a bigger desktop-bound
// dump without letting one row become unbounded JSON.
const MAX_HANDOFF_PHOTOS = 500;
// How far back the desktop looks for waiting handoffs. Older than this and the
// staged objects are stale enough that re-shooting beats resuming.
const HANDOFF_LIST_DAYS = 30;
const HANDOFF_SOURCES = new Set(["ios", "android", "web"]);

interface HandoffPhotoRow {
  id: string;
  storage_path: string;
  url: string;
  thumbnail_storage_path: string | null;
  thumbnail_url: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  captured_at_ms: number | null;
  source_name: string | null;
  phash: string;
}

interface HandoffGroupRow {
  id: string;
  photo_ids: string[];
  cover_id: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/// Parse + tenant-check the payload. Returns an error message instead of
/// throwing so the caller can pick the status code (403 for an ownership
/// failure, 400 for a malformed one).
function parseHandoffPayload(
  body: { photos?: unknown; groups?: unknown },
  ownerId: string,
): { photos: HandoffPhotoRow[]; groups: HandoffGroupRow[] } | { error: string; status: 400 | 403 } {
  const rawPhotos = Array.isArray(body.photos) ? body.photos : [];
  if (rawPhotos.length === 0) {
    return { error: "photos must contain at least one photo.", status: 400 };
  }
  if (rawPhotos.length > MAX_HANDOFF_PHOTOS) {
    return {
      error: `At most ${MAX_HANDOFF_PHOTOS} photos can be handed off at once.`,
      status: 400,
    };
  }

  const photos: HandoffPhotoRow[] = [];
  const seen = new Set<string>();
  for (const raw of rawPhotos) {
    const p = raw as Record<string, unknown>;
    const id = str(p.id);
    const path = str(p.storage_path);
    if (!id || !path) {
      return { error: "Each photo needs an id and storage_path.", status: 400 };
    }
    if (seen.has(id)) {
      return { error: "Duplicate photo id in payload.", status: 400 };
    }
    seen.add(id);
    // The ownership check, before anything is written or read back.
    if (!path.startsWith(`${ownerId}/_staging/`)) {
      return { error: "A photo is not owned by the caller.", status: 403 };
    }
    const thumbPath = str(p.thumbnail_storage_path);
    if (thumbPath && !thumbPath.startsWith(`${ownerId}/_staging/`)) {
      return { error: "A thumbnail is not owned by the caller.", status: 403 };
    }
    // Re-derive the public URLs from the (now verified) paths rather than
    // trusting the client's — a caller can't smuggle in a foreign URL.
    // item-photo-url-ok: staging objects in the public bucket, not item_photos
    // rows — there is no private variant to resolve.
    const url = supabaseAdmin.storage.from("item-photos").getPublicUrl(path)
      .data.publicUrl;
    const thumbnailUrl = thumbPath
      ? supabaseAdmin.storage.from("item-photos").getPublicUrl(thumbPath).data
        .publicUrl
      : null;
    photos.push({
      id,
      storage_path: path,
      url,
      thumbnail_storage_path: thumbPath || null,
      thumbnail_url: thumbnailUrl,
      width: numOrNull(p.width),
      height: numOrNull(p.height),
      bytes: numOrNull(p.bytes),
      captured_at_ms: numOrNull(p.captured_at_ms),
      source_name: str(p.source_name) || null,
      phash: str(p.phash),
    });
  }

  const rawGroups = Array.isArray(body.groups) ? body.groups : [];
  const groups: HandoffGroupRow[] = [];
  const claimed = new Set<string>();
  for (const raw of rawGroups) {
    const g = raw as Record<string, unknown>;
    const ids = Array.isArray(g.photo_ids) ? g.photo_ids.map(str) : [];
    const members = ids.filter((id) => id && seen.has(id) && !claimed.has(id));
    if (members.length === 0) continue;
    for (const id of members) claimed.add(id);
    const cover = str(g.cover_id);
    groups.push({
      id: str(g.id) || crypto.randomUUID(),
      photo_ids: members,
      cover_id: members.includes(cover) ? cover : members[0],
    });
  }

  return { photos, groups };
}

// POST /sessions — park a batch for the desktop.
// Body: { staging_session_id, source?, photos: [...], groups?: [...] }
flipdeskAutolisterRoutes.post("/sessions", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: {
    staging_session_id?: unknown;
    source?: unknown;
    photos?: unknown;
    groups?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Same token shape /staging/upload accepts — it IS a storage path segment.
  const stagingSessionId = str(body.staging_session_id);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(stagingSessionId)) {
    return c.json({ error: "Invalid staging_session_id" }, 400);
  }
  const source = str(body.source) || "ios";
  if (!HANDOFF_SOURCES.has(source)) {
    return c.json({ error: "Invalid source" }, 400);
  }

  const parsed = parseHandoffPayload(body, ownerId);
  if ("error" in parsed) {
    return c.json({ error: parsed.error }, parsed.status);
  }

  const { data, error } = await supabaseAdmin
    .from("autolister_handoff_sessions")
    .insert({
      user_id: ownerId,
      staging_session_id: stagingSessionId,
      source,
      status: "open",
      photo_count: parsed.photos.length,
      group_count: parsed.groups.length,
      photos: parsed.photos,
      groups: parsed.groups,
    })
    .select("id, photo_count, group_count, created_at")
    .single();
  if (error) {
    console.error("[AutoLister] handoff insert failed", error);
    return c.json({ error: "Couldn't save this batch for the desktop." }, 500);
  }
  return c.json(data, 201);
});

// GET /sessions — what's waiting for this seller (newest first, open only).
flipdeskAutolisterRoutes.get("/sessions", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const since = new Date(Date.now() - HANDOFF_LIST_DAYS * 86_400_000)
    .toISOString();
  const { data, error } = await supabaseAdmin
    .from("autolister_handoff_sessions")
    .select("id, source, status, photo_count, group_count, created_at")
    .eq("user_id", ownerId)
    .eq("status", "open")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    console.error("[AutoLister] handoff list failed", error);
    return c.json({ error: "Couldn't load waiting batches." }, 500);
  }
  return c.json({ sessions: data ?? [] });
});

// GET /sessions/:id — the full payload, for the desktop to load.
flipdeskAutolisterRoutes.get("/sessions/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("autolister_handoff_sessions")
    .select(
      "id, source, status, staging_session_id, photo_count, group_count, photos, groups, created_at",
    )
    .eq("id", c.req.param("id"))
    .eq("user_id", ownerId)
    .maybeSingle();
  if (error) {
    console.error("[AutoLister] handoff read failed", error);
    return c.json({ error: "Couldn't load that batch." }, 500);
  }
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json(data);
});

// POST /sessions/:id/claim — the desktop has loaded it. Kept (not deleted) so a
// mis-click on the desktop can't destroy an upload the phone no longer holds.
flipdeskAutolisterRoutes.post("/sessions/:id/claim", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("autolister_handoff_sessions")
    .update({ status: "claimed", claimed_at: new Date().toISOString() })
    .eq("id", c.req.param("id"))
    .eq("user_id", ownerId)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[AutoLister] handoff claim failed", error);
    return c.json({ error: "Couldn't claim that batch." }, 500);
  }
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// DELETE /sessions/:id — discard it, and sweep the staged objects with it so a
// declined handoff doesn't leave a folder of orphaned photos in storage.
//
// The sweep is for OPEN handoffs only, and that is load-bearing: generation
// does NOT copy staged objects anywhere — `item_photos.storage_path` points
// straight back into `_staging/`, so once a handoff has been claimed and
// generated its photos ARE the live listing images. Sweeping a claimed
// handoff's paths would delete the seller's published photos out from under
// their listings. A claimed row is dropped; its objects are left alone.
flipdeskAutolisterRoutes.delete("/sessions/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("autolister_handoff_sessions")
    .select("id, status, photos")
    .eq("id", c.req.param("id"))
    .eq("user_id", ownerId)
    .maybeSingle();
  if (error) {
    console.error("[AutoLister] handoff delete lookup failed", error);
    return c.json({ error: "Couldn't discard that batch." }, 500);
  }
  if (!data) return c.json({ error: "Not found" }, 404);

  const { error: delErr } = await supabaseAdmin
    .from("autolister_handoff_sessions")
    .delete()
    .eq("id", data.id)
    .eq("user_id", ownerId);
  if (delErr) {
    console.error("[AutoLister] handoff delete failed", delErr);
    return c.json({ error: "Couldn't discard that batch." }, 500);
  }

  // Best-effort storage sweep, OPEN handoffs only (see the note above — a
  // claimed handoff's objects may already be live item photos). Re-check the
  // prefix on the way out: these paths were verified on write, but a delete is
  // exactly the call that must not act on a path it hasn't checked itself.
  if (data.status !== "open") return c.json({ ok: true, swept: 0 });
  const paths: string[] = [];
  for (const raw of Array.isArray(data.photos) ? data.photos : []) {
    const p = raw as Record<string, unknown>;
    for (const key of ["storage_path", "thumbnail_storage_path"]) {
      const path = str(p[key]);
      if (path.startsWith(`${ownerId}/_staging/`)) paths.push(path);
    }
  }
  if (paths.length > 0) {
    const { error: sweepErr } = await supabaseAdmin.storage
      .from("item-photos")
      .remove(paths);
    if (sweepErr) {
      console.error("[AutoLister] handoff storage sweep failed", sweepErr);
    }
  }
  return c.json({ ok: true, swept: paths.length });
});

// POST /batch  Body: { item_ids: string[], use_comps?: boolean }
flipdeskAutolisterRoutes.post("/batch", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: {
    item_ids?: unknown;
    use_comps?: unknown;
    template_id?: unknown;
    auto_publish_green?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const itemIds = Array.isArray(body.item_ids)
    ? body.item_ids.filter((x): x is string => typeof x === "string")
    : [];
  // US-674: optional listing template applied to every generated draft.
  const templateId = typeof body.template_id === "string" && body.template_id.trim()
    ? body.template_id.trim()
    : null;

  // US-9115: the guards and the enqueue live in lib/autolister-enqueue.ts so
  // the connector's create-draft tool runs the SAME ones. This route keeps its
  // parsing and its exact 202 envelope.
  const outcome = await enqueueGenerationBatch(ownerId, {
    itemIds,
    // US-955: opt-in fire-and-forget — auto-publish the green, clean drafts
    // when this batch finishes generating. Defaults off.
    autoPublishGreen: body.auto_publish_green === true,
    useComps: body.use_comps !== false, // default true
    templateId,
    maxItems: MAX_BATCH_ITEMS,
  });
  if (!outcome.ok) return c.json(outcome.body, outcome.status as 400);

  return c.json({ batch_id: outcome.batchId, item_count: outcome.itemCount }, 202);
});

// POST /batch/:id/retry-failed  —  re-runs ONLY the failed jobs in this batch
// against the same item set (US-318/US-325). Quota is re-checked + reserved
// atomically per item, so retries can't bypass the monthly cap.
// US-533: POST /classify-photos — vision pass over one group's staged photos.
// Returns { cover_id, roles: { photoId: role } } so the AutoLister can pick the
// best cover and order/tag the listing gallery automatically. Stateless: it
// classifies the photos the caller already staged; it writes nothing.
//
// Distinct from /api/flipdesk/ai/classify-photos (US-286), which classifies each
// photo INDEPENDENTLY into a type and (Mode A) writes back to a committed item.
// AutoLister needs a HOLISTIC pass that picks one best cover across the set, runs
// BEFORE any item exists, and scopes by storage_path (not an arbitrary URL).
//
// Tenant safety (CLAUDE.md US-268): staged AutoLister photos live in item-photos
// under the owner's `{ownerId}/...` folder. We refuse any storage_path outside
// the caller's folder, so a forged path can't make us fetch another tenant's
// image into the model.
flipdeskAutolisterRoutes.post("/classify-photos", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { photos?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const rawPhotos = Array.isArray(body.photos) ? body.photos : [];
  if (rawPhotos.length === 0) {
    return c.json({ error: "photos must be a non-empty array" }, 400);
  }
  if (rawPhotos.length > MAX_CLASSIFY_PHOTOS) {
    return c.json(
      { error: `At most ${MAX_CLASSIFY_PHOTOS} photos can be classified at once.` },
      400,
    );
  }

  // Paid-tier gate (same as generation): the cover/role pass is an AI feature.
  const gated = await requireFlipdesk(c, { feature: "autolister", userId: ownerId });
  if (gated) return gated;
  // US-1581: this endpoint used to meter AFTER the call with no cap check at
  // all — an uncapped free-actions leak. Enablement + cap now gate up front.
  const quota = await checkQuota(ownerId);
  if (!quota.ok) return c.json(quota.body, quota.status);

  const photos: { id: string; url: string }[] = [];
  for (const raw of rawPhotos) {
    const id = typeof (raw as { id?: unknown })?.id === "string"
      ? (raw as { id: string }).id
      : "";
    const path = typeof (raw as { storage_path?: unknown })?.storage_path === "string"
      ? (raw as { storage_path: string }).storage_path
      : "";
    if (!id || !path) {
      return c.json({ error: "Each photo needs an id and storage_path." }, 400);
    }
    // US-1638: these are STAGED photos (uploaded via /staging/upload →
    // `${ownerId}/_staging/…`). Require the full staging prefix, not just the
    // owner folder, matching the sibling /verify-groups check — so a path
    // elsewhere in the owner's tree can't be smuggled in.
    if (!path.startsWith(`${ownerId}/_staging/`)) {
      return c.json({ error: "A photo is not owned by the caller." }, 403);
    }
    // item-photo-url-ok: a staging/just-uploaded object in the public bucket,
    // not an item_photos row — there is no private variant to resolve.
    const url = supabaseAdmin.storage.from("item-photos").getPublicUrl(path)
      .data.publicUrl;
    photos.push({ id, url });
  }

  try {
    // One billed action, reserved atomically BEFORE the vision call and
    // refunded if it throws (US-1581).
    const result = await withAiAction(ownerId, quota.limit, () =>
      classifyPhotoRoles(photos));
    return c.json({ cover_id: result.coverId, roles: result.roles });
  } catch (err) {
    if (err instanceof AiQuotaExhaustedError) {
      return c.json({ error: QUOTA_EXHAUSTED_MESSAGE }, 429);
    }
    console.error("[AutoLister] classify-photos failed", err);
    return c.json(
      { error: err instanceof Error ? err.message : "Photo classification failed." },
      502,
    );
  }
});

// US-1544: POST /verify-groups — AI sanity-check of the PROPOSED grouping
// before any AI actions are spent generating from it. Body:
//   { groups: [{ id, photos: [{ id, storage_path }] }, …] }  (ordered)
// Returns { suggestions: [{type: merge|split|move, group_ids, photo_ids,
// confidence, reason}], model, escalated, groups_covered, truncated }. Writes
// NOTHING — suggestions are never auto-applied; the intake UI renders them as
// dismissible chips whose Apply routes through the undoable client mutations.
//
// Tenant safety (CLAUDE.md US-268): staged AutoLister photos live under the
// caller's own `${ownerId}/_staging/…` folder; every path is checked against
// that prefix BEFORE any DB/AI work, so a forged path can never make us fetch
// another tenant's image into the model. Rate-limited under the shared
// autolister POST limiter (20/min) like its vision siblings; metered via the
// atomic reserve (US-1581), refunded when the coverable-groups short-circuit
// means no vision call actually ran.
flipdeskAutolisterRoutes.post("/verify-groups", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { groups?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const rawGroups = Array.isArray(body.groups) ? body.groups : [];
  if (rawGroups.length < 2) {
    return c.json({ error: "groups must contain at least two groups." }, 400);
  }
  if (rawGroups.length > MAX_BATCH_ITEMS) {
    return c.json(
      { error: `At most ${MAX_BATCH_ITEMS} groups can be verified at once.` },
      400,
    );
  }

  const groups: VerifyGroup[] = [];
  for (const raw of rawGroups) {
    const groupId = typeof (raw as { id?: unknown })?.id === "string"
      ? (raw as { id: string }).id
      : "";
    const rawPhotos = (raw as { photos?: unknown })?.photos;
    if (!groupId || !Array.isArray(rawPhotos) || rawPhotos.length === 0) {
      return c.json({ error: "Each group needs an id and a non-empty photos array." }, 400);
    }
    const photos: VerifyGroup["photos"] = [];
    for (const p of rawPhotos) {
      const id = typeof (p as { id?: unknown })?.id === "string"
        ? (p as { id: string }).id
        : "";
      const path = typeof (p as { storage_path?: unknown })?.storage_path === "string"
        ? (p as { storage_path: string }).storage_path
        : "";
      if (!id || !path) {
        return c.json({ error: "Each photo needs an id and storage_path." }, 400);
      }
      if (!path.startsWith(`${ownerId}/_staging/`)) {
        return c.json({ error: "A photo is not owned by the caller." }, 403);
      }
      photos.push({
        id,
        // item-photo-url-ok: a staging/just-uploaded object in the public bucket,
        // not an item_photos row — there is no private variant to resolve.
        url: supabaseAdmin.storage.from("item-photos").getPublicUrl(path).data.publicUrl,
      });
    }
    groups.push({ id: groupId, photos });
  }

  // Paid-tier gate + monthly cap, matching the sibling vision endpoints.
  const gated = await requireFlipdesk(c, { feature: "autolister", userId: ownerId });
  if (gated) return gated;
  const quota = await checkQuota(ownerId);
  if (!quota.ok) return c.json(quota.body, quota.status);

  // US-1581: reserve atomically BEFORE the vision call (the old meter-after
  // increment could race past the cap). Fewer than two coverable groups
  // short-circuits without touching the model — refund that reservation so a
  // no-op stays free, exactly like the old model!=="none" metering.
  if (!(await reserveAiActionSafe(ownerId, quota.limit))) {
    return c.json({ error: QUOTA_EXHAUSTED_MESSAGE }, 429);
  }
  try {
    const result = await verifyGroupBoundaries(groups, MAX_VERIFY_PHOTOS);
    if (result.model === "none") {
      await refundAiAction(ownerId);
    }
    return c.json({
      suggestions: result.suggestions,
      model: result.model,
      escalated: result.escalated,
      groups_covered: result.groupsCovered,
      truncated: result.truncated,
    });
  } catch (err) {
    await refundAiAction(ownerId);
    console.error("[AutoLister] verify-groups failed", err);
    return c.json(
      { error: err instanceof Error ? err.message : "Group verification failed." },
      502,
    );
  }
});

// US-1904: POST /propose-groups — AI group-boundary proposal for a TIMELESS
// photo dump auto-grouping can't split (EXIF stripped, one contiguous run).
// Body: { photos: [{ id, storage_path }] }  (ordered, one client window).
// Returns { groups: [{ photo_ids, confidence, reason }], model, escalated }.
// Writes NOTHING — the client applies proposals through the undoable grouping
// mutations and renders low-confidence boundaries as review chips.
//
// Tenant safety (CLAUDE.md US-268): staged AutoLister photos live under the
// caller's own `${ownerId}/_staging/…` folder; EVERY path is checked against
// that prefix BEFORE any AI work, so a forged path can't make us fetch another
// tenant's image into the model. Rate-limited under the shared autolister POST
// limiter like its vision siblings; metered via the atomic reserve (US-1581),
// refunded when fewer than two photos means no vision call ran.
flipdeskAutolisterRoutes.post("/propose-groups", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { photos?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const rawPhotos = Array.isArray(body.photos) ? body.photos : [];
  if (rawPhotos.length < 2) {
    return c.json({ error: "photos must contain at least two photos." }, 400);
  }
  // One window: bounded to the same per-request vision budget as verify.
  if (rawPhotos.length > MAX_VERIFY_PHOTOS) {
    return c.json(
      { error: `At most ${MAX_VERIFY_PHOTOS} photos per window.` },
      400,
    );
  }

  const photos: ProposePhoto[] = [];
  for (const p of rawPhotos) {
    const id = typeof (p as { id?: unknown })?.id === "string"
      ? (p as { id: string }).id
      : "";
    const path = typeof (p as { storage_path?: unknown })?.storage_path === "string"
      ? (p as { storage_path: string }).storage_path
      : "";
    if (!id || !path) {
      return c.json({ error: "Each photo needs an id and storage_path." }, 400);
    }
    if (!path.startsWith(`${ownerId}/_staging/`)) {
      return c.json({ error: "A photo is not owned by the caller." }, 403);
    }
    photos.push({
      id,
      // item-photo-url-ok: a staging/just-uploaded object in the public bucket,
      // not an item_photos row — there is no private variant to resolve.
      url: supabaseAdmin.storage.from("item-photos").getPublicUrl(path).data.publicUrl,
    });
  }

  const gated = await requireFlipdesk(c, { feature: "autolister", userId: ownerId });
  if (gated) return gated;
  const quota = await checkQuota(ownerId);
  if (!quota.ok) return c.json(quota.body, quota.status);

  // US-1581: reserve atomically before the vision call; refund on the no-op
  // short-circuit (model "none") or on failure so a wasted call stays free.
  if (!(await reserveAiActionSafe(ownerId, quota.limit))) {
    return c.json({ error: QUOTA_EXHAUSTED_MESSAGE }, 429);
  }
  try {
    const result = await proposeItemGroups(photos);
    if (result.model === "none") {
      await refundAiAction(ownerId);
    }
    return c.json({
      groups: result.groups,
      model: result.model,
      escalated: result.escalated,
    });
  } catch (err) {
    await refundAiAction(ownerId);
    console.error("[AutoLister] propose-groups failed", err);
    return c.json(
      { error: err instanceof Error ? err.message : "Group proposal failed." },
      502,
    );
  }
});

// US-537: POST /photo-qa — score each item's photos 0-100 for listing-readiness
// and persist the score + specific issues on the item, so the queue can nudge
// the seller to reshoot before publishing. Body: { item_ids: [...] }.
//
// Tenant safety (CLAUDE.md US-268): items are filtered to the workspace owner
// before any photo is loaded or any row is written.
flipdeskAutolisterRoutes.post("/photo-qa", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { item_ids?: unknown; covers?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // US-957: pre-generation cover scan. The AutoLister intake scores each group's
  // cover photo BEFORE any inventory item exists — and before AI generation
  // quota is spent — so a seller can reshoot an unusable cover early. There's no
  // item row to persist to, so this branch scores by storage_path and returns
  // the scores without writing anything. Tenant safety (CLAUDE.md US-268): a
  // staged photo path is `${ownerId}/_staging/...`, so only paths under this
  // owner's prefix are assessed — a path from another tenant is dropped.
  if (Array.isArray(body.covers)) {
    type CoverInput = { id: string; storage_path: string };
    const covers = (body.covers as unknown[])
      .filter((x): x is CoverInput =>
        !!x && typeof x === "object" &&
        typeof (x as { id?: unknown }).id === "string" &&
        typeof (x as { storage_path?: unknown }).storage_path === "string"
      )
      // US-1638: staged covers live under `${ownerId}/_staging/…` (see comment
      // above) — require the full staging prefix, not just the owner folder.
      .filter((x) => x.storage_path.startsWith(`${ownerId}/_staging/`));
    const uniqueCovers = [...new Map(covers.map((x) => [x.id, x])).values()];
    if (uniqueCovers.length === 0) {
      return c.json(
        { error: "covers must be a non-empty array of owned staged photos" },
        400,
      );
    }
    if (uniqueCovers.length > MAX_QA_ITEMS) {
      return c.json({ error: `At most ${MAX_QA_ITEMS} covers per request.` }, 400);
    }

    const gated = await requireFlipdesk(c, { feature: "autolister", userId: ownerId });
    if (gated) return gated;
    // US-1581: enablement + cap gate (this branch used to meter after each
    // vision call with NO cap check — an uncapped leak). Capture the limit
    // into a const: TS narrowing doesn't survive into the worker closure.
    const coverQuota = await checkQuota(ownerId);
    if (!coverQuota.ok) return c.json(coverQuota.body, coverQuota.status);
    const coverLimit = coverQuota.limit;

    type CoverResult = {
      cover_id: string;
      score: number;
      issues: Array<{
        type: string;
        severity: string;
        message: string;
        photo_index: number | null;
      }>;
      error?: string;
    };
    const coverResults: CoverResult[] = [];
    const coverQueue = [...uniqueCovers];
    const coverWorker = async (): Promise<void> => {
      while (coverQueue.length > 0) {
        const cover = coverQueue.shift()!;
        // item-photo-url-ok: a staging/just-uploaded object in the public bucket,
        // not an item_photos row — there is no private variant to resolve.
        const url = supabaseAdmin.storage
          .from("item-photos")
          .getPublicUrl(cover.storage_path).data.publicUrl;
        try {
          // One billed action per cover, reserved atomically before the call
          // and refunded on failure (US-1581). Cap reached mid-batch → stop
          // spending: report this cover as capped and drain the queue.
          const qa = await withAiAction(ownerId, coverLimit, () =>
            assessPhotoQuality([{ url, type: "front" }]));
          coverResults.push({
            cover_id: cover.id,
            score: qa.score,
            issues: qa.issues.map((i) => ({
              type: i.type,
              severity: i.severity,
              message: i.message,
              photo_index: i.photoIndex,
            })),
          });
        } catch (err) {
          if (err instanceof AiQuotaExhaustedError) {
            coverResults.push({
              cover_id: cover.id,
              score: -1,
              issues: [],
              error: QUOTA_EXHAUSTED_MESSAGE,
            });
            coverQueue.length = 0;
            continue;
          }
          console.error("[AutoLister] cover photo-qa failed for", cover.id, err);
          coverResults.push({
            cover_id: cover.id,
            score: -1,
            issues: [],
            error: err instanceof Error ? err.message : "Photo QA failed.",
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, coverQueue.length) }, () =>
        coverWorker()),
    );
    return c.json({ results: coverResults });
  }

  const itemIds = Array.isArray(body.item_ids)
    ? Array.from(
      new Set(body.item_ids.filter((x): x is string => typeof x === "string")),
    )
    : [];
  if (itemIds.length === 0) {
    return c.json({ error: "item_ids must be a non-empty array" }, 400);
  }
  if (itemIds.length > MAX_QA_ITEMS) {
    return c.json({ error: `At most ${MAX_QA_ITEMS} items per request.` }, 400);
  }

  const gated = await requireFlipdesk(c, { feature: "autolister", userId: ownerId });
  if (gated) return gated;
  // US-1581: enablement + cap gate (per-item QA used to meter after each
  // vision call with NO cap check — an uncapped leak). Capture the limit into
  // a const: TS narrowing doesn't survive into the worker closure.
  const quota = await checkQuota(ownerId);
  if (!quota.ok) return c.json(quota.body, quota.status);
  const qaLimit = quota.limit;

  // Tenant scope: only items owned by this workspace are assessed/written.
  const { data: ownedRows, error: ownErr } = await supabaseAdmin
    .from("inventory_items")
    .select("id")
    .eq("user_id", ownerId)
    .in("id", itemIds);
  if (ownErr) return c.json({ error: "Could not verify item ownership." }, 500);
  const ownedIds = ((ownedRows ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (ownedIds.length === 0) return c.json({ error: "No matching items." }, 404);

  // Load each item's photos (front-first via sort_order), capped per item.
  const { data: photoRows } = await supabaseAdmin
    .from("item_photos")
    .select("inventory_item_id, storage_path, photo_type, sort_order, photo_url")
    .in("inventory_item_id", ownedIds)
    .order("sort_order", { ascending: true });
  // US-2265: resolve each row to a URL the vision pass can actually fetch — the
  // sensitive types (tag / tag_2 / certificate) sit in the PRIVATE bucket for an
  // iOS capture, so a public URL 404s and the QA pass silently scored the item
  // without its label shot.
  const resolvedQaPhotos = await itemPhotoAiUrls(
    (photoRows ?? []) as Array<ItemPhotoUrlRow & { inventory_item_id: string }>,
  );
  const byItem = new Map<string, { url: string; type: string }[]>();
  for (const { row, url } of resolvedQaPhotos) {
    const arr = byItem.get(row.inventory_item_id) ?? [];
    if (arr.length >= MAX_QA_PHOTOS) continue;
    arr.push({ url, type: row.photo_type ?? "" });
    byItem.set(row.inventory_item_id, arr);
  }

  type QaPersistIssue = {
    type: string;
    severity: string;
    message: string;
    photo_index: number | null;
  };
  type QaItemResult = {
    item_id: string;
    score: number;
    issues: QaPersistIssue[];
    error?: string;
  };

  async function persist(itemId: string, score: number, issues: QaPersistIssue[]) {
    await supabaseAdmin
      .from("inventory_items")
      .update({
        photo_qa_score: score,
        photo_qa_issues: issues,
        photo_qa_at: new Date().toISOString(),
      })
      .eq("id", itemId)
      .eq("user_id", ownerId);
  }

  const results: QaItemResult[] = [];
  const queue = [...ownedIds];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const itemId = queue.shift()!;
      const photos = byItem.get(itemId) ?? [];
      if (photos.length === 0) {
        const issues: QaPersistIssue[] = [
          {
            type: "missing_angle",
            severity: "high",
            message: "This item has no photos yet — add the front, back, tag, and a detail shot.",
            photo_index: null,
          },
        ];
        await persist(itemId, 0, issues);
        results.push({ item_id: itemId, score: 0, issues });
        continue;
      }
      try {
        // One billed action per item, reserved atomically before the vision
        // call and refunded on failure (US-1581). Cap reached mid-batch →
        // stop spending: report this item as capped and drain the queue.
        const qa = await withAiAction(ownerId, qaLimit, () =>
          assessPhotoQuality(photos));
        const issues: QaPersistIssue[] = qa.issues.map((i) => ({
          type: i.type,
          severity: i.severity,
          message: i.message,
          photo_index: i.photoIndex,
        }));
        await persist(itemId, qa.score, issues);
        results.push({ item_id: itemId, score: qa.score, issues });
      } catch (err) {
        if (err instanceof AiQuotaExhaustedError) {
          results.push({
            item_id: itemId,
            score: -1,
            issues: [],
            error: QUOTA_EXHAUSTED_MESSAGE,
          });
          queue.length = 0;
          continue;
        }
        console.error("[AutoLister] photo-qa failed for", itemId, err);
        results.push({
          item_id: itemId,
          score: -1,
          issues: [],
          error: err instanceof Error ? err.message : "Photo QA failed.",
        });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ownedIds.length) }, () => worker()),
  );

  return c.json({ results });
});

flipdeskAutolisterRoutes.post("/batch/:id/retry-failed", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const batchId = c.req.param("id");

  // Ownership-scoped batch lookup (tenant isolation per CLAUDE.md US-268).
  const { data: batch, error: batchErr } = await supabaseAdmin
    .from("listing_generation_batches")
    .select("id, status, item_count, succeeded_count, failed_count, use_comps")
    .eq("id", batchId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (batchErr) return c.json({ error: "Could not load batch." }, 500);
  if (!batch) return c.json({ error: "Batch not found" }, 404);
  const useComps = (batch as { use_comps?: boolean }).use_comps !== false;

  // Premium tier + quota (same gates as POST /batch).
  const gated = await requireFlipdesk(c, { feature: "autolister", userId: ownerId });
  if (gated) return gated;
  const quota = await checkQuota(ownerId);
  if (!quota.ok) return c.json(quota.body, quota.status);
  const limit = quota.limit;

  const { data: failedJobs, error: jobsErr } = await supabaseAdmin
    .from("listing_generation_jobs")
    .select("id, inventory_item_id, attempts")
    .eq("batch_id", batchId)
    .eq("status", "failed");
  if (jobsErr) return c.json({ error: "Could not load failed jobs." }, 500);
  const jobs = (failedJobs ?? []) as Array<
    { id: string; inventory_item_id: string; attempts: number }
  >;
  if (jobs.length === 0) {
    return c.json({ error: "No failed jobs to retry." }, 400);
  }

  // Reopen the batch and reset the failed jobs to 'pending' so the worker can
  // claim them. finalizeBatch recomputes the rolled-up counts from the jobs.
  // US-1552: an EXPLICIT retry also resets the attempts budget — the cap
  // exists to stop unattended reclaim loops, not to refuse a seller who asked
  // again (after e.g. a wholesale-timeout batch, attempts were already burned).
  await supabaseAdmin
    .from("listing_generation_batches")
    .update({ status: "running", error: null })
    .eq("id", batchId);
  // US-1931: clear ai_reserved too — a previously-failed job had its reservation
  // refunded, so an explicit retry must reserve afresh (never reuse a released
  // slot). These are all 'failed' jobs, so blanket-clearing is safe here.
  await supabaseAdmin
    .from("listing_generation_jobs")
    .update({ status: "pending", error: null, attempts: 0, ai_reserved: false })
    .in("id", jobs.map((j) => j.id));

  void processBatch(
    batchId,
    ownerId,
    jobs.map((j) => ({ ...j, attempts: 0, ai_reserved: false })),
    useComps,
    limit,
  ).catch((err) =>
    console.error("[flipdesk-autolister] retry batch crashed:", err)
  );

  return c.json({ batch_id: batchId, retried: jobs.length }, 202);
});

// POST /batch/:id/resume — user-triggered resume of a STRANDED batch (jobs left
// 'pending'/'running' after the background worker was interrupted by a container
// restart). Same logic the reclaim cron runs, but on demand so the seller can
// unstick a 0/N batch immediately instead of waiting for (or relying on) the
// cron being configured.
flipdeskAutolisterRoutes.post("/batch/:id/resume", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const batchId = c.req.param("id");

  const { data: batch, error: batchErr } = await supabaseAdmin
    .from("listing_generation_batches")
    .select("id, use_comps, status, updated_at")
    .eq("id", batchId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (batchErr) return c.json({ error: "Could not load batch." }, 500);
  if (!batch) return c.json({ error: "Batch not found" }, 404);
  const batchRow = batch as {
    use_comps?: boolean;
    status?: string;
    updated_at?: string;
  };
  const useComps = batchRow.use_comps !== false;

  // US-1644: refuse to resume while a live worker is still progressing. The
  // batch's updated_at is a heartbeat (bumped on every progress roll-up); if it's
  // FRESH, a worker owns this batch and resetting its jobs to 'pending' would let
  // a second worker double-run them (double reserveAiAction spend). Only a
  // genuinely-stranded batch (stale heartbeat) is resumable on demand.
  if (isBatchHeartbeatFresh(batchRow.status, batchRow.updated_at, BATCH_STALE_MS, Date.now())) {
    return c.json(
      { error: "This batch is still running — give it a few minutes." },
      409,
    );
  }

  const gated = await requireFlipdesk(c, { feature: "autolister", userId: ownerId });
  if (gated) return gated;
  const quota = await checkQuota(ownerId);
  if (!quota.ok) return c.json(quota.body, quota.status);
  const limit = quota.limit;

  // US-1644: reset ONLY the safe jobs — pending jobs, and 'running' jobs whose
  // heartbeat is stale (a dead worker's orphans). A FRESH 'running' job is owned
  // by a live worker; flipping it to 'pending' would let a second worker claim
  // and double-run it. Sequential conditional updates (never `.or()` on an
  // UPDATE — US-1552). processBatch's own claim is staleness-guarded too, but the
  // reset must not destroy that protection.
  const jobStaleBefore = new Date(Date.now() - JOB_STALE_MS).toISOString();
  await supabaseAdmin
    .from("listing_generation_jobs")
    .update({ status: "pending", error: null })
    .eq("batch_id", batchId)
    .eq("status", "pending");
  await supabaseAdmin
    .from("listing_generation_jobs")
    .update({ status: "pending", error: null })
    .eq("batch_id", batchId)
    .eq("status", "running")
    .lt("updated_at", jobStaleBefore);

  // Re-read the now-resettable set (everything currently 'pending' for this batch)
  // to drive processBatch. A fresh 'running' job we left alone is excluded.
  // US-1931: carry ai_reserved so a crash-interrupted job reuses its reservation.
  const { data: openJobs, error: jobsErr } = await supabaseAdmin
    .from("listing_generation_jobs")
    .select("id, inventory_item_id, attempts, ai_reserved")
    .eq("batch_id", batchId)
    .eq("status", "pending");
  if (jobsErr) return c.json({ error: "Could not load jobs." }, 500);
  const jobs = (openJobs ?? []) as Array<
    { id: string; inventory_item_id: string; attempts: number; ai_reserved: boolean | null }
  >;
  if (jobs.length === 0) {
    return c.json({ error: "Nothing to resume — no unfinished jobs." }, 400);
  }

  await supabaseAdmin
    .from("listing_generation_batches")
    .update({ status: "running", error: null })
    .eq("id", batchId);

  void processBatch(batchId, ownerId, jobs, useComps, limit).catch((err) =>
    console.error("[flipdesk-autolister] resume batch crashed:", err)
  );

  return c.json({ batch_id: batchId, resumed: jobs.length }, 202);
});

// ── Admin job-control helpers (US-584) ───────────────────────────────
// Cross-tenant retry/cancel for the admin Jobs dashboard. Unlike the
// owner-scoped endpoints above, these resolve the batch's owner from the row
// itself (an operator acts across tenants) and skip the seller-facing
// premium gate — but generation still honors the owner's AI quota (limit 0
// makes the worker fail the jobs with the quota message, exactly as the
// reclaim cron does) so an over-cap retry can't run unmetered work.
export async function adminRetryGenerationBatch(
  batchId: string,
): Promise<{ ok: boolean; retried?: number; error?: string }> {
  const { data: batch } = await supabaseAdmin
    .from("listing_generation_batches")
    .select("id, user_id, use_comps")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) return { ok: false, error: "Batch not found" };
  const b = batch as { user_id: string; use_comps: boolean | null };

  // US-1931: carry ai_reserved so an in-flight (pending/running) job reclaimed by
  // an admin retry reuses its reservation; a failed job (ai_reserved cleared on
  // refund) reserves afresh.
  const { data: openJobs } = await supabaseAdmin
    .from("listing_generation_jobs")
    .select("id, inventory_item_id, attempts, ai_reserved")
    .eq("batch_id", batchId)
    .in("status", ["failed", "pending", "running"]);
  const jobs = (openJobs ?? []) as Array<
    { id: string; inventory_item_id: string; attempts: number; ai_reserved: boolean | null }
  >;
  if (jobs.length === 0) return { ok: false, error: "No incomplete jobs to retry." };

  const quota = await checkQuota(b.user_id);
  const limit = quota.ok ? quota.limit : 0;

  await supabaseAdmin
    .from("listing_generation_batches")
    .update({ status: "running", error: null })
    .eq("id", batchId);
  await supabaseAdmin
    .from("listing_generation_jobs")
    .update({ status: "pending", error: null })
    .in("id", jobs.map((j) => j.id));

  void processBatch(batchId, b.user_id, jobs, b.use_comps !== false, limit).catch((err) =>
    console.error("[flipdesk-autolister] admin retry batch crashed:", err)
  );
  return { ok: true, retried: jobs.length };
}

export async function adminCancelGenerationBatch(
  batchId: string,
  reason: string,
): Promise<{ ok: boolean; cancelled?: number; error?: string }> {
  const { data: batch } = await supabaseAdmin
    .from("listing_generation_batches")
    .select("id")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) return { ok: false, error: "Batch not found" };

  const { data: openJobs } = await supabaseAdmin
    .from("listing_generation_jobs")
    .select("id")
    .eq("batch_id", batchId)
    .in("status", ["pending", "running"]);
  const ids = (openJobs ?? []).map((j) => (j as { id: string }).id);
  if (ids.length > 0) {
    await supabaseAdmin
      .from("listing_generation_jobs")
      .update({ status: "failed", error: reason.slice(0, 1000) })
      .in("id", ids);
  }
  await finalizeBatch(batchId);
  return { ok: true, cancelled: ids.length };
}

// GET /batch/:id — batch + per-job status for progress polling.
flipdeskAutolisterRoutes.get("/batch/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const batchId = c.req.param("id");

  // Ownership-scoped batch load.
  const { data: batch, error } = await supabaseAdmin
    .from("listing_generation_batches")
    .select(
      "id, status, source, item_count, succeeded_count, failed_count, error, created_at, updated_at",
    )
    .eq("id", batchId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (error) return c.json({ error: "Could not load batch." }, 500);
  if (!batch) return c.json({ error: "Batch not found" }, 404);

  // Jobs are reachable only because the batch above is confirmed owned.
  const { data: jobs } = await supabaseAdmin
    .from("listing_generation_jobs")
    .select("id, inventory_item_id, status, error, attempts, listing_id, updated_at")
    .eq("batch_id", batchId)
    .order("created_at", { ascending: true });

  const jobRows = (jobs ?? []) as Array<{ id: string; listing_id: string | null }>;

  // US-2677 (AC6): near-duplicate titles WITHIN this batch.
  //
  // The per-listing check at publish cannot catch these. Nine tees generated
  // together are nine drafts, none of them live, so each one compares against
  // an empty set of active listings and passes -- they only become each other's
  // duplicates after publish, by which point the seller has already approved
  // nine titles one at a time. Checking the batch against itself is the only
  // moment the whole set is visible at once.
  const duplicateTitles = await (async () => {
    const listingIds = jobRows
      .map((j) => j.listing_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (listingIds.length < 2) return [];

    // Scoped on the owner as well as by id: the jobs came through an owned
    // batch, and this is the second filter rather than a substitute for it.
    const { data: drafts, error: draftErr } = await supabaseAdmin
      .from("listings")
      .select("id, listing_title")
      .eq("user_id", ownerId)
      .in("id", listingIds);
    if (draftErr) {
      console.error("[flipdesk-autolister] batch duplicate scan:", draftErr.message);
      return [];
    }

    const rows = ((drafts ?? []) as Array<{ id: string; listing_title: string | null }>)
      .filter((d) => (d.listing_title ?? "").trim().length > 0);
    const titleById = new Map(rows.map((d) => [d.id, d.listing_title!]));

    return findDuplicatesWithinBatch(
      rows.map((d) => ({ id: d.id, title: d.listing_title! })),
    ).map((pair) => ({
      ...pair,
      a_title: titleById.get(pair.a) ?? null,
      b_title: titleById.get(pair.b) ?? null,
    }));
  })();

  return c.json({ batch, jobs: jobs ?? [], duplicateTitles });
});

// US-525: reclaim sweeper. A cron hits POST /api/jobs/autolister-reclaim (job-
// secret gated, mounted in main.ts OUTSIDE the authed /autolister/* wildcard).
// Finds 'running' batches whose worker died (stale updated_at), claims each,
// and re-dispatches its still-open jobs so the batch eventually terminalizes.
export async function handleAutolisterReclaimCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // US-503: overlap guard. Per-batch claim (the UPDATE below bumps updated_at)
  // is the resource-level idempotency; this coarse lock avoids two sweepers
  // contending. 5-min lease.
  // US-2311: lease is 2x the */5 schedule interval. At <= 1x, a run
  // that overruns by a second is displaced by the very next tick.
  const lock = await acquireJobLock("autolister-reclaim", 600);
  if (!lock.acquired) {
    return c.json({ scanned: 0, resumed: 0, finalized: 0, skipped: true, reason: lock.reason });
  }
  try {
  const batchStaleBefore = new Date(Date.now() - BATCH_STALE_MS).toISOString();
  const { data: staleRows, error } = await supabaseAdmin
    .from("listing_generation_batches")
    .select("id, user_id, use_comps")
    .eq("status", "running")
    .lt("updated_at", batchStaleBefore)
    .limit(20);
  if (error) {
    console.error("[flipdesk-autolister] reclaim scan failed:", error.message);
    return c.json({ error: "Scan failed" }, 500);
  }
  const stale = (staleRows ?? []) as Array<
    { id: string; user_id: string; use_comps: boolean | null }
  >;

  let resumed = 0;
  let finalized = 0;
  for (const b of stale) {
    // Claim the batch — any UPDATE bumps updated_at via the trigger, so a
    // concurrent sweeper tick sees a fresh (non-stale) row and skips it.
    const { data: claimedBatch } = await supabaseAdmin
      .from("listing_generation_batches")
      .update({ error: null })
      .eq("id", b.id)
      .eq("status", "running")
      .lt("updated_at", batchStaleBefore)
      .select("id")
      .maybeSingle();
    if (!claimedBatch) continue; // lost the race to another tick

    // US-1931: carry ai_reserved so a crash-interrupted job resumed by the
    // reclaim cron reuses its reservation instead of charging the cap again.
    const { data: openJobs } = await supabaseAdmin
      .from("listing_generation_jobs")
      .select("id, inventory_item_id, attempts, ai_reserved")
      .eq("batch_id", b.id)
      .in("status", ["pending", "running"]);
    const jobs = (openJobs ?? []) as Array<
      { id: string; inventory_item_id: string; attempts: number; ai_reserved: boolean | null }
    >;

    if (jobs.length === 0) {
      // No open jobs but the batch was stuck 'running' — terminalize it.
      await finalizeBatch(b.id);
      finalized += 1;
      continue;
    }

    const quota = await checkQuota(b.user_id);
    // If AI is now off / over cap, limit 0 makes reserve refuse and the open
    // jobs fail with the quota message, so the batch still terminalizes.
    const limit = quota.ok ? quota.limit : 0;
    void processBatch(b.id, b.user_id, jobs, b.use_comps !== false, limit).catch((err) =>
      console.error("[flipdesk-autolister] reclaim resume crashed:", err)
    );
    resumed += 1;
  }

  return c.json({ scanned: stale.length, resumed, finalized });
  } finally {
    await lock.release();
  }
}

// ════════════════════════════════════════════════════════════════════
// US-559: durable server-side bulk publish
// ════════════════════════════════════════════════════════════════════
//
// Replaces the client loop over POST /listings/push. A run is durable in
// listing_publish_batches/jobs (00156) and mirrors the generation batch model:
//   • POST /publish-batch            — enqueue owned items; 202 + batch_id.
//   • GET  /publish-batch/:id        — poll batch + per-item status/blockers.
//   • POST /publish-batch/:id/retry-failed — re-run only the failed jobs.
//   • POST /publish-batch/:id/resume — unstick a batch stranded by a restart.
//   • handlePublishBatchReclaimCron  — sweeps abandoned batches (mounted at
//     /api/jobs/publish-batch-reclaim, OUTSIDE the authed wildcard).
//
// Survives tab-close: the 202 closes the HTTP connection and the worker runs
// server-side; if the container dies, the reclaim sweeper resumes from the
// persisted jobs. Idempotent per item: each job is CLAIMED before it runs, and
// publishItemForOwner adopts an existing live offer for the SKU rather than
// minting a duplicate (US-464). The rate budget is centralized in the single
// bounded-concurrency worker here, not multiplied across browser tabs.

/**
 * Recompute counts from the authoritative publish-jobs table and terminalize
 * the batch when no jobs remain open. Idempotent — also the live progress
 * roll-up (bumps updated_at, the heartbeat the reclaim sweeper watches).
 */
async function finalizePublishBatch(batchId: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from("listing_publish_jobs")
    .select("status")
    .eq("batch_id", batchId);
  const rows = (data ?? []) as Array<{ status: string }>;
  const succeeded = rows.filter((r) => r.status === "success").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const open = rows.filter((r) => r.status === "pending" || r.status === "running").length;
  const patch: Record<string, unknown> = {
    succeeded_count: succeeded,
    failed_count: failed,
  };
  const terminal = deriveBatchStatus(succeeded, failed, open);
  if (terminal) patch.status = terminal;
  await supabaseAdmin.from("listing_publish_batches").update(patch).eq("id", batchId);
  // US-955: an auto-published batch (from the green-drafts trigger) emits ONE
  // completion notification reporting published vs skipped, combining its live
  // results with the generation-time skips stored on the batch. Claim-guarded so
  // a repeated finalize / reclaim notifies exactly once.
  if (terminal) await maybeNotifyAutoPublishBatch(batchId, succeeded, failed);
}

/**
 * If this terminal publish batch was created by the auto-publish trigger
 * (US-955), claim its once-only notification and report published-vs-skipped.
 */
async function maybeNotifyAutoPublishBatch(
  batchId: string,
  succeeded: number,
  failed: number,
): Promise<void> {
  try {
    const { data: claimed } = await supabaseAdmin
      .from("listing_publish_batches")
      .update({ auto_notified_at: new Date().toISOString() })
      .eq("id", batchId)
      .eq("auto_published", true)
      .is("auto_notified_at", null)
      .select("user_id, auto_skipped")
      .maybeSingle();
    if (!claimed) return;
    const row = claimed as { user_id: string; auto_skipped: Partial<AutoPublishSkips> | null };
    const stored = row.auto_skipped ?? {};
    const skipped: AutoPublishSkips = {
      needs_review: Number(stored.needs_review ?? 0),
      blocked: Number(stored.blocked ?? 0),
      scheduled: Number(stored.scheduled ?? 0),
      plan_limit: Number(stored.plan_limit ?? 0),
    };
    await notifyAutoPublishOutcome(row.user_id, { published: succeeded, failed, skipped });
  } catch (err) {
    console.error("[flipdesk-autolister] auto-publish notify failed:", err);
  }
}

async function markPublishJobFailed(jobId: string, message: string): Promise<void> {
  await supabaseAdmin
    .from("listing_publish_jobs")
    .update({ status: "failed", error: message.slice(0, 1000) })
    .eq("id", jobId);
}

/** Human-readable failure message from a publishItemForOwner failure body. */
export function publishFailureMessage(body: Record<string, unknown>): string {
  const blockers = Array.isArray(body.blockers) ? (body.blockers as string[]) : [];
  if (blockers.length > 0) return blockers.join(" • ");
  return (body.detail ?? body.error ?? "Publish failed.") as string;
}

/**
 * Background worker: publish each job's item with bounded concurrency. Partial
 * failures never abort the batch — each job records its own status/error/
 * attempts. Jobs are CLAIMED so a resumed/concurrent run can't double-process
 * one (US-525); a per-item timeout caps a hung publish (US-526).
 */
async function processPublishBatch(
  batchId: string,
  ownerId: string,
  jobs: Array<{ id: string; inventory_item_id: string; attempts?: number }>,
): Promise<void> {
  const jobStaleBefore = new Date(Date.now() - PUBLISH_JOB_STALE_MS).toISOString();

  async function runJob(
    job: { id: string; inventory_item_id: string; attempts?: number },
  ): Promise<void> {
    const attempts = job.attempts ?? 0;
    if (attempts >= MAX_PUBLISH_JOB_ATTEMPTS) {
      await markPublishJobFailed(
        job.id,
        "Publish abandoned after repeated interruptions. Retry from the queue if needed.",
      );
      return;
    }

    // Atomically CLAIM the job. Eligible = still 'pending', or a 'running' job
    // left stale by a dead worker. A fresh 'running' job (live worker owns it)
    // matches nothing and we skip — the idempotency guard against double-publish.
    // US-1552: two sequential conditional updates, NOT `.or()` — the prod
    // PostgREST rejects logical operators on mutations (see generation claim).
    const claimPatch = { status: "running", attempts: attempts + 1, error: null };
    let { data: claimed, error: claimErr } = await supabaseAdmin
      .from("listing_publish_jobs")
      .update(claimPatch)
      .eq("id", job.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimErr && !claimed) {
      ({ data: claimed, error: claimErr } = await supabaseAdmin
        .from("listing_publish_jobs")
        .update(claimPatch)
        .eq("id", job.id)
        .eq("status", "running")
        .lt("updated_at", jobStaleBefore)
        .select("id")
        .maybeSingle());
    }
    if (claimErr) {
      console.error(
        `[flipdesk-autolister] publish job ${job.id} claim failed (left pending): ${claimErr.message}`,
      );
      return;
    }
    if (!claimed) return;

    try {
      const result = await withTimeout(
        publishItemForOwner(ownerId, job.inventory_item_id),
        PUBLISH_ITEM_TIMEOUT_MS,
        "Publish",
      );
      if (result.ok) {
        await supabaseAdmin
          .from("listing_publish_jobs")
          .update({
            status: "success",
            listing_id: result.listing_id,
            listing_url: result.listing_url,
            error: null,
          })
          .eq("id", job.id);
      } else {
        await markPublishJobFailed(job.id, publishFailureMessage(result.body));
      }
    } catch (err) {
      await markPublishJobFailed(
        job.id,
        err instanceof Error ? err.message : "Publish failed",
      );
    }
  }

  try {
    for (let i = 0; i < jobs.length; i += PUBLISH_CONCURRENCY) {
      await Promise.all(jobs.slice(i, i + PUBLISH_CONCURRENCY).map((j) => runJob(j)));
      await finalizePublishBatch(batchId); // live progress + heartbeat
    }
  } catch (err) {
    console.error("[flipdesk-autolister] publish worker crashed:", err);
  } finally {
    await finalizePublishBatch(batchId).catch((e) =>
      console.error("[flipdesk-autolister] finalizePublishBatch failed:", e)
    );
  }
}

// POST /publish-batch  Body: { item_ids: string[] }
// US-1616 / C3: publishing lists the OWNER's inventory live on a marketplace —
// require listing_manager+. A read-only viewer must not publish.
flipdeskAutolisterRoutes.post("/publish-batch", async (c) => {
  if (!roleAtLeast(c.get("workspaceRole") ?? "owner", "listing_manager")) {
    return c.json({ error: "This action requires listing_manager access or higher" }, 403);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { item_ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const itemIds = Array.isArray(body.item_ids)
    ? Array.from(
      new Set(body.item_ids.filter((x): x is string => typeof x === "string")),
    )
    : [];
  if (itemIds.length === 0) {
    return c.json({ error: "item_ids must be a non-empty array" }, 400);
  }
  if (itemIds.length > MAX_PUBLISH_BATCH_ITEMS) {
    return c.json(
      { error: `A publish batch can contain at most ${MAX_PUBLISH_BATCH_ITEMS} items.` },
      400,
    );
  }

  // Plan gate (paid FlipDesk feature, billed to the workspace owner).
  const gated = await requireFlipdesk(c, { feature: "autolister", userId: ownerId });
  if (gated) return gated;

  // Tenant isolation: every requested item MUST belong to this workspace.
  // Pull status too so the active-listing cap counts only the items that would
  // become NEWLY live (a re-publish of an already-'listed' item doesn't add to
  // the count) — same rule the single-item /listings/push handler uses.
  const { data: ownedRows, error: ownErr } = await supabaseAdmin
    .from("inventory_items")
    .select("id, status")
    .eq("user_id", ownerId)
    .in("id", itemIds);
  if (ownErr) {
    return c.json({ error: "Could not verify item ownership." }, 500);
  }
  const owned = (ownedRows ?? []) as Array<{ id: string; status: string }>;
  const ownedIds = new Set(owned.map((r) => r.id));
  const notOwned = itemIds.filter((id) => !ownedIds.has(id));
  if (notOwned.length > 0) {
    return c.json(
      { error: "One or more items do not belong to your workspace." },
      403,
    );
  }

  // Centralized rate/capacity budget: gate the whole run against the active-
  // listing cap up front (delta = items that aren't already live), so a bulk
  // publish can't quietly blow past the plan limit one item at a time.
  const newLive = owned.filter((r) => r.status !== "listed").length;
  if (newLive > 0) {
    const capGate = await requireFlipdesk(c, {
      capacity: { kind: "activeListings", delta: newLive },
      userId: ownerId,
    });
    if (capGate) return capGate;
  }

  // Create the batch + one job per item.
  const { data: batch, error: batchErr } = await supabaseAdmin
    .from("listing_publish_batches")
    .insert({
      user_id: ownerId,
      status: "running",
      item_count: itemIds.length,
    })
    .select("id")
    .single();
  if (batchErr || !batch) {
    return c.json({ error: "Could not create publish batch." }, 500);
  }
  const batchId = (batch as { id: string }).id;

  const { data: jobRows, error: jobsErr } = await supabaseAdmin
    .from("listing_publish_jobs")
    .insert(
      itemIds.map((id) => ({
        batch_id: batchId,
        inventory_item_id: id,
        status: "pending" as const,
      })),
    )
    .select("id, inventory_item_id");
  if (jobsErr || !jobRows) {
    await supabaseAdmin
      .from("listing_publish_batches")
      .update({ status: "failed", error: "Failed to enqueue jobs." })
      .eq("id", batchId);
    return c.json({ error: "Could not enqueue publish jobs." }, 500);
  }

  const jobs = jobRows as Array<{ id: string; inventory_item_id: string }>;

  // Optimistic immediate processing — the 202 closes the connection well under
  // Cloudflare's proxy timeout. Durability does NOT depend on this promise: if
  // the container dies mid-run, the reclaim sweeper resumes from the job rows.
  void processPublishBatch(batchId, ownerId, jobs).catch((err) =>
    console.error("[flipdesk-autolister] background publish batch crashed:", err)
  );

  return c.json({ batch_id: batchId, item_count: itemIds.length }, 202);
});

// GET /publish-batch/:id — batch + per-job status for progress polling.
flipdeskAutolisterRoutes.get("/publish-batch/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const batchId = c.req.param("id");

  const { data: batch, error } = await supabaseAdmin
    .from("listing_publish_batches")
    .select(
      "id, status, item_count, succeeded_count, failed_count, error, created_at, updated_at",
    )
    .eq("id", batchId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (error) return c.json({ error: "Could not load batch." }, 500);
  if (!batch) return c.json({ error: "Batch not found" }, 404);

  // Jobs are reachable only because the batch above is confirmed owned.
  const { data: jobs } = await supabaseAdmin
    .from("listing_publish_jobs")
    .select("id, inventory_item_id, status, error, attempts, listing_id, listing_url, updated_at")
    .eq("batch_id", batchId)
    .order("created_at", { ascending: true });

  return c.json({ batch, jobs: jobs ?? [] });
});

// POST /publish-batch/:id/retry-failed — re-run ONLY the failed jobs in place.
flipdeskAutolisterRoutes.post("/publish-batch/:id/retry-failed", async (c) => {
  if (!roleAtLeast(c.get("workspaceRole") ?? "owner", "listing_manager")) {
    return c.json({ error: "This action requires listing_manager access or higher" }, 403);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const batchId = c.req.param("id");

  const { data: batch, error: batchErr } = await supabaseAdmin
    .from("listing_publish_batches")
    .select("id")
    .eq("id", batchId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (batchErr) return c.json({ error: "Could not load batch." }, 500);
  if (!batch) return c.json({ error: "Batch not found" }, 404);

  const gated = await requireFlipdesk(c, { feature: "autolister", userId: ownerId });
  if (gated) return gated;

  const { data: failedJobs, error: jobsErr } = await supabaseAdmin
    .from("listing_publish_jobs")
    .select("id, inventory_item_id, attempts")
    .eq("batch_id", batchId)
    .eq("status", "failed");
  if (jobsErr) return c.json({ error: "Could not load failed jobs." }, 500);
  const jobs = (failedJobs ?? []) as Array<
    { id: string; inventory_item_id: string; attempts: number }
  >;
  if (jobs.length === 0) {
    return c.json({ error: "No failed jobs to retry." }, 400);
  }

  await supabaseAdmin
    .from("listing_publish_batches")
    .update({ status: "running", error: null })
    .eq("id", batchId);
  await supabaseAdmin
    .from("listing_publish_jobs")
    .update({ status: "pending", error: null })
    .in("id", jobs.map((j) => j.id));

  void processPublishBatch(batchId, ownerId, jobs).catch((err) =>
    console.error("[flipdesk-autolister] retry publish batch crashed:", err)
  );

  return c.json({ batch_id: batchId, retried: jobs.length }, 202);
});

// POST /publish-batch/:id/resume — user-triggered resume of a STRANDED batch
// (jobs left 'pending'/'running' after the worker was interrupted by a restart).
flipdeskAutolisterRoutes.post("/publish-batch/:id/resume", async (c) => {
  if (!roleAtLeast(c.get("workspaceRole") ?? "owner", "listing_manager")) {
    return c.json({ error: "This action requires listing_manager access or higher" }, 403);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const batchId = c.req.param("id");

  const { data: batch, error: batchErr } = await supabaseAdmin
    .from("listing_publish_batches")
    .select("id, status, updated_at")
    .eq("id", batchId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (batchErr) return c.json({ error: "Could not load batch." }, 500);
  if (!batch) return c.json({ error: "Batch not found" }, 404);

  const gated = await requireFlipdesk(c, { feature: "autolister", userId: ownerId });
  if (gated) return gated;

  // US-1644: refuse to resume while a live worker is still progressing (fresh
  // batch heartbeat) — resetting 'running' jobs to 'pending' would let a second
  // worker double-run them.
  const pubBatch = batch as { status?: string; updated_at?: string };
  if (isBatchHeartbeatFresh(pubBatch.status, pubBatch.updated_at, PUBLISH_BATCH_STALE_MS, Date.now())) {
    return c.json(
      { error: "This batch is still running — give it a few minutes." },
      409,
    );
  }

  // US-1644: reset pending jobs + only STALE 'running' orphans (never a
  // fresh-running job a live worker owns). Sequential conditional updates
  // (no `.or()` on an UPDATE — US-1552).
  const pubJobStaleBefore = new Date(Date.now() - PUBLISH_JOB_STALE_MS).toISOString();
  await supabaseAdmin
    .from("listing_publish_jobs")
    .update({ status: "pending", error: null })
    .eq("batch_id", batchId)
    .eq("status", "pending");
  await supabaseAdmin
    .from("listing_publish_jobs")
    .update({ status: "pending", error: null })
    .eq("batch_id", batchId)
    .eq("status", "running")
    .lt("updated_at", pubJobStaleBefore);

  const { data: openJobs, error: jobsErr } = await supabaseAdmin
    .from("listing_publish_jobs")
    .select("id, inventory_item_id, attempts")
    .eq("batch_id", batchId)
    .eq("status", "pending");
  if (jobsErr) return c.json({ error: "Could not load jobs." }, 500);
  const jobs = (openJobs ?? []) as Array<
    { id: string; inventory_item_id: string; attempts: number }
  >;
  if (jobs.length === 0) {
    return c.json({ error: "Nothing to resume — no unfinished jobs." }, 400);
  }

  await supabaseAdmin
    .from("listing_publish_batches")
    .update({ status: "running", error: null })
    .eq("id", batchId);

  void processPublishBatch(batchId, ownerId, jobs).catch((err) =>
    console.error("[flipdesk-autolister] resume publish batch crashed:", err)
  );

  return c.json({ batch_id: batchId, resumed: jobs.length }, 202);
});

// US-584 admin cross-tenant retry/cancel for a publish batch (mirrors the
// generation helpers above; publishing isn't AI-quota gated).
export async function adminRetryPublishBatch(
  batchId: string,
): Promise<{ ok: boolean; retried?: number; error?: string }> {
  const { data: batch } = await supabaseAdmin
    .from("listing_publish_batches")
    .select("id, user_id")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) return { ok: false, error: "Batch not found" };
  const ownerId = (batch as { user_id: string }).user_id;

  const { data: openJobs } = await supabaseAdmin
    .from("listing_publish_jobs")
    .select("id, inventory_item_id, attempts")
    .eq("batch_id", batchId)
    .in("status", ["failed", "pending", "running"]);
  const jobs = (openJobs ?? []) as Array<
    { id: string; inventory_item_id: string; attempts: number }
  >;
  if (jobs.length === 0) return { ok: false, error: "No incomplete jobs to retry." };

  await supabaseAdmin
    .from("listing_publish_batches")
    .update({ status: "running", error: null })
    .eq("id", batchId);
  await supabaseAdmin
    .from("listing_publish_jobs")
    .update({ status: "pending", error: null })
    .in("id", jobs.map((j) => j.id));

  void processPublishBatch(batchId, ownerId, jobs).catch((err) =>
    console.error("[flipdesk-autolister] admin retry publish batch crashed:", err)
  );
  return { ok: true, retried: jobs.length };
}

export async function adminCancelPublishBatch(
  batchId: string,
  reason: string,
): Promise<{ ok: boolean; cancelled?: number; error?: string }> {
  const { data: batch } = await supabaseAdmin
    .from("listing_publish_batches")
    .select("id")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) return { ok: false, error: "Batch not found" };

  const { data: openJobs } = await supabaseAdmin
    .from("listing_publish_jobs")
    .select("id")
    .eq("batch_id", batchId)
    .in("status", ["pending", "running"]);
  const ids = (openJobs ?? []).map((j) => (j as { id: string }).id);
  // US-2204: mark the cancelled jobs failed concurrently rather than one-by-one
  // (bounded to a single batch's still-open jobs).
  await Promise.all(ids.map((id) => markPublishJobFailed(id, reason)));
  await finalizePublishBatch(batchId);
  return { ok: true, cancelled: ids.length };
}

// US-559: publish-batch reclaim sweeper. A cron hits POST
// /api/jobs/publish-batch-reclaim (job-secret gated, mounted in main.ts OUTSIDE
// the authed /autolister/* wildcard). Finds 'running' publish batches whose
// worker died (stale heartbeat), claims each, and re-dispatches its still-open
// jobs so the batch eventually terminalizes.
export async function handlePublishBatchReclaimCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // US-2311: lease is 2x the */5 schedule interval. At <= 1x, a run
  // that overruns by a second is displaced by the very next tick.
  const lock = await acquireJobLock("publish-batch-reclaim", 600);
  if (!lock.acquired) {
    return c.json({ scanned: 0, resumed: 0, finalized: 0, skipped: true, reason: lock.reason });
  }
  try {
    const batchStaleBefore = new Date(Date.now() - PUBLISH_BATCH_STALE_MS).toISOString();
    const { data: staleRows, error } = await supabaseAdmin
      .from("listing_publish_batches")
      .select("id, user_id")
      .eq("status", "running")
      .lt("updated_at", batchStaleBefore)
      .limit(20);
    if (error) {
      console.error("[flipdesk-autolister] publish reclaim scan failed:", error.message);
      return c.json({ error: "Scan failed" }, 500);
    }
    const stale = (staleRows ?? []) as Array<{ id: string; user_id: string }>;

    let resumed = 0;
    let finalized = 0;
    for (const b of stale) {
      // Claim the batch — any UPDATE bumps updated_at via the trigger, so a
      // concurrent tick sees a fresh (non-stale) row and skips it.
      const { data: claimedBatch } = await supabaseAdmin
        .from("listing_publish_batches")
        .update({ error: null })
        .eq("id", b.id)
        .eq("status", "running")
        .lt("updated_at", batchStaleBefore)
        .select("id")
        .maybeSingle();
      if (!claimedBatch) continue; // lost the race

      const { data: openJobs } = await supabaseAdmin
        .from("listing_publish_jobs")
        .select("id, inventory_item_id, attempts")
        .eq("batch_id", b.id)
        .in("status", ["pending", "running"]);
      const jobs = (openJobs ?? []) as Array<
        { id: string; inventory_item_id: string; attempts: number }
      >;

      if (jobs.length === 0) {
        await finalizePublishBatch(b.id);
        finalized += 1;
        continue;
      }

      void processPublishBatch(b.id, b.user_id, jobs).catch((err) =>
        console.error("[flipdesk-autolister] publish reclaim resume crashed:", err)
      );
      resumed += 1;
    }

    return c.json({ scanned: stale.length, resumed, finalized });
  } finally {
    await lock.release();
  }
}

// US-721: POST /platform-fields — generate per-marketplace listing fields for an
// item that already has an eBay draft. Body: { item_id, platforms: [...] }.
// Returns the tailored variants (title/description/condition/category/tags +
// per-platform validation) and persists them to listings.platform_fields, so
// the copy-paste Listing Kit (US-723) and the API adapters (US-710/714) can use
// them. One text-only Claude call adapts all requested platforms at once.
//
// Tenant safety (CLAUDE.md US-268): the item is verified owned before any AI
// call or write; generatePlatformVariants additionally re-scopes its loads to
// ownerId.
flipdeskAutolisterRoutes.post("/platform-fields", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { item_id?: unknown; platforms?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const itemId = typeof body.item_id === "string" ? body.item_id : "";
  if (!itemId) return c.json({ error: "item_id is required" }, 400);

  const requested = Array.isArray(body.platforms) ? body.platforms : [];
  // Keep only specced, non-eBay platforms (eBay uses its own draft columns).
  const platforms = [
    ...new Set(
      requested
        .filter((p): p is string => typeof p === "string")
        .filter((p) => p !== "ebay" && getMarketplaceSpec(p)),
    ),
  ] as MarketplacePlatform[];
  if (platforms.length === 0) {
    return c.json({ error: "platforms must include at least one supported non-eBay marketplace" }, 400);
  }

  // Paid-tier gate (AI feature), same as generation.
  const gated = await requireFlipdesk(c, { feature: "autolister", userId: ownerId });
  if (gated) return gated;
  // US-1581: enablement + cap gate (used to meter after with no cap check).
  const quota = await checkQuota(ownerId);
  if (!quota.ok) return c.json(quota.body, quota.status);

  // Ownership pre-check for a clean 404.
  const { data: owned } = await supabaseAdmin
    .from("inventory_items")
    .select("id")
    .eq("id", itemId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!owned) return c.json({ error: "Item not found for this workspace" }, 404);

  try {
    // One billed action covers ALL requested platforms (single generation
    // pass) — reserved atomically before the call, refunded on failure.
    const result = await withAiAction(ownerId, quota.limit, () =>
      generatePlatformVariants(itemId, ownerId, platforms));
    // US-745: attach each platform's field spec (display label + per-field
    // char limits + required flags + photo cap + the "verify these" source
    // note) so a thin native client (the iOS Listing Kit) can render a
    // copy/share kit with live char-count-vs-limit straight from server data —
    // no need to re-port the marketplace-specs registry into Swift. Additive:
    // existing web consumers simply ignore the extra `spec` field.
    const variants = result.variants.map((v) => {
      const spec = getMarketplaceSpec(v.platform);
      return {
        ...v,
        spec: spec
          ? {
            label: spec.label,
            fields: spec.fields,
            maxPhotos: spec.maxPhotos,
            sourceNote: spec.sourceNote,
          }
          : null,
      };
    });
    return c.json({ listing_id: result.listingId, variants });
  } catch (err) {
    if (err instanceof AiQuotaExhaustedError) {
      return c.json({ error: QUOTA_EXHAUSTED_MESSAGE }, 429);
    }
    const msg = err instanceof Error ? err.message : "Platform-field generation failed.";
    // "no eBay draft" is a precondition the caller can fix → 409.
    const status = /no eBay draft/i.test(msg) ? 409 : 502;
    console.error("[AutoLister] platform-fields failed", err);
    return c.json({ error: msg }, status);
  }
});

// Loads an owned inventory item + its most-recent eBay listing draft for
// reconciliation. Tenant-scoped (US-268): the item is fetched by id AND
// user_id, and the listing only via that verified item's id.
async function loadReconcilePair(
  ownerId: string,
  itemId: string,
): Promise<
  | { ok: true; item: ReconcileItemRow; listing: ReconcileListingRow }
  | { ok: false; status: 404; error: string }
> {
  const { data: itemRow } = await supabaseAdmin
    .from("inventory_items")
    .select("id, sku, title, brand, size, color, material, style, description, target_price")
    .eq("id", itemId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!itemRow) {
    return { ok: false, status: 404, error: "Item not found for this workspace" };
  }
  const { data: listingRow } = await supabaseAdmin
    .from("listings")
    .select("id, listing_title, listing_description, listing_price, item_specifics_override")
    .eq("inventory_item_id", itemId)
    .eq("platform", "ebay")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!listingRow) {
    return { ok: false, status: 404, error: "No generated draft to reconcile yet" };
  }
  return {
    ok: true,
    item: itemRow as ReconcileItemRow,
    listing: listingRow as ReconcileListingRow,
  };
}

// POST /reconcile/diff  Body: { inventory_item_id }
// Returns the field-by-field comparison (original sheet value vs AI value) for
// a matched item, so the seller can pick per field in the AutoLister review.
flipdeskAutolisterRoutes.post("/reconcile/diff", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { inventory_item_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = typeof body.inventory_item_id === "string" ? body.inventory_item_id : "";
  if (!itemId) return c.json({ error: "inventory_item_id is required" }, 400);

  const pair = await loadReconcilePair(ownerId, itemId);
  if (!pair.ok) return c.json({ error: pair.error }, pair.status);

  const fields = buildReconcileDiff(pair.item, pair.listing);
  // has_original: does the inventory record carry sheet-imported attributes
  // (beyond the title an AutoLister item is seeded with)? If so there's a real
  // prior record to reconcile against; if not, this is a fresh AutoLister item.
  const hasOriginal = fields.some((f) => f.key !== "title" && f.original !== "");
  return c.json({
    inventory_item_id: itemId,
    sku: pair.item.sku,
    has_original: hasOriginal,
    conflicts: fields.filter((f) => f.differs).length,
    fields,
  });
});

// POST /reconcile/apply  Body: { inventory_item_id, choices: { [field]: "original"|"ai" } }
// Writes the chosen winners to BOTH the listing draft (so they reach eBay) and
// the inventory_items record (so the seller's inventory stays in sync).
flipdeskAutolisterRoutes.post("/reconcile/apply", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { inventory_item_id?: unknown; choices?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = typeof body.inventory_item_id === "string" ? body.inventory_item_id : "";
  if (!itemId) return c.json({ error: "inventory_item_id is required" }, 400);

  // Sanitize choices to the allowed shape (string → "original" | "ai").
  const rawChoices = (body.choices && typeof body.choices === "object")
    ? body.choices as Record<string, unknown>
    : {};
  const choices: Record<string, "original" | "ai"> = {};
  for (const [k, v] of Object.entries(rawChoices)) {
    if (v === "original" || v === "ai") choices[k] = v;
  }

  const pair = await loadReconcilePair(ownerId, itemId);
  if (!pair.ok) return c.json({ error: pair.error }, pair.status);

  const { itemUpdate, listingColUpdate, aspectUpdate } = buildMergeWrites(
    pair.item,
    pair.listing,
    choices,
  );

  const { error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .update(itemUpdate as never)
    .eq("id", itemId)
    .eq("user_id", ownerId);
  if (itemErr) {
    console.error("[AutoLister] reconcile item write failed:", itemErr);
    return c.json({ error: "Could not update inventory item" }, 502);
  }

  const { error: listingErr } = await supabaseAdmin
    .from("listings")
    .update({ ...listingColUpdate, item_specifics_override: aspectUpdate } as never)
    .eq("id", pair.listing.id);
  if (listingErr) {
    console.error("[AutoLister] reconcile listing write failed:", listingErr);
    return c.json({ error: "Could not update listing draft" }, 502);
  }

  return c.json({ ok: true, inventory_item_id: itemId });
});

// POST /reconcile/link  Body: { source_item_id, target_sku }
// After-the-fact binding: re-points an AutoLister item's photos + generated
// draft onto an EXISTING inventory item identified by the seller's SKU, then
// archives the now-empty source. Needed because SKU is unique per user, so you
// can't simply retype an existing SKU onto the new item (it 409s). The caller
// then reconciles against the target. Tenant-scoped (US-268): both items are
// verified owned before anything moves.
flipdeskAutolisterRoutes.post("/reconcile/link", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { source_item_id?: unknown; target_sku?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const sourceId = typeof body.source_item_id === "string" ? body.source_item_id : "";
  const targetSku = typeof body.target_sku === "string" ? body.target_sku.trim() : "";
  if (!sourceId) return c.json({ error: "source_item_id is required" }, 400);
  if (!targetSku) return c.json({ error: "target_sku is required" }, 400);

  const { data: source } = await supabaseAdmin
    .from("inventory_items")
    .select("id")
    .eq("id", sourceId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!source) return c.json({ error: "Item not found for this workspace" }, 404);

  const { data: target } = await supabaseAdmin
    .from("inventory_items")
    .select("id")
    .eq("user_id", ownerId)
    .eq("sku", targetSku)
    .maybeSingle();
  if (!target) {
    return c.json({ error: `No inventory item with SKU "${targetSku}"` }, 404);
  }
  const targetId = (target as { id: string }).id;
  if (targetId === sourceId) {
    return c.json({ error: "That SKU already belongs to this item." }, 400);
  }

  // Re-point the photos and the generated draft to the target item.
  const { error: photoErr } = await supabaseAdmin
    .from("item_photos")
    .update({ inventory_item_id: targetId } as never)
    .eq("inventory_item_id", sourceId);
  if (photoErr) {
    console.error("[AutoLister] reconcile link photo move failed:", photoErr);
    return c.json({ error: "Could not move photos to the existing item" }, 502);
  }
  const { error: listingErr } = await supabaseAdmin
    .from("listings")
    .update({ inventory_item_id: targetId } as never)
    .eq("inventory_item_id", sourceId);
  if (listingErr) {
    console.error("[AutoLister] reconcile link listing move failed:", listingErr);
    return c.json({ error: "Could not move the draft to the existing item" }, 502);
  }

  // Archive (don't hard-delete) the now-empty source so generation-job FKs and
  // history stay intact; archived items drop out of the active inventory views.
  await supabaseAdmin
    .from("inventory_items")
    .update({ status: "archived" } as never)
    .eq("id", sourceId)
    .eq("user_id", ownerId);

  return c.json({ ok: true, target_item_id: targetId });
});
