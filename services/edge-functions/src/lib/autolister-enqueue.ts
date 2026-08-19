// US-9115: enqueueing an AutoLister generation batch.
//
// The guards used to live inside POST /api/flipdesk/autolister/batch: the
// AutoLister kill switch, the paid-plan gate, AI enablement and the monthly
// cap, a count-aware pre-check so a batch refuses UP FRONT rather than dying
// item by item, and tenant ownership of every requested item and template.
// The connector's create-draft tool has to apply every one of them, and it
// authenticates with an API key, so it cannot reach a handler behind JWT auth.
//
// ── The worker is NOT here, and that is deliberate ────────────────────────
//
// processBatch (and runJob, and the template overlay) stay in the route module.
// Moving them would be another few hundred lines of judgement on the path that
// spends a seller's AI allowance. Instead the route REGISTERS its worker at
// module load and this lib calls it through that seam.
//
// If registration ever failed, an enqueued batch is not lost: it is written as
// status 'running' with pending jobs, which is exactly the state the reclaim
// cron (US-525) resumes. The cost of the seam breaking is up to BATCH_STALE_MS
// of latency, not a dropped batch -- the same durability the route's own
// comment already leaned on.

import { supabaseAdmin } from "./supabase.ts";
import { checkQuota } from "./ai-quota.ts";
import { featureAllowedForUser } from "./plan-gate.ts";
import { featureDisabledBody, isFeatureEnabled } from "./feature-flags.ts";

/** One item's generation job, as the worker needs it. */
export interface GenerationJob {
  id: string;
  inventory_item_id: string;
  attempts?: number;
  ai_reserved?: boolean | null;
}

export type BatchRunner = (
  batchId: string,
  ownerId: string,
  jobs: GenerationJob[],
  useComps: boolean,
  limit: number,
) => Promise<void>;

let runner: BatchRunner | null = null;

/**
 * Wire the worker in. Called by routes/flipdesk-autolister.ts at module load;
 * exported rather than imported so lib never reaches back into routes.
 */
export function registerBatchRunner(fn: BatchRunner): void {
  runner = fn;
}

/** Whether a worker is wired. Asserted by a test, because a silent no-runner
 * state degrades to a 15-minute wait rather than to an error. */
export function hasBatchRunner(): boolean {
  return runner !== null;
}

function startBatch(
  batchId: string,
  ownerId: string,
  jobs: GenerationJob[],
  useComps: boolean,
  limit: number,
): void {
  if (!runner) {
    console.error(
      "[autolister-enqueue] no batch runner registered — batch " + batchId +
        " waits for the reclaim cron",
    );
    return;
  }
  // Optimistic immediate processing for low latency. Durability does NOT depend
  // on this promise surviving: if the container dies mid-run, the reclaim
  // sweeper (US-525) resumes the batch from its persisted job rows.
  void runner(batchId, ownerId, jobs, useComps, limit).catch((err) =>
    console.error("[autolister-enqueue] background batch crashed:", err)
  );
}

/**
 * US-1545: count-aware quota pre-check for batch enqueue. A batch reserves one
 * AI action per item; when the month's remainder can't cover the whole batch,
 * return the 402 body (with the numbers, so the UI can say "trim or upgrade")
 * — null means the batch fits (or the plan is unlimited). Pure + unit-tested;
 * the per-item atomic reservation (US-527) remains the authoritative gate.
 */
export function insufficientAiActionsBody(
  itemCount: number,
  limit: number,
  used: number,
):
  | { error: string; code: "INSUFFICIENT_AI_ACTIONS"; needed: number; remaining: number; cap: number }
  | null {
  if (limit === -1) return null;
  const remaining = Math.max(0, limit - used);
  if (itemCount <= remaining) return null;
  return {
    error:
      `This batch needs ${itemCount} AI actions but only ${remaining} remain this month — ` +
      `remove some groups or upgrade your plan.`,
    code: "INSUFFICIENT_AI_ACTIONS",
    needed: itemCount,
    remaining,
    cap: limit,
  };
}

export interface EnqueueOptions {
  itemIds: string[];
  useComps?: boolean;
  templateId?: string | null;
  autoPublishGreen?: boolean;
  maxItems: number;
}

