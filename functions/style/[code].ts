// Cloudflare Pages Function: the public Lululemon style-code lookup at
// /style/:code (US-2747). Mirrors functions/cert/[id].ts.
//
// Data comes from the anonymous edge endpoint
// /api/content/public/style-codes/:code, which reads only non-tenant reference
// tables — brand, code, name, provenance. No owner, no item, no seller.
//
// TWO THINGS THIS ROUTE DECIDES:
//
// 1. ONE URL PER GARMENT. A code arrives in four spellings (W6AMYS, LW6AMYS,
//    W6AMYSP60417, LW6AMYSP60417) and every one of them is a real thing to type
//    off a tag. Serving the same answer at four URLs is competing with
//    ourselves, so the non-canonical ones 301 to the canonical style number.
//
// 2. NOINDEX WITHOUT AN ANSWER. The flag comes from the edge payload rather
//    than being recomputed here, so this page and sitemap-style-codes.xml
//    cannot disagree about which URLs exist. See _shared/style-code-render.

import {
  breadcrumbListLd,
  escape,
  fetchJson,
  renderBreadcrumbs,
  renderSsrResponse,
  siteUrl,
  SSR_CACHE_CONTROL,
  twitterSiteHandle,
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  withEdgeCache,
  type PagesEnv,
} from "../_shared/blog-render";
import {
  breadcrumbTrail,
  pageDescription,
  pageTitle,
  type PublicStyleCode,
  renderStyleCodeBody,
  styleCodeLd,
} from "../_shared/style-code-render";
import { headOf } from "../_shared/head-of";

export const onRequestGet: PagesFunction<PagesEnv> = (context) =>
  withEdgeCache(context, () => buildPage(context));

async function buildPage(
  context: Parameters<PagesFunction<PagesEnv>>[0],
): Promise<Response> {
  const env = context.env;
  const site = siteUrl(env);
  const requested = decodeURIComponent(
    (context.params.code as string | undefined) ?? "",
  ).trim();

  let payload: PublicStyleCode | null;
  try {
    payload = await fetchJson<PublicStyleCode>(
      env,
      `/api/content/public/style-codes/${encodeURIComponent(requested)}`,
    );
  } catch (err) {
    // US-2097: an unreachable upstream is OUR problem, not the URL's. A 503
    // keeps the URL alive; a 404 would tell crawlers the page is gone.
    if (err instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
    throw err;
  }

  // The edge rejects anything that is not a style code with a 400, which
  // fetchJson surfaces as a throw, not a null — so a null here means the code
  // is shaped right and simply has no row. That still renders.
  if (!payload) return notAStyleCode(env, site, requested);

  // One URL per garment. 301 rather than 302: the canonical spelling is the
  // permanent home, and a temporary redirect would keep the equity split.
  if (!payload.canonical) {
    return Response.redirect(`${site}/style/${payload.code}`, 301);
  }

  const canonical = `${site}/style/${payload.code}`;
  const trail = breadcrumbTrail(payload, site);
  const productLd = styleCodeLd(payload, canonical);
  const bodyHtml = `${renderBreadcrumbs(trail, site)}${renderStyleCodeBody(payload)}`;

  return renderSsrResponse(
    {
      title: pageTitle(payload),
      description: pageDescription(payload),
      canonicalUrl: canonical,
      twitterSite: twitterSiteHandle(env),
      ogType: "product",
      // No ProductModel node without a name — the repo's rule is that markup
      // never describes data we do not have.
      jsonLd: productLd ? [productLd, breadcrumbListLd(trail)] : [breadcrumbListLd(trail)],
      bodyHtml,
      // THE rule. A code we cannot name has nothing a search result could show,
      // and thousands of those is thin content that costs the whole domain.
      // "noindex, follow" rather than plain noindex: the page still links to
      // /style and the breadcrumb trail, and stranding those is a second
      // mistake on top of the first.
      robots: payload.indexable ? "index, follow" : "noindex, follow",
    },
    { cacheControl: SSR_CACHE_CONTROL },
  );
}

/** A path segment that is not a style code at all. 404, because this URL does
 *  not name anything and never will. */
function notAStyleCode(env: PagesEnv, site: string, requested: string): Response {
  return renderSsrResponse(
    {
      title: "Not a Lululemon style code — GradeThread",
      description:
        "That is not a Lululemon style code. The code is six characters starting with W or M, printed in the size dot.",
      canonicalUrl: `${site}/style`,
      twitterSite: twitterSiteHandle(env),
      bodyHtml: `<article class="style-code">
  <h1>That is not a style code</h1>
  <p class="lede">${escape(requested)} does not look like a Lululemon style code.</p>
  <p>The code is six characters starting with W or M, printed inside the small circle in the pocket, waistband or neckband. <a href="${site}/style">Try another one</a>.</p>
</article>`,
      noindex: true,
    },
    { cacheControl: "no-store", status: 404 },
  );
}

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);
