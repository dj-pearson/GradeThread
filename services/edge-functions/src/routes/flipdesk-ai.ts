import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  attributesToColumn,
  deriveAnalyticsMetrics,
  estimateCost,
  extractEbayAspects,
  extractItemFields,
  generateAnalyticsNarrative,
  generateListingCopy,
  generateNegotiationReply,
  isRewriteAction,
  researchAttributeSuggestions,
  rewriteField,
  rewriteListingCopy,
  validateCounterOffer,
  type AspectValueSuggestion,
  type AttributeSuggestion,
  type EbayAspectSpec,
  type ExtractionResult,
  type ExtractPhoto,
  type NegotiationMode,
} from "../lib/ai-extract.ts";
import {
  estimateSize,
  SIZE_ESTIMATE_LOW_CONFIDENCE,
} from "../lib/ai-size-estimate.ts";
import {
  MAX_ALLOWED_VALUES_PER_ASPECT,
  prioritizeByDemand,
} from "../lib/aspect-priority.ts";
import {
  type ItemPhotoUrlRow,
  itemPhotoAiUrls,
} from "../lib/item-photo-storage.ts";
import {
  fetchCategoryLeafStatus,
  getCategoryAspects,
  suggestCategories,
} from "../lib/ebay-client.ts";
import { buildEbayPrepUpdate } from "../lib/ebay-prep.ts";
import { decideCategory } from "../lib/category-decision.ts";
import {
  recordCategoryDecision,
  recordExtractionProvenance,
} from "../lib/identification-provenance.ts";
import { startVisualPass } from "../lib/visual-identify-pass.ts";
import { visualAspectPrefill } from "../lib/visual-aspect-prefill.ts";
import type { VisualAspectEvidence } from "../lib/visual-aspect-consensus.ts";
import type { BrowseCompCategoryVote } from "../lib/ebay-client.ts";
import { grantReward } from "../lib/rewards-engine.ts";
import { verifyIdentificationAgainstMarket } from "../lib/identification-verify.ts";
import {
  classifyPhotoTypes,
  extractMatchHints,
  groupSimilarPhotos,
  groupsToPairs,
  type VisionImage,
} from "../lib/ai-reconcile.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import {
  QUOTA_EXHAUSTED_MESSAGE,
  refundAiAction,
  reserveAiActionSafe,
} from "../lib/ai-metering.ts";
import {
  buildExtractText,
  buildKnownFields,
  decideAttribute,
  decideField,
  isAiOwned,
  type ExtractMode,
  type UntrackedPolicy,
} from "../lib/reextract-policy.ts";
import { changesFromItemDiff } from "../lib/title-sync.ts";
import { buildTitleSyncPatch } from "../lib/title-sync-patch.ts";

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
// US-9115: AI_ACTION_LIMITS and checkQuota moved to lib/ai-quota.ts and are
// re-exported here, because four route modules and a drift test import them
// from this path and a rename would be churn for no gain. Imported as well as
// re-exported: a bare `export ... from` does not bind the name in this module,
// and fifteen call sites below use it.
import { checkQuota } from "../lib/ai-quota.ts";
export { AI_ACTION_LIMITS, checkQuota, type QuotaResult } from "../lib/ai-quota.ts";

// ── US-387: atomic AI-action reservation ─────────────────────────
// reserve_ai_action (migration 00087) is a row-locking CAS that increments the
// monthly counter AND refuses at the cap in one statement, so N concurrent
// requests at the boundary can't collectively exceed it — unlike the old
// checkQuota()→increment_ai_actions() flow, which had a check-then-act TOCTOU
// gap. checkQuota stays for the enablement gate + limit resolution + a fast UX
// rejection; reserveAiAction is the AUTHORITATIVE enforcement point. Callers
// reserve immediately BEFORE the billable AI call and refund if it throws.
// US-1581: the primitives live in lib/ai-metering.ts (one contract, every
// route); this alias keeps the fifteen call sites below unchanged.
const reserveAiAction = reserveAiActionSafe;

const QUOTA_EXHAUSTED_429 = {
  error: QUOTA_EXHAUSTED_MESSAGE,
  actions_remaining: 0,
};

