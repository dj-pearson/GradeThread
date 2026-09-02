import { Hono } from "hono";
import type { Context } from "hono";
import {
  computePublicStats,
  computePublicTransparency,
  type PublicStats,
  type PublicTransparencyReport,
} from "../lib/accuracy-tracking.ts";
import { getIndexCurveBySlug, getIndexHub } from "../lib/condition-index.ts";
import { getValueHub, resolveValueCurve } from "../lib/value-index.ts";
import { getDurabilityByBrand, getDurabilityHub } from "../lib/durability-index.ts";
import { computeDurabilityReport, type DurabilityReport } from "../lib/durability-report.ts";
import { computeGarmentImpact } from "../lib/impact-estimate.ts";
import { computeEsgExport, toEsgCsv, type BrandEsgRow } from "../lib/esg-export.ts";
import {
  computeResaleConditionReport,
  type ResaleConditionReport,
} from "../lib/resale-condition.ts";
import { valueAtGrade, valueRangeFromStats, type ValueRange } from "../lib/condition-value.ts";
import type { ValueBasis } from "../lib/value-disclosure.ts";
import { searchBrowseComps, suggestCategories } from "../lib/ebay-client.ts";
import { quickGrade } from "../lib/quick-grade.ts";
import { claimedConditionToGrade, scoreDiscrepancy } from "../lib/condition-discrepancy.ts";
import { parsePriceCents, priceFairness } from "../lib/price-fairness.ts";
// US-2237: the scan's decision logic lives in lib/ so it can be type-checked and
// unit-tested without this file's dependency graph (hono, supabase, the eBay
// client). The route keeps the I/O; everything imported here is pure.
import {
  bucketScanCards,
  MAX_SCAN_COMP_BUCKETS,
  parseScanBody,
  SCAN_DISCLAIMER,
  type ScanCompStats,
  scanCardResults,
} from "../lib/extension-scan.ts";
import { deriveFraudFlags } from "../lib/fraud-flags.ts";
import { coverageGapForTitle } from "../lib/coverage-gap.ts";
import {
  type EbayListingRead,
  hydrateEbayListingBody,
  isValidEbayItemId,
  readEbayListingForGrading,
} from "../lib/ebay-item-read.ts";
// US-9033: the free tag reader reuses the AutoLister's tag-OCR pass rather than
// prompting for a second time. Same model call, anonymous caller.
import {
  extractTagGroundTruth,
  TAG_GROUND_TRUTH_MIN_CONFIDENCE,
  type TagField,
  type TagGroundTruth,
} from "../lib/ai-tag-ocr.ts";
import { parseRegisteredNumber, registeredNumberKey } from "../lib/registered-numbers.ts";
import { bearerFromHeader, verifyExtensionToken } from "../lib/extension-token.ts";
import { resolveExtensionGates } from "../lib/extension-gates.ts";
import {
  EXTENSION_MAX_IMAGES_ANON,
  parseListingImageUrls,
} from "../lib/extension-image-urls.ts";
import {
  ANONYMOUS_EXTENSION_ENTITLEMENTS,
  getBuyerEntitlements,
  getExtensionEntitlements,
} from "../lib/buyer-entitlements.ts";
import { supabaseAdmin } from "../lib/supabase.ts";
import { loadPendingDelists } from "../lib/pending-delists.ts";
import { confirmRevise, loadPendingRevises } from "../lib/pending-revises.ts";
import { completeRelist } from "../lib/extension-relist.ts";
import { loadSyncStatus } from "../lib/sync-status.ts";
// US-1808: extension-fed marketplace listing ingestion. The pure half (the
// marketplace allowlist that IS the anti-crawl boundary, URL canonicalization,
// body validation) lives in lib/listing-ingest.ts; the matching predicate is
// borrowed WHOLE from the alerts engine so an ingested listing is judged by the
// same rules as an on-platform certificate.
import { trackBuyerFeature } from "../lib/buyer-analytics.ts";
import {
  buildIngestAlertBody,
  INGEST_RETENTION_DAYS,
  type IngestListingInput,
  parseIngestBody,
  priceWithinCeiling,
} from "../lib/listing-ingest.ts";
import {
  type AlertSearch,
  entitledSearchIds,
  type MatchableItem,
  matchesSearch,
} from "../lib/condition-alerts.ts";
import { notifyBuyer } from "../lib/buyer-notify.ts";
import { BuyerQuotaExhaustedError, withBuyerMeter } from "../lib/buyer-metering.ts";

// US-1836: fraud flags are legally sensitive (a public "these look manipulated"
// signal), so the whole feature is FAIL-CLOSED behind a kill-switch until the
// risk-framed copy is legal-reviewed AND the Connoisseur tier-gate lands with the
// extension auth (US-1838). Default off — mirrors PUBLIC_AUTHENTICITY_CHECK_ENABLED.
export function extensionFraudFlagsEnabled(): boolean {
  return Deno.env.get("EXTENSION_FRAUD_FLAGS_ENABLED") === "true";
}
import { validateImageUpload, IMAGE_CONTENT_TYPE } from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";
import {
  assessAuthenticity,
  AUTHENTICITY_PROMPT_VERSION_GROUNDED,
} from "../lib/ai-authenticity.ts";
import { authenticityGateStatus } from "../lib/authenticity-eval.ts";
import { getEffectiveTellsForBrand } from "../lib/brand-authenticity.ts";
import { recordAiUsage } from "../lib/ai-usage.ts";
import { clientIp } from "../middleware/rate-limit.ts";
import { AiCeilingError, reserveGlobalDailyBudget } from "../lib/ai-limiter.ts";

// Public, UNAUTHENTICATED grading-transparency surface (US-326).
//
// Mounted at /api/grading/public — deliberately OUTSIDE /api/grade/* (which is
// JWT-gated) and /api/admin/* so it can be read by the public /transparency
// page with no account. Everything it returns is platform-wide aggregate data;
// see computePublicTransparency() for the safety contract (no per-tenant rows).

export const publicGradingRoutes = new Hono();

// The report scans reviews + outcomes, so we don't recompute it per request.
// A short in-memory TTL cache is plenty for a page that changes slowly; each
// edge instance warms its own copy.
const CACHE_TTL_MS = 15 * 60 * 1000;
let cached: { at: number; report: PublicTransparencyReport } | null = null;

// GET /transparency — published accuracy + volume + model changelog.
publicGradingRoutes.get("/transparency", async (c) => {
  try {
    const now = Date.now();
    if (!cached || now - cached.at > CACHE_TTL_MS) {
      cached = { at: now, report: await computePublicTransparency() };
    }
    // Let CDNs/browsers cache it too — it's public and slow-moving.
    return c.json(cached.report, 200, {
      "Cache-Control": "public, max-age=300, s-maxage=900",
    });
  } catch (err) {
    // US-580: this is an unauthenticated surface — never echo raw error detail
    // (DB/PostgREST internals) to the caller. Log it server-side and return a
    // generic body, mirroring the global app.onError in main.ts.
    console.error(
      "public-grading /transparency:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Internal error" }, 500);
  }
});

// ── Public stat counters (US-865) ────────────────────────────────────
// Slim headline numbers for the homepage + marketing social-proof counters.
// Aggregate-only (see computePublicStats). Cached harder than /transparency —
// these move slowly and the homepage hits this on every cold visit.
const STATS_CACHE_TTL_MS = 30 * 60 * 1000;
let statsCache: { at: number; stats: PublicStats } | null = null;

// GET /stats — items graded, verified sellers, graded sales, AI-vs-human agreement.
publicGradingRoutes.get("/stats", async (c) => {
  try {
    const now = Date.now();
    if (!statsCache || now - statsCache.at > STATS_CACHE_TTL_MS) {
      statsCache = { at: now, stats: await computePublicStats() };
    }
    return c.json(statsCache.stats, 200, {
      "Cache-Control": "public, max-age=600, s-maxage=1800",
    });
  } catch (err) {
    // US-580: unauthenticated surface — log server-side, return a generic body.
    console.error(
      "public-grading /stats:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Internal error" }, 500);
  }
});

// ── State of Resale Condition report (US-976) ────────────────────────
// Public, UNAUTHENTICATED, aggregate-only data report on how a garment's
// condition grade relates to resale outcomes (return rate, sell-through, and
// median resale price by grade band). The strongest GEO lever: original,
// citable statistics. Cached like /transparency — it scans items_full and moves
// slowly. See computeResaleConditionReport() for the aggregate-only safety
// contract (no per-tenant rows; every rate sample-gated).
const RESALE_CACHE_TTL_MS = 15 * 60 * 1000;
let resaleCache: { at: number; report: ResaleConditionReport } | null = null;

// GET /resale-condition-report — return rate, sell-through + value by grade band.
publicGradingRoutes.get("/resale-condition-report", async (c) => {
  try {
    const now = Date.now();
    if (!resaleCache || now - resaleCache.at > RESALE_CACHE_TTL_MS) {
      resaleCache = { at: now, report: await computeResaleConditionReport() };
    }
    return c.json(resaleCache.report, 200, {
      "Cache-Control": "public, max-age=600, s-maxage=900",
    });
  } catch (err) {
    // US-580: unauthenticated surface — log server-side, return a generic body.
    console.error(
      "public-grading /resale-condition-report:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Internal error" }, 500);
  }
});

// ── Condition Index (US-621/622) ─────────────────────────────────────
// Public, unauthenticated price-vs-grade data for the SEO Index pages (served
// by the Cloudflare Pages Function in functions/condition-index/). Aggregate
// only; thin curves are suppressed by the lib (no false precision).

// GET /api/grading/public/condition-index — the hub list.
publicGradingRoutes.get("/condition-index", async (c) => {
  try {
    const items = await getIndexHub();
    return c.json({ items }, 200, { "Cache-Control": "public, max-age=600, s-maxage=3600" });
  } catch {
    return c.json({ error: "Failed to load condition index" }, 500);
  }
});

// GET /api/grading/public/condition-index/:slug — one item's curve.
publicGradingRoutes.get("/condition-index/:slug", async (c) => {
  try {
    const curve = await getIndexCurveBySlug(c.req.param("slug"));
    if (!curve) return c.json({ error: "Not found" }, 404);
    return c.json({ curve }, 200, { "Cache-Control": "public, max-age=600, s-maxage=3600" });
  } catch {
    return c.json({ error: "Failed to load curve" }, 500);
  }
});

// ── Value Index (US-1747) ────────────────────────────────────────────
// Brand+item-structured projection of the condition-index curves, backing the
// /value/{brand}/{item}[/{condition}] SEO pages (functions/value/[[path]].ts).
// Same aggregate-only, thin-data-suppressed data as the condition index.

// GET /api/grading/public/value — the value hub (brand/item slugs + headline).
publicGradingRoutes.get("/value", async (c) => {
  try {
    const items = await getValueHub();
    return c.json({ items }, 200, { "Cache-Control": "public, max-age=600, s-maxage=3600" });
  } catch {
    return c.json({ error: "Failed to load value index" }, 500);
  }
});

// GET /api/grading/public/value/:brand/:item — one item's curve + its slugs.
publicGradingRoutes.get("/value/:brand/:item", async (c) => {
  try {
    const resolved = await resolveValueCurve(c.req.param("brand"), c.req.param("item"));
    if (!resolved) return c.json({ error: "Not found" }, 404);
    return c.json(resolved, 200, { "Cache-Control": "public, max-age=600, s-maxage=3600" });
  } catch {
    return c.json({ error: "Failed to load value" }, 500);
  }
});

// ── Durability rankings (US-1774) ────────────────────────────────────────
// Aggregate-only brand durability, backing the /durability SEO pages
// (functions/durability/[[path]].ts). ONLY sample-gated cohorts are returned by
// the lib (durability-index.ts); thin cohorts are never surfaced.

