// ScoutAI — the Condition Arbitrage Engine (US-615/616/617/619/620).
//
// "Grade what you don't own": a power seller pastes an eBay keyword/category
// search; ScoutAI grades each candidate listing from its OWN public photos
// (a private shadow grade — US-616), values it at that condition (US-610), and
// ranks by condition-adjusted margin (US-617) so "underpriced for its
// condition" deals rise to the top.
//
// Guardrails (US-620): shadow grades are PRIVATE to the requesting tenant — we
// never publish them or re-label the seller's listing; results are clearly an
// ESTIMATE, not a GradeThread certificate. Paid feature (compPulls gate, US-619)
// with atomic AI-quota reservation per candidate and a bounded candidate cap.
// Search uses the eBay APP token, so no user eBay connection is required.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { checkQuota } from "./flipdesk-ai.ts";
import { searchBrowseComps } from "../lib/ebay-client.ts";
import { quickGrade } from "../lib/quick-grade.ts";
import {
  valueAtGrade,
  valueRangeFromStats,
  type ValueRange,
} from "../lib/condition-value.ts";
import { gradeToConditionId } from "../lib/repricing.ts";
import { forecastSellThrough } from "../lib/sell-through.ts";
import { decideBuy } from "../lib/scout-decision.ts";
import {
  rankCandidates,
  scoreCandidate,
  type ScoutCandidate,
} from "../lib/scout-scoring.ts";
import { failSafe, jsonError } from "../lib/http-errors.ts";
import { captureException, recordMetric } from "../lib/observability.ts";

export const flipdeskScoutRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

// Hard cap on candidates graded per scan — bounds AI cost + eBay fan-out.
const MAX_CANDIDATES = 8;

flipdeskScoutRoutes.post("/", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  // US-619: ScoutAI is a paid pro feature. compPulls unlocks on pro+ — the same
  // gate as condition-comp access, which is exactly what ScoutAI does.
  const gate = await requireFlipdesk(c, { feature: "compPulls", userId });
  if (gate) return gate;

  let body: { categoryId?: unknown; q?: unknown; brand?: unknown; limit?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const categoryId = typeof body.categoryId === "string" ? body.categoryId.trim() : "";
  const q = typeof body.q === "string" ? body.q.trim() : undefined;
  const brand = typeof body.brand === "string" ? body.brand.trim() : undefined;
  const requested = typeof body.limit === "number" ? body.limit : MAX_CANDIDATES;
  const limit = Math.min(Math.max(requested, 1), MAX_CANDIDATES);
  if (!categoryId) {
    return jsonError(c, 400, "categoryId is required (with an optional q/brand to narrow the search)");
  }
  if (!q && !brand) {
    return jsonError(c, 400, "Provide a keyword (q) and/or brand to search");
  }

  // US-619: AI gate — enabled + within the monthly cap (whose plan = the owner's).
  const quota = await checkQuota(userId);
  if (!quota.ok) {
    return c.json(quota.body, quota.status);
  }

  // US-615: ingest candidate listings via the public Browse search.
  let candidates: ScoutCandidate[];
  try {
    const search = await searchBrowseComps({ categoryId, q, brand, limit });
    candidates = search.items
      .filter((i) => i.itemId)
      .map((i) => ({
        itemId: i.itemId,
        title: i.title,
        imageUrl: i.imageUrl,
        itemWebUrl: i.itemWebUrl,
        askingCents: i.price != null && i.price > 0 ? Math.round(i.price * 100) : null,
      }));
  } catch (err) {
    return failSafe(c, 502, "Couldn't reach eBay to search candidates. Try again shortly.", err, "scout.search");
  }

  if (candidates.length === 0) {
    return c.json({ candidates: [], scanned: 0, note: "No candidate listings matched that search." });
  }

  const scored = [];
  let graded = 0;
  for (const cand of candidates) {
    if (!cand.imageUrl) continue; // need a photo to shadow-grade

    // US-619: atomically reserve one AI action; stop cleanly when the cap is hit.
    const { data: reserved } = await supabaseAdmin.rpc("reserve_ai_action", {
      p_user_id: userId,
      p_limit: quota.limit,
    });
    if (reserved !== true) break;

    try {
      // US-616: PRIVATE shadow grade from the listing's own photo.
      const grade = await quickGrade({
        images: [{ url: cand.imageUrl, type: "front" }],
        garment: { brand: brand ?? null, title: cand.title },
      });
      // US-610: condition-adjusted value at that grade, same search identity.
      const value = await valueAtGrade({ categoryId, q, brand }, grade.overallScore);
      // US-617: score by condition-adjusted margin.
      scored.push(scoreCandidate(cand, grade.overallScore, grade.confidence, value));
      graded += 1;
    } catch (err) {
      // Refund the reserved action on failure so a transient error isn't billed.
      await supabaseAdmin.rpc("refund_ai_action", { p_user_id: userId }).then(() => {}, () => {});
      captureException(err, { level: "warn", route: "scout.grade", extra: { itemId: cand.itemId } });
    }
  }

  recordMetric("scout.scan", graded, { actionable: String(scored.filter((s) => s.actionable).length) });

  return c.json({
    scanned: graded,
    candidates: rankCandidates(scored),
    // US-620: be explicit about what this is.
    disclaimer:
      "Shadow grades are private estimates from the listing's photos — not a GradeThread certificate, and not visible to the seller. Verify condition before buying.",
  });
});

