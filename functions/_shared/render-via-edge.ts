// US-2619: render a card by asking the Deno edge to rasterise our markup.
//
// WHY. Three og routes render with workers-og INSIDE the Pages Function and
// always fall back: /og/social/card, /og/blog/:slug, /og/verified/:handle. The
// markup is not the problem — fed to satori 0.15.2 with satori-html and the
// bundled Inter faces it produces valid SVG for all three, so the failure is
// downstream of layout, inside workers-og in the Worker. og/cert, slab/cert and
// badge/cert hit the same wall and were fixed by rendering on the edge and
// streaming the bytes; six files carry that paragraph.
//
// WHAT MOVES, AND WHAT DOES NOT. Only the raster. The Pages Function still
// builds its own markup, so every card stays single-sourced in
// `og-template.ts`. Re-authoring layouts on the edge is what left
// buildCertOgHtml, buildCertSlabHtml and buildCertBadgeHtml dead on this side
// (src/test/og-template-builders-wired.test.ts records them).
//
// SAFE BEFORE THE SECRET LANDS. The edge route refuses unless
// `CF_PAGES_ORIGIN_SECRET` matches on BOTH sides (US-2612), and the Pages half
// is not set yet. Until it is, every call here 401s and we return the branded
// fallback — which is exactly what these three routes already serve today. So
// the worst case of shipping this early is the status quo, and the best case is
// that it starts working the moment the secret is set.

import { edgeApi, siteUrl, type PagesEnv } from "./blog-render";
import { brandedFallbackResponse } from "./og-template";

/** Give up rather than hold a crawler open; the fallback is cheap and instant. */
const RENDER_TIMEOUT_MS = 8000;

export interface RenderViaEdgeInput {
  markup: string;
  width: number;
  height: number;
  /** Cache-Control for a successful render. The fallback sets its own. */
  cacheControl: string;
  /** Names the endpoint in the log line, so a failure says WHICH card. */
  label: string;
}

/**
 * POST the markup to the edge and stream the PNG back. On any failure at all —
 * unreachable, 401 because the secret is not set on both sides yet, 500, empty
 * body — return the branded fallback rather than a broken image.
 */
export async function renderViaEdge(
  env: PagesEnv,
  input: RenderViaEdgeInput,
): Promise<Response> {
  const { markup, width, height, cacheControl, label } = input;
  const secret = env.CF_PAGES_ORIGIN_SECRET?.trim();

  // No secret on THIS side means the edge would refuse us anyway. Skip the
  // round trip and say so once, rather than logging a 401 per request.
  if (!secret) {
    console.warn(
      `[${label}] CF_PAGES_ORIGIN_SECRET is not set on the Pages project, so the ` +
        "edge renderer cannot be called (US-2612). Serving the branded fallback.",
    );
    return await brandedFallbackResponse(siteUrl(env));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    const res = await fetch(`${edgeApi(env)}/api/content/public/render-card`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pages-origin": secret,
      },
      body: JSON.stringify({ markup, width, height }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[${label}] edge render failed: HTTP ${res.status}`);
      return await brandedFallbackResponse(siteUrl(env));
    }
    // Buffer before responding. A streamed body that fails mid-flight lands
    // AFTER the Response is constructed, which is the US-2620 defect that let
    // an empty PNG leave as a 200 in the first place.
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) {
      console.error(`[${label}] edge render produced 0 bytes`);
      return await brandedFallbackResponse(siteUrl(env));
    }
    return new Response(buf, {
      status: 200,
      headers: { "Content-Type": "image/png", "Cache-Control": cacheControl },
    });
  } catch (err) {
    console.error(`[${label}] edge render errored:`, err);
    return await brandedFallbackResponse(siteUrl(env));
  } finally {
    clearTimeout(timer);
  }
}