// GET /api/grading/public/durability — the hub (brands ranked by retention).
publicGradingRoutes.get("/durability", async (c) => {
  try {
    const items = await getDurabilityHub();
    return c.json({ items }, 200, { "Cache-Control": "public, max-age=600, s-maxage=3600" });
  } catch {
    return c.json({ error: "Failed to load durability index" }, 500);
  }
});

// ── State of Secondhand Durability report (US-1775) ──────────────────────
// Public, aggregate-only findings (top/bottom brands, weakest factors) for the
// /state-of-durability report page. Cached like the resale-condition report — it
// scans the aggregate table and moves slowly.
const DURABILITY_REPORT_CACHE_TTL_MS = 15 * 60 * 1000;
let durabilityReportCache: { at: number; report: DurabilityReport } | null = null;

// ── Brand ESG export (US-1788) ───────────────────────────────────────────
// Aggregate-only, PII-safe CSV of graded-volume circularity impact by brand, for
// a resale partner's ESG reporting. Brand-level graded volume is a business
// metric, so it is FAIL-CLOSED behind ESG_EXPORT_ENABLED (default off) until an
// operator turns it on for partners; full partner-scoped access ties into the
// B2B API (US-1789+). Cached — it scans grades and moves slowly.
const ESG_CACHE_TTL_MS = 60 * 60 * 1000;
let esgCache: { at: number; rows: BrandEsgRow[] } | null = null;

publicGradingRoutes.get("/esg-export.csv", async (c) => {
  try {
    if (Deno.env.get("ESG_EXPORT_ENABLED") !== "true") return c.json({ error: "Not found" }, 404);
    const now = Date.now();
    if (!esgCache || now - esgCache.at > ESG_CACHE_TTL_MS) {
      esgCache = { at: now, rows: await computeEsgExport() };
    }
    return c.body(toEsgCsv(esgCache.rows), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="gradethread-esg-impact-by-brand.csv"',
      "Cache-Control": "public, max-age=600, s-maxage=3600",
    });
  } catch (err) {
    console.error("public-grading /esg-export:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "Internal error" }, 500);
  }
});

// ── Per-garment circularity impact (US-1787) ─────────────────────────────
// Public, aggregate-only estimate of the impact avoided by buying one garment of
// this type secondhand vs new. No PII, deterministic, cached hard. Backs the
// per-grade impact line on the certificate.
publicGradingRoutes.get("/impact/:garmentType", async (c) => {
  try {
    const impact = await computeGarmentImpact(c.req.param("garmentType"));
    if (!impact) return c.json({ error: "Not found" }, 404);
    return c.json(impact, 200, { "Cache-Control": "public, max-age=3600, s-maxage=86400" });
  } catch {
    return c.json({ error: "Failed to load impact" }, 500);
  }
});

// GET /api/grading/public/durability-report — the report findings.
publicGradingRoutes.get("/durability-report", async (c) => {
  try {
    const now = Date.now();
    if (!durabilityReportCache || now - durabilityReportCache.at > DURABILITY_REPORT_CACHE_TTL_MS) {
      durabilityReportCache = { at: now, report: await computeDurabilityReport() };
    }
    return c.json(durabilityReportCache.report, 200, {
      "Cache-Control": "public, max-age=600, s-maxage=900",
    });
  } catch (err) {
    console.error(
      "public-grading /durability-report:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Internal error" }, 500);
  }
});

// NOTE: keep the parameterized /durability/:brand route LAST so it doesn't
// shadow /durability-report (Hono matches static segments first, but ordering
// makes the intent explicit).
// GET /api/grading/public/durability/:brand — one brand's cohort ranking.
publicGradingRoutes.get("/durability/:brand", async (c) => {
  try {
    const dto = await getDurabilityByBrand(c.req.param("brand"));
    if (!dto) return c.json({ error: "Not found" }, 404);
    return c.json(dto, 200, { "Cache-Control": "public, max-age=600, s-maxage=3600" });
  } catch {
    return c.json({ error: "Failed to load durability" }, 500);
  }
});

// ── Unified-extension entitlements (US-1873) ─────────────────────────
// GET /entitlements — the unified browser extension calls this with its signed
// extension token (Authorization: Bearer) to learn which tools to activate:
// everyone gets the buyer research overlay; the seller Lister unlocks only for an
// ACTIVE PAID FlipDesk account. OPTIONAL auth — no/invalid token returns the
// anonymous default (buyer-only) rather than 401, so a logged-out install still
// works. Tenant-safe by construction: the userId comes from the HMAC-signed token
// (verifyExtensionToken), never from the request, so no cross-tenant read is
// possible. FAIL-SAFE: any lookup error resolves to the anonymous default so a
// hiccup never falsely unlocks seller tools.
publicGradingRoutes.get("/entitlements", async (c) => {
  // US-3051: the read quota rides along, computed from the grade route's own
  // windows (extGradeRemaining) so the popup's "N left" and the 429 agree.
  // Keyed exactly as the grade call is keyed: the attested IP plus the install
  // id header the extension sends on both requests.
  const quota = extGradeRemaining(
    clientIpFor(c),
    c.req.header("x-gt-extension-id")?.trim().slice(0, 64) || null,
    Date.now(),
  );
  const verified = await verifyExtensionToken(bearerFromHeader(c.req.header("authorization")));
  if (!verified) {
    return c.json({ ...ANONYMOUS_EXTENSION_ENTITLEMENTS, quota }, 200, { "Cache-Control": "no-store" });
  }
  try {
    const ent = await getExtensionEntitlements(verified.userId);
    return c.json({ ...ent, quota }, 200, { "Cache-Control": "no-store, private" });
  } catch (err) {
    console.error("public-grading /entitlements:", err instanceof Error ? err.message : String(err));
    return c.json({ ...ANONYMOUS_EXTENSION_ENTITLEMENTS, quota }, 200, { "Cache-Control": "no-store" });
  }
});

// ── Pending cross-listing delists for the extension popup (US-1885 AC1) ──
// GET /pending-delists — the queue of marketplace listings a sale elsewhere has
// ended in our DB but which still need ending in the seller's own browser
// (Poshmark/Mercari/Grailed have no delist API).
//
// This is a second door onto data the SaaS already exposes at
// /api/flipdesk/listings/pending-delists, and it exists because the extension
// speaks a different auth dialect: an HMAC extension token, not a Supabase JWT,
// so it cannot reach the JWT-guarded route. The QUERY is shared
// (lib/pending-delists.ts) precisely so a second door does not become a second
// answer.
//
// TENANCY (US-268): ownerId comes from the HMAC-signed token and NEVER from the
// request — there is no id, no filter and no workspace header a caller can
// supply here, so there is nothing to forge. Note the extension token carries no
// workspace notion, so this deliberately serves the TOKEN HOLDER'S OWN tenant
// only; a workspace member does not see the owner's queue through the extension.
//
// AUTHORIZATION IS ENFORCED HERE, NOT INHERITED FROM THE CLIENT. The extension's
// `delist` capability comes from registry.js, which is fail-safe UI GATING — it
// decides what to draw, not what the holder may read. A token minted before a
// plan lapsed would still say "seller" in the popup, so the seller entitlement
// is re-resolved server-side on every call.
// GET /sync-status — per-channel sold-sync health for the extension popup.
//
// The second door onto lib/sync-status.ts, for the same reason the pending-delists
// route above is a second door onto lib/pending-delists.ts: the extension speaks
// an HMAC extension token, not a Supabase JWT, so it cannot reach the
// JWT-guarded /api/flipdesk/sync/status. The PROJECTION is shared precisely so a
// second door does not become a second answer — a popup that called a channel
// healthy while the web called it failing would make the seller trust neither.
//
// TENANCY (US-268): ownerId comes from the HMAC-signed token and never from the
// request. As with pending-delists, the extension token carries no workspace
// notion, so this serves the TOKEN HOLDER'S OWN tenant only.
//
// AUTHORIZATION IS RE-RESOLVED HERE, not inherited from the popup's registry
// gating: a token minted before a plan lapsed would still draw seller UI.
// ── US-9202: pending revises for the extension (popup count + the drain) ──
//
// GET /pending-revises and POST /revise-confirm are the extension's doors onto
// lib/pending-revises.ts, for the same reason pending-delists has one here: the
// extension speaks an HMAC token, not a Supabase JWT. The read and the state
// machine are shared with the JWT routes so the two doors cannot disagree about
// what is stale or what counts as applied.
//
// TENANCY (US-268): ownerId comes from the signed token and never from the
// request. Serves the token holder's OWN tenant only. Authorization is
// re-resolved here (seller entitlement), not inherited from the popup.
async function extensionSellerId(
  c: { req: { header: (name: string) => string | undefined } },
): Promise<
  { ok: true; userId: string } | { ok: false; status: 401 | 403 | 503; error: string }
> {
  const verified = await verifyExtensionToken(bearerFromHeader(c.req.header("authorization")));
  if (!verified) return { ok: false, status: 401, error: "Sign in to GradeThread first." };
  let ent: { sellerEnabled: boolean };
  try {
    ent = await getExtensionEntitlements(verified.userId);
  } catch (err) {
    console.error(
      "public-grading revise entitlements:",
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, status: 503, error: "Could not verify your plan. Try again." };
  }
  if (!ent.sellerEnabled) return { ok: false, status: 403, error: "FlipDesk plan required." };
  return { ok: true, userId: verified.userId };
}

publicGradingRoutes.get("/pending-revises", async (c) => {
  const who = await extensionSellerId(c);
  if (!who.ok) return c.json({ error: who.error }, who.status, { "Cache-Control": "no-store" });
  const { pending, error } = await loadPendingRevises(who.userId, { limit: 50 });
  if (error) {
    console.error(
      "public-grading /pending-revises:",
      error instanceof Error ? error.message : String(error),
    );
    return c.json({ error: "Could not load pending edits." }, 500, { "Cache-Control": "no-store" });
  }
  return c.json({ pending }, 200, { "Cache-Control": "no-store" });
});

