// Cloudflare Pages Function: the public RN lookup at /rn/:number (US-9031).
// Mirrors functions/style/[code].ts.
//
// Data comes from the anonymous edge endpoint
// /api/content/public/registered-numbers/:number, which reads only non-tenant
// reference tables — the registry and the sighting count. No owner, no item,
// no seller.
//
// TWO THINGS THIS ROUTE DECIDES:
//
// 1. ONE URL PER NUMBER. A number arrives off a label in several spellings
//    (56323, RN56323, "RN 56323", 056323) and every one of them is a real
//    thing to type. Serving one answer at four URLs is competing with
//    ourselves, so the non-canonical ones 301 to the digits.
//
// 2. NOINDEX WITHOUT AN ANSWER. The flag comes from the edge payload rather
//    than being recomputed here, so this page and sitemap-rn.xml cannot
//    disagree about which URLs exist. See _shared/rn-render.

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
  type PublicRegisteredNumber,
  renderRnBody,
  rnLd,
} from "../_shared/rn-render";
import { headOf } from "../_shared/head-of";

export const onRequestGet: PagesFunction<PagesEnv> = (context) =>
  withEdgeCache(context, () => buildPage(context));

async function buildPage(
  context: Parameters<PagesFunction<PagesEnv>>[0],
): Promise<Response> {
  const env = context.env;
  const site = siteUrl(env);
  const requested = decodeURIComponent(
    (context.params.number as string | undefined) ?? "",
  ).trim();

  let payload: PublicRegisteredNumber | null;
  try {
    payload = await fetchJson<PublicRegisteredNumber>(
      env,
      `/api/content/public/registered-numbers/${encodeURIComponent(requested)}`,
    );
  } catch (err) {
    // US-2097: an unreachable upstream is OUR problem, not the URL's. A 503
    // keeps the URL alive; a 404 would tell crawlers the page is gone.
    if (err instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
    throw err;
  }

  // The edge rejects anything that is not a registry number with a 400, which
  // fetchJson surfaces as a throw rather than a null. A null here would mean a
  // well-formed number with no row, and that still renders.
  if (!payload) return notARegisteredNumber(env, site, requested);

  // One URL per number. 301 rather than 302: the digits are the permanent home,
  // and a temporary redirect would keep the equity split.
  if (!payload.canonical) {
    return Response.redirect(`${site}/rn/${payload.digits}`, 301);
  }

  const canonical = `${site}/rn/${payload.digits}`;
  const trail = breadcrumbTrail(payload, site);
  const orgLd = rnLd(payload, canonical);
  const bodyHtml = `${renderBreadcrumbs(trail, site)}${renderRnBody(payload)}`;

  return renderSsrResponse(
    {
      title: pageTitle(payload),
      description: pageDescription(payload),
      canonicalUrl: canonical,
      twitterSite: twitterSiteHandle(env),
      // No Organization node without a company — the repo's rule is that
      // markup never describes data we do not have.
      jsonLd: orgLd ? [orgLd, breadcrumbListLd(trail)] : [breadcrumbListLd(trail)],
      bodyHtml,
      // THE rule. A number we cannot name has nothing a search result could
      // show, and thousands of those is thin content that costs the whole
      // domain. "noindex, follow" rather than plain noindex: the page still
      // links to the hub and the breadcrumb trail, and stranding those is a
      // second mistake on top of the first.
      robots: payload.indexable ? "index, follow" : "noindex, follow",
    },
    { cacheControl: SSR_CACHE_CONTROL },
  );
}

/** A path segment that is not a registry number at all. 404, because this URL
 *  does not name anything and never will. */
function notARegisteredNumber(env: PagesEnv, site: string, requested: string): Response {
  return renderSsrResponse(
    {
      title: "Not a registered identification number — GradeThread",
      description:
        "That is not an RN or CA number. The number is printed on the care label as RN or CA followed by two to seven digits.",
      canonicalUrl: `${site}/tools/rn-lookup`,
      twitterSite: twitterSiteHandle(env),
      bodyHtml: `<article class="rn-lookup">
  <h1>That is not a registered number</h1>
  <p class="lede">${escape(requested)} does not look like an RN or CA number.</p>
  <p>The number is printed on the care label, usually beside the fabric content: "RN" or "CA" followed by two to seven digits. <a href="${site}/tools/rn-lookup">Try another one</a>.</p>
</article>`,
      noindex: true,
    },
    { cacheControl: "no-store", status: 404 },
  );
}

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);
