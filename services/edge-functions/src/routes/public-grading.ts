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
import {
  computeResaleConditionReport,
  type ResaleConditionReport,
} from "../lib/resale-condition.ts";
import { valueAtGrade, type ValueRange } from "../lib/condition-value.ts";
import { suggestCategories } from "../lib/ebay-client.ts";
import { quickGrade } from "../lib/quick-grade.ts";
import { validateImageUpload, IMAGE_CONTENT_TYPE } from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";

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

function clientIpFor(c: Context): string {
  const cf = c.req.header("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const xff = c.req.header("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || "unknown";
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
  };
}

publicGradingRoutes.post("/grade-check", async (c) => {
  try {
    const ip = clientIpFor(c);
    if (gradeCheckRateLimited(ip, Date.now())) {
      return c.json(
        { error: "You've reached the free grade-checker limit for now. Try again later." },
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
const EXT_GRADE_MAX_URLS = 4;
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

/**
 * Validate the request body's image URL(s). Accepts `imageUrl` (single) or
 * `imageUrls` (array); every entry must be a well-formed http(s) URL. Caps to
 * EXT_GRADE_MAX_URLS. Pure — exported for the edge test. The SSRF check itself
 * happens later inside quickGrade/safeFetch; this only rejects obvious junk
 * early so a bad request never spends a Vision call.
 */
export function parseGradeFromUrlBody(
  body: unknown,
): { ok: true; urls: string[] } | { ok: false; error: string } {
  const b = (body ?? {}) as { imageUrl?: unknown; imageUrls?: unknown };
  const raw: unknown[] = Array.isArray(b.imageUrls)
    ? b.imageUrls
    : typeof b.imageUrl === "string"
    ? [b.imageUrl]
    : [];
  const urls: string[] = [];
  for (const u of raw) {
    if (typeof u !== "string") continue;
    const trimmed = u.trim();
    if (!trimmed) continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { ok: false, error: "Each image must be a valid URL." };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, error: "Image URLs must be http(s)." };
    }
    urls.push(trimmed);
    if (urls.length >= EXT_GRADE_MAX_URLS) break;
  }
  if (urls.length === 0) {
    return { ok: false, error: "Provide at least one image URL." };
  }
  return { ok: true, urls };
}

function publicSiteUrl(): string {
  return (Deno.env.get("PUBLIC_SITE_URL")?.trim() || "https://gradethread.com").replace(/\/$/, "");
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
        },
        429,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = parseGradeFromUrlBody(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    // Optional garment context from the listing (title/brand) sharpens the grade.
    const brand = typeof (body as { brand?: unknown })?.brand === "string"
      ? (body as { brand: string }).brand.trim().slice(0, 80)
      : undefined;
    const title = typeof (body as { title?: unknown })?.title === "string"
      ? (body as { title: string }).title.trim().slice(0, 200)
      : undefined;

    let result;
    try {
      result = await quickGrade({
        images: parsed.urls.map((url) => ({ url, type: "detail" })),
        garment: { brand: brand ?? null, title: title ?? "" },
      });
    } catch (err) {
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

    return c.json(
      {
        estimate: true,
        overallScore: result.overallScore,
        gradeTier: result.gradeTier,
        confidence: result.confidence,
        factorScores: result.factorScores,
        imagesAnalyzed: result.imagesAnalyzed,
        disclaimer: GRADE_CHECK_DISCLAIMER,
        deepLink,
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