publicGradingRoutes.post("/revise-confirm", async (c) => {
  const who = await extensionSellerId(c);
  if (!who.ok) return c.json({ error: who.error }, who.status, { "Cache-Control": "no-store" });
  let body: { listing_id?: unknown; applied?: unknown; manual?: unknown; unverified?: unknown; error?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const listingId = typeof body.listing_id === "string" ? body.listing_id : "";
  if (!listingId) return c.json({ error: "listing_id is required." }, 400);
  const res = await confirmRevise(who.userId, listingId, {
    applied: body.applied === true,
    manual: body.manual === true,
    unverified: body.unverified === true,
    error: typeof body.error === "string" ? body.error : null,
  });
  if (!res.ok) return c.json({ error: res.error }, res.status);
  return c.json(
    { ok: true, listing_id: listingId, cleared: res.cleared, attempts: res.attempts },
    200,
    { "Cache-Control": "no-store" },
  );
});

// US-9203: the extension's watch saw the relist COPY go live. The new row's
// id came from the server (createRelistDraft) on the job the extension ran;
// the URL is the one the tab navigated to, host-pinned by isLiveListingUrl
// before it was sent. completeRelist owner-scopes the row through its item.
publicGradingRoutes.post("/relist-listed", async (c) => {
  const who = await extensionSellerId(c);
  if (!who.ok) return c.json({ error: who.error }, who.status, { "Cache-Control": "no-store" });
  let body: { new_listing_id?: unknown; listing_url?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const newId = typeof body.new_listing_id === "string" ? body.new_listing_id : "";
  const url = typeof body.listing_url === "string" && /^https:\/\//.test(body.listing_url)
    ? body.listing_url.slice(0, 500)
    : "";
  if (!newId || !url) return c.json({ error: "new_listing_id and an https listing_url are required." }, 400);
  const done = await completeRelist(who.userId, newId, url);
  if (!done.ok) return c.json({ error: done.error }, done.status);
  return c.json(
    { ok: true, listing_id: newId, relisted_from: done.old_listing_id, old_delist_queued: done.old_delist_queued },
    200,
    { "Cache-Control": "no-store" },
  );
});

publicGradingRoutes.get("/sync-status", async (c) => {
  const verified = await verifyExtensionToken(bearerFromHeader(c.req.header("authorization")));
  if (!verified) {
    return c.json({ error: "Sign in to GradeThread to see sync status." }, 401, {
      "Cache-Control": "no-store",
    });
  }

  let ent: { sellerEnabled: boolean };
  try {
    ent = await getExtensionEntitlements(verified.userId);
  } catch (err) {
    // FAIL CLOSED, matching pending-delists: a hiccup here would hand seller
    // data to a caller we could not confirm is entitled to it.
    console.error(
      "public-grading /sync-status entitlements:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Could not verify your plan. Try again." }, 503, {
      "Cache-Control": "no-store",
    });
  }
  if (!ent.sellerEnabled) {
    return c.json({ error: "FlipDesk plan required." }, 403, { "Cache-Control": "no-store" });
  }

  const { channels, error } = await loadSyncStatus(verified.userId);
  if (error) {
    console.error(
      "public-grading /sync-status:",
      error instanceof Error ? error.message : String(error),
    );
    return c.json({ error: "Could not load sync status." }, 500, { "Cache-Control": "no-store" });
  }
  return c.json({ channels }, 200, { "Cache-Control": "no-store" });
});

publicGradingRoutes.get("/pending-delists", async (c) => {
  const verified = await verifyExtensionToken(bearerFromHeader(c.req.header("authorization")));
  // 401, not the anonymous-fallback the entitlements route uses: there is no
  // meaningful anonymous answer to "what are MY pending delists".
  if (!verified) {
    return c.json({ error: "Sign in to GradeThread to see pending delists." }, 401, {
      "Cache-Control": "no-store",
    });
  }

  let ent: { sellerEnabled: boolean };
  try {
    ent = await getExtensionEntitlements(verified.userId);
  } catch (err) {
    // FAIL CLOSED. The entitlements route fails safe to anonymous because a
    // hiccup there costs a shopper their free read; here the same hiccup would
    // hand seller data to a caller we could not confirm is entitled to it.
    console.error(
      "public-grading /pending-delists entitlements:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Could not verify your plan. Try again." }, 503, {
      "Cache-Control": "no-store",
    });
  }
  if (!ent.sellerEnabled) {
    return c.json({ error: "FlipDesk plan required." }, 403, { "Cache-Control": "no-store" });
  }

  const { pending, error } = await loadPendingDelists(verified.userId, { limit: 50 });
  if (error) {
    console.error(
      "public-grading /pending-delists:",
      error instanceof Error ? error.message : String(error),
    );
    return c.json({ error: "Could not load pending delists." }, 500, {
      "Cache-Control": "no-store",
    });
  }
  return c.json({ ok: true, pending }, 200, { "Cache-Control": "no-store, private" });
});

// ── Selector health telemetry (US-1880 AC3) ──────────────────────────
// POST /selector-health — UNAUTHENTICATED, anonymous, opt-in-gated in the
// extension. selectors.js has always claimed broken adapters can be "corrected
// from telemetry"; nothing ever collected any, so a marketplace could change its
// DOM and the only signal was shoppers seeing "couldn't read this listing's
// photos" and saying nothing.
//
// THE SERVER ENFORCES THE PRIVACY PROMISE — it does not merely trust the client.
// A compromised or modified extension must not be able to turn this into a
// browsing-history sink, so the handler accepts a CLOSED VOCABULARY and drops
// everything else: unknown adapter keys, unknown selector-list names, and any
// over-long string are rejected rather than stored. There is deliberately no
// free-text column to write a URL into, and the IP is used for rate limiting
// only — never persisted, never inserted.
const SELECTOR_HEALTH_LISTS = new Set([
  "gallery",
  "gallery-no-urls",
  "title",
  "brand",
  "price",
  "condition",
  // US-2237/US-2239: the newer surfaces fail even more quietly than the gallery.
  // A broken search grid renders NOTHING (the shopper never asked for a scan, so
  // there is no error state to show them), and an unresolvable seller just means
  // the history line never appears — indistinguishable from "you haven't read
  // this seller twice". Neither would ever be reported by a user, so telemetry is
  // the only way they surface at all.
  "search-cards",
  "seller",
]);
// Mirrors the shipped config's adapter keys. A new marketplace adapter must be
// added here too — a closed list is the point, so an unknown key is dropped
// rather than trusted.
const SELECTOR_HEALTH_ADAPTERS = new Set([
  "ebay",
  "poshmark",
  "grailed",
  "mercari",
  "depop",
  "vinted",
]);
const SELECTOR_HEALTH_PER_IP_PER_HOUR = 30;
const SELECTOR_HEALTH_WINDOW_MS = 60 * 60 * 1000;
const selectorHealthHits = new Map<string, number[]>();

// Exported for the edge test: pure shape/vocabulary validation, no IO.
export function parseSelectorHealth(
  body: unknown,
): { adapter: string; emptySelectors: string[]; configVersion: string | null; extVersion: string | null } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  const adapter = typeof b.adapter === "string" ? b.adapter.trim().toLowerCase() : "";
  if (!SELECTOR_HEALTH_ADAPTERS.has(adapter)) return null;

  const raw = Array.isArray(b.emptySelectors) ? b.emptySelectors : [];
  // Closed vocabulary + dedupe. An empty result after filtering is not an error
  // worth reporting on — it carries no signal, so it is rejected.
  const emptySelectors = Array.from(
    new Set(raw.filter((s): s is string => typeof s === "string" && SELECTOR_HEALTH_LISTS.has(s))),
  );
  if (!emptySelectors.length) return null;

  // Version strings are the only free-ish text; hard-capped and charset-limited
  // so neither can smuggle a URL or an identifier.
  const version = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t && t.length <= 32 && /^[\w.\-]+$/.test(t) ? t : null;
  };

  return {
    adapter,
    emptySelectors,
    configVersion: version(b.configVersion),
    extVersion: version(b.extVersion),
  };
}

publicGradingRoutes.post("/selector-health", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = parseSelectorHealth(body);
  // Deliberately a flat 204 on a bad body as well as a good one: this endpoint
  // reports nothing back to an anonymous caller, so it cannot be used to probe
  // which adapters or selector names the server knows about.
  if (!parsed) return c.body(null, 204);

  const ip = clientIpFor(c);
  if (windowLimited(selectorHealthHits, ip, Date.now(), SELECTOR_HEALTH_PER_IP_PER_HOUR, SELECTOR_HEALTH_WINDOW_MS)) {
    return c.body(null, 204);
  }

  try {
    // No owner column, no IP, no instance id — see 00475. Telemetry must never
    // be able to fail a shopper's page, so this is best-effort and swallows.
    await supabaseAdmin.from("selector_health_pings").insert({
      adapter: parsed.adapter,
      empty_selectors: parsed.emptySelectors,
      config_version: parsed.configVersion,
      ext_version: parsed.extVersion,
    });
  } catch (err) {
    console.error("public-grading /selector-health:", err instanceof Error ? err.message : String(err));
  }
  return c.body(null, 204);
});

// ── Extension usage telemetry (US-1757 AC2) ──────────────────────────
// POST /usage — UNAUTHENTICATED, anonymous, opt-in-gated in the extension.
//
// WHAT IT ANSWERS. US-1753 tagged every outbound link, so a SIGNUP can be traced
// to the extension, and a store dashboard reports installs. Between those two
// numbers there was nothing, so "do installs convert to accounts" could not be
// answered — only guessed at from the two ends.
//
// THE SERVER ENFORCES THE PRIVACY PROMISE, exactly as /selector-health does: a
// modified extension must not be able to turn an anonymous tally into a usage
// record. The vocabulary is CLOSED (two events, four surfaces), counts are
// clamped, and there is no free-text column to write a URL or an id into. The IP
// rate-limits and is never persisted.
//
// A ping carries TOTALS, not events — no timestamps, no ordering, no per-listing
// anything (usage-telemetry.js explains why that shape). One row per counter, so
// the query "reads per surface this week" is a plain GROUP BY.
const USAGE_EVENTS = new Set(["read", "click_through"]);
const USAGE_SURFACES = new Set(["popup", "overlay", "flip", "onboarding"]);
// Mirrors GT_USAGE.MAX_COUNT. The client already saturates here; the server
// clamps again because the client's cap is a courtesy, not a guarantee.
const USAGE_MAX_COUNT = 999;
// events × (surfaces + the no-surface form). A structural bound, not a policy —
// a well-formed batch cannot exceed it, so anything longer is junk.
const USAGE_MAX_KEYS = USAGE_EVENTS.size * (USAGE_SURFACES.size + 1);
const USAGE_PER_IP_PER_HOUR = 12;
const USAGE_WINDOW_MS = 60 * 60 * 1000;
const usageHits = new Map<string, number[]>();

export type UsageCounter = { event: string; surface: string | null; count: number };

// Exported for the edge test: pure shape/vocabulary validation, no IO.
export function parseUsagePing(
  body: unknown,
): { counters: UsageCounter[]; extVersion: string | null } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const counts = b.counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return null;

  const entries = Object.entries(counts as Record<string, unknown>);
  if (!entries.length || entries.length > USAGE_MAX_KEYS) return null;

  const counters: UsageCounter[] = [];
  for (const [key, raw] of entries) {
    // "read" or "click_through:overlay" — nothing else parses. Splitting on the
    // FIRST colon only, so a third segment makes the surface unknown and the
    // whole counter is dropped rather than truncated into a valid-looking one.
    const parts = key.split(":");
    if (parts.length > 2) continue;
    const [event, surface] = parts;
    if (!USAGE_EVENTS.has(event)) continue;
    if (surface !== undefined && !USAGE_SURFACES.has(surface)) continue;

    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n <= 0) continue;
    counters.push({
      event,
      surface: surface === undefined ? null : surface,
      count: Math.min(n, USAGE_MAX_COUNT),
    });
  }
  // Nothing survived the vocabulary — no signal, so nothing to record.
  if (!counters.length) return null;

  // The only free-ish text on the wire; hard-capped and charset-limited so it
  // cannot smuggle a URL or an identifier. Same rule as /selector-health.
  const v = typeof b.extVersion === "string" ? b.extVersion.trim() : "";
  const extVersion = v && v.length <= 32 && /^[\w.\-]+$/.test(v) ? v : null;

  return { counters, extVersion };
}

publicGradingRoutes.post("/usage", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = parseUsagePing(body);
  // Flat 204 on a bad body as well as a good one, for the same reason
  // /selector-health does it: an anonymous caller learns nothing about which
  // events or surfaces the server knows about.
  if (!parsed) return c.body(null, 204);

  const ip = clientIpFor(c);
  if (windowLimited(usageHits, ip, Date.now(), USAGE_PER_IP_PER_HOUR, USAGE_WINDOW_MS)) {
    return c.body(null, 204);
  }

  try {
    // No owner column, no IP, no instance id — see 00531. Telemetry must never
    // be able to fail a shopper's page, so this is best-effort and swallows.
    await supabaseAdmin.from("extension_usage_pings").insert(
      parsed.counters.map((counter) => ({
        event: counter.event,
        surface: counter.surface,
        event_count: counter.count,
        ext_version: parsed.extVersion,
      })),
    );
  } catch (err) {
    console.error("public-grading /usage:", err instanceof Error ? err.message : String(err));
  }
  return c.body(null, 204);
});

