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
import { refundAiAction, reserveAiActionSafe } from "../lib/ai-metering.ts";
import { searchBrowseComps, suggestCategories } from "../lib/ebay-client.ts";
import { extractMatchHints, type VisionImage } from "../lib/ai-reconcile.ts";
import { quickGrade } from "../lib/quick-grade.ts";
import {
  valueAtGrade,
  valueRangeFromStats,
  type ValueRange,
} from "../lib/condition-value.ts";
import {
  resolveComps,
  SPECULATIVE_CONDITION_ID,
} from "../lib/comp-speculation.ts";
import { forecastSellThrough } from "../lib/sell-through.ts";
import { decideBuy, DECISION_FEE_RATE } from "../lib/scout-decision.ts";
import {
  rankCandidates,
  scoreCandidate,
  type ScoutCandidate,
} from "../lib/scout-scoring.ts";
import {
  EXTENSION_MAX_IMAGES_ANON,
  parseListingImageUrls,
} from "../lib/extension-image-urls.ts";
import { failSafe, jsonError } from "../lib/http-errors.ts";
import { captureException, recordMetric } from "../lib/observability.ts";
import { parseFix } from "../lib/radar-privacy.ts";
import { voidRecordScanLocation } from "../lib/radar-events.ts";

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
    const reserved = await reserveAiActionSafe(userId, quota.limit);
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
      await refundAiAction(userId);
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

  // 0) US-2753: START THE COMP QUERY NOW, before the grade exists.
  //
  // gradeToConditionId collapses the whole scale into four eBay buckets, and
  // everything from 3.0 to 8.4 lands on the same one — which is very nearly
  // every garment anyone picks up in a shop. So the condition the grade is about
  // to ask for is already knowable, and the eBay call no longer waits behind a
  // Claude Vision call doing nothing.
  //
  // The query issued here is IDENTICAL to the one the sequential code issued —
  // same filter, same limit — so a hit returns exactly what today returns. See
  // lib/comp-speculation.ts for why this beats bucketing an unfiltered result.
  const compArgs = barcode
    ? {
      gtin: barcode,
      categoryId: categoryId || undefined,
      brand: brand || undefined,
      limit: 25,
    }
    : {
      categoryId,
      q: q || undefined,
      brand: brand || undefined,
      size: size || undefined,
      limit: 25,
    };

  // Settled, never rejecting. The grade block below can return early on failure,
  // and an in-flight promise nobody awaits is the unhandled rejection that takes
  // the whole worker down (vault/10-ops/edge-hang-vs-crash-loop.md).
  const speculativeComps = searchBrowseComps({
    ...compArgs,
    conditionId: SPECULATIVE_CONDITION_ID,
  })
    .then((result) => ({ ok: true as const, result }))
    .catch((err: unknown) => ({ ok: false as const, err }));

  // 1) Private shadow grade from the photo (US-616 primitive). Barcode-only
  //    appraisals skip grading and value at the default "used" condition.
  let shadowGrade: number | null = null;
  let gradeConfidence = 0;
  let gradeTier: string | null = null;
  let needsHumanReview = false;
  let imagesAnalyzed = 0;
  if (image) {
    const reserved = await reserveAiActionSafe(userId, quota.limit);
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
      await refundAiAction(userId);
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
  const speculated = await speculativeComps;
  let compsReused = false;
  try {
    // The reuse decision lives in lib/comp-speculation.ts and is unit-tested by
    // COUNTING fetches, so "a hit issues no second call" is held by a test rather
    // than by reading this line and believing it.
    const { result: search, reused } = await resolveComps(
      speculated,
      shadowGrade,
      (conditionId) => searchBrowseComps({ ...compArgs, conditionId }),
    );
    compsReused = reused;
    value = valueRangeFromStats(search.stats, shadowGrade, search.stats.currency);
    if (barcode) matchedTitle = search.items[0]?.title ?? null;
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
    // US-2753: did the speculative comp query serve this appraisal, or did the
    // grade land outside the used band and force a second call? The unit test
    // measures coverage across a FLAT scale; this measures it against the grades
    // sellers actually produce, which is the number that decides whether the
    // speculation is worth keeping.
    compsReused: String(compsReused),
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

// ── US-2238: /appraise-url — appraise a listing you are LOOKING AT ──────────
//
// /appraise and /prospect both assume the reseller is HOLDING the item: they
// take an uploaded photo. But most sourcing now happens online — a flipper
// scrolling eBay, Poshmark or Grailed is standing in the same decision, with
// the item's photos already on the page in front of them.
//
// This is that entry point, and it exists for the browser extension: same
// grade → value → sell-through → buy/pass pipeline, fed by the listing's public
// image URLs instead of an upload. The cost basis is the ASKING PRICE, which is
// the number the flipper would actually pay.
//
// It is the seller-side twin of /api/grading/public/grade-from-url and shares
// that route's SSRF posture: quickGrade fetches every URL through safeFetch
// (private-range blocklist, redirect re-validation, size cap, content-type
// check), and parseAppraiseUrls rejects anything that isn't a well-formed
// http(s) URL BEFORE a socket opens or an AI action is reserved.
//
// PRIVACY / US-620: the grade produced here is a PRIVATE shadow grade for the
// requesting tenant. It is never written to grade_reports, never published, and
// never re-labels the seller's listing — the response says so, and the extension
// renders it as an estimate.
// Photos we'll grade from one listing. Deliberately the ANONYMOUS ceiling rather
// than the paid one: this is the seller's own metered AI action, and the value
// here comes from the comps, not from a deeper condition read.
const MAX_APPRAISE_URLS = EXTENSION_MAX_IMAGES_ANON;

export const APPRAISE_URL_DISCLAIMER =
  "A private AI estimate from the listing's own photos — not a GradeThread certificate, " +
  "and never shown to the seller. Resale, sell-through and ROI are estimates from " +
  "condition-matched eBay comps. Inspect the item before you buy.";


/**
 * Validate the listing image URLs. Shape only — the real SSRF check is safeFetch
 * inside quickGrade. Delegates to the shared extension parser so this endpoint
 * and /api/grading/public/grade-from-url cannot drift on what they accept.
 */
export function parseAppraiseUrls(
  raw: unknown,
): { ok: true; urls: string[] } | { ok: false; error: string } {
  return parseListingImageUrls(raw, MAX_APPRAISE_URLS, {
    malformed: "Each listing photo must be a valid URL.",
    scheme: "Listing photo URLs must be http(s).",
    empty: "Provide at least one listing photo URL.",
  });
}

flipdeskScoutRoutes.post("/appraise-url", async (c) => {
  // US-268: the tenant for EVERY downstream spend — the plan gate, the quota
  // check and the AI reservation. A workspace member acting in the owner's
  // workspace spends the OWNER's quota, which is why this is
  // workspaceOwnerId ?? userId and never a bare userId.
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  // Same paid gate as /appraise: this runs the grader and pulls comps.
  const gate = await requireFlipdesk(c, { feature: "compPulls", userId });
  if (gate) return gate;

  let body: {
    imageUrls?: unknown;
    title?: unknown;
    brand?: unknown;
    size?: unknown;
    categoryId?: unknown;
    priceCents?: unknown;
    marketplace?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  const parsedUrls = parseAppraiseUrls(body.imageUrls);
  if (!parsedUrls.ok) return jsonError(c, 400, parsedUrls.error);

  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  const brand = typeof body.brand === "string" ? body.brand.trim().slice(0, 80) : "";
  const size = typeof body.size === "string" ? body.size.trim().slice(0, 24) : "";
  let categoryId = typeof body.categoryId === "string" ? body.categoryId.trim() : "";
  // The asking price IS the cost basis: what the flipper would pay to source it.
  const costCents = typeof body.priceCents === "number" && body.priceCents > 0
    ? Math.round(body.priceCents)
    : null;

  if (!title && !brand && !categoryId) {
    return jsonError(
      c,
      400,
      "Provide the listing's title or brand so we can find comparable sales.",
    );
  }

  const quota = await checkQuota(userId);
  if (!quota.ok) return c.json(quota.body, quota.status);

  // 1) PRIVATE shadow grade from the listing's own photos. One AI action,
  //    reserved atomically and refunded if the grade fails.
  const reserved = await reserveAiActionSafe(userId, quota.limit);
  if (reserved !== true) {
    return jsonError(
      c,
      429,
      "Monthly AI action limit reached — upgrade or wait for the reset.",
    );
  }
  let shadowGrade: number | null = null;
  let gradeConfidence = 0;
  let gradeTier: string | null = null;
  let needsHumanReview = false;
  let imagesAnalyzed = 0;
  try {
    const grade = await quickGrade({
      images: parsedUrls.urls.map((url, i) => ({
        url,
        type: i === 0 ? "front" : "detail",
      })),
      garment: { brand: brand || null, title: title || undefined },
    });
    shadowGrade = grade.overallScore;
    gradeConfidence = grade.confidence;
    gradeTier = grade.gradeTier;
    needsHumanReview = grade.needsHumanReview;
    imagesAnalyzed = grade.imagesAnalyzed;
  } catch (err) {
    await refundAiAction(userId);
    return failSafe(
      c,
      502,
      "Couldn't read this listing's photos. Try again shortly.",
      err,
      "scout.appraise-url.grade",
    );
  }

  // 2) Condition-adjusted value at THAT grade. A category is required by eBay
  //    Browse; resolve one from the listing text when the caller didn't send it.
  if (!categoryId) {
    try {
      const query = [brand, title].filter(Boolean).join(" ").trim();
      categoryId = (await suggestCategories(query))[0]?.categoryId ?? "";
    } catch (err) {
      return failSafe(
        c,
        502,
        "Couldn't reach eBay to value this listing. Try again shortly.",
        err,
        "scout.appraise-url.category",
      );
    }
  }
  if (!categoryId) {
    // No category means no comps, and no comps means no honest margin. Say so
    // rather than returning a decision built on nothing. The grade is still
    // returned — it is real, and it cost an AI action the caller already spent.
    return c.json({
      grade: {
        value: shadowGrade,
        tier: gradeTier,
        confidence: gradeConfidence,
        needsHumanReview,
        imagesAnalyzed,
      },
      value: null,
      sellThrough: null,
      costCents,
      decision: null,
      insufficientComps: true,
      disclaimer: APPRAISE_URL_DISCLAIMER,
    });
  }

  let value: ValueRange;
  try {
    value = await valueAtGrade(
      {
        categoryId,
        q: title || undefined,
        brand: brand || undefined,
        size: size || undefined,
      },
      shadowGrade,
    );
  } catch (err) {
    return failSafe(
      c,
      502,
      "Couldn't reach eBay to value this listing. Try again shortly.",
      err,
      "scout.appraise-url.value",
    );
  }

  // 3) Sell-through + the buy/pass verdict at the asking price.
  const sellThrough = forecastSellThrough(value, value.medianCents ?? 0);
  const decision = decideBuy({
    shadowGrade,
    gradeConfidence,
    value,
    sellThrough,
    costCents,
  });

  recordMetric("scout.appraise-url", 1, {
    recommendation: decision.recommendation,
    marketplace: typeof body.marketplace === "string" ? body.marketplace.slice(0, 24) : "unknown",
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
    feeRate: DECISION_FEE_RATE,
    // Thin comps are reported, not hidden: the caller renders "not enough
    // comps" instead of a margin computed off a two-item sample.
    insufficientComps: !value.sufficient,
    disclaimer: APPRAISE_URL_DISCLAIMER,
  });
});


// ── US-1107: /prospect — snap-and-source, NO typing ─────────────────────────
//
// The thrift-aisle entry point. /appraise already grades + values + forecasts,
// but it makes the reseller TYPE the keyword/brand/category. /prospect closes
// that gap: snap 1-2 photos (front + tag), and we IDENTIFY the item from the
// photo (brand + keywords off the tag, US-285 primitive), resolve its eBay leaf
// category, then run the exact same condition-matched value + sell-through
// pipeline. The reseller learns "what is it, how many are out there, what's the
// going rate, will it sell" without touching the keyboard.
//
// Comp basis = ACTIVE eBay listings (asking prices). When the Marketplace
// Insights grant lands (EBAY_MARKETPLACE_INSIGHTS), valueAtGrade's comp source
// flips to realized SOLD prices with no change here — the `source` field tells
// the client which it is. Paid (compPulls) + up to 2 AI actions (identify +
// grade), each reserved atomically and refunded on failure.

// Split a data URI into the base64 payload + media type the vision layer wants;
// tolerates a bare base64 string (assumed JPEG). Returns null when unusable.
function splitImageInput(
  s: string,
): { base64: string; mediaType: string } | null {
  const m = s.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (m) return { mediaType: m[1]!, base64: m[2]! };
  // Bare base64 (no data: prefix) — assume JPEG, the iOS capture default.
  if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 64) {
    return { mediaType: "image/jpeg", base64: s.replace(/\s+/g, "") };
  }
  return null;
}

// Title-case a short identification phrase for display ("lululemon" → "Lululemon").
function titleizeWords(parts: string[]): string {
  return parts
    .join(" ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .trim();
}

flipdeskScoutRoutes.post("/prospect", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  // Same paid gate + AI quota as the scan/appraise: prospecting runs the grader.
  const gate = await requireFlipdesk(c, { feature: "compPulls", userId });
  if (gate) return gate;

  let body: {
    image?: unknown;
    images?: unknown;
    costCents?: unknown;
    lat?: unknown;
    lng?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  // US-1861 (Thrift Radar): the ONLY reason this endpoint accepts a coordinate.
  // It is used to derive a coarse cell inside `voidRecordScanLocation` and is
  // never stored, logged or echoed — there is no column for it, by design. A
  // client that has not opted in simply omits it; a client that sends one while
  // opted out still contributes nothing, because the consent check is
  // server-side and reads `users.radar_contribute` on every scan.
  const fix = parseFix(body.lat, body.lng);

  // Accept a single `image` or up to two `images` (front + tag). Front is used
  // for the condition grade; all are fed to the identifier (the tag carries the
  // brand). Keep them in order — the first is treated as the front.
  const rawImages: string[] = [];
  if (Array.isArray(body.images)) {
    for (const v of body.images) {
      if (typeof v === "string" && v.length > 0) rawImages.push(v);
    }
  } else if (typeof body.image === "string" && body.image.length > 0) {
    rawImages.push(body.image);
  }
  const capped = rawImages.slice(0, 2);
  if (capped.length === 0) {
    return jsonError(c, 400, "Provide a photo (front and/or the brand tag).");
  }
  for (const img of capped) {
    if (img.length > MAX_APPRAISE_IMAGE_BYTES * 1.4) {
      return jsonError(c, 413, "Image is too large — use a photo under 12 MB.");
    }
  }

  const visionImages: VisionImage[] = [];
  let frontDataUri: string | null = null;
  for (const img of capped) {
    const parsed = splitImageInput(img);
    if (!parsed) continue;
    visionImages.push({ data: parsed.base64, mediaType: parsed.mediaType });
    if (!frontDataUri) {
      frontDataUri = `data:${parsed.mediaType};base64,${parsed.base64}`;
    }
  }
  if (visionImages.length === 0) {
    return jsonError(c, 400, "Couldn't read that image. Try a clearer photo.");
  }

  const costCents =
    typeof body.costCents === "number" && body.costCents > 0
      ? Math.round(body.costCents)
      : null;

  const quota = await checkQuota(userId);
  if (!quota.ok) {
    return c.json(quota.body, quota.status);
  }

  // 1) IDENTIFY — read the brand/size tag and pull short matching keywords
  //    (US-285 primitive). One AI action; the comp search is meaningless
  //    without it, so a failure here is terminal for this call.
  {
    const reserved = await reserveAiActionSafe(userId, quota.limit);
    if (reserved !== true) {
      return jsonError(
        c,
        429,
        "Monthly AI action limit reached — upgrade or wait for the reset.",
      );
    }
  }
  let hints;
  try {
    hints = await extractMatchHints(visionImages);
  } catch (err) {
    await refundAiAction(userId);
    return failSafe(
      c,
      502,
      "Couldn't read that photo. Try a clearer shot of the item and its tag.",
      err,
      "scout.prospect.identify",
    );
  }

  const brand = hints.brand?.trim() || null;
  const keywords = hints.keywords.map((k) => k.trim()).filter(Boolean);
  const query = [brand, ...keywords].filter(Boolean).join(" ").trim();
  const displayTitle = titleizeWords([brand ?? "", ...keywords].filter(Boolean));

  // No brand AND no keywords → we can't comp. Return the (empty) identification
  // honestly rather than a misleading "0 comps" against a blank search.
  if (!query) {
    recordMetric("scout.prospect", 1, { identified: "false" });
    return c.json({
      identified: false,
      item: { brand: null, title: null, keywords: [], identifyConfidence: hints.confidence },
      category: null,
      grade: null,
      stats: null,
      sellThrough: null,
      source: "active",
      note:
        "Couldn't identify the item — try a sharper photo of the brand/size tag.",
    });
  }

  // 2) Resolve an eBay leaf category from the identification query.
  let categoryId: string | null = null;
  let categoryPath: string | null = null;
  try {
    const cats = await suggestCategories(query);
    categoryId = cats[0]?.categoryId ?? null;
    categoryPath = cats[0]?.categoryTreePath ?? null;
  } catch (err) {
    captureException(err, { level: "warn", route: "scout.prospect.category" });
  }

  // 3) GRADE the front photo (best-effort) so the value is condition-adjusted.
  //    If the cap is hit or grading fails, fall through with a null grade —
  //    valueAtGrade then prices at the default "used" condition.
  let shadowGrade: number | null = null;
  let gradeTier: string | null = null;
  let gradeConfidence = 0;
  if (frontDataUri) {
    const reservedGrade = await reserveAiActionSafe(userId, quota.limit);
    if (reservedGrade === true) {
      try {
        const grade = await quickGrade({
          images: [{ dataUri: frontDataUri, type: "front" }],
          garment: { brand, title: keywords.join(" ") || undefined },
        });
        shadowGrade = grade.overallScore;
        gradeTier = grade.gradeTier;
        gradeConfidence = grade.confidence;
      } catch (err) {
        await refundAiAction(userId);
        captureException(err, { level: "warn", route: "scout.prospect.grade" });
      }
    }
  }

  // 4) Condition-matched value range (= comp count + going rate) — only when we
  //    resolved a category. Then a transparent sell-through forecast.
  let value: ValueRange | null = null;
  if (categoryId) {
    try {
      value = await valueAtGrade(
        { categoryId, q: keywords.join(" ") || undefined, brand: brand ?? undefined },
        shadowGrade,
      );
    } catch (err) {
      captureException(err, { level: "warn", route: "scout.prospect.value" });
    }
  }
  const sellThrough = value
    ? forecastSellThrough(value, value.medianCents ?? 0)
    : null;
  const decision = value
    ? decideBuy({
        shadowGrade,
        gradeConfidence,
        value,
        sellThrough: sellThrough!,
        costCents,
      })
    : null;

  // A deep link to eBay's SOLD/completed search for this item — lets the
  // reseller eyeball actual realized prices in the browser even while our comp
  // basis is active listings (until the Marketplace Insights grant lands).
  const ebaySoldSearchUrl =
    `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}` +
    `&LH_Sold=1&LH_Complete=1`;

  recordMetric("scout.prospect", 1, {
    identified: "true",
    comped: String((value?.sampleSize ?? 0) > 0),
  });

  // US-1861 + US-1864: record where this scan happened — started here,
  // deliberately NOT awaited, so a slow or failing Radar write cannot delay or
  // degrade the scan result the reseller is standing in the aisle waiting for
  // (rule 8). Every gate lives inside `recordScanLocation`, so this call site
  // stays one line and cannot forget one of them, and the two writes it makes
  // have DIFFERENT gates: the reseller's own visit history is free and needs no
  // consent (rule 7), while the anonymous contribution to the shared map needs
  // both the kill-switch and `users.radar_contribute`.
  if (fix) {
    voidRecordScanLocation({
      accountId: userId,
      lat: fix.lat,
      lng: fix.lng,
      brand,
      category: categoryPath ?? categoryId,
      grade: shadowGrade,
      verdict: decision?.recommendation ?? "unknown",
    });
  }

  return c.json({
    identified: true,
    item: {
      brand,
      title: displayTitle || null,
      keywords,
      identifyConfidence: hints.confidence,
    },
    category: categoryId ? { id: categoryId, path: categoryPath } : null,
    grade: shadowGrade != null
      ? { value: shadowGrade, tier: gradeTier, confidence: gradeConfidence }
      : null,
    // The headline numbers: count = how many comps backed the estimate,
    // medianCents = the going rate, low/high = the spread.
    stats: value
      ? {
          count: value.sampleSize,
          lowCents: value.lowCents,
          medianCents: value.medianCents,
          highCents: value.highCents,
          currency: value.currency,
          confidence: value.confidence,
          sufficient: value.sufficient,
        }
      : null,
    sellThrough,
    costCents,
    decision,
    ebaySoldSearchUrl,
    // "active" today; flips to "sold" automatically once Marketplace Insights
    // is granted — the client labels its pricing copy off this.
    source: "active",
    disclaimer:
      "Identified by AI from your photos. Prices come from condition-matched ACTIVE eBay listings (asking prices) — real sold prices are often lower, so treat the going rate as a ceiling. Tap to see sold comps on eBay.",
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
