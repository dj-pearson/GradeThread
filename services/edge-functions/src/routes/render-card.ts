// US-2619: rasterise markup for the Cloudflare Pages og/* routes.
//
// WHY THIS EXISTS. Three share-image endpoints render with workers-og INSIDE a
// Pages Function and always fall back: /og/social/card, /og/blog/:slug and
// /og/verified/:handle. Eleven causes were eliminated, ending with the decisive
// one — the same markup fed to satori 0.15.2 with satori-html and the bundled
// Inter faces produces valid SVG for all three (42536, 46025 and 67940 chars).
// So the markup is fine and the failure is downstream of layout, inside
// workers-og in the Worker. og/cert, slab/cert and badge/cert hit the same wall
// and were fixed by rendering here and streaming the bytes back; six files carry
// that paragraph. This is that remedy, generalised.
//
// THE SPLIT IS DELIBERATE. The Pages Function keeps building its own markup —
// that is cheap string work and it keeps every card single-sourced in
// functions/_shared/og-template.ts. Only the raster moves. The alternative,
// re-authoring each layout here, is what left three builders dead on the Pages
// side (src/test/og-template-builders-wired.test.ts records them).
//
// ⚠ AUTH FAILS CLOSED, and that is the whole security story. This takes markup
// from the caller and rasterises it, so an open version is compute
// amplification. It gates on requirePagesOrigin — NOT pagesOriginBypass, which
// returns false when the secret is unset and would leave the route reachable by
// anyone in exactly the configuration production sat in until 2026-08-16.
//
// Satori itself never fetches remote resources (the slab pre-fetches its hero
// photo to a data URI precisely so it does not), so caller-supplied markup
// carries no SSRF surface here. The caps below are about compute, not fetching.

import { Hono } from "hono";
import { renderPng } from "../lib/cert-image-render.ts";
import { requirePagesOrigin } from "../middleware/rate-limit.ts";
import { captureException } from "../lib/observability.ts";

export const renderCardRoutes = new Hono();

/**
 * Caps. Generous against the real cards (the largest today is a ~2.8 KB markup
 * string at 1200x630) and tight enough that a leaked secret buys an attacker
 * bounded work rather than a rasteriser.
 */
export const MAX_MARKUP_BYTES = 64 * 1024;
export const MAX_DIMENSION = 2400;
export const MIN_DIMENSION = 16;

const PNG_CACHE_CONTROL = "public, max-age=86400, s-maxage=86400";

export interface RenderCardBody {
  markup?: unknown;
  width?: unknown;
  height?: unknown;
}

/**
 * Validate a request body. Pure, so the rules are testable without a server —
 * and the rules ARE the security surface, so they should not need one.
 */
export function validateRenderCardBody(
  body: RenderCardBody,
): { ok: true; markup: string; width: number; height: number } | { ok: false; error: string } {
  const { markup, width, height } = body;
  if (typeof markup !== "string" || markup.trim().length === 0) {
    return { ok: false, error: "markup (non-empty string) is required" };
  }
  // Byte length, not string length: a card of astrological symbols is bigger
  // than it looks, and the cap is about work rather than characters.
  const bytes = new TextEncoder().encode(markup).length;
  if (bytes > MAX_MARKUP_BYTES) {
    return { ok: false, error: `markup exceeds ${MAX_MARKUP_BYTES} bytes` };
  }
  for (const [name, v] of [["width", width], ["height", height]] as const) {
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
      return { ok: false, error: `${name} (integer) is required` };
    }
    if (v < MIN_DIMENSION || v > MAX_DIMENSION) {
      return { ok: false, error: `${name} must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}` };
    }
  }
  return { ok: true, markup, width: width as number, height: height as number };
}

renderCardRoutes.post("/render-card", async (c) => {
  // The gate comes FIRST, before the body is even read: a caller who cannot
  // authenticate should not be able to make this service parse a 64 KB payload.
  if (!requirePagesOrigin(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: RenderCardBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = validateRenderCardBody(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  try {
    const png = await renderPng(parsed.markup, parsed.width, parsed.height);
    // `new Uint8Array(png)` rather than `png`: the same wrapping every other
    // cert-image route uses. Deno's BodyInit does not accept a
    // Uint8Array<ArrayBufferLike> directly, and the re-wrap gives it a plain
    // ArrayBuffer view.
    return new Response(new Uint8Array(png), {
      status: 200,
      headers: { "Content-Type": "image/png", "Cache-Control": PNG_CACHE_CONTROL },
    });
  } catch (err) {
    // The caller's own branded fallback handles the failure; what matters here
    // is that the exception is RECORDED, because the whole reason this story
    // took eleven eliminations is that the original throw was invisible.
    captureException(err, { route: "render-card" });
    console.error("[render-card] render failed:", err);
    return c.json({ error: "Render failed" }, 500);
  }
});
