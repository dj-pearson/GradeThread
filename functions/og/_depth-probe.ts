// TEMPORARY DIAGNOSTIC — US-2619. Delete once it has answered.
//
// THE QUESTION. Three in-Function OG renderers use the same library the same
// way. /og/grade-check works (proved: different query params produce different
// byte counts — 134022 / 137380 / 139465, so it is really rasterising).
// /og/social/card and /og/blog/:slug both throw, and now degrade to the branded
// fallback since US-2619 made the throw catchable.
//
// Four causes are eliminated from the outside: gradients (all six templates use
// one, including the working one), images (grade-check embeds a data-URI QR),
// any CSS property present in both failures and absent from the success (there
// is none — the diff runs the other way), and character set (the failing
// default text is plain ASCII).
//
// The only structural difference left is DIRECTORY DEPTH. The one renderer that
// works is the only one at the top level of functions/og/. Every nested one
// either fails or has never actually rendered.
//
// So: this file renders the FAILING template from the WORKING depth. It is the
// same buildSocialCardHtml, the same ImageResponse, the same buffering — only
// the module's path differs.
//
//   real bytes  → depth is the cause. Move the renderer up, or proxy it from
//                 the edge the way functions/og/cert/[id].ts already does.
//   fallback    → depth is eliminated too, and the cause is inside the template
//                 or its data rather than anywhere structural.
//
// Stateless, no secrets, no database. Renders one fixed generic card.

import { ImageResponse } from "workers-og";
import { siteUrl, type PagesEnv } from "../_shared/blog-render";
import {
  brandedFallbackResponse,
  buildSocialCardHtml,
  renderOgImage,
  SOCIAL_CARD_SIZES,
} from "../_shared/og-template";

export const onRequestGet: PagesFunction<PagesEnv> = async (context) => {
  const size = SOCIAL_CARD_SIZES.landscape;
  try {
    const html = buildSocialCardHtml({
      ratio: "landscape",
      kind: "title",
      text: "Depth probe for US-2619",
      stat: null,
      product: "gradethread",
      eyebrow: null,
    });
    return await renderOgImage(
      () => new ImageResponse(html, { width: size.width, height: size.height }),
      { "Cache-Control": "no-store" },
    );
  } catch (err) {
    console.error("[og/_depth-probe] render failed:", err);
    return await brandedFallbackResponse(siteUrl(context.env));
  }
};