/**
 * POST /extract
 * Body: { text?, photo_urls?, known_fields?, item_id?, include_ebay_aspects? }
 * Routes to Haiku (text) or Sonnet (photos), logs usage, returns suggestions.
 *
 * One-call listing prep: when an owned item_id is supplied (and
 * include_ebay_aspects isn't explicitly false), the route ALSO resolves an
 * eBay leaf category (saved on the item, else taxonomy search on the
 * AI-suggested category query) and fills that category's item-specifics in a
 * second model pass, persisting ebay_category_id + ebay_aspects on the item —
 * so the category picker opens prefilled on web and iOS. The aspects pass is
 * best-effort: any failure still returns the core extraction. It consumes a
 * second AI action when it runs.
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
    include_ebay_aspects?: unknown;
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
          role:
            typeof (p as ExtractPhoto).role === "string"
              ? (p as ExtractPhoto).role
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
  // Aspects pass defaults ON when an item is in play; callers can opt out.
  const includeEbayAspects = body.include_ebay_aspects === undefined
    ? itemId != null
    : body.include_ebay_aspects === true;

  if ((!text || text.trim() === "") && cappedPhotos.length === 0) {
    return c.json({ error: "Provide text or photos." }, 400);
  }

  // US-1638: when an item_id is supplied, verify it belongs to this workspace
  // BEFORE any DB write keyed on it (the ai_enrichment_log insert below and the
  // canonical-attribute persistence). Skipping this made a foreign item_id a
  // cross-tenant UUID-existence oracle (the FK insert would succeed/fail
  // depending on whether the row exists) and wrote a log row against another
  // tenant's item. Fail fast — before the AI spend, too.
  if (itemId) {
    const { data: ownedItem } = await supabaseAdmin
      .from("inventory_items")
      .select("id")
      .eq("id", itemId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!ownedItem) return c.json({ error: "Item not found" }, 404);
  }

  // US-826 diagnostics: the success path is sampled out of the access log, so a
  // 200 that extracts nothing is otherwise invisible (the iOS canvas just lands
  // on an "Untitled" item with no error). Log entry unconditionally so a failed
  // run is always greppable. Hosts only — never the signed-URL query string.
  console.log(
    "[flipdesk-ai] extract: start",
    JSON.stringify({
      itemId,
      hasText: !!(text && text.trim() !== ""),
      photoCount: cappedPhotos.length,
      photoTypes: cappedPhotos.map((p) => p.type ?? "untyped"),
      photoHosts: cappedPhotos.map((p) => {
        try {
          return new URL(p.url).host;
        } catch {
          return "INVALID_URL";
        }
      }),
    })
  );

  // US-2768: start the visual pass NOW, before the quota round trips and long
  // before the model call. Nothing awaits it here - the promise is handed to
  // extractItemFields, which only awaits it after every photo is fetched and
  // inlined. That is where the concurrency comes from: it overlaps the
  // network-bound preparation instead of being bolted on in front of it.
  //
  // Flag off means this returns immediately without fetching a thing.
  const visualPass = startVisualPass(cappedPhotos);

  // Enablement + monthly cap check.
  const quota = await checkQuota(userId);
  if (!quota.ok) return c.json(quota.body, quota.status);
  const { limit, used } = quota;

  const inputKind =
    cappedPhotos.length > 0 ? (text ? "both" : "photo") : "text";

  // US-387: reserve the action atomically before spending it.
  if (!(await reserveAiAction(userId, limit))) {
    return c.json(QUOTA_EXHAUSTED_429, 429);
  }

  const start = Date.now();
  let result;
  try {
    result = await extractItemFields({
      text,
      photos: cappedPhotos,
      knownFields,
      visualCandidates: visualPass.then((v) => {
        if (v.declined) {
          console.log(`[flipdesk-ai] visual pass declined: ${v.declined}`);
        }
        return v.candidates;
      }),
    });
  } catch (err) {
    await refundAiAction(userId);
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

  const suggestionCount = Object.keys(result.suggestions).length;
  const attributeCount = Object.keys(result.attributes ?? {}).length;

  // US-826 diagnostics: always log the outcome (bypasses access-log sampling).
  console.log(
    "[flipdesk-ai] extract: done",
    JSON.stringify({
      itemId,
      model: result.model,
      suggestionCount,
      attributeCount,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs,
      // Diagnostics: the actual high-value field values + brand confidence/source,
      // so a "brand is wrong" report is diagnosable from one log line (Claude's
      // value? on-device OCR fallback?) without querying ai_enrichment_log.
      fields: {
        title: result.suggestions.title?.value,
        brand: result.suggestions.brand?.value,
        brandConf: result.suggestions.brand?.confidence,
        brandSrc: result.suggestions.brand?.source,
        style: result.suggestions.style?.value,
        size: result.suggestions.size?.value,
        material: result.suggestions.material?.value,
      },
    })
  );

  // The silent-failure signature: photos were sent and the AI call succeeded,
  // yet Claude returned ZERO usable fields. This is what surfaces on iOS as an
  // "Untitled" item with nothing filled. WARN loudly with the inputs so the
  // cause (unreadable images, a misconfigured DEFAULT_AI_MODEL, a blank/placeholder
  // object) is diagnosable from one reproduction instead of guesswork.
  if (suggestionCount === 0 && attributeCount === 0 && cappedPhotos.length > 0) {
    console.warn(
      "[flipdesk-ai] extract: EMPTY result despite photos — AI returned no fields.",
      JSON.stringify({
        itemId,
        model: result.model,
        photoCount: cappedPhotos.length,
        photoTypes: cappedPhotos.map((p) => p.type ?? "untyped"),
        photoHosts: cappedPhotos.map((p) => {
          try {
            return new URL(p.url).host;
          } catch {
            return "INVALID_URL";
          }
        }),
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      })
    );
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

  // US-2774: what the visual pass offered and what the model ruled on each
  // candidate. Best-effort — a lost provenance row must never cost an
  // extraction. The id completes the same row when the eBay phase settles the
  // category below, so one run is one row rather than two half-rows.
  const provenanceId = await recordExtractionProvenance(supabaseAdmin, {
    ownerUserId: userId,
    itemId,
    enrichmentLogId: (logRow as { id: string } | null)?.id ?? null,
    candidates: result.visualCandidates,
    rulings: result.visualRulings,
    // US-2779: already resolved — extractItemFields awaited this same promise
    // before it built its prompt, so reading it costs nothing.
    visualDeclined: (await visualPass).declined,
  });

  // US-821: persist the canonical attributes + condition_summary +
  // ebay_category_query onto the item in the SAME pass (gap-fill, tenant-
  // scoped). Best-effort — never fails the core extraction.
  let persistedAttributes: Record<string, string | string[]> = {};
  if (itemId) {
    try {
      const persisted = await persistCanonicalAttributes({
        userId,
        itemId,
        extraction: result,
      });
      persistedAttributes = persisted.attributes;
    } catch (err) {
      console.error(
        "[flipdesk-ai] canonical-attribute persistence failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // One-call listing prep: resolve the eBay category + fill its item-specifics
  // and persist them onto the item — but DON'T block the response on it. That
  // phase runs a SECOND model call (~20s) which previously doubled the extract
  // latency to ~40s; deferring it lets the core extraction return in ~16s. The
  // persisted category/aspects are read by the specifics editor on demand, so
  // the client no longer needs them inline. Best-effort — failures are logged,
  // never surfaced. Fire-and-forget on the persistent edge event loop.
  const ebayPending = includeEbayAspects && itemId != null;
  if (ebayPending) {
    const bgItemId = itemId as string;
    void (async () => {
      try {
        await runEbayAspectsPhase({
          userId,
          itemId: bgItemId,
          limit,
          photos: cappedPhotos,
          extraction: result,
          // US-2765: already resolved by now - extractItemFields awaited this
          // same promise before it built its prompt - so reading it here is
          // free and adds no latency to a phase that already ran the search.
          visualLeafVotes: (await visualPass).leafCategoryVotes,
          // Same already-resolved promise, same zero added latency (US-2770).
          visualEvidence: (await visualPass).evidence,
          provenanceId,
        });
      } catch (err) {
        console.error(
          "[flipdesk-ai] background eBay aspects phase failed:",
          err instanceof Error ? err.message : String(err)
        );
      }
    })();
  }

  // US-1528: cross-reference the research identification against live eBay
  // listings (Browse, app token) in the background — verified IDs get boosted
  // confidence + "Verified on eBay"; zero market hits demote. No AI call, no
  // foreground latency; every failure degrades to "stays unverified".
  //
  // US-2689: also run on a bare STYLE CODE with no research identification. The
  // research tier is where identifications come from, but a legible tag code is
  // learnable from any tier, and gating on result.research meant the learned
  // index (US-2246) never saw the items the model could not name.
  const verifyStyleCode = result.attributes.style_code?.values[0] ?? null;
  if (itemId && (result.research || verifyStyleCode)) {
    const bgItemId = itemId as string;
    const research = result.research ?? null;
    const brand = result.suggestions.brand?.value ?? null;
    const styleCode = verifyStyleCode;
    void (async () => {
      try {
        await verifyIdentificationAgainstMarket({
          userId,
          itemId: bgItemId,
          brand,
          styleCode,
          research,
        });
      } catch (err) {
        console.error(
          "[flipdesk-ai] background identification verify failed:",
          err instanceof Error ? err.message : String(err)
        );
      }
    })();
  }

  // Action already reserved atomically above (US-387). The background eBay pass
  // reserves its OWN action when it runs, so it isn't subtracted from this
  // response's remaining count.
  const actionsRemaining =
    limit === -1 ? -1 : Math.max(0, limit - used - 1);

  return c.json({
    suggestions: result.suggestions,
    // US-821: canonical attributes captured this pass (raw per-field
    // confidence + source) plus the merged column form persisted on the item.
    attributes: result.attributes,
    persisted_attributes: persistedAttributes,
    // US-1527: research-tier product identification (already confidence-
    // floored in decode). The style suggestion carries source:'research' when
    // it came from here; clients badge it and show the rationale.
    research: result.research
      ? {
          identified_style: result.research.identifiedStyle,
          product_line: result.research.productLine,
          fabric_technology: result.research.fabricTechnology,
          msrp_estimate_cents: result.research.msrpEstimateCents,
          identification_rationale: result.research.rationale,
          identification_confidence: result.research.confidence,
        }
      : null,
    condition_summary: result.conditionSummary,
    ebay_category_query: result.ebayCategoryQuery,
    conflicts: result.conflicts,
    measurements: result.measurements,
    model: result.model,
    log_id: logRow?.id ?? null,
    actions_remaining: actionsRemaining,
    // eBay category/aspects now resolve in the background (see above); the
    // client reads them from the item once persisted. `ebay_pending` lets a
    // client show a "resolving category…" hint if it wants to.
    ebay: null,
    ebay_pending: ebayPending,
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

interface EbayRawAspect {
  localizedAspectName?: string;
  aspectConstraint?: {
    aspectMode?: string;
    aspectRequired?: boolean;
    aspectUsage?: string;
    itemToAspectCardinality?: string;
    /** "STRING" | "NUMBER" | "DATE" — drives numeric value validation. */
    aspectDataType?: string;
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
      dataType: c.aspectDataType,
    });
  }
  return specs;
}

