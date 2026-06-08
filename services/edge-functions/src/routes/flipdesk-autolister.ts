import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { generateListing, generatePlatformVariants } from "../lib/ai-listing.ts";
import {
  getMarketplaceSpec,
  type MarketplacePlatform,
} from "../lib/marketplace-specs.ts";
import { classifyPhotoRoles } from "../lib/ai-photo-roles.ts";
import { assessPhotoQuality } from "../lib/ai-photo-qa.ts";
import { checkQuota } from "./flipdesk-ai.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { featureDisabledBody, isFeatureEnabled } from "../lib/feature-flags.ts";
import {
  buildTemplateListingPatch,
  type ListingTemplateRow,
} from "../lib/listing-template.ts";

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

const MAX_BATCH_ITEMS = 100; // matches the "100 listings in one batch" target
// US-533: a single group's photo set passed to the cover/role vision pass.
// One item rarely has more than a handful of shots; the cap bounds the vision
// cost (and request size) of one classify call.
const MAX_CLASSIFY_PHOTOS = 40;
// US-537: cap on photo-QA scope. One item's gallery is small; cap photos per
// item, and cap items per request to bound vision cost.
const MAX_QA_ITEMS = 100;
const MAX_QA_PHOTOS = 12;
const CONCURRENCY = 3; // vision calls are heavy; mirror flipdesk-ai bulk-extract

// US-526: hard wall-clock cap on a single item's generation. generateListing
// makes several sequential Anthropic + eBay calls; only the SDK socket timeout
// protected it before, so one hung item could pin a concurrency slot.
const GENERATION_TIMEOUT_MS = 90_000;
// US-525: a job started this many times (incl. reclaim resumes) is failed
// terminally rather than resumed forever.
const MAX_JOB_ATTEMPTS = 5;
// US-525: a 'running' job whose updated_at is older than this was left by a
// dead worker and is eligible for reclaim. Must exceed GENERATION_TIMEOUT_MS so
// a live, generating job is never reclaimed out from under its worker.
const JOB_STALE_MS = 5 * 60_000;
// US-525: a 'running' batch whose updated_at (bumped on every progress roll-up)
// is older than this is presumed abandoned and is swept.
const BATCH_STALE_MS = 15 * 60_000;

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

/**
 * US-527: atomically reserve one AI action against the monthly cap. Returns
 * true if reserved, false if the cap is reached. This is the SINGLE quota
 * enforcement point — replacing the old in-memory allowance that two parallel
 * batches could each spend, blowing past the cap.
 */
async function reserveAiAction(ownerId: string, limit: number): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("reserve_ai_action", {
    p_user_id: ownerId,
    p_limit: limit,
  });
  if (error) throw new Error(`Quota reservation failed: ${error.message}`);
  return data === true;
}

/** Give a reserved AI action back when its generation ultimately failed. */
async function refundAiAction(ownerId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("refund_ai_action", { p_user_id: ownerId });
  if (error) {
    console.error("[flipdesk-autolister] refund_ai_action failed:", error.message);
  }
}

async function markJobFailed(jobId: string, message: string): Promise<void> {
  await supabaseAdmin
    .from("listing_generation_jobs")
    .update({ status: "failed", error: message.slice(0, 1000) })
    .eq("id", jobId);
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
async function processBatch(
  batchId: string,
  ownerId: string,
  jobs: Array<{ id: string; inventory_item_id: string; attempts?: number }>,
  useComps: boolean,
  limit: number,
): Promise<void> {
  const jobStaleBefore = new Date(Date.now() - JOB_STALE_MS).toISOString();

  // US-674: load the batch's template once (covers the initial run, retry, and
  // reclaim/resume paths, which all call processBatch). Best-effort — a missing
  // template just means no overlay; generation proceeds unchanged.
  const template = await loadBatchTemplate(batchId);

  /** Overlay the template onto a freshly-generated listing draft. */
  async function applyTemplate(listingId: string): Promise<void> {
    if (!template) return;
    const { data: current } = await supabaseAdmin
      .from("listings")
      .select("listing_description")
      .eq("id", listingId)
      .maybeSingle();
    const patch = buildTemplateListingPatch(
      template,
      (current as { listing_description?: string | null } | null)?.listing_description ?? null,
    );
    if (Object.keys(patch).length === 0) return;
    await supabaseAdmin.from("listings").update(patch).eq("id", listingId);
  }

  async function runJob(
    job: { id: string; inventory_item_id: string; attempts?: number },
  ): Promise<void> {
    const attempts = job.attempts ?? 0;
    // US-525: don't resume a job forever.
    if (attempts >= MAX_JOB_ATTEMPTS) {
      await markJobFailed(
        job.id,
        "Generation abandoned after repeated interruptions. Retry from the queue if needed.",
      );
      return;
    }

    // US-525: atomically CLAIM the job. Eligible = still 'pending', or a
    // 'running' job left stale by a dead worker. If a live worker already owns
    // it (fresh 'running'), the conditional update matches nothing and we skip.
    const { data: claimed } = await supabaseAdmin
      .from("listing_generation_jobs")
      .update({ status: "running", attempts: attempts + 1, error: null })
      .eq("id", job.id)
      .in("status", ["pending", "running"])
      .or(`status.eq.pending,updated_at.lt.${jobStaleBefore}`)
      .select("id")
      .maybeSingle();
    if (!claimed) return;

    // US-527: atomic, cap-aware reservation.
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

    try {
      const result = await withTimeout(
        generateListing(job.inventory_item_id, ownerId, { batchId, useComps }),
        GENERATION_TIMEOUT_MS,
        "Listing generation",
      );
      await supabaseAdmin
        .from("listing_generation_jobs")
        .update({ status: "success", listing_id: result.listingId, error: null })
        .eq("id", job.id);
      // US-674: apply the batch's template to the generated draft (no-op when
      // none was selected). Best-effort — overlay failure must not fail the job.
      try {
        await applyTemplate(result.listingId);
      } catch (overlayErr) {
        console.error("[flipdesk-autolister] template overlay failed:", overlayErr);
      }
    } catch (err) {
      // Generation failed (incl. timeout) — give the reserved quota slot back.
      await refundAiAction(ownerId);
      await markJobFailed(job.id, err instanceof Error ? err.message : "Generation failed");
    }
  }

  try {
    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
      await Promise.all(jobs.slice(i, i + CONCURRENCY).map((j) => runJob(j)));
      // Live progress + heartbeat for the reclaim sweeper.
      await finalizeBatch(batchId);
    }
  } catch (err) {
    console.error("[flipdesk-autolister] batch worker crashed:", err);
  } finally {
    // US-525: always terminalize from the jobs table, even on a crash/resume.
    await finalizeBatch(batchId).catch((e) =>
      console.error("[flipdesk-autolister] finalizeBatch failed:", e)
    );
  }
}

