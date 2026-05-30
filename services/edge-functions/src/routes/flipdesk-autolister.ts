import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { generateListing } from "../lib/ai-listing.ts";
import { checkQuota } from "./flipdesk-ai.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";

// FlipDesk AutoLister batch generation (US-313).
// Mounted at /api/flipdesk/autolister (authed + workspace context).
//
// POST /batch       — enqueue many items for AI listing generation; returns
//                     202 + batch_id and processes in the background.
// GET  /batch/:id   — poll batch + per-job status for the queue view (US-318).
//
// Tenant safety (CLAUDE.md US-268): the service-role client bypasses RLS, so
// every query here is scoped to the workspace owner. Items are verified owned
// before any job is created; batch/job reads join through batch.user_id.

const MAX_BATCH_ITEMS = 100; // matches the "100 listings in one batch" target
const CONCURRENCY = 3; // vision calls are heavy; mirror flipdesk-ai bulk-extract

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

type BatchStatus = "pending" | "running" | "completed" | "failed" | "partial";

/**
 * Background worker: generate a listing for each job in the batch with bounded
 * concurrency. Partial failures never abort the batch — each job records its
 * own status/error/attempts and the batch rolls up succeeded/failed counts.
 *
 * Quota: `allowance` is the number of generations permitted this run (Infinity
 * for unlimited plans). Once exhausted, remaining jobs are marked failed with a
 * clear message rather than silently dropped.
 */
async function processBatch(
  batchId: string,
  ownerId: string,
  jobs: Array<{ id: string; inventory_item_id: string; attempts?: number }>,
  useComps: boolean,
  allowance: number,
  initialCounts?: { succeeded: number; failed: number },
): Promise<void> {
  let succeeded = initialCounts?.succeeded ?? 0;
  let failed = initialCounts?.failed ?? 0;
  let consumed = 0;

  async function runJob(
    job: { id: string; inventory_item_id: string; attempts?: number },
  ): Promise<void> {
    // Mark running + bump attempts (US-325: real per-job retry counter).
    // attempts always reflects the total number of times the job has been run.
    const nextAttempts = (job.attempts ?? 0) + 1;
    await supabaseAdmin
      .from("listing_generation_jobs")
      .update({ status: "running", attempts: nextAttempts, error: null })
      .eq("id", job.id);

    // Quota gate (local counter against the run's allowance).
    if (consumed >= allowance) {
      failed++;
      await supabaseAdmin
        .from("listing_generation_jobs")
        .update({
          status: "failed",
          error:
            "Monthly AI action limit reached — this item was not generated. Your allowance resets next month.",
        })
        .eq("id", job.id);
      return;
    }

    try {
      consumed++;
      const result = await generateListing(job.inventory_item_id, ownerId, {
        batchId,
        useComps,
      });
      succeeded++;
      await supabaseAdmin
        .from("listing_generation_jobs")
        .update({ status: "success", listing_id: result.listingId, error: null })
        .eq("id", job.id);
    } catch (err) {
      failed++;
      // Refund the local allowance slot — generateListing only increments the
      // DB action counter on success (its own logging is post-write).
      consumed--;
      await supabaseAdmin
        .from("listing_generation_jobs")
        .update({
          status: "failed",
          error: err instanceof Error ? err.message : "Generation failed",
        })
        .eq("id", job.id);
    }

    // Roll up progress so the queue view updates live.
    await supabaseAdmin
      .from("listing_generation_batches")
      .update({ succeeded_count: succeeded, failed_count: failed })
      .eq("id", batchId);
  }

  try {
    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
      await Promise.all(jobs.slice(i, i + CONCURRENCY).map((j) => runJob(j)));
    }

    const status: BatchStatus = failed === 0
      ? "completed"
      : succeeded === 0
      ? "failed"
      : "partial";
    await supabaseAdmin
      .from("listing_generation_batches")
      .update({ status, succeeded_count: succeeded, failed_count: failed })
      .eq("id", batchId);
  } catch (err) {
    console.error("[flipdesk-autolister] batch worker crashed:", err);
    await supabaseAdmin
      .from("listing_generation_batches")
      .update({
        status: "failed",
        error: err instanceof Error ? err.message : "Batch processing crashed",
        succeeded_count: succeeded,
        failed_count: failed,
      })
      .eq("id", batchId);
  }
}

// POST /batch  Body: { item_ids: string[], use_comps?: boolean }
flipdeskAutolisterRoutes.post("/batch", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { item_ids?: unknown; use_comps?: unknown };
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

  // AI enablement + monthly allowance (over-quota items fail per-item below).
  const quota = await checkQuota(ownerId);
  if (!quota.ok) return c.json(quota.body, quota.status);
  const allowance = quota.limit === -1
    ? Number.POSITIVE_INFINITY
    : Math.max(0, quota.limit - quota.used);

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

  // Create the batch + one job per item.
  const { data: batch, error: batchErr } = await supabaseAdmin
    .from("listing_generation_batches")
    .insert({
      user_id: ownerId,
      status: "running",
      source: "autolister",
      item_count: itemIds.length,
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

  // Fire-and-forget — do NOT await. Returning 202 closes the HTTP connection
  // immediately (well under Cloudflare's proxy timeout); the frontend polls
  // GET /batch/:id. Mirrors flipdesk-ebay.ts /listings/pull.
  void processBatch(batchId, ownerId, jobs, useComps, allowance).catch((err) =>
    console.error("[flipdesk-autolister] background batch crashed:", err)
  );

  return c.json({ batch_id: batchId, item_count: itemIds.length }, 202);
});

// POST /batch/:id/retry-failed  —  re-runs ONLY the failed jobs in this batch
// against the same item set (US-318/US-325). Increments each job's attempts
// counter and resets its status to "running"; partial failures stay in place
// for further retries. Quota is re-checked, so the workspace can't bypass its
// monthly cap by spamming retries.
flipdeskAutolisterRoutes.post("/batch/:id/retry-failed", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const batchId = c.req.param("id");

  // Ownership-scoped batch lookup (tenant isolation per CLAUDE.md US-268).
  const { data: batch, error: batchErr } = await supabaseAdmin
    .from("listing_generation_batches")
    .select(
      "id, status, item_count, succeeded_count, failed_count",
    )
    .eq("id", batchId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (batchErr) return c.json({ error: "Could not load batch." }, 500);
  if (!batch) return c.json({ error: "Batch not found" }, 404);

  // Premium tier + quota (same gates as POST /batch).
  const gated = await requireFlipdesk(c, { feature: "autolister", userId: ownerId });
  if (gated) return gated;
  const quota = await checkQuota(ownerId);
  if (!quota.ok) return c.json(quota.body, quota.status);
  const allowance = quota.limit === -1
    ? Number.POSITIVE_INFINITY
    : Math.max(0, quota.limit - quota.used);

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

  // Reopen the batch and decrement failed_count by the retry set; keep
  // succeeded_count untouched. processBatch will re-roll on completion.
  const b = batch as {
    id: string;
    item_count: number;
    succeeded_count: number | null;
    failed_count: number | null;
  };
  const succeededSoFar = b.succeeded_count ?? 0;
  const failedSoFar = Math.max(0, (b.failed_count ?? 0) - jobs.length);
  await supabaseAdmin
    .from("listing_generation_batches")
    .update({
      status: "running",
      succeeded_count: succeededSoFar,
      failed_count: failedSoFar,
      error: null,
    })
    .eq("id", batchId);

  void processBatch(batchId, ownerId, jobs, true, allowance, {
    succeeded: succeededSoFar,
    failed: failedSoFar,
  }).catch((err) =>
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