// US-2420: required first, then by eBay's own 30-day buyer-search volume, using
// the SAME ranking and caps as the AutoLister path (lib/aspect-priority.ts).
// The old sort was required → RECOMMENDED → OPTIONAL, which cut the aspects
// buyers filter on most (Theme, Accents, Occasion) out of the tool schema.
function prioritizeAspects(
  specs: EbayAspectSpec[],
  rawAspects: unknown
): EbayAspectSpec[] {
  return prioritizeByDemand(specs, rawAspects);
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

  // US-387: reserve the action atomically before spending it.
  if (!(await reserveAiAction(userId, quota.limit))) {
    return c.json(QUOTA_EXHAUSTED_429, 429);
  }

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
    await refundAiAction(userId);
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
  // Action already reserved atomically above (US-387).

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

// ─── One-call eBay aspects phase (rides on POST /extract) ─────────
//
// Resolves a leaf category for the item (saved ebay_category_id, else eBay
// Taxonomy search on the model's ebay_category_query), fills that category's
// item-specifics with a second model pass, and persists ebay_category_id +
// ebay_aspects on the item so the category picker opens prefilled everywhere.

interface EbayAspectsBlock {
  category_id: string;
  category_path: string | null;
  /** Merged, persisted aspects (existing values win over AI suggestions). */
  aspects: Record<string, string[]>;
  /** Raw per-aspect AI suggestions with confidence + source. */
  suggestions: Record<string, AspectValueSuggestion>;
  /**
   * US-826: true when the category resolved but aspects could NOT be filled
   * (AI budget exhausted or aspect extraction failed). The item is flagged
   * (inventory_items.ebay_aspects_refill_needed) so the specifics editor /
   * publish-prep deterministically refills aspects with no further AI.
   */
  refill_needed: boolean;
}

function sanitizeAspectMap(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, values] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(values)) continue;
    const clean = values
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (clean.length > 0) out[name] = clean;
  }
  return out;
}

async function runEbayAspectsPhase(args: {
  userId: string;
  itemId: string;
  limit: number;
  photos: ExtractPhoto[];
  extraction: ExtractionResult;
  /**
   * Leaf categories the visually similar listings sit in (US-2765).
   *
   * Optional, and its absence is the current behaviour rather than a
   * degradation: with no votes the decision falls to the Taxonomy keyword
   * search, which is what ran here before. US-2768 supplies them.
   */
  visualLeafVotes?: readonly BrowseCompCategoryVote[];
  /**
   * Per-aspect consensus from the same visual pass (US-2770).
   *
   * Absent means no prefill and today's behaviour exactly, which is also what
   * the flag-off path produces.
   */
  visualEvidence?: VisualAspectEvidence | null;
  /**
   * The provenance row this run opened (US-2774), so the category decision
   * completes it instead of opening a second one. Absent means the extraction
   * could not open one; the decision is still recorded, on its own row.
   */
  provenanceId?: string | null;
}): Promise<{ block: EbayAspectsBlock | null; actionsSpent: number }> {
  const {
    userId,
    itemId,
    limit,
    photos,
    extraction,
    visualLeafVotes,
    visualEvidence,
    provenanceId,
  } = args;

  // Ownership gate — this phase WRITES to the item.
  const { data: item } = await supabaseAdmin
    .from("inventory_items")
    .select(
      "id, user_id, title, brand, style, size, color, material, condition_notes, ebay_category_id, ebay_aspects"
    )
    .eq("id", itemId)
    .single();
  if (!item || item.user_id !== userId) return { block: null, actionsSpent: 0 };

  // 1. Resolve a leaf category (US-2765). Precedence, strongest first: a
  //    category the seller already set, then the leaf that visually similar
  //    listings actually sit in, then the Taxonomy keyword search on the AI's
  //    phrase. The keyword path is unchanged and is still the floor.
  //
  //    `leafVotes` is empty until the visual pass runs here (US-2768), so
  //    today every call takes the keyword branch exactly as it did before.
  let categoryPath: string | null = null;
  const decision = await decideCategory({
    savedCategoryId: item.ebay_category_id as string | null,
    leafVotes: visualLeafVotes,
    leafStatus: fetchCategoryLeafStatus,
    keywordSuggest: async () => {
      const query = extraction.ebayCategoryQuery ??
        extraction.suggestions.title?.value ??
        (typeof item.title === "string" ? item.title : null);
      if (!query || !query.trim()) return [];
      const matches = await suggestCategories(query.trim());
      // The path is only carried on the keyword branch because only Taxonomy
      // returns it; a vote knows the leaf's name but not its ancestry.
      categoryPath = matches[0]?.categoryTreePath ?? null;
      return matches.map((m) => ({
        categoryId: m.categoryId,
        categoryName: m.categoryName,
      }));
    },
  });
  // US-2774: the decision itself, not just a log line. Recorded BEFORE the
  // early return below, so a run that resolved no category at all is stored as
  // method 'none' rather than as an absent row — "nothing was decided" and
  // "nothing was recorded" are different findings.
  await recordCategoryDecision(supabaseAdmin, {
    ownerUserId: userId,
    itemId,
    provenanceId,
    decision,
  });
  if (decision.rejectedReason && decision.method !== "visual_consensus") {
    // A vote that lost is worth a line. An ignored vote and an absent vote are
    // indistinguishable in the data otherwise, and only one means the visual
    // pass is not earning its latency.
    console.log(
      `[ebay-prep] visual category vote rejected (${decision.rejectedReason}); ` +
        `fell back to ${decision.method}`,
    );
  }
  const categoryId = decision.categoryId;
  if (!categoryId) return { block: null, actionsSpent: 0 };

  // 2. Category aspect spec (cached taxonomy read).
  const aspectsResponse = await getCategoryAspects(categoryId);
  const rawAspects = (aspectsResponse.aspects as Record<string, unknown>)
    .aspects;
  const allSpecs = toAspectSpecs(rawAspects);
  const aiSpecs = prioritizeAspects(allSpecs, rawAspects);

  const existingAspects = sanitizeAspectMap(item.ebay_aspects);

  // Persist the resolved category even if there's nothing for the AI to do —
  // the picker pre-selecting the right category is half the win.
  if (aiSpecs.length === 0) {
    // Complete prep: this category exposes no fillable specifics. Clear any
    // stale refill flag — there is nothing for a deterministic refill to do.
    await supabaseAdmin
      .from("inventory_items")
      .update(buildEbayPrepUpdate({ categoryId, status: "no_specs" }))
      .eq("id", itemId)
      .eq("user_id", userId);
    // US-2770: "nothing worth an AI call" is not "nothing worth filling". The
    // category can still expose optional specifics, and the visual matches may
    // already answer them - at no AI cost on this path, since no model runs.
    const freePrefill = visualAspectPrefill({
      evidence: visualEvidence ?? null,
      specs: allSpecs,
      existing: existingAspects,
    });
    return {
      block: {
        category_id: categoryId,
        category_path: categoryPath,
        aspects: existingAspects,
        suggestions: freePrefill.suggestions,
        refill_needed: false,
      },
      actionsSpent: 0,
    };
  }

  // 3. Second model pass — billable, so reserve another AI action. If the
  //    budget is exhausted, persist the category alone, FLAG the item for a
  //    later deterministic (non-AI) refill, and stop (US-826).
  if (!(await reserveAiAction(userId, limit))) {
    await supabaseAdmin
      .from("inventory_items")
      .update(buildEbayPrepUpdate({ categoryId, status: "budget_exhausted" }))
      .eq("id", itemId)
      .eq("user_id", userId);
    return {
      block: {
        category_id: categoryId,
        category_path: categoryPath,
        aspects: existingAspects,
        suggestions: {},
        refill_needed: true,
      },
      actionsSpent: 0,
    };
  }

  // Text context: just-extracted core fields + item columns.
  const textParts = [
    extraction.suggestions.title?.value ?? item.title,
    extraction.suggestions.brand?.value ?? item.brand,
    extraction.suggestions.style?.value ?? item.style,
    extraction.suggestions.size?.value ?? item.size,
    extraction.suggestions.color?.value ?? item.color,
    extraction.suggestions.material?.value ?? item.material,
    extraction.suggestions.condition_notes?.value ?? item.condition_notes,
    extraction.conditionSummary,
  ]
    .filter((t): t is string => !!t && String(t).trim() !== "")
    .join("\n");

  const start = Date.now();
  let aspectResult;
  try {
    aspectResult = await extractEbayAspects({
      text: textParts || undefined,
      photos,
      knownAspects: existingAspects,
      aspects: aiSpecs,
      categoryPath,
      // US-1529: Style/Model/Product Line/Fabric Type aspects fill from the
      // identification instead of being omitted. Absent → prompt unchanged.
      research: extraction.research,
    });
  } catch (err) {
    await refundAiAction(userId);
    console.error(
      "[flipdesk-ai] one-call aspect extraction failed:",
      err instanceof Error ? err.message : String(err)
    );
    // Partial prep: category survived but aspects did not. Persist the category
    // and FLAG the item so the specifics editor / publish-prep refills aspects
    // deterministically (no AI) on next open (US-826).
    await supabaseAdmin
      .from("inventory_items")
      .update(buildEbayPrepUpdate({ categoryId, status: "extraction_failed" }))
      .eq("id", itemId)
      .eq("user_id", userId);
    return {
      block: {
        category_id: categoryId,
        category_path: categoryPath,
        aspects: existingAspects,
        suggestions: {},
        refill_needed: true,
      },
      actionsSpent: 0,
    };
  }
  const latencyMs = Date.now() - start;

  // 4. Merge (user-entered values are ground truth) + persist.
  const merged: Record<string, string[]> = { ...existingAspects };
  for (const [name, suggestion] of Object.entries(aspectResult.suggestions)) {
    if (!merged[name] || merged[name].length === 0) {
      merged[name] = suggestion.values;
    }
  }
  await supabaseAdmin
    .from("inventory_items")
    .update(
      buildEbayPrepUpdate({
        categoryId,
        status: "filled",
        mergedAspects: merged,
      })
    )
    .eq("id", itemId)
    .eq("user_id", userId);

  // US-1849 AC3: `aspects_filled` — the listing-quality/SEO act. Awarded ONLY on
  // the `filled` outcome; a partial prep (budget exhausted / extraction failed)
  // returns above and earns nothing, so the XP tracks the finished surface, not
  // the attempt. It reached here through reserveAiAction, so the action was
  // credit-consuming by construction (AC4's spirit — a free retry can't farm it).
  // Idempotent on the item, so re-running prep on the same item never re-earns.
  void grantReward(userId, "aspects_filled", {
    referenceId: `item:${itemId}`,
    source: "ebay_prep",
    metadata: { category_id: categoryId, aspect_count: Object.keys(merged).length },
  }).catch((err) =>
    console.error(
      "[flipdesk-ai] aspects_filled reward grant failed:",
      err instanceof Error ? err.message : String(err)
    )
  );

  // Telemetry log row, mirroring POST /extract-aspects.
  const costUsd = estimateCost(
    aspectResult.model,
    aspectResult.tokensIn,
    aspectResult.tokensOut
  );
  await supabaseAdmin.from("ai_enrichment_log").insert({
    user_id: userId,
    inventory_item_id: itemId,
    model: aspectResult.model,
    input_kind: photos.length > 0 ? "both" : "text",
    tokens_in: aspectResult.tokensIn,
    tokens_out: aspectResult.tokensOut,
    cost_usd: costUsd,
    latency_ms: latencyMs,
    suggested_fields: {
      category_id: categoryId,
      aspect_suggestions: aspectResult.suggestions,
    },
  });

  // US-2770. `existing: merged` rather than existingAspects, so an aspect the
  // model just filled is already excluded - and modelSuggestions on top of that,
  // because the two record different reasons and a reader wants to know which.
  const prefill = visualAspectPrefill({
    evidence: visualEvidence ?? null,
    specs: allSpecs,
    existing: merged,
    modelSuggestions: aspectResult.suggestions,
  });
  if (prefill.skipped.length > 0) {
    // A refused prefill and an absent one look identical in the data otherwise,
    // and only one of them means the visual pass is not earning its latency.
    console.log(
      "[ebay-prep] visual aspect prefill skipped:",
      JSON.stringify(prefill.skipped.map((s) => `${s.aspect}:${s.reason}`)),
    );
  }

  return {
    block: {
      category_id: categoryId,
      category_path: categoryPath,
      aspects: merged,
      // Spread order is the precedence: the model looked at THIS garment, the
      // prefill looked at listings that resemble it. The lib already refuses an
      // aspect the model answered; this makes that true structurally too.
      suggestions: { ...prefill.suggestions, ...aspectResult.suggestions },
      refill_needed: false,
    },
    actionsSpent: 1,
  };
}