// ── US-592: Scout / buy-decision mode ───────────────────────────────────────
//
// The in-field, single-item side of Scout. A reseller standing in a thrift aisle
// snaps a PHOTO (or scans a BARCODE) of an item they're considering and gets an
// instant buy / maybe / skip BEFORE they buy — condition signal, condition-
// adjusted resale range, sell-through forecast, and ROI/breakeven at the price
// they'd pay. This extends the FlipDesk pipeline upstream of "sourced" (the
// already-bought start): on "buy", /buy creates the inventory item at `sourced`.

// Max image bytes we'll accept inline (data URI) for an appraisal. quick-grade
// caps per-image bytes too; this bounds the request body up front.
const MAX_APPRAISE_IMAGE_BYTES = 12 * 1024 * 1024;

flipdeskScoutRoutes.post("/appraise", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  // Same paid gate + AI quota as the scan: appraising runs the AI grader.
  const gate = await requireFlipdesk(c, { feature: "compPulls", userId });
  if (gate) return gate;

  let body: {
    image?: unknown;
    barcode?: unknown;
    q?: unknown;
    brand?: unknown;
    categoryId?: unknown;
    size?: unknown;
    costCents?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  const image = typeof body.image === "string" && body.image.length > 0
    ? body.image
    : null;
  const barcode = typeof body.barcode === "string" ? body.barcode.trim() : "";
  const q = typeof body.q === "string" ? body.q.trim() : "";
  const brand = typeof body.brand === "string" ? body.brand.trim() : "";
  const categoryId = typeof body.categoryId === "string"
    ? body.categoryId.trim()
    : "";
  const size = typeof body.size === "string" ? body.size.trim() : "";
  const costCents = typeof body.costCents === "number" && body.costCents > 0
    ? Math.round(body.costCents)
    : null;

  if (image && image.length > MAX_APPRAISE_IMAGE_BYTES * 1.4) {
    // base64 inflates bytes ~1.37x; reject obviously-oversized payloads early.
    return jsonError(c, 413, "Image is too large — use a photo under 12 MB.");
  }
  // Need SOMETHING to value against: a barcode, a keyword, or an eBay category.
  if (!barcode && !q && !categoryId) {
    return jsonError(
      c,
      400,
      "Provide a photo plus at least one of: barcode, a keyword (q), or an eBay category.",
    );
  }

  const quota = await checkQuota(userId);
  if (!quota.ok) {
    return c.json(quota.body, quota.status);
  }

  // 1) Private shadow grade from the photo (US-616 primitive). Barcode-only
  //    appraisals skip grading and value at the default "used" condition.
  let shadowGrade: number | null = null;
  let gradeConfidence = 0;
  let gradeTier: string | null = null;
  let needsHumanReview = false;
  let imagesAnalyzed = 0;
  if (image) {
    const { data: reserved } = await supabaseAdmin.rpc("reserve_ai_action", {
      p_user_id: userId,
      p_limit: quota.limit,
    });
    if (reserved !== true) {
      return jsonError(
        c,
        429,
        "Monthly AI action limit reached — upgrade or wait for the reset.",
      );
    }
    try {
      const grade = await quickGrade({
        images: [{ dataUri: image, type: "front" }],
        garment: { brand: brand || null, title: q || undefined },
      });
      shadowGrade = grade.overallScore;
      gradeConfidence = grade.confidence;
      gradeTier = grade.gradeTier;
      needsHumanReview = grade.needsHumanReview;
      imagesAnalyzed = grade.imagesAnalyzed;
    } catch (err) {
      await supabaseAdmin.rpc("refund_ai_action", { p_user_id: userId }).then(
        () => {},
        () => {},
      );
      return failSafe(
        c,
        502,
        "Couldn't grade that photo. Try a clearer, well-lit shot.",
        err,
        "scout.appraise.grade",
      );
    }
  }

  // 2) Condition-adjusted value at that grade, plus a best-effort product title
  //    (from the barcode match) so /buy can prefill the inventory item.
  let value: ValueRange;
  let matchedTitle: string | null = null;
  const matchedCategoryId: string | null = categoryId || null;
  try {
    if (barcode) {
      const search = await searchBrowseComps({
        gtin: barcode,
        categoryId: categoryId || undefined,
        brand: brand || undefined,
        conditionId: gradeToConditionId(shadowGrade),
        limit: 25,
      });
      value = valueRangeFromStats(search.stats, shadowGrade, search.stats.currency);
      matchedTitle = search.items[0]?.title ?? null;
    } else {
      value = await valueAtGrade(
        { categoryId, q: q || undefined, brand: brand || undefined, size: size || undefined },
        shadowGrade,
      );
    }
  } catch (err) {
    return failSafe(
      c,
      502,
      "Couldn't reach eBay to value this item. Try again shortly.",
      err,
      "scout.appraise.value",
    );
  }

  // 3) Sell-through at the condition-adjusted median + the buy/skip verdict.
  const sellThrough = forecastSellThrough(value, value.medianCents ?? 0);
  const decision = decideBuy({
    shadowGrade,
    gradeConfidence,
    value,
    sellThrough,
    costCents,
  });

  recordMetric("scout.appraise", 1, {
    recommendation: decision.recommendation,
    graded: String(imagesAnalyzed > 0),
  });

  return c.json({
    grade: {
      value: shadowGrade,
      tier: gradeTier,
      confidence: gradeConfidence,
      needsHumanReview,
      imagesAnalyzed,
    },
    value,
    sellThrough,
    costCents,
    decision,
    matchedTitle,
    matchedCategoryId,
    disclaimer:
      "This is a private AI estimate from your photo — not a GradeThread certificate. Resale, sell-through, and ROI are estimates from condition-matched eBay comps. Verify condition before buying.",
  });
});

