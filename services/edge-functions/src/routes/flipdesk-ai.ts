import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  estimateCost,
  extractEbayAspects,
  extractItemFields,
  generateListingCopy,
  type EbayAspectSpec,
  type ExtractPhoto,
} from "../lib/ai-extract.ts";
import { getCategoryAspects } from "../lib/ebay-client.ts";
import {
  classifyPhotoTypes,
  extractMatchHints,
  groupSimilarPhotos,
  groupsToPairs,
  type VisionImage,
} from "../lib/ai-reconcile.ts";
import { effectivePlanFor } from "../lib/grade-pricing.ts";
import { effectiveAiCap } from "../lib/plan-gate.ts";

const MAX_PHOTOS = 8;

// AI item-enrichment endpoints. Mounted at /api/flipdesk/ai (authed).
// workspaceOwnerId is set by workspaceMiddleware — billing, item ownership,
// and ai-actions counter all live on the workspace owner. userId stays
// around for audit only.
export const flipdeskAiRoutes = new Hono<{
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

// Monthly AI-action allowance per FlipDesk plan. -1 = unlimited.
// US-386: keyed by users.flipdesk_plan (free/starter/pro/business) — NOT the
// deprecated users.plan enum (free/starter/professional/enterprise) that the
// old lookup used, which silently fell through to the Free cap for every paying
// FlipDesk tier. MUST mirror PLAN_MATRIX.aiActionsPerMonth in plan-gate.ts
// (asserted by grade-pricing/plan-gate tests). Exported so AutoLister batch
// generation (flipdesk-autolister.ts) shares the exact same per-plan budget.
export const AI_ACTION_LIMITS: Record<string, number> = {
  free: 25,
  starter: 200,
  pro: 1000,
  business: 5000,
};

// True when `resetAt` falls in a calendar month before `now`.
function isPriorMonth(resetAt: Date, now: Date): boolean {
  if (resetAt.getUTCFullYear() < now.getUTCFullYear()) return true;
  return (
    resetAt.getUTCFullYear() === now.getUTCFullYear() &&
    resetAt.getUTCMonth() < now.getUTCMonth()
  );
}

type QuotaResult =
  | { ok: true; limit: number; used: number }
  | { ok: false; status: 403 | 404 | 429; body: Record<string, unknown> };

// Checks AI enablement + monthly cap for a user. `pending` lets a batch
// caller account for actions it is about to consume in the same request.
// Always pass the WORKSPACE OWNER's id — that's whose plan and AI quota apply.
// Exported for reuse by AutoLister batch generation (flipdesk-autolister.ts).
export async function checkQuota(
  ownerId: string,
  pending = 0
): Promise<QuotaResult> {
  const { data: user, error } = await supabaseAdmin
    .from("users")
    .select(
      "flipdesk_plan, subscription_status, trial_ends_at, ai_enrichment_enabled, ai_actions_used_this_month, ai_actions_reset_at, ai_action_limit"
    )
    .eq("id", ownerId)
    .single();

  if (error || !user) {
    return { ok: false, status: 404, body: { error: "User not found" } };
  }
  if (!user.ai_enrichment_enabled) {
    return {
      ok: false,
      status: 403,
      body: {
        error:
          "AI enrichment is turned off for your account. Enable it in Settings.",
        action: "upgrade",
      },
    };
  }

  // US-386: resolve the AI cap from the FlipDesk plan (paused + expired-trial
  // fall back to Free via effectivePlanFor), then honor the user's optional
  // self-cap (users.ai_action_limit) — min(planLimit, userLimit). The old code
  // read the deprecated `plan` column (capping every paid tier at Free) and
  // selected ai_action_limit but never applied it.
  const effectivePlan = effectivePlanFor(
    user.flipdesk_plan,
    user.subscription_status,
    user.trial_ends_at,
  );
  const planLimit = AI_ACTION_LIMITS[effectivePlan] ?? AI_ACTION_LIMITS.free!;
  const limit = effectiveAiCap(planLimit, user.ai_action_limit ?? null);
  let used = user.ai_actions_used_this_month ?? 0;
  if (isPriorMonth(new Date(user.ai_actions_reset_at), new Date())) {
    used = 0;
  }
  if (limit !== -1 && used + pending >= limit) {
    return {
      ok: false,
      status: 429,
      body: {
        error: `You've used all ${limit} AI actions for this month. Your allowance resets at the start of next month.`,
        actions_remaining: Math.max(0, limit - used),
      },
    };
  }
  return { ok: true, limit, used };
}

/**
 * POST /extract
 * Body: { text?, photo_urls?, known_fields?, item_id? }
 * Routes to Haiku (text) or Sonnet (photos), logs usage, returns suggestions.
 */
flipdeskAiRoutes.post("/extract", async (c) => {
  // Re-bind userId to the active workspace owner. For solo users this is
  // identical to the caller's id; for a member acting in someone else's
  // workspace, all reads/writes/quota lookups must target the owner.
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: {
    text?: unknown;
    photo_urls?: unknown;
    photos?: unknown;
    known_fields?: unknown;
    item_id?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const text = typeof body.text === "string" ? body.text : undefined;

  // Accept either typed photos [{url,type}] or a plain photo_urls string[].
  const photos: ExtractPhoto[] = [];
  if (Array.isArray(body.photos)) {
    for (const p of body.photos) {
      if (p && typeof p === "object" && typeof (p as ExtractPhoto).url === "string") {
        photos.push({
          url: (p as ExtractPhoto).url,
          type:
            typeof (p as ExtractPhoto).type === "string"
              ? (p as ExtractPhoto).type
              : undefined,
        });
      }
    }
  } else if (Array.isArray(body.photo_urls)) {
    for (const u of body.photo_urls) {
      if (typeof u === "string") photos.push({ url: u });
    }
  }
  const cappedPhotos = photos.slice(0, MAX_PHOTOS);

  const knownFields =
    body.known_fields && typeof body.known_fields === "object"
      ? (body.known_fields as Record<string, unknown>)
      : {};
  const itemId = typeof body.item_id === "string" ? body.item_id : null;

  if ((!text || text.trim() === "") && cappedPhotos.length === 0) {
    return c.json({ error: "Provide text or photos." }, 400);
  }

  // Enablement + monthly cap check.
  const quota = await checkQuota(userId);
  if (!quota.ok) return c.json(quota.body, quota.status);
  const { limit, used } = quota;

  const inputKind =
    cappedPhotos.length > 0 ? (text ? "both" : "photo") : "text";

  const start = Date.now();
  let result;
  try {
    result = await extractItemFields({
      text,
      photos: cappedPhotos,
      knownFields,
    });
  } catch (err) {
    console.error(
      "[flipdesk-ai] extraction failed:",
      err instanceof Error ? err.message : String(err)
    );
    return c.json(
      {
        error:
          "AI extraction is temporarily unavailable. Please try again in a moment.",
      },
      502
    );
  }
  const latencyMs = Date.now() - start;

  // Never contradict caller-supplied known fields.
  for (const key of Object.keys(knownFields)) {
    delete result.suggestions[key];
  }

  const costUsd = estimateCost(
    result.model,
    result.tokensIn,
    result.tokensOut
  );

  const { data: logRow, error: logErr } = await supabaseAdmin
    .from("ai_enrichment_log")
    .insert({
      user_id: userId,
      inventory_item_id: itemId,
      model: result.model,
      input_kind: inputKind,
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      cost_usd: costUsd,
      latency_ms: latencyMs,
      suggested_fields: result.suggestions,
    })
    .select("id")
    .single();

  if (logErr) {
    console.error("[flipdesk-ai] failed to write log row:", logErr.message);
  }

  await supabaseAdmin.rpc("increment_ai_actions", { p_user_id: userId });

  const actionsRemaining =
    limit === -1 ? -1 : Math.max(0, limit - used - 1);

  return c.json({
    suggestions: result.suggestions,
    condition_summary: result.conditionSummary,
    conflicts: result.conflicts,
    measurements: result.measurements,
    model: result.model,
    log_id: logRow?.id ?? null,
    actions_remaining: actionsRemaining,
  });
});

// ─── eBay aspect-aware extraction (Week 2) ────────────────────────
//
// POST /extract-aspects
// Body: { item_id, category_id, known_aspects?, category_path? }
//
// Loads the item + its photos, pulls (or refreshes) the cached aspect spec
// for the category, asks Claude to fill values constrained to eBay's allowed
// values, and returns per-aspect suggestions.

const MAX_AI_ASPECTS = 30; // schema bloats fast above this — see ai-extract.ts.
const MAX_ALLOWED_VALUES_PER_ASPECT = 200;

interface EbayRawAspect {
  localizedAspectName?: string;
  aspectConstraint?: {
    aspectMode?: string;
    aspectRequired?: boolean;
    aspectUsage?: string;
    itemToAspectCardinality?: string;
  };
  aspectValues?: Array<{ localizedValue?: string }>;
}

function toAspectSpecs(rawAspects: unknown): EbayAspectSpec[] {
  const list = Array.isArray(rawAspects) ? (rawAspects as EbayRawAspect[]) : [];
  const specs: EbayAspectSpec[] = [];
  for (const a of list) {
    const name = typeof a.localizedAspectName === "string"
      ? a.localizedAspectName.trim()
      : "";
    if (!name) continue;
    const c = a.aspectConstraint ?? {};
    const mode = (c.aspectMode === "SELECTION_ONLY" ||
        c.aspectMode === "SUGGESTED" ||
        c.aspectMode === "FREE_TEXT")
      ? c.aspectMode
      : "FREE_TEXT";
    const cardinality = c.itemToAspectCardinality === "MULTI"
      ? "MULTI"
      : "SINGLE";
    const required = !!c.aspectRequired;
    const allowedValues = (a.aspectValues ?? [])
      .map((v) => (typeof v.localizedValue === "string" ? v.localizedValue : ""))
      .filter((v): v is string => v.length > 0)
      .slice(0, MAX_ALLOWED_VALUES_PER_ASPECT);
    specs.push({
      name,
      required,
      cardinality,
      mode,
      allowedValues: allowedValues.length > 0 ? allowedValues : undefined,
    });
  }
  return specs;
}

// Required first, then RECOMMENDED, then drop OPTIONAL — the AI focuses on
// the aspects that actually matter for an eBay listing.
function prioritizeAspects(
  specs: EbayAspectSpec[],
  rawAspects: unknown
): EbayAspectSpec[] {
  const list = Array.isArray(rawAspects) ? (rawAspects as EbayRawAspect[]) : [];
  const usageByName = new Map<string, string>();
  for (const a of list) {
    if (a.localizedAspectName) {
      usageByName.set(
        a.localizedAspectName,
        a.aspectConstraint?.aspectUsage ?? "OPTIONAL"
      );
    }
  }
  const required = specs.filter((s) => s.required);
  const recommended = specs.filter(
    (s) => !s.required && usageByName.get(s.name) === "RECOMMENDED"
  );
  const optional = specs.filter(
    (s) => !s.required && usageByName.get(s.name) !== "RECOMMENDED"
  );
  return [...required, ...recommended, ...optional].slice(0, MAX_AI_ASPECTS);
}

flipdeskAiRoutes.post("/extract-aspects", async (c) => {
  // Re-bind userId to the active workspace owner. For solo users this is
  // identical to the caller's id; for a member acting in someone else's
  // workspace, all reads/writes/quota lookups must target the owner.
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: {
    item_id?: unknown;
    category_id?: unknown;
    known_aspects?: unknown;
    category_path?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = typeof body.item_id === "string" ? body.item_id : null;
  const categoryIdBody = typeof body.category_id === "string"
    ? body.category_id
    : null;
  const categoryPath = typeof body.category_path === "string"
    ? body.category_path
    : null;
  if (!itemId) return c.json({ error: "item_id is required" }, 400);

  const quota = await checkQuota(userId);
  if (!quota.ok) return c.json(quota.body, quota.status);

  // Item ownership + fallback category fetch (when caller didn't override).
  const { data: item } = await supabaseAdmin
    .from("inventory_items")
    .select(
      "id, user_id, title, brand, style, size, color, material, condition_notes, ebay_category_id"
    )
    .eq("id", itemId)
    .single();
  if (!item || item.user_id !== userId) {
    return c.json({ error: "Item not found" }, 404);
  }

  const categoryId = categoryIdBody ?? (item.ebay_category_id as string | null);
  if (!categoryId) {
    return c.json(
      {
        error: "category_id is required (none saved on item, none supplied)",
      },
      400
    );
  }

  // Pull aspect spec (cached or live from eBay Taxonomy API).
  let aspectsResponse;
  try {
    aspectsResponse = await getCategoryAspects(categoryId);
  } catch (err) {
    console.error("[flipdesk-ai] aspect fetch failed:", err);
    return c.json(
      {
        error:
          "Could not load eBay item-specifics for this category. Try again.",
      },
      502
    );
  }
  const rawAspects = (aspectsResponse.aspects as Record<string, unknown>)
    .aspects;
  const allSpecs = toAspectSpecs(rawAspects);
  const aiSpecs = prioritizeAspects(allSpecs, rawAspects);
  if (aiSpecs.length === 0) {
    return c.json({
      category_id: categoryId,
      suggestions: {},
      model: null,
      log_id: null,
      actions_remaining: quota.limit === -1
        ? -1
        : Math.max(0, quota.limit - quota.used),
    });
  }

  const photos = await loadItemPhotos(itemId);

  // Free-text context that helps the AI: brand/style/condition_notes go into
  // the prompt body so it can read e.g. "vintage 1990s" out of notes.
  const textParts = [
    item.title,
    item.brand,
    item.style,
    item.size,
    item.color,
    item.material,
    item.condition_notes,
  ]
    .filter((t): t is string => !!t && String(t).trim() !== "")
    .join("\n");

  const knownAspects =
    body.known_aspects && typeof body.known_aspects === "object"
      ? (body.known_aspects as Record<string, string[]>)
      : {};

  const start = Date.now();
  let result;
  try {
    result = await extractEbayAspects({
      text: textParts || undefined,
      photos,
      knownAspects,
      aspects: aiSpecs,
      categoryPath,
    });
  } catch (err) {
    console.error(
      "[flipdesk-ai] aspect extraction failed:",
      err instanceof Error ? err.message : String(err)
    );
    return c.json(
      { error: "AI aspect extraction is temporarily unavailable." },
      502
    );
  }
  const latencyMs = Date.now() - start;
  const costUsd = estimateCost(result.model, result.tokensIn, result.tokensOut);

  const { data: logRow } = await supabaseAdmin
    .from("ai_enrichment_log")
    .insert({
      user_id: userId,
      inventory_item_id: itemId,
      model: result.model,
      input_kind: photos.length > 0 ? "both" : "text",
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      cost_usd: costUsd,
      latency_ms: latencyMs,
      suggested_fields: {
        category_id: categoryId,
        aspect_suggestions: result.suggestions,
      },
    })
    .select("id")
    .single();
  await supabaseAdmin.rpc("increment_ai_actions", { p_user_id: userId });

  const actionsRemaining = quota.limit === -1
    ? -1
    : Math.max(0, quota.limit - quota.used - 1);

  return c.json({
    category_id: categoryId,
    suggestions: result.suggestions,
    model: result.model,
    log_id: logRow?.id ?? null,
    actions_remaining: actionsRemaining,
    // Useful telemetry for the UI ("AI considered 27 of 134 aspects").
    aspects_considered: aiSpecs.length,
    aspects_available: allSpecs.length,
  });
});

// Item photos as typed { url, type } pairs from the public item-photos bucket.
async function loadItemPhotos(itemId: string): Promise<ExtractPhoto[]> {
  const { data } = await supabaseAdmin
    .from("item_photos")
    .select("photo_type, storage_path")
    .eq("inventory_item_id", itemId);
  return ((data ?? []) as { photo_type: string; storage_path: string }[]).map(
    (p) => ({
      url: supabaseAdmin.storage
        .from("item-photos")
        .getPublicUrl(p.storage_path).data.publicUrl,
      type: p.photo_type,
    })
  );
}

const ENRICHABLE_COLUMNS = [
  "brand",
  "style",
  "size",
  "color",
  "material",
  "item_category",
] as const;

/**
 * POST /listing-copy
 * Body: { item_id }. Generates a marketplace listing title + description.
 */
flipdeskAiRoutes.post("/listing-copy", async (c) => {
  // Re-bind userId to the active workspace owner. For solo users this is
  // identical to the caller's id; for a member acting in someone else's
  // workspace, all reads/writes/quota lookups must target the owner.
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { item_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = typeof body.item_id === "string" ? body.item_id : null;
  if (!itemId) return c.json({ error: "item_id is required" }, 400);

  const quota = await checkQuota(userId);
  if (!quota.ok) return c.json(quota.body, quota.status);

  const { data: item } = await supabaseAdmin
    .from("inventory_items")
    .select(
      "id, user_id, title, brand, style, size, color, material, item_category, condition_notes, measurements"
    )
    .eq("id", itemId)
    .single();
  if (!item || item.user_id !== userId) {
    return c.json({ error: "Item not found" }, 404);
  }

  const photos = await loadItemPhotos(itemId);
  const start = Date.now();
  let result;
  try {
    result = await generateListingCopy({
      attributes: {
        title: item.title,
        brand: item.brand,
        style: item.style,
        size: item.size,
        color: item.color,
        material: item.material,
        item_category: item.item_category,
      },
      conditionNotes: item.condition_notes ?? undefined,
      measurements:
        (item.measurements as Record<string, unknown> | null) ?? undefined,
      photos,
    });
  } catch (err) {
    console.error(
      "[flipdesk-ai] listing copy failed:",
      err instanceof Error ? err.message : String(err)
    );
    return c.json(
      { error: "AI listing generation is temporarily unavailable." },
      502
    );
  }
  const latencyMs = Date.now() - start;
  const costUsd = estimateCost(result.model, result.tokensIn, result.tokensOut);

  const { data: logRow } = await supabaseAdmin
    .from("ai_enrichment_log")
    .insert({
      user_id: userId,
      inventory_item_id: itemId,
      model: result.model,
      input_kind: photos.length > 0 ? "both" : "text",
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      cost_usd: costUsd,
      latency_ms: latencyMs,
      suggested_fields: {
        listing_title: result.title,
        listing_description: result.description,
      },
    })
    .select("id")
    .single();
  await supabaseAdmin.rpc("increment_ai_actions", { p_user_id: userId });

  const actionsRemaining =
    quota.limit === -1 ? -1 : Math.max(0, quota.limit - quota.used - 1);
  return c.json({
    title: result.title,
    description: result.description,
    model: result.model,
    log_id: logRow?.id ?? null,
    actions_remaining: actionsRemaining,
  });
});

/**
 * POST /bulk-extract
 * Body: { item_ids: string[] }. Enriches many items; high-confidence gap
 * fields auto-apply, uncertain ones are returned for per-item review.
 */
flipdeskAiRoutes.post("/bulk-extract", async (c) => {
  // Re-bind userId to the active workspace owner. For solo users this is
  // identical to the caller's id; for a member acting in someone else's
  // workspace, all reads/writes/quota lookups must target the owner.
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { item_ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemIds = Array.isArray(body.item_ids)
    ? body.item_ids.filter((i): i is string => typeof i === "string")
    : [];
  if (itemIds.length === 0) {
    return c.json({ error: "item_ids is required" }, 400);
  }

  const quota = await checkQuota(userId);
  if (!quota.ok) return c.json(quota.body, quota.status);

  // Clamp the batch to what the monthly allowance permits.
  const remaining =
    quota.limit === -1 ? itemIds.length : quota.limit - quota.used;
  const toProcess = itemIds.slice(0, Math.max(0, remaining));
  const skipped = itemIds.slice(toProcess.length);

  const AUTO_APPLY_CONFIDENCE = 0.85;
  const results: {
    item_id: string;
    status: "enriched" | "needs_review" | "failed";
    applied: string[];
    pending: string[];
    reason?: string;
  }[] = [];

  async function processItem(itemId: string) {
    try {
      const { data: item } = await supabaseAdmin
        .from("inventory_items")
        .select(
          "id, user_id, title, brand, style, size, color, material, item_category, description, condition_notes, ai_field_sources"
        )
        .eq("id", itemId)
        .single();
      if (!item || item.user_id !== userId) {
        results.push({
          item_id: itemId,
          status: "failed",
          applied: [],
          pending: [],
          reason: "Item not found",
        });
        return;
      }

      const photos = await loadItemPhotos(itemId);
      const text = [item.title, item.description, item.condition_notes]
        .filter((t): t is string => !!t && t.trim() !== "")
        .join("\n");
      const known: Record<string, unknown> = {};
      for (const col of ENRICHABLE_COLUMNS) {
        const v = (item as Record<string, unknown>)[col];
        if (v && String(v).trim()) known[col] = v;
      }

      const start = Date.now();
      const extraction = await extractItemFields({
        text: text || undefined,
        photos,
        knownFields: known,
      });
      const latencyMs = Date.now() - start;

      const update: Record<string, unknown> = {};
      const aiSources =
        (item.ai_field_sources as Record<string, unknown>) ?? {};
      const applied: string[] = [];
      const pending: string[] = [];
      const conflictFields = new Set(
        extraction.conflicts.map((cf) => cf.field)
      );

      for (const [field, sug] of Object.entries(extraction.suggestions)) {
        if (!(ENRICHABLE_COLUMNS as readonly string[]).includes(field)) {
          continue;
        }
        const currentlyEmpty = !String(
          (item as Record<string, unknown>)[field] ?? ""
        ).trim();
        // Only auto-apply confident, non-conflicting values into empty gaps.
        if (
          currentlyEmpty &&
          sug.confidence >= AUTO_APPLY_CONFIDENCE &&
          !conflictFields.has(field)
        ) {
          update[field] = sug.value;
          aiSources[field] = {
            source: sug.source,
            confidence: sug.confidence,
            accepted: true,
          };
          applied.push(field);
        } else {
          pending.push(field);
        }
      }

      const costUsd = estimateCost(
        extraction.model,
        extraction.tokensIn,
        extraction.tokensOut
      );
      await supabaseAdmin.from("ai_enrichment_log").insert({
        user_id: userId,
        inventory_item_id: itemId,
        model: extraction.model,
        input_kind: photos.length > 0 ? "both" : "text",
        tokens_in: extraction.tokensIn,
        tokens_out: extraction.tokensOut,
        cost_usd: costUsd,
        latency_ms: latencyMs,
        suggested_fields: extraction.suggestions,
      });
      await supabaseAdmin.rpc("increment_ai_actions", { p_user_id: userId });

      if (applied.length > 0) {
        update.ai_field_sources = aiSources;
        update.ai_enriched_at = new Date().toISOString();
        await supabaseAdmin
          .from("inventory_items")
          .update(update)
          .eq("id", itemId);
      }

      results.push({
        item_id: itemId,
        status: pending.length > 0 ? "needs_review" : "enriched",
        applied,
        pending,
      });
    } catch (err) {
      results.push({
        item_id: itemId,
        status: "failed",
        applied: [],
        pending: [],
        reason: err instanceof Error ? err.message : "Extraction failed",
      });
    }
  }

  // Bounded concurrency — 3 items at a time.
  const CONCURRENCY = 3;
  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    await Promise.all(
      toProcess.slice(i, i + CONCURRENCY).map((id) => processItem(id))
    );
  }

  return c.json({
    summary: {
      enriched: results.filter((r) => r.status === "enriched").length,
      needs_review: results.filter((r) => r.status === "needs_review")
        .length,
      failed: results.filter((r) => r.status === "failed").length,
      skipped: skipped.length,
    },
    results,
    skipped,
  });
});

/**
 * PATCH /log/:id
 * Records which suggested fields the user actually accepted, so US-167 can
 * compute an acceptance rate. Body: { accepted_fields: Record<string,unknown> }
 */
flipdeskAiRoutes.patch("/log/:id", async (c) => {
  // Re-bind userId to the active workspace owner. For solo users this is
  // identical to the caller's id; for a member acting in someone else's
  // workspace, all reads/writes/quota lookups must target the owner.
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");

  let body: { accepted_fields?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const acceptedFields =
    body.accepted_fields && typeof body.accepted_fields === "object"
      ? (body.accepted_fields as Record<string, unknown>)
      : {};

  const { error } = await supabaseAdmin
    .from("ai_enrichment_log")
    .update({ accepted_fields: acceptedFields })
    .eq("id", id)
    .eq("user_id", userId);

  if (error) {
    return c.json({ error: "Failed to record acceptance" }, 500);
  }
  return c.json({ ok: true });
});

// Shared body parser for the reconcile vision endpoints: accepts either a list
// of inline images [{id, data(base64), media_type?}] or {url}.
function parseVisionPhotos(body: unknown): { ids: string[]; images: VisionImage[] } {
  const ids: string[] = [];
  const images: VisionImage[] = [];
  const arr = (body as { photos?: unknown })?.photos;
  if (Array.isArray(arr)) {
    for (const p of arr) {
      if (!p || typeof p !== "object") continue;
      const o = p as { id?: unknown; data?: unknown; media_type?: unknown; url?: unknown };
      const id = typeof o.id === "string" ? o.id : crypto.randomUUID();
      if (typeof o.data === "string" && o.data.length > 0) {
        ids.push(id);
        images.push({
          data: o.data,
          mediaType: typeof o.media_type === "string" ? o.media_type : "image/jpeg",
        });
      } else if (typeof o.url === "string" && o.url.length > 0) {
        ids.push(id);
        images.push({ url: o.url });
      }
    }
  }
  return { ids, images };
}

/**
 * POST /embed-photos  (US-283)
 * Body: { photos: [{ id, data(base64) | url, media_type? }] }
 * Returns same-garment similarity pairs for an opt-in visual second pass.
 * Tenant-scoped to the workspace owner and quota-gated like other AI actions.
 */
flipdeskAiRoutes.post("/embed-photos", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { ids, images } = parseVisionPhotos(body);
  if (images.length < 2) return c.json({ pairs: [] });
  // Cap the batch — vision over a huge dump is costly; the board can chunk.
  if (images.length > 40) {
    return c.json({ error: "Too many photos in one batch (max 40)." }, 400);
  }

  const quota = await checkQuota(userId);
  if (!quota.ok) return c.json(quota.body, quota.status);

  try {
    const groups = await groupSimilarPhotos(images);
    const pairs = groupsToPairs(groups, ids);
    await supabaseAdmin.rpc("increment_ai_actions", { p_user_id: userId });
    return c.json({ pairs });
  } catch (err) {
    // Fail soft: the board keeps its time-gap clusters and tells the user.
    return c.json(
      { error: "Visual pass failed", detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

/**
 * POST /classify-photos  (US-286)
 * Body: { item_id }  OR  { photos: [{ id, data(base64) | url, media_type? }] }
 * Classifies each photo into a reconcile photo type. When item_id is given the
 * caller's ownership is re-verified and high-confidence types are written back
 * to item_photos (only over the generic 'detail' default, so user corrections
 * are respected). Classification failures fall back to 'detail'.
 */
flipdeskAiRoutes.post("/classify-photos", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { item_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const quota = await checkQuota(userId);
  if (!quota.ok) return c.json(quota.body, quota.status);

  // Mode A: classify a committed item's photos (verify ownership, write back).
  if (typeof body.item_id === "string") {
    const itemId = body.item_id;
    const { data: item } = await supabaseAdmin
      .from("inventory_items")
      .select("id, user_id")
      .eq("id", itemId)
      .maybeSingle();
    if (!item || (item as { user_id: string }).user_id !== userId) {
      return c.json({ error: "Item not found" }, 404);
    }
    const { data: rows } = await supabaseAdmin
      .from("item_photos")
      .select("id, storage_path, photo_type")
      .eq("inventory_item_id", itemId)
      .order("sort_order", { ascending: true });
    const photos = (rows ?? []) as { id: string; storage_path: string; photo_type: string }[];
    if (photos.length === 0) return c.json({ classifications: [] });

    const images: VisionImage[] = photos.map((p) => ({
      url: supabaseAdmin.storage.from("item-photos").getPublicUrl(p.storage_path).data.publicUrl,
    }));

    let classifications: { id: string; type: string; confidence: number }[];
    try {
      const result = await classifyPhotoTypes(images);
      const byIndex = new Map(result.map((r) => [r.index, r]));
      classifications = photos.map((p, i) => {
        const r = byIndex.get(i);
        return { id: p.id, type: r?.type ?? "detail", confidence: r?.confidence ?? 0 };
      });
    } catch {
      // Fall back to 'detail' rather than blocking the commit.
      classifications = photos.map((p) => ({ id: p.id, type: "detail", confidence: 0 }));
    }

    // Write back high-confidence types, but only over the generic 'detail'
    // default so a user's manual correction is never clobbered.
    for (let i = 0; i < classifications.length; i++) {
      const cl = classifications[i]!;
      const current = photos[i]!.photo_type;
      if (cl.confidence >= 0.6 && cl.type !== current && current === "detail") {
        await supabaseAdmin
          .from("item_photos")
          .update({ photo_type: cl.type })
          .eq("id", cl.id)
          .eq("inventory_item_id", itemId);
      }
    }
    await supabaseAdmin.rpc("increment_ai_actions", { p_user_id: userId });
    return c.json({ classifications });
  }

  // Mode B: classify caller-supplied inline images (pre-commit).
  const { ids, images } = parseVisionPhotos(body);
  if (images.length === 0) return c.json({ classifications: [] });
  if (images.length > 40) {
    return c.json({ error: "Too many photos in one batch (max 40)." }, 400);
  }
  try {
    const result = await classifyPhotoTypes(images);
    const byIndex = new Map(result.map((r) => [r.index, r]));
    const classifications = ids.map((id, i) => {
      const r = byIndex.get(i);
      return { id, type: r?.type ?? "detail", confidence: r?.confidence ?? 0 };
    });
    await supabaseAdmin.rpc("increment_ai_actions", { p_user_id: userId });
    return c.json({ classifications });
  } catch {
    return c.json({ classifications: ids.map((id) => ({ id, type: "detail", confidence: 0 })) });
  }
});

/**
 * POST /suggest-item-match  (US-285)
 * Body: { photos: [{ id, data(base64) | url, media_type? }] }
 * Returns vision-extracted brand + keyword hints for the cluster. The CLIENT
 * fuzzy-matches these against its own (owner-scoped) photo-less item list — the
 * server never sees or touches the candidate items, so there's no cross-tenant
 * surface here beyond the standard workspace-scoped quota. Never auto-applied.
 */
flipdeskAiRoutes.post("/suggest-item-match", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { images } = parseVisionPhotos(body);
  if (images.length === 0) return c.json({ brand: null, keywords: [], confidence: 0 });
  if (images.length > 8) {
    // Matching only needs the tag/front — the board sends a couple of photos.
    return c.json({ error: "Too many photos (max 8 for match hints)." }, 400);
  }

  const quota = await checkQuota(userId);
  if (!quota.ok) return c.json(quota.body, quota.status);

  try {
    const hints = await extractMatchHints(images);
    await supabaseAdmin.rpc("increment_ai_actions", { p_user_id: userId });
    return c.json(hints);
  } catch (err) {
    return c.json(
      { error: "Suggestion failed", detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});