// US-821: persist the single-pass canonical attributes (+ condition_summary,
// ebay_category_query) onto an OWNED item. Gap-fills inventory_items.attributes
// (existing/user-entered keys win), records provenance in ai_field_sources, and
// refreshes the two AI-owned display fields. Tenant-scoped by user_id; returns
// the merged attribute column so the caller can reflect it to the client.
// Best-effort — never throws into the extract response path.
async function persistCanonicalAttributes(args: {
  userId: string;
  itemId: string;
  extraction: ExtractionResult;
}): Promise<{ attributes: Record<string, string | string[]> }> {
  const { userId, itemId, extraction } = args;
  const { data: item } = await supabaseAdmin
    .from("inventory_items")
    .select("id, user_id, attributes, ai_field_sources")
    .eq("id", itemId)
    .eq("user_id", userId)
    .single();
  if (!item || (item as { user_id: string }).user_id !== userId) {
    return { attributes: {} };
  }

  const existing =
    ((item as { attributes?: unknown }).attributes &&
      typeof (item as { attributes?: unknown }).attributes === "object"
      ? (item as { attributes: Record<string, string | string[]> }).attributes
      : {}) as Record<string, string | string[]>;
  const aiSources =
    ((item as { ai_field_sources?: unknown }).ai_field_sources as Record<
      string,
      unknown
    >) ?? {};

  // US-1529: the research identification persists alongside the extracted
  // attributes (identified_style / product_line / fabric_technology / msrp)
  // so AutoLister generation + the aspects pass can consume it later without
  // re-running AI. Empty map when no identification — unchanged behavior.
  const allSuggestions = {
    ...extraction.attributes,
    ...researchAttributeSuggestions(extraction.research),
  };
  const suggested = attributesToColumn(allSuggestions);
  const merged: Record<string, string | string[]> = { ...existing };
  let attributesChanged = false;
  for (const [key, value] of Object.entries(suggested)) {
    // Gap-fill only — never clobber an existing (likely user-entered) value.
    const cur = existing[key];
    const isEmpty =
      cur === undefined ||
      cur === null ||
      (Array.isArray(cur) ? cur.length === 0 : String(cur).trim() === "");
    if (!isEmpty) continue;
    merged[key] = value;
    const sug: AttributeSuggestion | undefined = allSuggestions[key];
    aiSources[key] = {
      source: sug?.source ?? "ai",
      confidence: sug?.confidence ?? 0,
      accepted: true,
    };
    attributesChanged = true;
  }

  const update: Record<string, unknown> = {};
  if (attributesChanged) {
    update.attributes = merged;
    update.ai_field_sources = aiSources;
    update.ai_enriched_at = new Date().toISOString();
  }
  // condition_summary / ebay_category_query are AI-owned display fields —
  // refresh them whenever the latest pass produced a value.
  if (extraction.conditionSummary) {
    update.condition_summary = extraction.conditionSummary;
  }
  if (extraction.ebayCategoryQuery) {
    update.ebay_category_query = extraction.ebayCategoryQuery;
  }

  if (Object.keys(update).length > 0) {
    await supabaseAdmin
      .from("inventory_items")
      .update(update)
      .eq("id", itemId)
      .eq("user_id", userId);
  }
  return { attributes: merged };
}