// POST /buy — commit a buy decision into the pipeline by creating the inventory
// item at `sourced` (the existing already-bought start). Tenant-scoped: the row
// is always written under the workspace owner's user_id.
flipdeskScoutRoutes.post("/buy", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  const gate = await requireFlipdesk(c, { feature: "compPulls", userId });
  if (gate) return gate;

  let body: {
    title?: unknown;
    brand?: unknown;
    size?: unknown;
    color?: unknown;
    costCents?: unknown;
    targetCents?: unknown;
    gradeValue?: unknown;
    gradeLabel?: unknown;
    conditionNotes?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return jsonError(c, 400, "title is required");
  const brand = typeof body.brand === "string" && body.brand.trim() ? body.brand.trim() : null;
  const size = typeof body.size === "string" && body.size.trim() ? body.size.trim() : null;
  const color = typeof body.color === "string" && body.color.trim() ? body.color.trim() : null;
  const conditionNotes = typeof body.conditionNotes === "string" && body.conditionNotes.trim()
    ? body.conditionNotes.trim()
    : null;
  const acquiredPrice = typeof body.costCents === "number" && body.costCents > 0
    ? Math.round(body.costCents) / 100
    : null;
  const targetPrice = typeof body.targetCents === "number" && body.targetCents > 0
    ? Math.round(body.targetCents) / 100
    : null;
  const gradeValue = typeof body.gradeValue === "number" && body.gradeValue > 0
    ? Math.round(body.gradeValue * 10) / 10
    : null;
  const gradeLabel = typeof body.gradeLabel === "string" && body.gradeLabel.trim()
    ? body.gradeLabel.trim()
    : null;

  const { data: row, error } = await supabaseAdmin
    .from("inventory_items")
    .insert({
      user_id: userId,
      title,
      brand,
      size,
      color,
      acquired_price: acquiredPrice,
      acquired_date: new Date().toISOString(),
      acquired_source: "scout",
      status: "sourced",
      target_price: targetPrice,
      grade_value: gradeValue,
      grade_label: gradeLabel,
      condition_notes: conditionNotes,
    } as never)
    .select("id")
    .single();

  if (error || !row) {
    return failSafe(
      c,
      500,
      "Couldn't add this item to your inventory.",
      error,
      "scout.buy",
    );
  }

  recordMetric("scout.buy", 1, {});
  return c.json({ id: (row as { id: string }).id, status: "sourced" }, 201);
});
