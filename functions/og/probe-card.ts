// US-2619 PROBE — temporary, and here to answer one question.
//
// DELETE THIS FILE once the question is answered. It exists to settle a
// correlation, not to serve anybody.
//
// THE QUESTION. Among the og routes that render in the Pages Function (rather
// than proxying to the Deno edge), exactly one works and four fall back:
//
//   functions/og/grade-check.ts        depth 2   RENDERS
//   functions/og/social/card.ts        depth 3   falls back
//   functions/og/blog/[slug].ts        depth 3   falls back
//   functions/og/verified/[handle].ts  depth 3   falls back
//   functions/og/help/[slug].ts        depth 3   untestable (empty corpus)
//
// Every other axis has been eliminated over five passes: gradients, images and
// data-URIs (present in the WORKING card), the emitted CSS declaration set,
// Satori's multi-child flex rule, font weight, character set, canvas size,
// static-vs-dynamic route, and whether the handler fetches upstream first.
// Module depth is the only difference left standing, and the earlier notes list
// it as ELIMINATED — a verdict reached before this split was visible.
//
// WHY A PROBE RATHER THAN MORE READING. A correlation across five samples is a
// lead, and this story has already had one correlation shipped as a root cause
// and reverted (font weight, 2026-08-15). The way to settle it is to change ONE
// variable: the same template, the same in-Function render, one directory
// shallower. Nothing else differs.
//
//   renders for real  → depth IS the discriminator, and the fix may be as small
//                       as flattening the four routes.
//   falls back        → depth is eliminated for good, and the answer is the
//                       proxy migration the cert and badge routes already use.
//
// SAFETY. Additive and inert: a new public path that renders a fixed card from
// query-free input. It reads nothing, writes nothing, and takes no user data.
// It shares the branded-fallback behaviour of its siblings, so a failure here
// looks like theirs rather than like an error.

import { ImageResponse } from "workers-og";
import {
  brandedFallbackResponse,
  buildSocialCardHtml,
  renderOgImage,
} from "../_shared/og-template";
import { siteUrl, type PagesEnv } from "../_shared/blog-render";
import { headOf } from "../_shared/head-of";

// Deliberately short: a probe that edge-caches for a day cannot be re-run after
// a change, and re-running it is the entire point.
const PROBE_CACHE_CONTROL = "public, max-age=60";

export const onRequestGet: PagesFunction<PagesEnv> = async (context) => {
  const env = context.env;
  try {
    // Byte-for-byte the input /og/social/card gets with no query string, so the
    // ONLY difference between this route and that one is where the file sits.
    const html = buildSocialCardHtml({
      ratio: "landscape",
      kind: "title",
      text: "Verified condition grading for pre-owned clothing",
      stat: null,
      product: "gradethread",
      eyebrow: null,
    });
    return await renderOgImage(
      () => new ImageResponse(html, { width: 1200, height: 630 }),
      { "Cache-Control": PROBE_CACHE_CONTROL },
    );
  } catch (err) {
    console.error("[og/probe-card] render failed:", err);
    return await brandedFallbackResponse(siteUrl(env));
  }
};

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);
