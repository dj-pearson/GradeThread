import { Hono } from "hono";
import {
  computePublicStats,
  computePublicTransparency,
  type PublicStats,
  type PublicTransparencyReport,
} from "../lib/accuracy-tracking.ts";
import { getIndexCurveBySlug, getIndexHub } from "../lib/condition-index.ts";
import {
  computeResaleConditionReport,
  type ResaleConditionReport,
} from "../lib/resale-condition.ts";

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