// ── Free grade-checker tool (US-1687) ────────────────────────────────
// POST /grade-check — UNAUTHENTICATED single-photo ROUGH grade for the
// /tools/grade-checker landing. Reuses the real grader via quickGrade (no
// submission row, certificate, or billing) and hardens the upload
// (validateImageUpload magic-byte sniff + stripImageMetadata, US-276). This is
// a Vision-cost/abuse surface, so it is defended in depth: the body-limit caps
// the request, a per-IP sliding window caps calls here, the shared ai-limiter's
// global daily ceiling caps total Vision spend inside quickGrade, and no image
// or result is ever persisted. The output is explicitly labeled an ESTIMATE.
const GRADE_CHECK_PER_IP_PER_HOUR = 5;
const GRADE_CHECK_WINDOW_MS = 60 * 60 * 1000;
// Tighter than the 10 MB grading default — an anon endpoint takes smaller input.
const GRADE_CHECK_MAX_BYTES = 8 * 1024 * 1024;
// Per-instance sliding window. First-line defense; a durable cross-instance
// counter (like ai-global-daily) is the follow-up if abuse warrants it.
const gradeCheckHits = new Map<string, number[]>();

// US-1883/US-354: the ONLY trustworthy per-IP identifier is the hardened
// clientIp() — it proves the request transited Cloudflare (cf-origin-secret) and
// reads CF-Connecting-IP, which CF overwrites so a caller can't spoof it. The old
// implementation here trusted the client-controlled X-Forwarded-For in
// production, so a direct-to-origin attacker rotated that header to mint an
// unlimited number of distinct per-IP quota buckets (an unmetered-grading bypass
// on grade-check / grade-from-url / authenticity-check). A request with no
// trustworthy IP now collapses to ONE shared sentinel bucket — a degraded
// ceiling, but never unlimited — instead of a spoofable per-header bucket.
export const NO_TRUSTWORTHY_IP = "no-trustworthy-ip";
export function clientIpFor(c: Context): string {
  return clientIp(c) ?? NO_TRUSTWORTHY_IP;
}

// US-1883 (AC3): server-side capacity conditions (the global AI daily ceiling /
// concurrency) return a 503 carrying this machine-readable code + retryable:false
// so the extension renders "GradeThread is at capacity, try later" as a
// NON-retryable state — distinct from a bad-URL 400 (which invited quota-burning
// retries when the AI ceiling was mis-reported as the user's fault).
export const AT_CAPACITY_CODE = "at_capacity";

// US-2526: the machine-readable half of a 429. The free tools rendered every
// non-OK response as a grading failure — "try a clearer, well-lit shot" — so a
// visitor who had simply used the tool three times went and retook a photo that
// was fine. A code lets the page say "limit", not "your photo".
export const RATE_LIMITED_CODE = "rate_limited";
export function atCapacityBody(): { error: string; code: string; retryable: false } {
  return {
    error: "GradeThread is at capacity right now. Please try again later.",
    code: AT_CAPACITY_CODE,
    retryable: false,
  };
}

export function gradeCheckRateLimited(ip: string, now: number): boolean {
  const recent = (gradeCheckHits.get(ip) ?? []).filter((t) => now - t < GRADE_CHECK_WINDOW_MS);
  if (recent.length >= GRADE_CHECK_PER_IP_PER_HOUR) {
    gradeCheckHits.set(ip, recent);
    return true;
  }
  recent.push(now);
  gradeCheckHits.set(ip, recent);
  // Opportunistic cleanup so the map can't grow unbounded across many IPs.
  if (gradeCheckHits.size > 5000) {
    for (const [k, v] of gradeCheckHits) {
      if (v.every((t) => now - t >= GRADE_CHECK_WINDOW_MS)) gradeCheckHits.delete(k);
    }
  }
  return false;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Exported for the edge test — pure decode + validate + strip of a data URL.
export function prepareGradeCheckImage(
  dataUri: unknown,
): { ok: true; cleanDataUri: string } | { ok: false; status: 400; error: string } {
  if (typeof dataUri !== "string" || !dataUri.startsWith("data:image/")) {
    return { ok: false, status: 400, error: "Provide one photo as an image data URL." };
  }
  const comma = dataUri.indexOf(",");
  const b64 = comma >= 0 ? dataUri.slice(comma + 1) : "";
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  } catch {
    return { ok: false, status: 400, error: "That image data couldn't be read." };
  }
  const v = validateImageUpload(bytes, { maxBytes: GRADE_CHECK_MAX_BYTES, allow: ["jpeg", "png", "webp"] });
  if (!v.ok) return { ok: false, status: 400, error: v.reason };
  const { bytes: clean } = stripImageMetadata(bytes, v.format);
  return { ok: true, cleanDataUri: `data:${IMAGE_CONTENT_TYPE[v.format]};base64,${uint8ToBase64(clean)}` };
}

export const GRADE_CHECK_DISCLAIMER =
  "This is a rough estimate from a single photo, not a certified grade. A full " +
  "GradeThread grade uses front, back, label, and detail photos scored across " +
  "five weighted factors, with human review on low-confidence cases.";

// US-1751: the aggregate-only public value shape. Deliberately a subset of the
// internal ValueRange — only platform-wide comp aggregates, never a per-listing
// price or any PII. Returned to an anonymous, no-account caller.
export interface PublicGradeCheckValue {
  lowCents: number;
  medianCents: number;
  highCents: number;
  sampleSize: number;
  confidence: number;
  currency: string;
  /**
   * US-2850. This surface is UNAUTHENTICATED and it is where a stranger meets
   * our numbers for the first time, so it is the last place a range should
   * appear without saying what it is.
   */
  basis?: ValueBasis;
}

// The public tool is gated HARDER than /snap: a range is surfaced only when the
// condition-matched comp sample is statistically sufficient (ValueRange.sufficient),
// otherwise value is null — never a falsely-precise number on an unauthenticated
// surface. Pure so it's unit-testable without eBay.
export function publicValueFromRange(
  range: ValueRange | null | undefined,
): PublicGradeCheckValue | null {
  if (
    !range ||
    !range.sufficient ||
    range.lowCents == null ||
    range.medianCents == null ||
    range.highCents == null
  ) {
    return null;
  }
  return {
    lowCents: range.lowCents,
    medianCents: range.medianCents,
    highCents: range.highCents,
    sampleSize: range.sampleSize,
    confidence: range.confidence,
    currency: range.currency,
    basis: range.basis,
  };
}