// Item photos as typed { url, type } pairs, each resolved to a URL that is
// actually fetchable: public for listing imagery, a short-TTL signed URL for the
// private-bucket sensitive types (tag / tag_2 / certificate) an iOS capture
// writes. Hardcoding the public bucket here silently dropped the tag photo from
// every AI pass on an iOS-sourced item (US-2265).
async function loadItemPhotos(itemId: string): Promise<ExtractPhoto[]> {
  const { data } = await supabaseAdmin
    .from("item_photos")
    .select("photo_type, photo_role, storage_path, photo_url")
    .eq("inventory_item_id", itemId);
  const resolved = await itemPhotoAiUrls(
    (data ?? []) as ItemPhotoUrlRow[],
  );
  return resolved.map(({ row, url }) => ({
    url,
    type: row.photo_type ?? undefined,
    // US-2471: the qualifier that says which tag is the brand and which is the
    // size. Absent on every pre-00587 row, which reads as "unqualified tag".
    role: (row as { photo_role?: string | null }).photo_role ?? undefined,
  }));
}

// US-1088: Size AI — best-guess a missing/cut-off size (and gender/department)
// from the item's photos, prioritizing measurement / flat-lay shots, compared
// against the brand's sizing. One AI action; tenant-scoped to the item owner.
flipdeskAiRoutes.post("/size", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { item_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = typeof body.item_id === "string" ? body.item_id : null;
  if (!itemId) return c.json({ error: "item_id is required" }, 400);

  // Ownership + context (tenant-scoped — US-268: service-role bypasses RLS).
  const { data: itemRow, error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .select("id, brand, item_category")
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  if (itemErr) {
    console.error("[flipdesk-ai] size item lookup failed:", itemErr.message);
    return c.json({ error: "Lookup failed" }, 500);
  }
  if (!itemRow) return c.json({ error: "Item not found" }, 404);
  const item = itemRow as {
    id: string;
    brand: string | null;
    item_category: string | null;
  };

  const photos = (await loadItemPhotos(itemId)).slice(0, MAX_PHOTOS);
  if (photos.length === 0) {
    return c.json(
      {
        error:
          "Add at least one photo (a measurement or flat-lay shot works best) before estimating size.",
      },
      400,
    );
  }

  // Enablement + monthly cap, then reserve atomically before the billable call.
  const quota = await checkQuota(userId);
  if (!quota.ok) return c.json(quota.body, quota.status);
  const { limit } = quota;
  if (!(await reserveAiAction(userId, limit))) {
    return c.json(QUOTA_EXHAUSTED_429, 429);
  }

  const start = Date.now();
  let estimate;
  try {
    estimate = await estimateSize({
      photos,
      brand: item.brand,
      category: item.item_category,
    });
  } catch (err) {
    await refundAiAction(userId);
    console.error(
      "[flipdesk-ai] size estimate failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json(
      { error: "Size AI is temporarily unavailable. Please try again in a moment." },
      502,
    );
  }
  const latencyMs = Date.now() - start;

  const costUsd = estimateCost(estimate.model, estimate.tokensIn, estimate.tokensOut);
  const { error: logErr } = await supabaseAdmin.from("ai_enrichment_log").insert({
    user_id: userId,
    inventory_item_id: itemId,
    model: estimate.model,
    input_kind: "photo",
    tokens_in: estimate.tokensIn,
    tokens_out: estimate.tokensOut,
    cost_usd: costUsd,
    latency_ms: latencyMs,
    suggested_fields: {
      size: estimate.size,
      gender: estimate.gender,
      confidence: estimate.confidence,
    },
  });
  if (logErr) {
    console.error("[flipdesk-ai] size log write failed:", logErr.message);
  }

  return c.json({
    size: estimate.size,
    gender: estimate.gender,
    confidence: estimate.confidence,
    rationale: estimate.rationale,
    low_confidence: estimate.confidence < SIZE_ESTIMATE_LOW_CONFIDENCE,
  });
});

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

  // US-387: reserve the action atomically before spending it.
  if (!(await reserveAiAction(userId, quota.limit))) {
    return c.json(QUOTA_EXHAUSTED_429, 429);
  }

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
    await refundAiAction(userId);
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
  // Action already reserved atomically above (US-387).

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
 * POST /rewrite
 * Body: { item_id, action, title?, description? }. Rewrites a single listing
 * field (title or description) per a fixed reseller action — SEO punch-up,
 * shorten-to-80, add buyer keywords, tighten, or regenerate-from-photos
 * (US-552). Returns the suggestion in the same shape as /extract so the
 * composer can reuse AiFillPanel (accept-all, confidence, acceptance logging).
 */
flipdeskAiRoutes.post("/rewrite", async (c) => {
  // Re-bind userId to the active workspace owner. For solo users this is
  // identical to the caller's id; for a member acting in someone else's
  // workspace, all reads/writes/quota lookups must target the owner.
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: {
    item_id?: unknown;
    action?: unknown;
    title?: unknown;
    description?: unknown;
    // US-2677: the near-duplicate titles the rewrite should move away from.
    conflicting_titles?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = typeof body.item_id === "string" ? body.item_id : null;
  if (!itemId) return c.json({ error: "item_id is required" }, 400);
  if (!isRewriteAction(body.action)) {
    return c.json({ error: "Unknown rewrite action" }, 400);
  }
  const action = body.action;
  const field = rewriteField(action);
  const title = typeof body.title === "string" ? body.title : "";
  const description =
    typeof body.description === "string" ? body.description : "";

  // The text actions need their source field to actually contain text; the
  // photo regenerate is the only one that can run on an empty description.
  if (field === "title" && !title.trim()) {
    return c.json({ error: "Add a title before rewriting it." }, 400);
  }
  if (action === "description_tighten" && !description.trim()) {
    return c.json(
      { error: "Add a description before tightening it." },
      400
    );
  }

  const quota = await checkQuota(userId);
  if (!quota.ok) return c.json(quota.body, quota.status);

  // Tenant-scoped ownership check before touching anything billable.
  const { data: item } = await supabaseAdmin
    .from("inventory_items")
    .select(
      "id, user_id, title, brand, style, size, color, material, item_category, condition_notes"
    )
    .eq("id", itemId)
    .single();
  if (!item || item.user_id !== userId) {
    return c.json({ error: "Item not found" }, 404);
  }

  const photos =
    action === "description_regen" ? await loadItemPhotos(itemId) : [];

  // US-387: reserve the action atomically before spending it.
  if (!(await reserveAiAction(userId, quota.limit))) {
    return c.json(QUOTA_EXHAUSTED_429, 429);
  }

  const start = Date.now();
  let result;
  try {
    result = await rewriteListingCopy({
      action,
      title,
      description,
      // US-2677. Taken from the request rather than re-derived here on purpose:
      // the composer already holds the findings from /listings/validate, and a
      // second lookup would let the two disagree about which listing is the
      // conflict. Bounded and sanitized downstream, and there is no id in it to
      // act on -- it can only influence wording.
      conflictingTitles: Array.isArray(body.conflicting_titles)
        ? body.conflicting_titles.filter((t): t is string => typeof t === "string")
        : undefined,
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
      photos,
    });
  } catch (err) {
    await refundAiAction(userId);
    console.error(
      "[flipdesk-ai] rewrite failed:",
      err instanceof Error ? err.message : String(err)
    );
    return c.json(
      { error: "AI rewrite is temporarily unavailable." },
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
      suggested_fields: { [result.field]: result.value },
    })
    .select("id")
    .single();
  // Action already reserved atomically above (US-387).

  const actionsRemaining =
    quota.limit === -1 ? -1 : Math.max(0, quota.limit - quota.used - 1);
  // Shape matches AiExtractResponse so the web composer can drop the result
  // straight into AiFillPanel (US-552).
  return c.json({
    suggestions: {
      [result.field]: {
        value: result.value,
        confidence: result.confidence,
        source: `ai:${action}`,
      },
    },
    condition_summary: null,
    conflicts: [],
    measurements: null,
    model: result.model,
    log_id: logRow?.id ?? null,
    actions_remaining: actionsRemaining,
    ebay: null,
  });
});

/**
 * US-2817: push a re-identified item value through to the titles that quote
 * it. Runs the same orchestration the three web save paths use
 * (buildTitleSyncPatch): an eBay-origin listing is refused outright because
 * eBay owns its title, both A/B variants move together, and a title the
 * seller hand-edited or that buyers are already looking at is FLAGGED rather
 * than silently rewritten.
 *
 * No-ops when the write changed no syncable field, which is every gap-fill
 * run — filling a blank leaves nothing in the title to substitute.
 */
async function syncListingTitles(
  itemId: string,
  userId: string,
  before: Record<string, unknown>,
  update: Record<string, unknown>,
): Promise<void> {
  const after = { ...before, ...update };
  const changes = changesFromItemDiff(before, after);
  if (changes.length === 0) return;

  // Tenant-scoped through the parent item (US-268): the id came from an
  // ownership-verified row, and the filter is repeated here rather than
  // trusted, because this runs on the service-role client.
  const { data: listings } = await supabaseAdmin
    .from("listings")
    .select(
      "id, listing_title, title_variants, ai_generated_snapshot, listing_origin, listing_status, is_active",
    )
    .eq("inventory_item_id", itemId)
    .eq("user_id", userId);

  for (const row of (listings ?? []) as Array<{
    id: string;
    listing_title: string | null;
    title_variants: unknown;
    ai_generated_snapshot: { title?: string | null } | null;
    listing_origin: string | null;
    listing_status: string | null;
    is_active: boolean | null;
  }>) {
    const patch = buildTitleSyncPatch({
      baseTitle: row.listing_title,
      variants: row.title_variants,
      changes,
      snapshotTitle: row.ai_generated_snapshot?.title ?? null,
      isLive: row.is_active === true || row.listing_status === "active",
      listingOrigin: row.listing_origin,
    });
    if (Object.keys(patch).length === 0) continue;
    await supabaseAdmin.from("listings").update(patch).eq("id", row.id);
  }
}

/**
 * POST /bulk-extract
 * Body: { item_ids: string[], mode?: "gap_fill" | "reidentify" }.
 *
 * `gap_fill` (the default, and the only behaviour before US-2817) enriches many
 * items: high-confidence values land in EMPTY columns, uncertain ones come back
 * for per-item review, and anything already filled is left alone.
 *
 * `reidentify` re-runs identification on items the AI has already seen — the
 * "my drafts are from three months ago and the model is better now" case. It
 * withholds the AI's own past answers from the prompt and lets a confident new
 * value overwrite an AI-written one; seller-typed values are never overwritten,
 * only surfaced. See lib/reextract-policy.ts for the provenance rules.
 */
flipdeskAiRoutes.post("/bulk-extract", async (c) => {
  // Re-bind userId to the active workspace owner. For solo users this is
  // identical to the caller's id; for a member acting in someone else's
  // workspace, all reads/writes/quota lookups must target the owner.
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: {
    item_ids?: unknown;
    mode?: unknown;
    overwrite_untracked?: unknown;
  };
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
  // Unknown values fall back to gap-fill: an older client that doesn't send the
  // field must keep the behaviour it was written against.
  const mode: ExtractMode = body.mode === "reidentify"
    ? "reidentify"
    : "gap_fill";
  // Opt-in, per run, and only meaningful under reidentify. Drafts made
  // before US-2817 have no per-column provenance, so without this the pass
  // reads every one of their values as seller-typed and corrects nothing --
  // which is the exact stock the feature exists for. The seller turns it on
  // because only they know which of those values they typed themselves.
  const untracked: UntrackedPolicy =
    mode === "reidentify" && body.overwrite_untracked === true
      ? "treat_as_ai"
      : "respect";

  // US-382: bulk extraction is a gated "bulk actions" feature (Pro+). Enforce
  // server-side before spending any AI quota — a Free/Starter caller gets 402
  // FEATURE_LOCKED.
  const bulkGate = await requireFlipdesk(c, { feature: "bulkActions", userId });
  if (bulkGate) return bulkGate;

  const quota = await checkQuota(userId);
  if (!quota.ok) return c.json(quota.body, quota.status);
  // Capture the narrowed value: the `!quota.ok` guard above narrows `quota` to
  // the success variant here, but that narrowing does NOT propagate into the
  // nested processItem() closure below, so read `quota.limit` once into a local
  // (mirrors the `const { limit, used } = quota` pattern used elsewhere).
  const quotaLimit = quota.limit;

  // Clamp the batch to what the monthly allowance permits.
  const remaining =
    quotaLimit === -1 ? itemIds.length : quotaLimit - quota.used;
  const toProcess = itemIds.slice(0, Math.max(0, remaining));
  const skipped = itemIds.slice(toProcess.length);

  const AUTO_APPLY_CONFIDENCE = 0.85;
  const results: {
    item_id: string;
    status: "enriched" | "needs_review" | "failed";
    applied: string[];
    pending: string[];
    /** Subset of `applied` that OVERWROTE an earlier AI value (US-2817). */
    replaced: string[];
    reason?: string;
  }[] = [];

  async function processItem(itemId: string) {
    try {
      const { data: item } = await supabaseAdmin
        .from("inventory_items")
        .select(
          "id, user_id, title, brand, style, size, color, material, item_category, description, condition_notes, ai_field_sources, attributes"
        )
        .eq("id", itemId)
        .single();
      if (!item || item.user_id !== userId) {
        results.push({
          item_id: itemId,
          status: "failed",
          applied: [],
          pending: [],
          replaced: [],
          reason: "Item not found",
        });
        return;
      }

      // US-387: reserve this item's action atomically. If the cap is reached
      // (including by a concurrent batch), skip it rather than processing for
      // free — reserve_ai_action is the single enforcement point across batches.
      if (!(await reserveAiAction(userId, quotaLimit))) {
        results.push({
          item_id: itemId,
          status: "failed",
          applied: [],
          pending: [],
          replaced: [],
          reason: "Monthly AI limit reached",
        });
        return;
      }

      const photos = await loadItemPhotos(itemId);
      // US-2817: provenance is read BEFORE the prompt is built, not just
      // before the write. In re-identify mode it decides what the model is
      // allowed to SEE as well as what it is allowed to overwrite.
      const aiSources =
        (item.ai_field_sources as Record<string, unknown>) ?? {};
      const text = buildExtractText(
        {
          title: item.title,
          description: item.description,
          conditionNotes: item.condition_notes,
        },
        photos.length > 0,
        mode,
      );
      const known = buildKnownFields(
        item as unknown as Record<string, unknown>,
        ENRICHABLE_COLUMNS,
        aiSources,
        mode,
        untracked,
      );

      const start = Date.now();
      const extraction = await extractItemFields({
        text: text || undefined,
        photos,
        knownFields: known,
      });
      const latencyMs = Date.now() - start;

      const update: Record<string, unknown> = {};
      const applied: string[] = [];
      const pending: string[] = [];
      const replaced: string[] = [];
      const conflictFields = new Set(
        extraction.conflicts.map((cf) => cf.field)
      );

      for (const [field, sug] of Object.entries(extraction.suggestions)) {
        if (!(ENRICHABLE_COLUMNS as readonly string[]).includes(field)) {
          continue;
        }
        // Gap-fill writes only into empty columns. Re-identify may also
        // write over a value an earlier AI pass put there, never over one
        // the seller typed - that comes back as `pending` (US-2817).
        const decision = decideField({
          current: (item as Record<string, unknown>)[field],
          suggested: sug.value,
          confidence: sug.confidence,
          autoApplyConfidence: AUTO_APPLY_CONFIDENCE,
          conflicted: conflictFields.has(field),
          aiOwned: isAiOwned(aiSources, field, untracked),
          mode,
        });
        if (decision === "skip") continue;
        if (decision === "pending") {
          pending.push(field);
          continue;
        }
        update[field] = sug.value;
        aiSources[field] = {
          source: sug.source,
          confidence: sug.confidence,
          accepted: true,
        };
        applied.push(field);
        if (decision === "replace") replaced.push(field);
      }

      // US-821: gap-fill canonical attributes (existing/user values win) and
      // refresh the AI-owned display fields in the same write.
      const existingAttrs =
        ((item as { attributes?: unknown }).attributes &&
          typeof (item as { attributes?: unknown }).attributes === "object"
          ? (item as { attributes: Record<string, string | string[]> })
              .attributes
          : {}) as Record<string, string | string[]>;
      // US-1529: research identification persists with the attributes here too.
      const allAttrSuggestions = {
        ...extraction.attributes,
        ...researchAttributeSuggestions(extraction.research),
      };
      const suggestedAttrs = attributesToColumn(allAttrSuggestions);
      const mergedAttrs: Record<string, string | string[]> = {
        ...existingAttrs,
      };
      let attributesChanged = false;
      for (const [key, value] of Object.entries(suggestedAttrs)) {
        const cur = existingAttrs[key];
        // US-2817: the SAME FUNCTION the columns above use, not a second copy
        // of the same rule. Gap-fill only fills blanks; re-identify may also
        // refresh an attribute a prior AI pass wrote, and never touches one
        // the seller set.
        const decision = decideAttribute({
          current: cur,
          suggested: value,
          aiOwned: isAiOwned(aiSources, key, untracked),
          mode,
        });
        if (decision === "skip") continue;
        if (decision === "replace") replaced.push(key);
        mergedAttrs[key] = value;
        const sug = allAttrSuggestions[key];
        aiSources[key] = {
          source: sug?.source ?? "ai",
          confidence: sug?.confidence ?? 0,
          accepted: true,
        };
        applied.push(key);
        attributesChanged = true;
      }
      if (attributesChanged) update.attributes = mergedAttrs;
      if (extraction.conditionSummary) {
        update.condition_summary = extraction.conditionSummary;
      }
      if (extraction.ebayCategoryQuery) {
        update.ebay_category_query = extraction.ebayCategoryQuery;
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
      // Action already reserved atomically at the top of processItem (US-387).

      if (applied.length > 0) {
        update.ai_field_sources = aiSources;
        update.ai_enriched_at = new Date().toISOString();
      }
      if (Object.keys(update).length > 0) {
        await supabaseAdmin
          .from("inventory_items")
          .update(update)
          .eq("id", itemId)
          .eq("user_id", userId);
      }

      // US-2817: a REPLACED brand/size/color/style leaves the listing title
      // saying the old one, and the title is the field buyers search
      // hardest. Gap-fill never hit this (the old value was blank, so the
      // substitution was a no-op), which is why no edge writer carried the
      // sync before. Best-effort: a title that does not move must never cost
      // the seller a correctly re-identified item.
      try {
        await syncListingTitles(itemId, userId, item as Record<string, unknown>, update);
      } catch (err) {
        console.error(
          "[flipdesk-ai] bulk-extract title sync failed:",
          err instanceof Error ? err.message : String(err),
        );
      }

      results.push({
        item_id: itemId,
        status: pending.length > 0 ? "needs_review" : "enriched",
        applied,
        pending,
        replaced,
      });
    } catch (err) {
      // US-387: the action was reserved before the AI call — refund it so a
      // failed item doesn't permanently consume quota.
      await refundAiAction(userId);
      results.push({
        item_id: itemId,
        status: "failed",
        applied: [],
        pending: [],
        replaced: [],
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
      // US-2817: how many fields this run OVERWROTE (always 0 in gap-fill).
      // The seller-facing question after a re-identify is "did anything
      // actually change?", and applied-count alone cannot answer it.
      replaced: results.reduce((n, r) => n + r.replaced.length, 0),
    },
    mode,
    overwrite_untracked: untracked === "treat_as_ai",
    results,
    skipped,
  });
});

/**
 * PATCH /log/:id
 * Records which suggested fields the user accepted (US-167 acceptance rate) and,
 * for fields they EDITED, what they changed the AI value TO (US-1531 extraction
 * correction-capture). Body: { accepted_fields?: Record<string,unknown>,
 * corrected_fields?: Record<string,{suggested,final}> }
 */
flipdeskAiRoutes.patch("/log/:id", async (c) => {
  // Re-bind userId to the active workspace owner. For solo users this is
  // identical to the caller's id; for a member acting in someone else's
  // workspace, all reads/writes/quota lookups must target the owner.
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");

  let body: { accepted_fields?: unknown; corrected_fields?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const acceptedFields =
    body.accepted_fields && typeof body.accepted_fields === "object"
      ? (body.accepted_fields as Record<string, unknown>)
      : {};

  const update: Record<string, unknown> = { accepted_fields: acceptedFields };
  // US-1531: only set corrected_fields when the caller supplies a plain object,
  // so a PATCH that carries only acceptances never clobbers prior corrections.
  if (
    body.corrected_fields &&
    typeof body.corrected_fields === "object" &&
    !Array.isArray(body.corrected_fields)
  ) {
    update.corrected_fields = body.corrected_fields as Record<string, unknown>;
  }

  const { error } = await supabaseAdmin
    .from("ai_enrichment_log")
    .update(update)
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

  // US-387: reserve the action atomically before spending it.
  if (!(await reserveAiAction(userId, quota.limit))) {
    return c.json(QUOTA_EXHAUSTED_429, 429);
  }

  try {
    const groups = await groupSimilarPhotos(images);
    const pairs = groupsToPairs(groups, ids);
    // Action already reserved atomically above (US-387).
    return c.json({ pairs });
  } catch (err) {
    await refundAiAction(userId);
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
      .select("id, storage_path, photo_type, photo_url")
      .eq("inventory_item_id", itemId)
      .order("sort_order", { ascending: true });
    // US-2265: resolve each row to a fetchable URL (signed for the private
    // sensitive types) and classify only what resolved — an unresolvable photo
    // would otherwise consume an index in the model's answer and mis-key the
    // classification write-back below.
    const resolved = await itemPhotoAiUrls(
      (rows ?? []) as Array<ItemPhotoUrlRow & { id: string }>,
    );
    const photos = resolved.map(({ row }) => row);
    if (photos.length === 0) return c.json({ classifications: [] });

    const images: VisionImage[] = resolved.map(({ url }) => ({ url }));

    // US-387: reserve the action atomically before the vision call.
    if (!(await reserveAiAction(userId, quota.limit))) {
      return c.json(QUOTA_EXHAUSTED_429, 429);
    }

    let classifications: { id: string; type: string; confidence: number }[];
    try {
      const result = await classifyPhotoTypes(images);
      const byIndex = new Map(result.map((r) => [r.index, r]));
      classifications = photos.map((p, i) => {
        const r = byIndex.get(i);
        return { id: p.id, type: r?.type ?? "detail", confidence: r?.confidence ?? 0 };
      });
    } catch {
      // Classification failed → refund the reserved action and fall back to
      // 'detail' rather than blocking the commit (US-387).
      await refundAiAction(userId);
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
    // Action already reserved atomically above (US-387).
    return c.json({ classifications });
  }

  // Mode B: classify caller-supplied inline images (pre-commit).
  const { ids, images } = parseVisionPhotos(body);
  if (images.length === 0) return c.json({ classifications: [] });
  if (images.length > 40) {
    return c.json({ error: "Too many photos in one batch (max 40)." }, 400);
  }
  // US-387: reserve the action atomically before the vision call.
  if (!(await reserveAiAction(userId, quota.limit))) {
    return c.json(QUOTA_EXHAUSTED_429, 429);
  }
  try {
    const result = await classifyPhotoTypes(images);
    const byIndex = new Map(result.map((r) => [r.index, r]));
    const classifications = ids.map((id, i) => {
      const r = byIndex.get(i);
      return { id, type: r?.type ?? "detail", confidence: r?.confidence ?? 0 };
    });
    // Action already reserved atomically above (US-387).
    return c.json({ classifications });
  } catch {
    await refundAiAction(userId);
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

  // US-387: reserve the action atomically before spending it.
  if (!(await reserveAiAction(userId, quota.limit))) {
    return c.json(QUOTA_EXHAUSTED_429, 429);
  }

  try {
    const hints = await extractMatchHints(images);
    // Action already reserved atomically above (US-387).
    return c.json(hints);
  } catch (err) {
    await refundAiAction(userId);
    return c.json(
      { error: "Suggestion failed", detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

/**
 * POST /negotiate  (US-1168)
 * Body: { item_id, mode: "counter" | "reply", offer_price?, currency?,
 *         buyer_message?, proposed_counter? }
 *
 * Drafts a buyer-facing counter or reply (reuses the ListingCopyService edge
 * pattern) AND runs the pure counter-offer validator against the buyer's offer,
 * the item's asking price (target_price) and cost (acquired_price). Returns a
 * safe suggested counter + any out-of-range warnings so the negotiation sheet
 * never counters below cost or at/below the offer.
 */
flipdeskAiRoutes.post("/negotiate", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: {
    item_id?: unknown;
    mode?: unknown;
    offer_price?: unknown;
    currency?: unknown;
    buyer_message?: unknown;
    proposed_counter?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const itemId = typeof body.item_id === "string" ? body.item_id : null;
  if (!itemId) return c.json({ error: "item_id is required" }, 400);
  const mode: NegotiationMode = body.mode === "reply" ? "reply" : "counter";
  const offerPrice =
    typeof body.offer_price === "number" && Number.isFinite(body.offer_price)
      ? body.offer_price
      : null;
  const currency =
    typeof body.currency === "string" && body.currency.trim()
      ? body.currency.trim()
      : "USD";
  const buyerMessage =
    typeof body.buyer_message === "string" ? body.buyer_message : null;
  const proposedCounter =
    typeof body.proposed_counter === "number" &&
    Number.isFinite(body.proposed_counter)
      ? body.proposed_counter
      : null;

  const quota = await checkQuota(userId);
  if (!quota.ok) return c.json(quota.body, quota.status);

  // Tenant-scoped item load (US-268): title for the draft, target_price as the
  // asking price and acquired_price as cost for the validator.
  const { data: item } = await supabaseAdmin
    .from("inventory_items")
    .select("id, user_id, title, target_price, acquired_price")
    .eq("id", itemId)
    .single();
  if (!item || item.user_id !== userId) {
    return c.json({ error: "Item not found" }, 404);
  }

  // Pure guardrail — runs even when offer_price is missing (suggestedCounter
  // is simply null then).
  const validation = validateCounterOffer(
    {
      offerPrice: offerPrice ?? 0,
      askingPrice:
        typeof item.target_price === "number" ? item.target_price : null,
      costBasis:
        typeof item.acquired_price === "number" ? item.acquired_price : null,
    },
    proposedCounter,
  );

  // US-387: reserve atomically before the billable AI call.
  if (!(await reserveAiAction(userId, quota.limit))) {
    return c.json(QUOTA_EXHAUSTED_429, 429);
  }

  const start = Date.now();
  let draft;
  try {
    draft = await generateNegotiationReply({
      mode,
      itemTitle: item.title ?? null,
      offerPrice,
      currency,
      buyerMessage,
      suggestedCounter: mode === "counter" ? validation.suggestedCounter : null,
    });
  } catch (err) {
    await refundAiAction(userId);
    console.error(
      "[flipdesk-ai] negotiation draft failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json(
      { error: "AI negotiation assist is temporarily unavailable." },
      502,
    );
  }
  const latencyMs = Date.now() - start;
  const costUsd = estimateCost(draft.model, draft.tokensIn, draft.tokensOut);

  const { data: logRow } = await supabaseAdmin
    .from("ai_enrichment_log")
    .insert({
      user_id: userId,
      inventory_item_id: itemId,
      model: draft.model,
      input_kind: "text",
      tokens_in: draft.tokensIn,
      tokens_out: draft.tokensOut,
      cost_usd: costUsd,
      latency_ms: latencyMs,
      suggested_fields: { negotiation_message: draft.message },
    })
    .select("id")
    .single();

  const actionsRemaining =
    quota.limit === -1 ? -1 : Math.max(0, quota.limit - quota.used - 1);
  return c.json({
    message: draft.message,
    suggested_counter: validation.suggestedCounter,
    warnings: validation.warnings,
    below_cost: validation.belowCost,
    at_or_below_offer: validation.atOrBelowOffer,
    above_asking: validation.aboveAsking,
    model: draft.model,
    log_id: logRow?.id ?? null,
    actions_remaining: actionsRemaining,
  });
});

/**
 * POST /analytics-narrative  (US-1169)
 * Body: { period_label, gross_revenue, fees, cogs, units_sold,
 *         sell_through_rate?, grading_roi_lift?, top_brand?, currency? }
 *
 * The client computes its period rollups locally (PeriodPnL etc.) and posts the
 * numbers; this turns them into a plain-language summary + highlights + next
 * actions. No item is read, so there's no per-item ownership check — the
 * numbers are supplied by the authenticated caller and only the AI quota gates.
 */
flipdeskAiRoutes.post("/analytics-narrative", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: {
    period_label?: unknown;
    gross_revenue?: unknown;
    fees?: unknown;
    cogs?: unknown;
    units_sold?: unknown;
    sell_through_rate?: unknown;
    grading_roi_lift?: unknown;
    top_brand?: unknown;
    currency?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const periodLabel =
    typeof body.period_label === "string" && body.period_label.trim()
      ? body.period_label.trim()
      : "this period";

  const quota = await checkQuota(userId);
  if (!quota.ok) return c.json(quota.body, quota.status);

  const metrics = deriveAnalyticsMetrics({
    periodLabel,
    grossRevenue: Number(body.gross_revenue),
    fees: Number(body.fees),
    cogs: Number(body.cogs),
    unitsSold: Number(body.units_sold),
    sellThroughRate:
      body.sell_through_rate == null ? null : Number(body.sell_through_rate),
    gradingRoiLift:
      body.grading_roi_lift == null ? null : Number(body.grading_roi_lift),
    topBrand: typeof body.top_brand === "string" ? body.top_brand : null,
    currency: typeof body.currency === "string" ? body.currency : null,
  });

  // Nothing sold and no revenue → narrating an empty period wastes an AI action.
  if (metrics.unitsSold === 0 && metrics.grossRevenue === 0) {
    return c.json({
      summary:
        "No sales recorded for this period yet — once items sell, you'll get a trend summary here.",
      highlights: [],
      actions: ["List or relist items to start generating sales data."],
      model: null,
      log_id: null,
      actions_remaining: quota.limit === -1 ? -1 : Math.max(0, quota.limit - quota.used),
    });
  }

  // US-387: reserve atomically before the billable AI call.
  if (!(await reserveAiAction(userId, quota.limit))) {
    return c.json(QUOTA_EXHAUSTED_429, 429);
  }

  const start = Date.now();
  let narrative;
  try {
    narrative = await generateAnalyticsNarrative(metrics);
  } catch (err) {
    await refundAiAction(userId);
    console.error(
      "[flipdesk-ai] analytics narrative failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json(
      { error: "AI analytics summary is temporarily unavailable." },
      502,
    );
  }
  const latencyMs = Date.now() - start;
  const costUsd = estimateCost(
    narrative.model,
    narrative.tokensIn,
    narrative.tokensOut,
  );

  const { data: logRow } = await supabaseAdmin
    .from("ai_enrichment_log")
    .insert({
      user_id: userId,
      inventory_item_id: null,
      model: narrative.model,
      input_kind: "text",
      tokens_in: narrative.tokensIn,
      tokens_out: narrative.tokensOut,
      cost_usd: costUsd,
      latency_ms: latencyMs,
      suggested_fields: {
        analytics_summary: narrative.summary,
        analytics_highlights: narrative.highlights,
        analytics_actions: narrative.actions,
      },
    })
    .select("id")
    .single();

  const actionsRemaining =
    quota.limit === -1 ? -1 : Math.max(0, quota.limit - quota.used - 1);
  return c.json({
    summary: narrative.summary,
    highlights: narrative.highlights,
    actions: narrative.actions,
    model: narrative.model,
    log_id: logRow?.id ?? null,
    actions_remaining: actionsRemaining,
  });
});
