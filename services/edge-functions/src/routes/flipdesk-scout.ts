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
import {
  type BrowseCompsResult,
  searchBrowseComps,
  suggestCategories,
} from "../lib/ebay-client.ts";
import { extractMatchHints, type VisionImage } from "../lib/ai-reconcile.ts";
import { quickGrade } from "../lib/quick-grade.ts";
import {
  valueAtGrade,
  applyMeasuredCurve,
  valueRangeFromStats,
  type ValueRange,
} from "../lib/condition-value.ts";
import {
  resolveComps,
  SPECULATIVE_CONDITION_ID,
} from "../lib/comp-speculation.ts";
import { whichRefusal } from "../lib/gate-order.ts";
import { cachedSearchBrowseComps, cachedValueAtGrade } from "../lib/comps-cache.ts";
import {
  pickVisualImageIndex,
  planProspectIdentification,
} from "../lib/prospect-identify.ts";
import { parseProspectOverride } from "../lib/prospect-repull.ts";
import {
  chooseProviders,
  ebayImageProvider,
  ebayImageSearchEnabled,
  type IdentitySource,
  identifyWithFallback,
  type IdentifyRequest,
} from "../lib/scout-identify.ts";
import { forecastSellThrough } from "../lib/sell-through.ts";
import { ebaySoldSearchUrl } from "../lib/sold-comps.ts";
import { decideBuy, DECISION_FEE_RATE, sourcingCeiling } from "../lib/scout-decision.ts";
import { sourcingTargetRoi } from "../lib/sourcing-target.ts";
import {
  rankCandidates,
  scoreCandidate,
  type ScoutCandidate,
  type ScoutScored,
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

// How many candidates are graded at once.
//
// One shadow grade is two model calls back to back and lands around 15-25s.
// Run serially, a full scan therefore took two to three MINUTES and returned
// nothing until the last candidate finished, which is longer than any client
// will wait and was why the iOS scan always failed. Four at a time brings a
// full scan to roughly one wave-and-a-half.
//
// Bounded rather than "all of them" on purpose: one user's scan should not be
// able to hold eight model slots on a replica that is also grading submissions.
const SCAN_CONCURRENCY = 4;

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

  // A candidate with no photo cannot be shadow-graded, so it never enters the
  // queue rather than being skipped inside it.
  const queue = candidates.filter(
    (cand): cand is ScoutCandidate & { imageUrl: string } => Boolean(cand.imageUrl),
  );

  const scored: ScoutScored[] = [];
  let graded = 0;
  // Set when the AI cap refuses a reservation. Every worker checks it, so one
  // refusal stops the whole scan instead of each worker discovering the cap
  // separately and burning a round trip to do it.
  let capHit = false;

  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, queue.length) }, async () => {
      while (!capHit) {
        const cand = queue.shift();
        if (!cand) return;

        // US-619: atomically reserve one AI action; stop cleanly when the cap is
        // hit. The reservation is atomic, so concurrent workers cannot together
        // reserve past the cap.
        const reserved = await reserveAiActionSafe(userId, quota.limit);
        if (reserved !== true) {
          capHit = true;
          return;
        }

        try {
          // US-616: PRIVATE shadow grade from the listing's own photo.
          const grade = await quickGrade({
            images: [{ url: cand.imageUrl, type: "front" }],
            garment: { brand: brand ?? null, title: cand.title },
          });
          // US-610: condition-adjusted value at that grade, same search
          // identity. Through the cache: the only field that varies across
          // candidates here is the condition the grade maps to, and there are
          // about five of those, so a scan asks eBay a handful of questions
          // rather than one per candidate.
          const value = await cachedValueAtGrade({ categoryId, q, brand }, grade.overallScore);
          // US-617: score by condition-adjusted margin.
          scored.push(scoreCandidate(cand, grade.overallScore, grade.confidence, value));
          graded += 1;
        } catch (err) {
          // Refund the reserved action on failure so a transient error isn't billed.
          await refundAiAction(userId);
          captureException(err, { level: "warn", route: "scout.grade", extra: { itemId: cand.itemId } });
        }
      }
    }),
  );

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

  // US-2755: the plan gate and the AI quota both read the same users row and
  // neither depends on the other, so they run together instead of one behind the
  // other. Which refusal wins when BOTH fail is a named rule with a test
  // (lib/gate-order.ts) rather than an accident of statement order — a seller on
  // an expired plan told "monthly AI limit reached" is being sent to fix the
  // wrong thing.
  const [gate, quota] = await Promise.all([
    requireFlipdesk(c, { feature: "compPulls", userId }),
    checkQuota(userId),
  ]);
  // The rule decides whether the GATE wins; the narrowing below is what lets
  // TypeScript see the quota union, and the two agree by construction because
  // whichRefusal only returns "quota" when quota.ok is false.
  if (whichRefusal(gate !== null, quota.ok) === "gate") return gate!;
  if (!quota.ok) return c.json(quota.body, quota.status);

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
  // Settled, never rejecting. The grade block below can return early on failure,
  // and an in-flight promise nobody awaits is the unhandled rejection that takes
  // the whole worker down (vault/10-ops/edge-hang-vs-crash-loop.md).
  // US-2756: through the provider chain. With the experiment flag off — the
  // default, and every stock deployment — this resolves to the hints provider,
  // which is the same cached comp query US-2754 introduced. Nothing changes.
  const identifyReq: IdentifyRequest = {
    imageDataUri: image,
    barcode,
    q,
    brand,
    categoryId,
    size,
  };
  const providers = chooseProviders();

  const speculativeComps = identifyWithFallback(
    providers,
    identifyReq,
    SPECULATIVE_CONDITION_ID,
  )
    .then((outcome) =>
      outcome
        ? { ok: true as const, result: outcome.comps, outcome }
        : { ok: false as const, err: new Error("no provider identified the item") }
    )
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
  // US-2763: the title travels with HOW it was arrived at. A barcode pins a
  // product; a visual match names something that looks like it. Only the first
  // may be written into a field without the seller confirming it.
  let identitySource: IdentitySource | null = null;
  let identityIsAuthoritative = false;
  const matchedCategoryId: string | null = categoryId || null;
  const speculated = await speculativeComps;
  let compsReused = false;
  let requeryTitle: string | null = null;
  let requerySource: IdentitySource | null = null;
  let requeryAuthoritative = false;
  let identifiedBy: string = "hints";
  if (speculated.ok) identifiedBy = speculated.outcome.provider;
  try {
    // The reuse decision lives in lib/comp-speculation.ts and is unit-tested by
    // COUNTING fetches, so "a hit issues no second call" is held by a test rather
    // than by reading this line and believing it.
    const { result: search, reused } = await resolveComps(
      speculated,
      shadowGrade,
      async (conditionId) => {
        const outcome = await identifyWithFallback(providers, identifyReq, conditionId);
        if (!outcome) throw new Error("no provider could value this item");
        requeryTitle = outcome.matchedTitle;
        requerySource = outcome.identitySource;
        requeryAuthoritative = outcome.identityIsAuthoritative;
        identifiedBy = outcome.provider;
        return outcome.comps;
      },
    );
    compsReused = reused;
    // US-2851: /appraise built its range inline too, so US-2849's flip reached
    // neither in-field surface. Both go through the choke point now.
    value = await applyMeasuredCurve(
      { categoryId, q: q || undefined, brand: brand || undefined, size: size || undefined },
      shadowGrade,
      valueRangeFromStats(search.stats, shadowGrade, search.stats.currency),
    );
    // The provider decides what a matched title means: only a barcode pins an
    // exact product on the hints path, while a visual match names what it saw.
    matchedTitle = reused
      ? (speculated.ok ? speculated.outcome.matchedTitle : null)
      : requeryTitle;
    identitySource = reused
      ? (speculated.ok ? speculated.outcome.identitySource : null)
      : requerySource;
    identityIsAuthoritative = reused
      ? (speculated.ok ? speculated.outcome.identityIsAuthoritative : false)
      : requeryAuthoritative;
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
  // US-2851: the sourcing ceiling. Absent, never guessed, unless this cell has
  // a publishable measured curve; sourcingCeiling enforces that itself. The
  // target is the OWNER's setting, so a workspace member spends against the
  // owner's margin rather than one of their own.
  const ceiling = sourcingCeiling({
    value,
    targetRoi: await sourcingTargetRoi(userId),
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
    // US-2756: which provider actually answered. With the flag off this is
    // always "hints"; once the experiment is on it is the only way to see how
    // often visual search is carrying its weight.
    identifiedBy,
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
    ceiling,
    matchedTitle,
    // US-2763 AC5: the client must be able to tell "recognised as X" from
    // "looks like these". Sending the title without this is what let a pure
    // similarity guess become an item's saved name.
    identitySource,
    identityIsAuthoritative,
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

  // Same paid gate as /appraise, and the same US-2755 pairing: both checks read
  // one users row and neither depends on the other, so they run together and the
  // named precedence rule decides which refusal a doubly-failing caller sees.
  const [gate, quota] = await Promise.all([
    requireFlipdesk(c, { feature: "compPulls", userId }),
    checkQuota(userId),
  ]);
  if (whichRefusal(gate !== null, quota.ok) === "gate") return gate!;
  if (!quota.ok) return c.json(quota.body, quota.status);

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
  // US-2851: the sourcing ceiling. Absent, never guessed, unless this cell has
  // a publishable measured curve; sourcingCeiling enforces that itself. The
  // target is the OWNER's setting, so a workspace member spends against the
  // owner's margin rather than one of their own.
  const ceiling = sourcingCeiling({
    value,
    targetRoi: await sourcingTargetRoi(userId),
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
    ceiling,
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
  //
  // US-2757: both read one users row and neither depends on the other, so they
  // run together, with the same named precedence rule /appraise uses. The quota
  // result is needed further down for the two reservations, so it is hoisted
  // here rather than re-fetched.
  const [gate, quota] = await Promise.all([
    requireFlipdesk(c, { feature: "compPulls", userId }),
    checkQuota(userId),
  ]);
  if (whichRefusal(gate !== null, quota.ok) === "gate") return gate!;
  if (!quota.ok) return c.json(quota.body, quota.status);

  let body: {
    image?: unknown;
    images?: unknown;
    // US-2759: what each photo SHOWS, parallel to `images`. Optional, and its
    // absence keeps today's path — a client that does not label its photos
    // never reaches visual search, which is the US-2762 posture.
    imageRoles?: unknown;
    costCents?: unknown;
    lat?: unknown;
    lng?: unknown;
    // US-2923: the seller correcting a wrong identification. When present, this
    // request identifies NOTHING and grades NOTHING - see lib/prospect-repull.ts.
    titleOverride?: unknown;
    brandOverride?: unknown;
    gradeValue?: unknown;
    gradeTier?: unknown;
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

  // US-2923: is this a RE-PULL? The seller saw the identification was wrong,
  // typed the right title, and wants the comps re-run against it. A re-pull
  // sends no photos, identifies nothing and grades nothing, so it costs zero AI
  // actions - it is still a comp pull and still passes the gate above.
  //
  // An override that is present but unusable is refused by name rather than
  // falling through to the identify path, because falling through would spend
  // two AI actions on what the seller experienced as a typo.
  const override = parseProspectOverride(body);
  if (override.kind === "invalid") return jsonError(c, 400, override.error);
  const isRepull = override.kind === "override";

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
  // Roles travel positionally with `images`. A short or missing array simply
  // leaves the later photos unlabelled, which is the safe state.
  const rawRoles: (string | null)[] = [];
  if (Array.isArray(body.imageRoles)) {
    for (const v of body.imageRoles) {
      rawRoles.push(typeof v === "string" && v.trim() ? v.trim() : null);
    }
  }
  const capped = rawImages.slice(0, 2);
  const cappedRoles = capped.map((_, i) => rawRoles[i] ?? null);
  if (capped.length === 0 && !isRepull) {
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
  if (visionImages.length === 0 && !isRepull) {
    return jsonError(c, 400, "Couldn't read that image. Try a clearer photo.");
  }

  const costCents =
    typeof body.costCents === "number" && body.costCents > 0
      ? Math.round(body.costCents)
      : null;

  // 1) IDENTIFY. US-2759: who does this depends on what the seller photographed.
  //
  //   tag in frame        -> extractMatchHints. Text on the garment beats a
  //                          similarity match, and it is what they went to the
  //                          trouble of photographing.
  //   garment only        -> eBay visual search. No text to read, and this is
  //                          the case US-2758 measured it best on. Costs NO AI
  //                          action, which is the whole of US-2760's complaint.
  //   unlabelled / off    -> exactly today's path.
  //
  // The rule itself lives in lib/prospect-identify.ts so it can be read and
  // tested without a route.
  const idPlan = planProspectIdentification({
    visualEnabled: ebayImageSearchEnabled(),
    imageRoles: cappedRoles,
  });

  let brand: string | null = null;
  let keywords: string[] = [];
  let identitySource: IdentitySource | null = null;
  let identityIsAuthoritative = false;
  let visualComps: Awaited<ReturnType<typeof identifyWithFallback>> = null;
  // How sure the IDENTIFICATION is, on the 0-1 scale the response has always
  // used. Visual search reports no confidence of its own - US-2758 measured it
  // being equally confident when right and when wrong - so a matched title gets
  // a fixed, deliberately unflattering 0.5. It is a suggestion, and the number
  // should not read like a measurement.
  let identifyConfidence = 0;

  if (isRepull && override.kind === "override") {
    // The seller identified it. Nothing here runs: no visual search, no hints,
    // no AI action. `keywords` carries the corrected words so the category
    // lookup and the comp query below are unchanged in shape.
    brand = override.brand;
    keywords = override.title.split(/\s+/).filter(Boolean).slice(0, 12);
    identitySource = "seller";
    // The one authoritative source in the union. A human looked at the garment.
    identityIsAuthoritative = true;
    identifyConfidence = 1;
  } else if (idPlan.useVisual) {
    const vIdx = pickVisualImageIndex(cappedRoles);
    // -1 would mean the plan and the picker disagree; a unit test pins that they
    // cannot, and this stays as the runtime floor rather than a default of 0.
    if (vIdx >= 0) {
      const parsed = splitImageInput(capped[vIdx]!);
      if (parsed) {
        visualComps = await identifyWithFallback(
          [ebayImageProvider],
          {
            imageDataUri: `data:${parsed.mediaType};base64,${parsed.base64}`,
            imageRole: cappedRoles[vIdx],
            barcode: "",
            q: "",
            brand: "",
            categoryId: "",
            size: "",
          },
          SPECULATIVE_CONDITION_ID,
        ).catch(() => null);
      }
    }
  }

  if (isRepull) {
    // Already identified by the seller, above. Deliberately first, so that
    // adding a branch below can never reach a re-pull by accident: the cost
    // claim in prospect-repull_test.ts is that NO AI action is spent here.
  } else if (visualComps?.matchedTitle) {
    // Visual search carried it. NO AI action was spent here.
    identitySource = visualComps.identitySource;
    identityIsAuthoritative = visualComps.identityIsAuthoritative;
    keywords = visualComps.matchedTitle.split(/\s+/).filter(Boolean).slice(0, 8);
    identifyConfidence = 0.5;
  } else {
    // Either the plan chose hints, or visual search declined / found nothing.
    // Falling back is silent to the seller and costs the ordinary AI action.
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
    brand = hints.brand?.trim() || null;
    keywords = hints.keywords.map((k) => k.trim()).filter(Boolean);
    identifyConfidence = hints.confidence;
    // A tag read is TEXT on the garment, which is stronger than a similarity
    // match and weaker than a barcode: OCR misreads, and a tag can name a parent
    // brand or a licensee. Offered, not saved.
    identitySource = brand ? "tag" : null;
    identityIsAuthoritative = false;
  }
  const query = [brand, ...keywords].filter(Boolean).join(" ").trim();
  // A corrected title is shown back EXACTLY as the seller typed it. titleizeWords
  // would rewrite "ABC Pant" to "Abc Pant" and "L'AGENCE" to "L'agence", which
  // reads as the app having failed to understand the correction.
  const displayTitle = isRepull && override.kind === "override"
    ? override.title
    : titleizeWords([brand ?? "", ...keywords].filter(Boolean));

  // No brand AND no keywords → we can't comp. Return the (empty) identification
  // honestly rather than a misleading "0 comps" against a blank search.
  if (!query) {
    recordMetric("scout.prospect", 1, { identified: "false" });
    return c.json({
      identified: false,
      item: { brand: null, title: null, keywords: [], identifyConfidence },
      category: null,
      grade: null,
      stats: null,
      sellThrough: null,
      source: "active",
      note:
        "Couldn't identify the item — try a sharper photo of the brand/size tag.",
    });
  }

  // 2+3) US-2757: RESOLVE THE CATEGORY AND GRADE THE PHOTO AT THE SAME TIME.
  //
  // These were sequential, and there was never a reason for it. The category
  // lookup needs the identification QUERY; the grade needs the front PHOTO and
  // the same hints for context. Both inputs exist the moment extractMatchHints
  // returns, and neither waits on the other — so /prospect was paying for an
  // eBay round trip and a Vision call back to back when it could pay for the
  // slower of the two.
  //
  // The grade still receives the hints, so the number it produces is unchanged.
  // Running it BEFORE the hints would have been faster still and would have
  // meant grading a garment we could not name — a different answer dressed up
  // as a speedup, which this epic has already refused once.
  //
  // The comp query rides behind the category inside the same branch, at the
  // speculative condition (US-2753), so it overlaps the grade too.
  const compQuery = { q: keywords.join(" ") || undefined, brand: brand ?? undefined };

  const [categoryOutcome, gradeOutcome] = await Promise.all([
    (async () => {
      let categoryId: string | null = null;
      let categoryPath: string | null = null;
      try {
        const cats = await suggestCategories(query);
        categoryId = cats[0]?.categoryId ?? null;
        categoryPath = cats[0]?.categoryTreePath ?? null;
      } catch (err) {
        captureException(err, { level: "warn", route: "scout.prospect.category" });
      }
      if (!categoryId) return { categoryId, categoryPath, speculated: null };
      // Settled, never rejecting: the grade branch beside this one can fail and
      // an in-flight promise nobody awaits is the unhandled rejection that takes
      // the worker down (vault/10-ops/edge-hang-vs-crash-loop.md).
      const speculated = await cachedSearchBrowseComps({
        categoryId,
        ...compQuery,
        conditionId: SPECULATIVE_CONDITION_ID,
        limit: 25,
      })
        .then((out: { result: BrowseCompsResult; hit: boolean }) => ({ ok: true as const, result: out.result }))
        .catch((err: unknown) => ({ ok: false as const, err }));
      return { categoryId, categoryPath, speculated };
    })(),
    (async () => {
      // Best-effort. If the cap is hit or grading fails, fall through with a
      // null grade and price at the default used condition, exactly as before.
      if (!frontDataUri) return { shadowGrade: null, gradeTier: null, gradeConfidence: 0 };
      const reservedGrade = await reserveAiActionSafe(userId, quota.limit);
      if (reservedGrade !== true) {
        return { shadowGrade: null, gradeTier: null, gradeConfidence: 0 };
      }
      try {
        const grade = await quickGrade({
          images: [{ dataUri: frontDataUri, type: "front" }],
          garment: { brand, title: keywords.join(" ") || undefined },
        });
        return {
          shadowGrade: grade.overallScore,
          gradeTier: grade.gradeTier,
          gradeConfidence: grade.confidence,
        };
      } catch (err) {
        await refundAiAction(userId);
        captureException(err, { level: "warn", route: "scout.prospect.grade" });
        return { shadowGrade: null, gradeTier: null, gradeConfidence: 0 };
      }
    })(),
  ]);

  const categoryId = categoryOutcome.categoryId;
  const categoryPath = categoryOutcome.categoryPath;

  // US-2923: on a re-pull the grade is CARRIED ACROSS from the run being
  // corrected, not recomputed. The photos did not change, so neither did the
  // condition; only the identification was wrong. The grade branch above
  // already returned nulls (there is no front photo on a re-pull, so it never
  // reserved an AI action), and this substitutes what the first run measured.
  //
  // It arrives from the client, so it is range-checked in parseProspectOverride
  // rather than trusted. All it selects is which eBay condition bucket the comps
  // are filtered to, on this caller's own screen. Absent or out of range means
  // null, which prices at the default used bucket - exactly what an ungraded
  // prospect has always done.
  const isRepullGrade = isRepull && override.kind === "override";
  const shadowGrade = isRepullGrade ? override.gradeValue : gradeOutcome.shadowGrade;
  const gradeTier = isRepullGrade ? override.gradeTier : gradeOutcome.gradeTier;
  // A carried-across grade reports the confidence of a measurement that is not
  // being re-made. 0 would read as "we are unsure"; the honest statement is that
  // this run did not grade, and the client shows the grade it already had.
  const gradeConfidence = isRepullGrade
    ? (override.gradeValue != null ? 1 : 0)
    : gradeOutcome.gradeConfidence;

  // 4) Condition-matched value range. The speculative comps usually already
  //    hold the condition the grade wants, so this is normally free.
  let value: ValueRange | null = null;
  if (categoryId && categoryOutcome.speculated) {
    try {
      const { result: search } = await resolveComps(
        categoryOutcome.speculated,
        shadowGrade,
        async (conditionId) => {
          const out = await cachedSearchBrowseComps({
            categoryId,
            ...compQuery,
            conditionId,
            limit: 25,
          });
          return out.result;
        },
      );
      // US-2851: /prospect built its range inline and so was the ONE value
      // surface US-2849's flip never reached. It is also the thrift-aisle
      // surface the sourcing ceiling exists for, so a ceiling here would have
      // been permanently absent. Same choke point as everything else now.
      value = await applyMeasuredCurve(
        { categoryId, q: compQuery.q, brand: compQuery.brand },
        shadowGrade,
        valueRangeFromStats(search.stats, shadowGrade, search.stats.currency),
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
  // US-2851: the sourcing ceiling. Absent, never guessed, unless this cell has
  // a publishable measured curve; sourcingCeiling enforces that itself. The
  // target is the OWNER's setting, so a workspace member spends against the
  // owner's margin rather than one of their own.
  const ceiling = value
    ? sourcingCeiling({ value, targetRoi: await sourcingTargetRoi(userId) })
    : null;

  // A deep link to eBay's SOLD/completed search for this item — lets the
  // reseller eyeball actual realized prices in the browser even while our comp
  // basis is active listings (until the Marketplace Insights grant lands).
  // Built by the shared builder so the page the seller lands on carries the SAME
  // category filter our own comp query ran under; an unscoped sold search was
  // showing a different item's price spread next to our estimate.
  const soldSearchUrl = ebaySoldSearchUrl({ query, categoryId });

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
  // US-2923: a re-pull is a CORRECTION of a scan already recorded, not a new
  // one. Recording it again would double-count one garment in the shared map
  // and put a second visit in the seller's own history for an item they never
  // picked up twice.
  if (fix && !isRepull) {
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
      identifyConfidence,
      // US-2763 AC5: the seller has to be able to tell "we read this off the
      // tag" from "it looks like these". A comp range is only trustworthy if
      // you know what it was matched against.
      identitySource,
      identityIsAuthoritative,
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
          // US-2850: /prospect flattens the range into `stats`, so the
          // provenance has to be carried across by hand or it is lost.
          basis: value.basis,
        }
      : null,
    sellThrough,
    costCents,
    decision,
    ceiling,
    ebaySoldSearchUrl: soldSearchUrl,
    // "active" today; flips to "sold" automatically once Marketplace Insights
    // is granted — the client labels its pricing copy off this.
    source: "active",
    // US-2923: on a re-pull the first sentence would be a lie. Nothing was
    // identified by AI on this request; the seller typed the title and the
    // grade is the one the earlier run measured. The pricing half is identical
    // because the comp query is identical.
    disclaimer: isRepull
      ? "You corrected the title, so these comps are matched to your words, not to an AI reading of the photo. The condition grade is the one from your first scan. Prices come from condition-matched ACTIVE eBay listings (asking prices); real sold prices are often lower, so treat the going rate as a ceiling."
      : "Identified by AI from your photos. Prices come from condition-matched ACTIVE eBay listings (asking prices) — real sold prices are often lower, so treat the going rate as a ceiling. Tap to see sold comps on eBay.",
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