publicGradingRoutes.post("/grade-check", async (c) => {
  try {
    const ip = clientIpFor(c);
    if (gradeCheckRateLimited(ip, Date.now())) {
      return c.json(
        { error: "You've reached the free grade-checker limit for now. Try again later.",
          code: RATE_LIMITED_CODE,
        },
        429,
      );
    }
    const body = (await c.req.json().catch(() => null)) as
      | { image?: unknown; brand?: unknown; keyword?: unknown }
      | null;
    const prepared = prepareGradeCheckImage(body?.image);
    if (!prepared.ok) return c.json({ error: prepared.error }, prepared.status);

    const brand = typeof body?.brand === "string" ? body.brand.trim() : undefined;
    const keyword = typeof body?.keyword === "string" ? body.keyword.trim() : undefined;

    const result = await quickGrade({ images: [{ dataUri: prepared.cleanDataUri, type: "detail" }] });

    // US-1751: condition-adjusted resale value — only when brand/keyword lets us
    // identify the item enough to comp it (mirrors grade.ts /snap). Best-effort:
    // a taxonomy/comp hiccup never fails the grade, and the AI daily ceiling +
    // per-IP window above still bound cost. Aggregate-only + sufficiency-gated.
    let value: PublicGradeCheckValue | null = null;
    if (brand || keyword) {
      try {
        const query = [brand, keyword].filter(Boolean).join(" ").trim();
        const cats = await suggestCategories(query);
        const categoryId = cats[0]?.categoryId;
        if (categoryId) {
          const range = await valueAtGrade({ categoryId, q: keyword, brand }, result.overallScore);
          value = publicValueFromRange(range);
        }
      } catch (err) {
        console.error(
          "public-grading /grade-check value:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return c.json(
      {
        estimate: true,
        overallScore: result.overallScore,
        gradeTier: result.gradeTier,
        confidence: result.confidence,
        factorScores: result.factorScores,
        value,
        disclaimer: GRADE_CHECK_DISCLAIMER,
      },
      200,
    );
  } catch (err) {
    // US-1883 (AC3): capacity (global AI ceiling) → distinct non-retryable 503,
    // not a generic 500, so the client stops retrying and burning quota.
    if (err instanceof AiCeilingError) {
      return c.json(atCapacityBody(), 503);
    }
    // US-580: unauthenticated surface — never echo raw error detail.
    console.error(
      "public-grading /grade-check:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json(
      { error: "Couldn't grade that photo. Try a clearer, well-lit shot of the whole item." },
      500,
    );
  }
});

// ── Extension image-URL second-opinion (US-1754) ─────────────────────
// POST /grade-from-url — UNAUTHENTICATED ROUGH grade from image URL(s), for the
// browser extension (US-1755) to show a second opinion on a marketplace listing
// WITHOUT the user uploading files. quickGrade fetches each URL through the SSRF
// guard (safeFetch: private-range blocklist + redirect re-validation + size cap
// + image-content-type check), so a caller-supplied URL can't reach an internal
// host. Defended in depth like /grade-check: CORS is locked to the extension
// origin (EXTENSION_ALLOWED_ORIGINS, in main.ts), a per-IP AND a
// per-extension-instance sliding window cap calls here, the shared ai-limiter's
// global daily ceiling caps Vision spend inside quickGrade, and nothing is
// persisted. The output is explicitly labeled an ESTIMATE.
const EXT_GRADE_PER_IP_PER_HOUR = 20;
const EXT_GRADE_PER_INSTANCE_PER_HOUR = 40;
const EXT_GRADE_WINDOW_MS = 60 * 60 * 1000;
const extIpHits = new Map<string, number[]>();
const extInstanceHits = new Map<string, number[]>();

// Generic per-key sliding-window check with opportunistic map cleanup. Records
// the hit when it is allowed (mutates `map`). Pure w.r.t. `now` for testing.
function windowLimited(
  map: Map<string, number[]>,
  key: string,
  now: number,
  limit: number,
  windowMs: number,
): boolean {
  const recent = (map.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    map.set(key, recent);
    return true;
  }
  recent.push(now);
  map.set(key, recent);
  if (map.size > 5000) {
    for (const [k, v] of map) {
      if (v.every((t) => now - t >= windowMs)) map.delete(k);
    }
  }
  return false;
}

/**
 * Rate-limit a grade-from-url call on BOTH dimensions: the (Cloudflare-attested)
 * client IP and, when the extension sends one, its per-install instance id. The
 * instance id separates a heavy legitimate user's quota from the shared web
 * grade-checker window and lets one abusive install be throttled without
 * penalising a whole NAT'd network. Returns which scope (if any) tripped.
 */
export function extGradeRateLimited(
  ip: string,
  instanceId: string | null,
  now: number,
): { limited: boolean; scope?: "ip" | "instance" } {
  if (windowLimited(extIpHits, ip, now, EXT_GRADE_PER_IP_PER_HOUR, EXT_GRADE_WINDOW_MS)) {
    return { limited: true, scope: "ip" };
  }
  if (
    instanceId &&
    windowLimited(
      extInstanceHits,
      instanceId,
      now,
      EXT_GRADE_PER_INSTANCE_PER_HOUR,
      EXT_GRADE_WINDOW_MS,
    )
  ) {
    return { limited: true, scope: "instance" };
  }
  return { limited: false };
}

// US-3051: how much of the window is left, WITHOUT recording a hit.
//
// The popup and the overlay say "12 of 40 reads left this hour" from this,
// and the only honest source is the same two maps extGradeRateLimited writes
// — a second counter would drift from the one that actually refuses. The
// figures are those of whichever window is TIGHTER right now, since either
// can refuse: for a lone shopper that is the IP window (20/hr) even when an
// install id was sent, because "20 of 40" would name a ceiling they cannot
// reach; the instance window only shows once it is the one closer to refusing.
// `resetsAt` is when the oldest counted hit leaves its window, i.e. the
// earliest moment one more read becomes possible; null when nothing is counted.
export interface ExtGradeQuota {
  remaining: number;
  limit: number;
  resetsAt: string | null;
  windowMs: number;
}

function windowRemaining(
  map: Map<string, number[]>,
  key: string,
  now: number,
  limit: number,
  windowMs: number,
): { remaining: number; oldest: number | null } {
  const recent = (map.get(key) ?? []).filter((t) => now - t < windowMs);
  return {
    remaining: Math.max(0, limit - recent.length),
    oldest: recent.length ? Math.min(...recent) : null,
  };
}

export function extGradeRemaining(
  ip: string,
  instanceId: string | null,
  now: number,
): ExtGradeQuota {
  const byIp = windowRemaining(extIpHits, ip, now, EXT_GRADE_PER_IP_PER_HOUR, EXT_GRADE_WINDOW_MS);
  if (!instanceId) {
    return {
      remaining: byIp.remaining,
      limit: EXT_GRADE_PER_IP_PER_HOUR,
      resetsAt: byIp.oldest === null ? null : new Date(byIp.oldest + EXT_GRADE_WINDOW_MS).toISOString(),
      windowMs: EXT_GRADE_WINDOW_MS,
    };
  }
  const byInst = windowRemaining(
    extInstanceHits,
    instanceId,
    now,
    EXT_GRADE_PER_INSTANCE_PER_HOUR,
    EXT_GRADE_WINDOW_MS,
  );
  const instTighter = byInst.remaining < byIp.remaining;
  const tight = instTighter ? byInst : byIp;
  return {
    remaining: tight.remaining,
    limit: instTighter ? EXT_GRADE_PER_INSTANCE_PER_HOUR : EXT_GRADE_PER_IP_PER_HOUR,
    resetsAt: tight.oldest === null ? null : new Date(tight.oldest + EXT_GRADE_WINDOW_MS).toISOString(),
    windowMs: EXT_GRADE_WINDOW_MS,
  };
}

/**
 * Validate the request body's image URL(s). Accepts `imageUrl` (single) or
 * `imageUrls` (array); every entry must be a well-formed http(s) URL. Caps to
 * EXT_GRADE_MAX_URLS. Pure — exported for the edge test. The SSRF check itself
 * happens later inside quickGrade/safeFetch; this only rejects obvious junk
 * early so a bad request never spends a Vision call.
 */
export function parseGradeFromUrlBody(
  body: unknown,
  maxUrls: number = EXTENSION_MAX_IMAGES_ANON,
): { ok: true; urls: string[] } | { ok: false; error: string } {
  const b = (body ?? {}) as { imageUrl?: unknown; imageUrls?: unknown };
  return parseListingImageUrls(b.imageUrls ?? b.imageUrl, maxUrls, {
    malformed: "Each image must be a valid URL.",
    scheme: "Image URLs must be http(s).",
    empty: "Provide at least one image URL.",
  });
}

function publicSiteUrl(): string {
  return (Deno.env.get("PUBLIC_SITE_URL")?.trim() || "https://gradethread.com").replace(/\/$/, "");
}

// Assign sensible VIEW types to a marketplace listing's scraped gallery photos.
// The extension can't know which photo is which, so it used to send every URL as
// "detail" — which tells the composite grader the set is all close-ups with NO
// primary front/back coverage, so it (correctly, given that framing) docks its
// own confidence_score. Real galleries conventionally LEAD with the hero/front
// shot, then a back/alternate view, then close-ups, so typing the first two as
// front/back gives the grader the primary-angle coverage a listing usually has.
// A "front"/"back" per-image prompt is also a better fit for a full-garment shot
// than "detail" (which narrows the model to stitching/hardware). This changes the
// grader's INPUT framing, not any prompt text and not the post-composite
// confidence policy — the model still reports whatever confidence it earns. Pure;
// exported for the edge test. Never emits more types than there are images.
const GALLERY_VIEW_ORDER = ["front", "back", "detail", "detail_2", "detail_3", "detail_4"];
export function assignGalleryImageTypes(count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(GALLERY_VIEW_ORDER[i] ?? "detail");
  return out;
}

// The "ask the seller for these photos" coverage-gap macro is only worth showing
// when it would actually help: when the read came back low-confidence OR the
// listing had too few photos to cover the item. On a confident read of a
// well-photographed listing, surfacing a full "ask for 7 photos" list reads as
// "this grade is unreliable" when it isn't — so we suppress it. Pure; exported
// for the edge test.
export const COVERAGE_GAP_CONFIDENCE_BAR = 0.75;
export const COVERAGE_GAP_MIN_IMAGES = 3;
export function shouldRequestCoveragePhotos(confidence: number, imagesAnalyzed: number): boolean {
  return confidence < COVERAGE_GAP_CONFIDENCE_BAR || imagesAnalyzed < COVERAGE_GAP_MIN_IMAGES;
}

publicGradingRoutes.post("/grade-from-url", async (c) => {
  try {
    const ip = clientIpFor(c);
    const instanceId = c.req.header("x-gt-extension-id")?.trim().slice(0, 64) || null;
    const gate = extGradeRateLimited(ip, instanceId, Date.now());
    if (gate.limited) {
      return c.json(
        {
          error:
            gate.scope === "instance"
              ? "This extension has reached its grading limit for now. Try again later."
              : "You've reached the grading limit for now. Try again later.",
        code: RATE_LIMITED_CODE,
      },
      429,
      );
    }

    const body = await c.req.json().catch(() => null);

    // US-2241: resolve WHO is calling before parsing, because the photo cap is
    // now theirs. This block used to sit after the grade — it had to move, not
    // just get copied, or the grade would run on a 4-photo slice and the tier
    // would be applied to a decision already made.
    const verified = await verifyExtensionToken(bearerFromHeader(c.req.header("authorization")));
    let ent = null;
    if (verified) {
      try {
        ent = await getBuyerEntitlements(verified.userId);
      } catch { /* entitlement hiccup → treat as anonymous (fail-safe) */ }
    }
    const gates = resolveExtensionGates(ent);

    // US-3042: the eBay path does NOT trust the page. When the caller sends an
    // eBay item id, every gradeable field — photos, title, brand, price, claimed
    // condition — is read from eBay's Browse API here, and whatever the client
    // sent alongside it is ignored.
    //
    // This is the compliance fix, and it is a fix in both directions. eBay's
    // license says their content comes through their API, and a shopper's
    // browser is not their API. It also removes the one place a caller could
    // hand us a title and price that did not match the listing they were
    // pointing at, which is what the over-grade and price-fairness signals are
    // computed against.
    const ebayItemId = (body as { ebayItemId?: unknown })?.ebayItemId;
    let listing: EbayListingRead | null = null;
    if (ebayItemId !== undefined && ebayItemId !== null && ebayItemId !== "") {
      if (!isValidEbayItemId(ebayItemId)) {
        return c.json({ error: "That doesn't look like an eBay item." }, 400);
      }
      listing = await readEbayListingForGrading(ebayItemId.trim(), gates.maxImages);
      if (!listing) {
        // Ended, private, or on a marketplace our keyset cannot read. Say so
        // plainly rather than falling back to client-supplied photos, which is
        // the behaviour this whole branch exists to remove.
        return c.json(
          {
            error:
              "That eBay listing is no longer available, so there is nothing to grade.",
          },
          404,
        );
      }
    }

    const parsed = listing
      ? ({ ok: true, urls: listing.imageUrls } as const)
      : parseGradeFromUrlBody(body, gates.maxImages);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    // Optional garment context from the listing (title/brand) sharpens the grade.
    // eBay's own values win when we have them; they are structured fields from
    // eBay rather than text scraped off a page.
    const brand = listing
      ? (listing.brand?.slice(0, 80) ?? undefined)
      : typeof (body as { brand?: unknown })?.brand === "string"
      ? (body as { brand: string }).brand.trim().slice(0, 80)
      : undefined;
    const title = listing
      ? listing.title.slice(0, 200)
      : typeof (body as { title?: unknown })?.title === "string"
      ? (body as { title: string }).title.trim().slice(0, 200)
      : undefined;

    let result;
    try {
      const viewTypes = assignGalleryImageTypes(parsed.urls.length);
      result = await quickGrade({
        images: parsed.urls.map((url, i) => ({ url, type: viewTypes[i] })),
        garment: { brand: brand ?? null, title: title ?? "" },
      });
    } catch (err) {
      // US-1883 (AC3): a global AI-ceiling / capacity error is OUR limit, not the
      // caller's bad URL — return a distinct, machine-readable 503 the extension
      // renders as non-retryable ("at capacity, try later") so a retry storm
      // doesn't burn quota, instead of the misleading bad-URL 400 below.
      if (err instanceof AiCeilingError) {
        return c.json(atCapacityBody(), 503);
      }
      // A fetch/SSRF/analysis failure on the caller's URL is a 400, not a 500 —
      // the input (an unreachable or non-image URL) is at fault, not the server.
      console.error(
        "public-grading /grade-from-url grade:",
        err instanceof Error ? err.message : String(err),
      );
      return c.json(
        { error: "Couldn't grade that image. Make sure the URL points to a public photo." },
        400,
      );
    }

    // Deep link back to the full experience, with attribution for the funnel.
    const deepLink =
      `${publicSiteUrl()}/tools/grade-checker?utm_source=extension&utm_medium=second-opinion`;

    // US-1834: claimed-vs-objective discrepancy. Parse the seller's stated
    // condition (an eBay conditionId or a free-text label) and score it against
    // our objective grade so the extension can flag over-graded listings.
    // US-3042: on the eBay path the claimed condition is eBay's own conditionId,
    // not a string read off the page. The discrepancy signal is a comparison
    // against what the SELLER declared to eBay, so reading it from anywhere
    // other than eBay was always the weaker source.
    const rawCondition = listing
      ? listing.conditionId ?? listing.conditionLabel
      : (body as { condition?: unknown })?.condition;
    const marketplace = listing
      ? "ebay"
      : typeof (body as { marketplace?: unknown })?.marketplace === "string"
      ? (body as { marketplace: string }).marketplace
      : null;
    const claimedGrade = claimedConditionToGrade(
      typeof rawCondition === "string" || typeof rawCondition === "number" ? rawCondition : null,
      marketplace,
    );
    const discrepancy = scoreDiscrepancy(result.overallScore, claimedGrade);

    // US-1835: condition-normalized fair value (Value Index range at the OBJECTIVE
    // grade) + a price-fairness verdict for the listing's price. Best-effort +
    // sufficiency-gated — thin comps yield value:null, never a fabricated band.
    let value: PublicGradeCheckValue | null = null;
    if (brand || title) {
      try {
        const query = [brand, title].filter(Boolean).join(" ").trim();
        const cats = await suggestCategories(query);
        const categoryId = cats[0]?.categoryId;
        if (categoryId) {
          const range = await valueAtGrade({ categoryId, q: title, brand }, result.overallScore);
          value = publicValueFromRange(range);
        }
      } catch (err) {
        console.error("public-grading /grade-from-url value:", err instanceof Error ? err.message : String(err));
      }
    }
    const fairness = priceFairness(
      listing
        ? listing.priceCents
        : parsePriceCents((body as { price?: unknown })?.price),
      value,
    );
    const fraudFlagsAll = extensionFraudFlagsEnabled() ? deriveFraudFlags(result.imageAuthenticity) : [];

    // US-1838: the tier gates resolved above decide which paid VALUE signals this
    // caller sees. FAIL-SAFE: no/invalid token (anonymous) unlocks only the free
    // basics (grade + coverage advice) and gets a signup prompt with funnel
    // attribution. The base objective grade always returns — it's the hook.
    const signupPrompt = gates.tier === "anonymous"
      ? {
        message: "Sign in to GradeThread to unlock over-grade, price-fairness & fraud signals.",
        url: `${publicSiteUrl()}/signup?utm_source=extension&utm_medium=gate`,
      }
      : null;

    return c.json(
      {
        estimate: true,
        overallScore: result.overallScore,
        gradeTier: result.gradeTier,
        confidence: result.confidence,
        factorScores: result.factorScores,
        imagesAnalyzed: result.imagesAnalyzed,
        tier: gates.tier,
        // US-2241: the extension reads its ceiling from here rather than
        // hardcoding one, so a tier change takes effect without a store update.
        maxImages: gates.maxImages,
        discrepancy: gates.discrepancy ? discrepancy : null,
        value: gates.priceFairness ? value : null,
        priceFairness: gates.priceFairness ? fairness : null,
        fraudFlags: gates.fraud ? fraudFlagsAll : [],
        // US-1837: free basic — the photos worth asking for + a ready-to-send msg.
        // Only when it would help (low confidence or too few photos); a confident
        // read of a well-photographed listing doesn't get the "ask for 7 photos"
        // list, which otherwise reads as "this grade is unreliable".
        coverageGap:
          gates.coverage && shouldRequestCoveragePhotos(result.confidence, result.imagesAnalyzed)
            ? coverageGapForTitle(title)
            : null,
        // US-1839: inline "will it fit me?" — Guard+ entitlement. The fit itself
        // uses the buyer's SAVED body profile on the fit surface (no listing
        // measurements are available inline), so this is an entitled deep-link.
        fit: gates.fit
          ? { available: true, deepLink: `${publicSiteUrl()}/tools/fit-checker?utm_source=extension&utm_medium=fit` }
          : null,
        signupPrompt,
        disclaimer: GRADE_CHECK_DISCLAIMER,
        deepLink,
        // US-3051: what is left after THIS read was counted, so the overlay
        // can say so under the grade without a second request.
        quota: extGradeRemaining(ip, instanceId, Date.now()),
      },
      200,
    );
  } catch (err) {
    // US-580: unauthenticated surface — never echo raw error detail.
    console.error(
      "public-grading /grade-from-url:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Couldn't grade that image right now. Try again later." }, 500);
  }
});

// ── Search-page triage scan (US-2237) ────────────────────────────────────
//
// The extension's overlay reads ONE listing at a time, after a click, on a
// detail page. Every buying decision that matters happens a screen earlier — on
// the search results grid — where it showed nothing at all.
//
// This endpoint is what makes a result grid readable WITHOUT a Vision call per
// card. Grading 24 cards would be 24 Vision calls per scroll; instead it uses
// only the two signals already printed on the card (the seller's CLAIMED
// condition and the asking price) and answers a narrower, honest question:
// "for what the seller SAYS it is, is this price high or low?"
//
// COST SHAPE — the reason this is affordable. Cards are bucketed by the
// conditionId their claimed condition maps to, and comps are fetched ONCE per
// distinct bucket (capped at MAX_SCAN_COMP_BUCKETS), not once per card. The
// per-card work after that is the two PURE functions valueRangeFromStats +
// priceFairness. A 24-card scan costs at most one suggestCategories call plus
// three eBay Browse calls, and ZERO AI actions.
//
// WHAT IT IS NOT: this is not a grade. Nothing here looks at a photo, so the
// response deliberately carries no overallScore/gradeTier/confidence field for
// the extension to render — a number on a card that the buyer read as a
// GradeThread grade would be the worst possible outcome of this feature. The
// per-card `claimedGrade` is explicitly the SELLER's claim expressed on our
// scale, and it is named that way all the way to the DOM.
const SCAN_PER_IP_PER_HOUR = 60;
const SCAN_PER_INSTANCE_PER_HOUR = 120;
const SCAN_WINDOW_MS = 60 * 60 * 1000;
const scanIpHits = new Map<string, number[]>();
const scanInstanceHits = new Map<string, number[]>();

/**
 * Rate-limit a scan on both IP and extension instance. Deliberately its OWN
 * window rather than sharing extGradeRateLimited: a scan costs no Vision call,
 * so charging it against the 20/hr grade budget would let a few scrolls of a
 * search page exhaust the buyer's ability to actually grade anything — the
 * expensive action must not be starved by the cheap one.
 */
export function scanRateLimited(
  ip: string,
  instanceId: string | null,
  now: number,
): { limited: boolean; scope?: "ip" | "instance" } {
  if (windowLimited(scanIpHits, ip, now, SCAN_PER_IP_PER_HOUR, SCAN_WINDOW_MS)) {
    return { limited: true, scope: "ip" };
  }
  if (
    instanceId &&
    windowLimited(scanInstanceHits, instanceId, now, SCAN_PER_INSTANCE_PER_HOUR, SCAN_WINDOW_MS)
  ) {
    return { limited: true, scope: "instance" };
  }
  return { limited: false };
}

// POST /scan — per-card claim + price triage for a marketplace SEARCH page.
// Unauthenticated like /grade-from-url, and cheaper by construction: no Vision
// call, no AI quota, nothing persisted.
publicGradingRoutes.post("/scan", async (c) => {
  try {
    const ip = clientIpFor(c);
    const instanceId = c.req.header("x-gt-extension-id")?.trim().slice(0, 64) || null;
    const gate = scanRateLimited(ip, instanceId, Date.now());
    if (gate.limited) {
      return c.json(
        {
          error: gate.scope === "instance"
            ? "This extension has reached its scan limit for now. Try again later."
            : "You've reached the scan limit for now. Try again later.",
          code: RATE_LIMITED_CODE,
        },
        429,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = parseScanBody(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const marketplace = typeof (body as { marketplace?: unknown })?.marketplace === "string"
      ? (body as { marketplace: string }).marketplace.slice(0, 24)
      : null;

    // One category resolution for the whole grid — every card on a search page
    // is an answer to the same query, so comping them under different categories
    // would be noise, not precision.
    let categoryId: string | undefined;
    const query = [parsed.brand, parsed.query].filter(Boolean).join(" ").trim();
    if (query) {
      try {
        categoryId = (await suggestCategories(query))[0]?.categoryId;
      } catch (err) {
        // Comps are the OPTIONAL half of this response. A category lookup that
        // fails still leaves every card its claimed-condition read, which is the
        // signal a shopper can't get anywhere else — so degrade, never 500.
        console.error(
          "public-grading /scan categories:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const statsByKey = new Map<string, ScanCompStats>();
    if (categoryId) {
      const buckets = bucketScanCards(parsed.cards, marketplace).slice(0, MAX_SCAN_COMP_BUCKETS);
      for (const bucket of buckets) {
        try {
          const { stats } = await searchBrowseComps({
            categoryId,
            q: parsed.query || undefined,
            brand: parsed.brand || undefined,
            conditionId: bucket.conditionId,
            limit: 25,
          });
          for (const key of bucket.keys) statsByKey.set(key, stats);
        } catch (err) {
          // One bucket's comps failing leaves the OTHER buckets priced and every
          // card its claimed-condition read. Degrade per bucket, never per page.
          console.error(
            "public-grading /scan comps:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    return c.json(
      {
        estimate: true,
        // Named so no caller can mistake this for a graded read: the extension
        // asserts on this field before it will render anything.
        signal: "claimed-condition-and-price",
        comped: statsByKey.size > 0,
        // The band builder is injected so lib/extension-scan.ts can stay free of
        // the eBay client. This is the real implementation; the unit test passes
        // its own, which is what makes the decision logic testable at all.
        cards: scanCardResults(
          parsed.cards,
          marketplace,
          statsByKey,
          (stats, claimedGrade) =>
            publicValueFromRange(valueRangeFromStats(stats, claimedGrade, stats.currency)),
        ),
        disclaimer: SCAN_DISCLAIMER,
      },
      200,
    );
  } catch (err) {
    console.error(
      "public-grading /scan:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Couldn't scan this page right now. Try again later." }, 500);
  }
});

// ── Public 'is it authentic?' lookup (US-1771) ───────────────────────────
// UNAUTHENTICATED, ESTIMATE-framed brand-authenticity check for the public
// /tools/authenticity-check tool: a buyer uploads 1–4 photos (data URLs) of an
// item's tags/logo/stitching and gets the grounded authenticity read (US-1769) —
// a buyer-safe verdict + confidence + the mandatory limitations disclaimer.
// Defended in depth like /grade-check: a per-IP window, the shared ai-limiter's
// global daily ceiling (reserveGlobalDailyBudget) caps total Vision spend, the
// body-limit caps input, and NOTHING is persisted. Raw red_flags / tell_findings
// NEVER leave the server — only the coarse verdict is returned.
//
// LIABILITY: a public authenticity verdict is legally sensitive, so the whole
// endpoint is FAIL-CLOSED behind PUBLIC_AUTHENTICITY_CHECK_ENABLED (default off)
// until an operator enables it AFTER legal review of the limitations copy.
const AUTH_CHECK_PER_IP_PER_HOUR = 6;
const AUTH_CHECK_WINDOW_MS = 60 * 60 * 1000;
const AUTH_CHECK_MAX_IMAGES = 4;
const authCheckHits = new Map<string, number[]>();

export function publicAuthenticityCheckEnabled(): boolean {
  return Deno.env.get("PUBLIC_AUTHENTICITY_CHECK_ENABLED") === "true";
}

// Parse + validate the uploaded photos (each through prepareGradeCheckImage:
// magic-byte sniff + EXIF strip). Pure — exported for the edge test.
export function parseAuthenticityCheckBody(
  body: unknown,
): { ok: true; dataUris: string[]; brand?: string; title?: string } | { ok: false; error: string } {
  const b = (body ?? {}) as { images?: unknown; image?: unknown; brand?: unknown; title?: unknown };
  const raw: unknown[] = Array.isArray(b.images)
    ? b.images
    : typeof b.image === "string"
    ? [b.image]
    : [];
  if (raw.length === 0) return { ok: false, error: "Upload at least one clear photo of the item's tags, logo, or stitching." };
  const dataUris: string[] = [];
  for (const entry of raw) {
    const prepared = prepareGradeCheckImage(entry);
    if (!prepared.ok) return { ok: false, error: prepared.error };
    dataUris.push(prepared.cleanDataUri);
    if (dataUris.length >= AUTH_CHECK_MAX_IMAGES) break;
  }
  const brand = typeof b.brand === "string" ? b.brand.trim().slice(0, 80) : undefined;
  const title = typeof b.title === "string" ? b.title.trim().slice(0, 200) : undefined;
  return { ok: true, dataUris, brand, title };
}

publicGradingRoutes.post("/authenticity-check", async (c) => {
  try {
    // Fail-closed until legal-reviewed + operator-enabled. 404 so a disabled
    // surface isn't advertised.
    if (!publicAuthenticityCheckEnabled()) return c.json({ error: "Not found" }, 404);

    // US-2145/US-2133: the env flag is the LEGAL gate — it says a human reviewed
    // the limitations copy. It says nothing about whether the model is any good.
    // This is the ACCURACY gate, and it is deliberately separate: enabling the
    // endpoint after a legal review should not be sufficient to publish verdicts
    // from a prompt version that has never cleared the golden set.
    //
    // Unauthenticated + public + no measured error rate is the combination worth
    // refusing. Authenticated surfaces (the paid add-on, the buyer check) still
    // run ungated — they carry the limitations disclaimer and a named account,
    // which is a different risk posture from an anonymous public claim.
    //
    // 503 + Retry-After rather than 404: the surface exists and is expected back,
    // so a crawler should not deindex the tool page behind it.
    const gate = await authenticityGateStatus(AUTHENTICITY_PROMPT_VERSION_GROUNDED)
      .catch(() => ({ gated: false, reason: "gate check failed" }));
    if (!gate.gated) {
      console.warn(`[public-authenticity] refused — ungated prompt: ${gate.reason ?? "unknown"}`);
      c.header("Retry-After", "3600");
      return c.json(
        {
          error:
            "The authenticity check is temporarily unavailable while we re-validate " +
            "our accuracy. Please try again later.",
        },
        503,
      );
    }

    const ip = clientIpFor(c);
    if (windowLimited(authCheckHits, ip, Date.now(), AUTH_CHECK_PER_IP_PER_HOUR, AUTH_CHECK_WINDOW_MS)) {
      return c.json(
        { error: "You've reached the free authenticity-check limit for now. Try again later.",
        code: RATE_LIMITED_CODE,
      },
      429,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = parseAuthenticityCheckBody(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    // Global Vision-cost ceiling (shared with grading) before spending a call.
    try {
      await reserveGlobalDailyBudget();
    } catch (err) {
      // US-1883 (AC3): shared machine-readable 503 capacity shape across all
      // public grading endpoints (was a bare 429 here).
      if (err instanceof AiCeilingError) {
        return c.json(atCapacityBody(), 503);
      }
      throw err;
    }

    const tells = await getEffectiveTellsForBrand(parsed.brand).catch(() => []);
    const assessment = await assessAuthenticity(
      parsed.dataUris.map((dataUri) => ({ imageType: "detail", dataUri })),
      {
        garment_type: "other",
        garment_category: "other",
        brand: parsed.brand ?? null,
        title: parsed.title ?? "",
        description: null,
        style_attributes: [],
      },
      { tells },
    );

    // US-1771 (AC2): meter the anonymous authenticity call under its own feature.
    if (assessment.usage) {
      void recordAiUsage({
        userId: null,
        submissionId: null,
        feature: "authenticity",
        usages: [{ phase: "authenticity_public", usage: assessment.usage }],
      });
    }

    const deepLink =
      `${publicSiteUrl()}/tools/authenticity-check?utm_source=tool&utm_medium=authenticity`;

    // Buyer-safe projection ONLY — the raw red_flags / tell_findings /
    // supporting_signals stay server-side (never publish accusation detail).
    return c.json(
      {
        estimate: true,
        verdict: assessment.verdict,
        verdictConfidence: assessment.verdict_confidence,
        counterfeitRisk: assessment.counterfeit_risk,
        brandAssessed: assessment.brand_assessed,
        summary: assessment.summary,
        limitations: assessment.limitations,
        deepLink,
      },
      200,
    );
  } catch (err) {
    console.error(
      "public-grading /authenticity-check:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json(
      { error: "Couldn't check that item right now. Try clear, well-lit photos of the tags, logo, and stitching." },
      500,
    );
  }
});

// ── Extension-fed marketplace listing ingestion (US-1808) ────────────────────
//
// THE GAP THIS CLOSES. The alerts engine (condition-alerts.ts) matches saved
// searches against PUBLIC GRADETHREAD CERTIFICATES and nothing else. That is a
// deliberate, privacy-safe universe — and it is also almost none of what a buyer
// shops. So a buyer could describe exactly the jacket they want, then walk past
// it on Grailed with the alert silent. This endpoint lets a listing the buyer is
// LOOKING AT enter the same alerts pipeline: graded, matched, notified.
//
// WHY IT IS A SEPARATE ENDPOINT FROM /grade-from-url. That one is anonymous,
// stateless and persists nothing; this one is authenticated, writes a row, and
// spends a metered buyer action. Folding a write path into the anonymous read
// path would mean the anonymous case had to carry a "not signed in" branch
// through a persistence flow — and the ONE thing that must never regress here is
// that an unauthenticated caller cannot write.
//
// HARDENING, reused rather than reinvented (story AC2):
//   • per-IP + per-install sliding windows, its own budget (a listing ingest
//     spends a Vision call AND a DB write, so it cannot share the scan window);
//   • the monthly `extension_checks` allowance via withBuyerMeter — reserve
//     before the grade, refund if it throws;
//   • a per-buyer DAILY row cap, because the top tiers' monthly allowance is
//     unlimited and "unlimited" must not read as "may be pointed at a catalogue";
//   • SSRF: image URLs are fetched only through quickGrade → safeFetch (private-
//     range blocklist + redirect re-validation + size + content-type cap). The
//     LISTING page itself is never fetched at all;
//   • the global AI daily ceiling inside quickGrade caps total Vision spend.
//
// TENANCY (US-268): `ownerId` is the id inside the HMAC-signed extension token
// and NOTHING else. There is no user id, workspace header or row id anywhere in
// the request for a caller to forge, every query below is `.eq("user_id",
// ownerId)`, and the saved searches evaluated are only ever the token holder's.
const INGEST_PER_IP_PER_HOUR = 10;
const INGEST_PER_INSTANCE_PER_HOUR = 20;
const INGEST_WINDOW_MS = 60 * 60 * 1000;
const ingestIpHits = new Map<string, number[]>();
const ingestInstanceHits = new Map<string, number[]>();

/**
 * US-1808 AC3, the anti-crawl bound. The monthly meter already rations Free
 * (10 extension checks), but Guard and Connoisseur are `-1` — unlimited — and an
 * unlimited monthly allowance would let a scripted client walk a category all
 * night while every individual request looked perfectly legitimate. A daily row
 * cap is what makes "the buyer's own browsing" a number rather than an intention.
 * Well above any human's real browsing; low enough that a crawl hits it in an hour.
 */
export const INGEST_MAX_PER_DAY = 60;

export function ingestRateLimited(
  ip: string,
  instanceId: string | null,
  now: number,
): { limited: boolean; scope?: "ip" | "instance" } {
  if (windowLimited(ingestIpHits, ip, now, INGEST_PER_IP_PER_HOUR, INGEST_WINDOW_MS)) {
    return { limited: true, scope: "ip" };
  }
  if (
    instanceId &&
    windowLimited(ingestInstanceHits, instanceId, now, INGEST_PER_INSTANCE_PER_HOUR, INGEST_WINDOW_MS)
  ) {
    return { limited: true, scope: "instance" };
  }
  return { limited: false };
}

interface IngestMatch {
  searchId: string;
  label: string;
}

/**
 * Evaluate one ingested listing against the buyer's OWN saved searches and emit
 * a condition_alert for each match, through notifyBuyer — the SAME delivery path
 * an on-platform certificate match takes (story AC3), so an ingested match
 * inherits the buyer's channel preferences, quiet hours, plan-capped digest
 * cadence and (userId, dedupeKey) idempotency with no second delivery code path.
 *
 * The plan's `activeAlertsCap` is applied here too, via the same
 * `entitledSearchIds` the cron uses. Without it this endpoint would be a way to
 * get alerts on searches over the cap — the enforcement point would have moved,
 * not been added to.
 */
async function matchIngestedListing(
  ownerId: string,
  listing: IngestListingInput,
  grade: number,
  cap: number,
  featureEnabled: boolean,
): Promise<IngestMatch[]> {
  const { data, error } = await supabaseAdmin
    .from("saved_searches")
    .select(
      "id, user_id, label, brands, categories, keywords, min_grade, max_price_cents, last_matched_at, created_at",
    )
    .eq("user_id", ownerId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(`ingest saved-search load failed: ${error.message}`);

  const searches = (data ?? []) as AlertSearch[];
  const entitled = entitledSearchIds(searches, cap, featureEnabled);

  // An ingested listing carries no garment CATEGORY — marketplaces express it as
  // a breadcrumb we deliberately don't scrape — so a category-constrained search
  // will not match one. Honest under-matching, not a silent wildcard: pretending
  // "unknown" satisfies "must be outerwear" would alert on the wrong items.
  const item: MatchableItem = {
    brand: listing.brand,
    title: listing.title ?? "",
    category: null,
    grade,
  };

  const matches: IngestMatch[] = [];
  for (const search of searches) {
    if (!entitled.has(search.id)) continue;
    if (!matchesSearch(item, search)) continue;
    // The real asking price against the buyer's real ceiling — see
    // priceWithinCeiling on why this is a stronger test than the cert path's.
    if (!priceWithinCeiling(listing.priceCents, search.max_price_cents)) continue;
    matches.push({ searchId: search.id, label: search.label });
  }

  for (const match of matches) {
    await notifyBuyer(ownerId, {
      category: "condition_alert",
      title: "A listing you checked matches your alert",
      body: buildIngestAlertBody(listing, grade),
      // In-app, not the marketplace URL: notify links are rendered inside the
      // buyer app, and the listing itself is carried on `data` for the client.
      link: "/buyer/alerts",
      // One alert per (search, listing) per buyer, forever — re-checking the
      // same item does not re-notify.
      dedupeKey: `ingested-listing:${match.searchId}:${listing.listingUrl}`,
      data: { searchId: match.searchId, listingUrl: listing.listingUrl },
    });
  }
  return matches;
}

publicGradingRoutes.post("/ingest-listing", async (c) => {
  try {
    // AUTHENTICATION FIRST, and no anonymous fallback. /entitlements degrades to
    // an anonymous answer on a bad token because the cost of being wrong there is
    // one shopper's free read; here a fallback would mean an unauthenticated
    // caller writing rows and spending Vision.
    const verified = await verifyExtensionToken(bearerFromHeader(c.req.header("authorization")));
    if (!verified) {
      return c.json(
        { error: "Sign in to GradeThread to check listings against your alerts." },
        401,
        { "Cache-Control": "no-store" },
      );
    }
    const ownerId = verified.userId;

    const ip = clientIpFor(c);
    const instanceId = c.req.header("x-gt-extension-id")?.trim().slice(0, 64) || null;
    const gate = ingestRateLimited(ip, instanceId, Date.now());
    if (gate.limited) {
      return c.json(
        {
          error: gate.scope === "instance"
            ? "This extension has checked too many listings for now. Try again later."
            : "You've checked too many listings for now. Try again later.",
        code: RATE_LIMITED_CODE,
      },
      429,
      );
    }

    // FAIL CLOSED on an entitlements read gap, like /pending-delists: this call
    // spends a metered action and writes a row, so acting on an unverified plan
    // is worse than making the buyer retry.
    let ent;
    try {
      ent = await getBuyerEntitlements(ownerId);
    } catch (err) {
      console.error(
        "public-grading /ingest-listing entitlements:",
        err instanceof Error ? err.message : String(err),
      );
      return c.json({ error: "Could not verify your plan. Try again." }, 503, {
        "Cache-Control": "no-store",
      });
    }
    if (!ent.gateFlags.conditionAlerts) {
      return c.json(
        { error: "upgrade_required", product: "buyer", feature: "conditionAlerts", current_plan: ent.plan },
        402,
      );
    }

    const gates = resolveExtensionGates(ent);
    const rawBody = await c.req.json().catch(() => null);

    // US-3042: on eBay, the listing's content comes from eBay, not from the
    // page. The extension sends only the URL; we replace the photo, title,
    // brand, price and condition fields with what Browse returns before the
    // body is validated, so the SAME validation runs on eBay-sourced values and
    // there is no second code path to keep in step.
    //
    // Anything the client sent in those fields is discarded rather than merged.
    // A merge would leave a caller able to influence the grade's inputs on the
    // one marketplace where we have gone to the trouble of not letting them.
    const ebayHydrated = await hydrateEbayListingBody(rawBody, gates.maxImages);
    if (ebayHydrated.status === "unavailable") {
      return c.json(
        { error: "That eBay listing is no longer available." },
        404,
      );
    }

    const parsed = parseIngestBody(ebayHydrated.body, gates.maxImages);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const listing = parsed.listing;

    // Retention, scoped to this buyer. Done inline on the write path rather than
    // in a cron because it is one indexed delete against one owner's rows, and a
    // table of somebody's browsing should not depend on a separate job being
    // healthy to stop growing. Independent of the cap below (90 days vs 24 hours).
    const cutoff = new Date(Date.now() - INGEST_RETENTION_DAYS * 86_400_000).toISOString();
    await supabaseAdmin
      .from("ingested_listings")
      .delete()
      .eq("user_id", ownerId)
      .lt("created_at", cutoff);

    // A ROLLING 24 hours, not a calendar day: a midnight-resetting counter hands
    // a scripted client two full budgets back to back either side of the reset.
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { count: recentCount } = await supabaseAdmin
      .from("ingested_listings")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ownerId)
      .gte("created_at", since);
    if ((recentCount ?? 0) >= INGEST_MAX_PER_DAY) {
      return c.json(
        {
          error:
            "You've checked a lot of listings today. GradeThread reads listings you're " +
            "browsing, one at a time — try again tomorrow.",
          code: RATE_LIMITED_CODE,
        },
        429,
      );
    }

    // The metered grade. quickGrade fetches ONLY the photo URLs, each through
    // safeFetch's SSRF guard; the listing page is never requested.
    let result;
    try {
      const viewTypes = assignGalleryImageTypes(listing.imageUrls.length);
      result = await withBuyerMeter(
        ownerId,
        "extension_checks",
        ent.allowances.extensionChecksPerMonth,
        () =>
          quickGrade({
            images: listing.imageUrls.map((url, i) => ({ url, type: viewTypes[i] })),
            garment: { brand: listing.brand, title: listing.title ?? "" },
          }),
      );
    } catch (err) {
      if (err instanceof BuyerQuotaExhaustedError) {
        return c.json(
          {
            error: err.message,
            code: "quota_exhausted",
            product: "buyer",
            feature: "extensionChecks",
            current_plan: ent.plan,
          },
          402,
        );
      }
      if (err instanceof AiCeilingError) return c.json(atCapacityBody(), 503);
      console.error(
        "public-grading /ingest-listing grade:",
        err instanceof Error ? err.message : String(err),
      );
      return c.json(
        { error: "Couldn't read this listing's photos. Try again from the listing page." },
        400,
      );
    }

    // US-1834's scorer, persisted: how far the objective grade falls below what
    // the seller claimed. Gated for DISPLAY by tier below, but always stored —
    // it is the buyer's own record of an item they looked at.
    const claimedGrade = claimedConditionToGrade(listing.claimedCondition, listing.marketplace);
    const discrepancy = scoreDiscrepancy(result.overallScore, claimedGrade);

    let matches: IngestMatch[] = [];
    try {
      matches = await matchIngestedListing(
        ownerId,
        listing,
        result.overallScore,
        ent.allowances.activeAlertsCap,
        ent.gateFlags.conditionAlerts,
      );
    } catch (err) {
      // The grade is the thing the buyer is standing there waiting for. A
      // matching failure must not throw it away — degrade to "no matches" and
      // still return the read (and still persist it, so a later run can see it).
      console.error(
        "public-grading /ingest-listing match:",
        err instanceof Error ? err.message : String(err),
      );
    }

    // Upsert on (user_id, listing_url) — re-checking an item the buyer already
    // ingested refreshes that row rather than growing the table.
    const { data: saved, error: saveErr } = await supabaseAdmin
      .from("ingested_listings")
      .upsert(
        {
          user_id: ownerId,
          marketplace: listing.marketplace,
          listing_url: listing.listingUrl,
          title: listing.title,
          brand: listing.brand,
          claimed_condition: listing.claimedCondition,
          price_cents: listing.priceCents,
          thumb_url: listing.imageUrls[0] ?? null,
          images_analyzed: result.imagesAnalyzed,
          overall_score: result.overallScore,
          grade_tier: result.gradeTier,
          confidence: result.confidence,
          factor_scores: result.factorScores,
          claimed_grade: claimedGrade,
          discrepancy,
          matched_search_ids: matches.map((m) => m.searchId),
        } as never,
        { onConflict: "user_id,listing_url" },
      )
      .select("id")
      .maybeSingle();
    if (saveErr) {
      console.error("public-grading /ingest-listing save:", saveErr.message);
    }
    const ingestedId = (saved as { id?: string } | null)?.id ?? null;

    // The buyer asked to keep watching this one. Scoped by user_id and made
    // idempotent by 00416's (user_id, target_type, target_id) unique index.
    if (listing.watch && ingestedId) {
      const { error: watchErr } = await supabaseAdmin
        .from("watchlist_items")
        .upsert(
          {
            user_id: ownerId,
            target_type: "ingested_listing",
            target_id: ingestedId,
            label: listing.title,
            brand: listing.brand,
          } as never,
          { onConflict: "user_id,target_type,target_id" },
        );
      if (watchErr) console.error("public-grading /ingest-listing watch:", watchErr.message);
    }

    // US-1845: the extension check is a metered spend the browser never reports
    // — the extension talks to this endpoint, not to PostHog. Marketplace and
    // plan only; never the listing URL, title or price.
    trackBuyerFeature(ownerId, "extension_check", "listing_checked", {
      marketplace: listing.marketplace,
      buyer_plan: ent.plan,
      matches: matches.length,
      has_discrepancy: discrepancy != null,
      watched: Boolean(listing.watch && ingestedId),
    });

    return c.json(
      {
        ok: true,
        estimate: true,
        ingestedId,
        marketplace: listing.marketplace,
        overallScore: result.overallScore,
        gradeTier: result.gradeTier,
        confidence: result.confidence,
        imagesAnalyzed: result.imagesAnalyzed,
        // Same tier gating as /grade-from-url — the objective grade is the free
        // hook, the claimed-vs-objective read is a paid signal.
        discrepancy: gates.discrepancy ? discrepancy : null,
        matches,
        watched: Boolean(listing.watch && ingestedId),
        disclaimer: GRADE_CHECK_DISCLAIMER,
      },
      200,
      { "Cache-Control": "no-store, private" },
    );
  } catch (err) {
    console.error(
      "public-grading /ingest-listing:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Couldn't check that listing right now. Try again later." }, 500);
  }
});

// ── Free tag reader for /tools/rn-lookup (US-9033) ───────────────────────────
// POST /tag-read — UNAUTHENTICATED single-photo read of a garment care label,
// returning the RN, size, fibre content and style code printed on it.
//
// Defended exactly like /grade-check above, and for the same reason: it is a
// Vision-cost and abuse surface reachable with no account. The body limit caps
// the request, a per-IP sliding window caps calls here, the shared ai-limiter's
// global daily ceiling caps total Vision spend, and NO image is ever persisted.
//
// The one thing it does write is a SIGHTING — the registry key and nothing
// else. That is what makes the lookup pages better the more the tool is used,
// and it carries no image, no IP, no session and no identity. See
// lib/registered-numbers.ts for why a bare count is the honest signal.
const TAG_READ_PER_IP_PER_HOUR = 5;
const TAG_READ_WINDOW_MS = 60 * 60 * 1000;
const tagReadHits = new Map<string, number[]>();

export function tagReadRateLimited(ip: string, now: number): boolean {
  const recent = (tagReadHits.get(ip) ?? []).filter((t) => now - t < TAG_READ_WINDOW_MS);
  if (recent.length >= TAG_READ_PER_IP_PER_HOUR) {
    tagReadHits.set(ip, recent);
    return true;
  }
  recent.push(now);
  tagReadHits.set(ip, recent);
  if (tagReadHits.size > 5000) {
    for (const [k, v] of tagReadHits) {
      if (v.every((t) => now - t >= TAG_READ_WINDOW_MS)) tagReadHits.delete(k);
    }
  }
  return false;
}

/** What the page renders. A field the model could not read is simply absent. */
export interface PublicTagRead {
  rn: string | null;
  size: string | null;
  fiberContent: string | null;
  styleCode: string | null;
  brand: string | null;
}

/** Pure: shape the OCR result for an anonymous caller, dropping confidences
 *  and anything the model was not sure enough about to be worth showing. */
export function publicTagRead(fields: TagGroundTruth): PublicTagRead {
  const pick = (f: TagField | undefined): string | null => {
    const v = (f?.value ?? "").trim();
    if (!v) return null;
    // The same floor the ground-truth merge uses. Below it the model is
    // guessing at smudged text, and a wrong RN sends someone to the wrong
    // company with our name on the answer.
    if ((f?.confidence ?? 0) < TAG_GROUND_TRUTH_MIN_CONFIDENCE) return null;
    return v;
  };
  return {
    rn: pick(fields.rn_number),
    size: pick(fields.size),
    fiberContent: pick(fields.fiber_content),
    styleCode: pick(fields.style_code),
    brand: pick(fields.brand),
  };
}

/** Record the sighting a successful read earns. Pure except for the writer,
 *  which is injected so the rule is testable without a database. */
export async function afterTagRead(
  read: { rn: string | null; brand: string | null },
  opts: { writer?: (args: { registryKey: string; declaredBrand?: string }) => Promise<void> } = {},
): Promise<void> {
  const parsed = parseRegisteredNumber(read.rn);
  // No number on the label is the common case and writes nothing. A sighting
  // is a claim that we SAW this number, so inventing one would poison the
  // count that the lookup page's whole credibility rests on.
  if (!parsed) return;
  // NOT recordRegisteredNumberSighting: that one is the cross-check's path and
  // writes only when the outcome is `no_reference`, so a number we HAVE
  // resolved would never increment. This surface wants the opposite — the
  // count on a resolved number's page is exactly the line nobody else can
  // print. Same RPC underneath, from 00501.
  const writer = opts.writer ??
    (async (args) => {
      const { error } = await supabaseAdmin.rpc("record_registered_number_sighting", {
        p_registry_key: args.registryKey,
        p_kind: parsed.kind,
        p_digits: parsed.digits,
        p_declared_brand: args.declaredBrand ?? null,
      });
      if (error) throw error;
    });
  await writer({
    registryKey: registeredNumberKey(parsed),
    declaredBrand: read.brand ?? undefined,
  });
}

publicGradingRoutes.post("/tag-read", async (c) => {
  try {
    const ip = clientIpFor(c);
    if (tagReadRateLimited(ip, Date.now())) {
      return c.json(
        {
          error: "You've reached the free tag-reader limit for now. Try again later.",
          code: RATE_LIMITED_CODE,
        },
        429,
      );
    }

    const body = (await c.req.json().catch(() => null)) as { image?: unknown } | null;
    const prepared = prepareGradeCheckImage(body?.image);
    if (!prepared.ok) return c.json({ error: prepared.error }, prepared.status);

    try {
      await reserveGlobalDailyBudget();
    } catch (err) {
      if (err instanceof AiCeilingError) return c.json(atCapacityBody(), 503);
      throw err;
    }

    const result = await extractTagGroundTruth([{ url: prepared.cleanDataUri, type: "tag" }]);
    const read = publicTagRead(result.fields);

    // Best-effort. A sighting that fails to write must never cost the reader
    // the answer they came for.
    try {
      await afterTagRead(read);
    } catch (err) {
      console.warn("[tag-read] sighting write failed (ignored):", err);
    }

    return c.json({ ...read, disclaimer: TAG_READ_DISCLAIMER });
  } catch (err) {
    console.error("public-grading /tag-read:", err);
    return c.json({ error: "Couldn't read that tag. Try a straighter, better-lit photo." }, 500);
  }
});

export const TAG_READ_DISCLAIMER =
  "Read from one photo by AI. An RN names the company that made or imported " +
  "the item, never the brand on the tag, and a counterfeit can print a real one.";