export type EnqueueOutcome =
  | { ok: true; batchId: string; itemCount: number }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Create a generation batch and its jobs, then kick the worker.
 *
 * Every guard the route applied is applied here, in the same order, because a
 * caller arriving through anything else (the connector's tools) must not skip
 * one. The route keeps its own request parsing and its exact 202 envelope.
 */
export async function enqueueGenerationBatch(
  ownerId: string,
  opts: EnqueueOptions,
): Promise<EnqueueOutcome> {
  // US-507: AutoLister kill-switch (heavy per-item AI cost).
  // US-2406: owner-scoped so plan targeting / rollout is honoured.
  if (!(await isFeatureEnabled("autolister", { userId: ownerId }))) {
    return { ok: false, status: 503, body: featureDisabledBody("autolister") };
  }

  const itemIds = Array.from(new Set(opts.itemIds));
  const useComps = opts.useComps !== false;
  const templateId = opts.templateId ?? null;

  if (itemIds.length === 0) {
    return { ok: false, status: 400, body: { error: "item_ids must be a non-empty array" } };
  }
  if (itemIds.length > opts.maxItems) {
    return {
      ok: false,
      status: 400,
      body: { error: `A batch can contain at most ${opts.maxItems} items.` },
    };
  }

  // Premium tier gate (US-323): AutoLister is a paid-tier feature. Gate the
  // workspace OWNER's plan (they pay). The context-free resolver, because this
  // runs for callers that have no Hono context.
  if (!(await featureAllowedForUser(ownerId, "autolister"))) {
    return {
      ok: false,
      status: 402,
      body: {
        error: "AutoLister is not included in your plan.",
        code: "FEATURE_LOCKED",
        feature: "autolister",
      },
    };
  }

  // AI enablement + monthly cap. The per-item atomic reservation (US-527) is
  // the real enforcement; this returns early if AI is off or already capped.
  const quota = await checkQuota(ownerId);
  if (!quota.ok) return { ok: false, status: quota.status, body: quota.body };
  const limit = quota.limit;

  const insufficient = insufficientAiActionsBody(itemIds.length, limit, quota.used);
  if (insufficient) return { ok: false, status: 402, body: insufficient };

  // Tenant isolation: every requested item MUST belong to this workspace.
  const { data: ownedRows, error: ownErr } = await supabaseAdmin
    .from("inventory_items")
    .select("id")
    .eq("user_id", ownerId)
    .in("id", itemIds);
  if (ownErr) {
    return { ok: false, status: 500, body: { error: "Could not verify item ownership." } };
  }
  const ownedIds = new Set((ownedRows ?? []).map((r) => (r as { id: string }).id));
  if (itemIds.some((id) => !ownedIds.has(id))) {
    return {
      ok: false,
      status: 403,
      body: { error: "One or more items do not belong to your workspace." },
    };
  }

  // US-674: a supplied template MUST belong to this workspace (US-268).
  if (templateId) {
    const { data: tpl, error: tplErr } = await supabaseAdmin
      .from("listing_templates")
      .select("id")
      .eq("id", templateId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (tplErr) {
      return { ok: false, status: 500, body: { error: "Could not verify the selected template." } };
    }
    if (!tpl) {
      return { ok: false, status: 404, body: { error: "Template not found in your workspace." } };
    }
  }

  const { data: batch, error: batchErr } = await supabaseAdmin
    .from("listing_generation_batches")
    .insert({
      user_id: ownerId,
      status: "running",
      source: "autolister",
      item_count: itemIds.length,
      use_comps: useComps,
      template_id: templateId,
      auto_publish_green: opts.autoPublishGreen === true,
    })
    .select("id")
    .single();
  if (batchErr || !batch) {
    return { ok: false, status: 500, body: { error: "Could not create generation batch." } };
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
    return { ok: false, status: 500, body: { error: "Could not enqueue generation jobs." } };
  }

  startBatch(batchId, ownerId, jobRows as GenerationJob[], useComps, limit);
  return { ok: true, batchId, itemCount: itemIds.length };
}
