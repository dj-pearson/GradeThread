import { Hono } from "hono";
import {
  computePublicTransparency,
  type PublicTransparencyReport,
} from "../lib/accuracy-tracking.ts";
import { getIndexCurveBySlug, getIndexHub } from "../lib/condition-index.ts";

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
    return c.json(
      {
        error: "Failed to build transparency report",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
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