// POST /batch  Body: { item_ids: string[], use_comps?: boolean }
flipdeskAutolisterRoutes.post("/batch", async (c) => {
  // US-507: AutoLister kill-switch (heavy per-item AI cost).
  if (!(await isFeatureEnabled("autolister"))) {
    return c.json(featureDisabledBody("autolister"), 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { item_ids?: unknown; use_comps?: unknown; template_id?: unknown };
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
  const useComps = body.use_comps !== false; // default true
  // US-674: optional listing template applied to every generated draft.
  const templateId = typeof body.template_id === "string" && body.template_id.trim()
    ? body.template_id.trim()
    : null;

  if (itemIds.length === 0) {
    return c.json({ error: "item_ids must be a non-empty array" }, 400);
  }
  if (itemIds.length > MAX_BATCH_ITEMS) {
    return c.json(
      { error: `A batch can contain at most ${MAX_BATCH_ITEMS} items.` },
      400,
    );
  }

  // Premium tier gate (US-323): AutoLister is a paid-tier feature. A blocked
  // plan returns 402 FEATURE_LOCKED, which edgeFetch turns into the upgrade
  // dialog on the client. Gate the workspace OWNER's plan (they pay).
  const gated = await requireFlipdesk(c, { feature: "autolister", userId: ownerId });
  if (gated) return gated;

  // AI enablement + monthly cap. The per-item atomic reservation (US-527) is
  // the real enforcement; this returns 402 early if AI is off or already capped.
  const quota = await checkQuota(ownerId);
  if (!quota.ok) return c.json(quota.body, quota.status);
  const limit = quota.limit;

  // Tenant isolation: every requested item MUST belong to this workspace.
  const { data: ownedRows, error: ownErr } = await supabaseAdmin
    .from("inventory_items")
    .select("id")
    .eq("user_id", ownerId)
    .in("id", itemIds);
  if (ownErr) {
    return c.json({ error: "Could not verify item ownership." }, 500);
  }
  const ownedIds = new Set((ownedRows ?? []).map((r) => (r as { id: string }).id));
  const notOwned = itemIds.filter((id) => !ownedIds.has(id));
  if (notOwned.length > 0) {
    return c.json(
      { error: "One or more items do not belong to your workspace." },
      403,
    );
  }

  // US-674: a supplied template MUST belong to this workspace (US-268). Verify
  // before we persist it on the batch; the worker re-reads it from the batch.
  if (templateId) {
    const { data: tpl, error: tplErr } = await supabaseAdmin
      .from("listing_templates")
      .select("id")
      .eq("id", templateId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (tplErr) {
      return c.json({ error: "Could not verify the selected template." }, 500);
    }
    if (!tpl) {
      return c.json({ error: "Template not found in your workspace." }, 404);
    }
  }

  // Create the batch + one job per item.
  const { data: batch, error: batchErr } = await supabaseAdmin
    .from("listing_generation_batches")
    .insert({
      user_id: ownerId,
      status: "running",
      source: "autolister",
      item_count: itemIds.length,
      use_comps: useComps,
      template_id: templateId,
    })
    .select("id")
    .single();
  if (batchErr || !batch) {
    return c.json({ error: "Could not create generation batch." }, 500);
  }
  const batchId = (batch as { id: string }).id;

  const { data: jobRows, error: jobsErr } = await supabaseAdmin
    .from("listing_generation_jobs")
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
      .from("listing_generation_batches")
      .update({ status: "failed", error: "Failed to enqueue jobs." })
      .eq("id", batchId);
    return c.json({ error: "Could not enqueue generation jobs." }, 500);
  }

  const jobs = (jobRows as Array<{ id: string; inventory_item_id: string }>);

  // Optimistic immediate processing for low latency — returning 202 closes the
  // HTTP connection well under Cloudflare's proxy timeout. Durability does NOT
  // depend on this promise surviving: if the container dies mid-run, the
  // reclaim sweeper (US-525) resumes the batch from its persisted job rows.
  void processBatch(batchId, ownerId, jobs, useComps, limit).catch((err) =>
    console.error("[flipdesk-autolister] background batch crashed:", err)
  );

  return c.json({ batch_id: batchId, item_count: itemIds.length }, 202);
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
    if (!path.startsWith(`${ownerId}/`)) {
      return c.json({ error: "A photo is not owned by the caller." }, 403);
    }
    const url = supabaseAdmin.storage.from("item-photos").getPublicUrl(path)
      .data.publicUrl;
    photos.push({ id, url });
  }

  try {
    const result = await classifyPhotoRoles(photos);
    // Meter the AI action for usage parity with the other vision endpoints.
    await supabaseAdmin.rpc("increment_ai_actions", { p_user_id: ownerId });
    return c.json({ cover_id: result.coverId, roles: result.roles });
  } catch (err) {
    console.error("[AutoLister] classify-photos failed", err);
    return c.json(
      { error: err instanceof Error ? err.message : "Photo classification failed." },
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
  if (itemIds.length > MAX_QA_ITEMS) {
    return c.json({ error: `At most ${MAX_QA_ITEMS} items per request.` }, 400);
  }

  const gated = await requireFlipdesk(c, { feature: "autolister", userId: ownerId });
  if (gated) return gated;

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
    .select("inventory_item_id, storage_path, photo_type, sort_order")
    .in("inventory_item_id", ownedIds)
    .order("sort_order", { ascending: true });
  const byItem = new Map<string, { url: string; type: string }[]>();
  for (
    const r of (photoRows ?? []) as Array<{
      inventory_item_id: string;
      storage_path: string | null;
      photo_type: string;
    }>
  ) {
    if (!r.storage_path) continue;
    const arr = byItem.get(r.inventory_item_id) ?? [];
    if (arr.length >= MAX_QA_PHOTOS) continue;
    arr.push({
      url: supabaseAdmin.storage.from("item-photos").getPublicUrl(r.storage_path)
        .data.publicUrl,
      type: r.photo_type,
    });
    byItem.set(r.inventory_item_id, arr);
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
        const qa = await assessPhotoQuality(photos);
        const issues: QaPersistIssue[] = qa.issues.map((i) => ({
          type: i.type,
          severity: i.severity,
          message: i.message,
          photo_index: i.photoIndex,
        }));
        await persist(itemId, qa.score, issues);
        await supabaseAdmin.rpc("increment_ai_actions", { p_user_id: ownerId });
        results.push({ item_id: itemId, score: qa.score, issues });
      } catch (err) {
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
  await supabaseAdmin
    .from("listing_generation_batches")
    .update({ status: "running", error: null })
    .eq("id", batchId);
  await supabaseAdmin
    .from("listing_generation_jobs")
    .update({ status: "pending", error: null })
    .in("id", jobs.map((j) => j.id));

  void processBatch(batchId, ownerId, jobs, useComps, limit).catch((err) =>
    console.error("[flipdesk-autolister] retry batch crashed:", err)
  );

  return c.json({ batch_id: batchId, retried: jobs.length }, 202);
});

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

  return c.json({ batch, jobs: jobs ?? [] });
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
  const lock = await acquireJobLock("autolister-reclaim", 300);
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

    const { data: openJobs } = await supabaseAdmin
      .from("listing_generation_jobs")
      .select("id, inventory_item_id, attempts")
      .eq("batch_id", b.id)
      .in("status", ["pending", "running"]);
    const jobs = (openJobs ?? []) as Array<
      { id: string; inventory_item_id: string; attempts: number }
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

  // Ownership pre-check for a clean 404.
  const { data: owned } = await supabaseAdmin
    .from("inventory_items")
    .select("id")
    .eq("id", itemId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!owned) return c.json({ error: "Item not found for this workspace" }, 404);

  try {
    const result = await generatePlatformVariants(itemId, ownerId, platforms);
    await supabaseAdmin.rpc("increment_ai_actions", { p_user_id: ownerId });
    return c.json({ listing_id: result.listingId, variants: result.variants });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Platform-field generation failed.";
    // "no eBay draft" is a precondition the caller can fix → 409.
    const status = /no eBay draft/i.test(msg) ? 409 : 502;
    console.error("[AutoLister] platform-fields failed", err);
    return c.json({ error: msg }, status);
  }
});
