// Catch-all Pages Function for the public Value Index (US-1747).
//   /value                              → hub (every published brand/item)
//   /value/<brand>/<item>               → value-by-grade for that item
//   /value/<brand>/<item>/<condition>   → value at one condition band
//
// A brand+item-structured projection of the Condition Index curves (same data,
// same thin-data suppression) onto exact-match URLs a searcher types. Model B
// (dynamic edge-SSR), NOT the prerender registry, so it's exempt from
// public-routes.test.ts. Mirrors functions/condition-index/[[path]].ts.

import {
  breadcrumbListLd,
  escape,
  faqPageJsonLd,
  fetchJson,
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  formatDate,
  ga4MeasurementId,
  notFoundResponse,
  renderBreadcrumbs,
  renderSsrResponse,
  siteUrl,
  SSR_CACHE_CONTROL,
  twitterSiteHandle,
  type BreadcrumbItem,
  type PagesEnv,
} from "../_shared/blog-render";
import {
  type ConditionCurveLite,
  conditionDatasetLd,
  conditionFaqs,
  dollars,
  renderExampleCertificates,
  renderGradingFactors,
  renderMethodology,
  renderPerGradeSummary,
  valueItemTitle,
  valueProductLd,
} from "../_shared/condition-index-render";
import { headOf } from "../_shared/head-of";

interface HubItem {
  slug: string;
  label: string;
  brand: string;
  brandSlug: string;
  itemSlug: string;
  headlineMedianCents: number | null;
  totalSampleSize: number;
}

interface ResolvedCurve {
  curve: ConditionCurveLite;
  brandSlug: string;
  itemSlug: string;
}

// The public condition bands the /value/.../{condition} URLs address, each
// anchored to a representative grade. Kept in lockstep with CONDITION_TIERS in
// services/edge-functions/src/lib/value-index.ts.
const CONDITION_TIERS: Array<{ slug: string; label: string; grade: number }> = [
  { slug: "new", label: "New / like-new", grade: 9.5 },
  { slug: "excellent", label: "Excellent", grade: 8 },
  { slug: "very-good", label: "Very Good", grade: 6.5 },
  { slug: "good", label: "Good", grade: 5 },
  { slug: "fair", label: "Fair", grade: 4 },
];

function nearestPoint(points: ConditionCurveLite["points"], grade: number) {
  let best: ConditionCurveLite["points"][number] | null = null;
  let bestDist = Infinity;
  for (const p of points) {
    const d = Math.abs(p.grade - grade);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

type Ctx = EventContext<PagesEnv, "path", Record<string, unknown>>;

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");
  const ga = ga4MeasurementId(env);
  const site = siteUrl(env);

  const condMatch = path.match(/^\/value\/([a-z0-9-]+)\/([a-z0-9-]+)\/([a-z0-9-]+)$/i);
  const itemMatch = path.match(/^\/value\/([a-z0-9-]+)\/([a-z0-9-]+)$/i);

  // ── Condition page: /value/<brand>/<item>/<condition> ──────────────
  if (condMatch) {
    const [, brand, item, condition] = condMatch;
    const tier = CONDITION_TIERS.find((t) => t.slug === condition?.toLowerCase());
    if (!brand || !item || !tier) return notFoundResponse(env);
    // US-2044: fetchJson now THROWS UpstreamUnavailable rather than returning
    // null when it could not reach the API — so a transient failure can never
    // again be reported to a crawler as "this page is gone".
    let data: ResolvedCurve | null;
    try {
      data = await fetchJson<ResolvedCurve>(
      env,
      `/api/grading/public/value/${encodeURIComponent(brand)}/${encodeURIComponent(item)}`,
    );
    } catch (e) {
      if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
      throw e;
    }
    if (!data?.curve) return notFoundResponse(env);
    const curve = data.curve;
    const point = nearestPoint(curve.points, tier.grade);
    if (!point) return notFoundResponse(env);

    const canonical = `${site}/value/${data.brandSlug}/${data.itemSlug}/${tier.slug}`;
    const itemUrl = `${site}/value/${data.brandSlug}/${data.itemSlug}`;
    const typical = dollars(point.medianCents);
    const range = `${dollars(point.lowCents)} – ${dollars(point.highCents)}`;

    const trail: BreadcrumbItem[] = [
      { name: "GradeThread", url: `${site}/` },
      { name: "Value Index", url: `${site}/value` },
      { name: curve.label, url: itemUrl },
      { name: tier.label, url: canonical },
    ];

    // Sibling conditions (other bands with comp support) — sideways interlinks.
    const siblingLinks = CONDITION_TIERS.filter(
      (t) => t.slug !== tier.slug && nearestPoint(curve.points, t.grade),
    )
      .map(
        (t) =>
          `<li><a href="/value/${data.brandSlug}/${data.itemSlug}/${t.slug}">${escape(curve.label)} in ${escape(t.label)} condition</a></li>`,
      )
      .join("");

    const body = `${renderBreadcrumbs(trail, site)}
    <main class="container">
      <h1>${escape(curve.label)} value in ${escape(tier.label)} condition</h1>
      <p>A <strong>${escape(curve.label)}</strong> in
      <a href="/grading-standard">${escape(tier.label)}</a> condition is typically worth
      <strong>${typical}</strong> (${range}), from condition-matched resale comps.
      See <a href="${itemUrl.replace(site, "")}">the full value-by-grade breakdown &rarr;</a></p>
      ${renderPerGradeSummary(curve)}
      ${siblingLinks ? `<h2>Other conditions</h2><ul>${siblingLinks}</ul>` : ""}
      ${renderGradingFactors()}
      ${renderExampleCertificates(curve)}
      ${renderMethodology(curve)}
      <p><a href="/tools/grade-checker">Check your item's condition + value free &rarr;</a></p>
    </main>`;

    const productLd = valueProductLd(curve, canonical, {
      conditionLabel: tier.label,
      low: point.lowCents,
      high: point.highCents,
    });
    const faqLd = faqPageJsonLd(conditionFaqs(curve));
    const jsonLd: unknown[] = [
      ...(productLd ? [productLd] : []),
      conditionDatasetLd(curve, canonical, site),
      breadcrumbListLd(trail),
      ...(faqLd ? [faqLd] : []),
    ];

    return renderSsrResponse(
      {
        title: `${curve.label} value in ${tier.label} condition — GradeThread`,
        // US-2847: "comps" here are ACTIVE marketplace listings, so this says
        // "listed at" rather than "worth" or "sells for". eBay Marketplace
        // Insights is ungranted, so no sold price has ever reached this page.
        description: `What a ${curve.label} in ${tier.label} condition is listed at: typically ${typical}, across condition-matched marketplace listings. Updated ${formatDate(curve.refreshedAt)}.`,
        canonicalUrl: canonical,
        bodyHtml: body,
        jsonLd,
        gaMeasurementId: ga,
        twitterSite: twitterSiteHandle(env),
      },
      { cacheControl: SSR_CACHE_CONTROL },
    );
  }

  // ── Item page: /value/<brand>/<item> ──────────────────────────────
  if (itemMatch) {
    const [, brand, item] = itemMatch;
    if (!brand || !item) return notFoundResponse(env);
    // US-2044: fetchJson now THROWS UpstreamUnavailable rather than returning
    // null when it could not reach the API — so a transient failure can never
    // again be reported to a crawler as "this page is gone".
    let data: ResolvedCurve | null;
    try {
      data = await fetchJson<ResolvedCurve>(
      env,
      `/api/grading/public/value/${encodeURIComponent(brand)}/${encodeURIComponent(item)}`,
    );
    } catch (e) {
      if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
      throw e;
    }
    if (!data?.curve) return notFoundResponse(env);
    const curve = data.curve;
    const canonical = `${site}/value/${data.brandSlug}/${data.itemSlug}`;
    const g8 = curve.points.find((p) => p.grade === 8) ?? curve.points[0];
    const headline = g8 ? dollars(g8.medianCents) : "—";

    const rows = [...curve.points]
      .sort((a, b) => b.grade - a.grade)
      .map(
        (p) => `<tr>
          <td><strong>${p.grade.toFixed(1)}</strong></td>
          <td>${dollars(p.lowCents)} – ${dollars(p.highCents)}</td>
          <td>${dollars(p.medianCents)}</td>
          <td>${p.sampleSize}</td>
        </tr>`,
      )
      .join("");

    // Interlink to each condition band that has comp support.
    const condLinks = CONDITION_TIERS.filter((t) => nearestPoint(curve.points, t.grade))
      .map(
        (t) =>
          `<li><a href="/value/${data.brandSlug}/${data.itemSlug}/${t.slug}">${escape(curve.label)} in ${escape(t.label)} condition</a></li>`,
      )
      .join("");

    const trail: BreadcrumbItem[] = [
      { name: "GradeThread", url: `${site}/` },
      { name: "Value Index", url: `${site}/value` },
      { name: curve.label, url: canonical },
    ];

    const body = `${renderBreadcrumbs(trail, site)}
    <main class="container">
      <h1>${escape(curve.label)} resale value</h1>
      <p>What a <strong>${escape(curve.label)}</strong> is worth at each
      <a href="/grading-standard">GradeThread condition grade</a>, from condition-matched resale comps.
      A grade-8 (&ldquo;Excellent&rdquo;) sits around <strong>${headline}</strong>.</p>
      ${renderPerGradeSummary(curve)}
      <h2>Full value-by-grade table</h2>
      <table>
        <thead><tr><th>Grade</th><th>Value range</th><th>Typical</th><th>Comps</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${condLinks ? `<h2>Value by condition</h2><ul>${condLinks}</ul>` : ""}
      ${renderGradingFactors()}
      ${renderExampleCertificates(curve)}
      ${renderMethodology(curve)}
      <p><a href="/condition-index/${escape(curve.slug)}">See this item in the Condition Index &rarr;</a> &middot;
      <a href="/tools/grade-checker">Value your own item free &rarr;</a></p>
    </main>`;

    const productLd = valueProductLd(curve, canonical);
    const faqLd = faqPageJsonLd(conditionFaqs(curve));
    const jsonLd: unknown[] = [
      ...(productLd ? [productLd] : []),
      conditionDatasetLd(curve, canonical, site),
      breadcrumbListLd(trail),
      ...(faqLd ? [faqLd] : []),
    ];

    return renderSsrResponse(
      {
        // US-9017: the old title was `<label> resale value by condition —
        // GradeThread Value Index`, which ran past the ~60-char SERP cap on
        // most labels and spent what was left restating the query. The
        // measured page (/value/nike/tech-fleece: 116 impressions at position
        // 6.5, zero clicks) needs a title promising the number itself.
        title: valueItemTitle(curve.label),
        // US-2847 CORRECTION. This said "from condition-matched SOLD comps
        // rather than asking prices". It was the exact opposite of the truth:
        // the curve is built by searchBrowseComps, which returns ACTIVE
        // listings, and EBAY_MARKETPLACE_INSIGHTS (the only source of realized
        // prices) is off and ungranted. Asking prices are all this has ever had.
        description: `What a used ${curve.label} is listed at across each condition grade, from condition-matched marketplace listings. Updated ${formatDate(curve.refreshedAt)}.`,
        canonicalUrl: canonical,
        bodyHtml: body,
        jsonLd,
        gaMeasurementId: ga,
        twitterSite: twitterSiteHandle(env),
      },
      { cacheControl: SSR_CACHE_CONTROL },
    );
  }

  // ── Hub: /value ────────────────────────────────────────────────────
  if (path === "/value") {
    // US-2044: fetchJson now THROWS UpstreamUnavailable rather than returning
    // null when it could not reach the API — so a transient failure can never
    // again be reported to a crawler as "this page is gone".
    let data: { items: HubItem[] } | null;
    try {
      data = await fetchJson<{ items: HubItem[] }>(env, `/api/grading/public/value`);
    } catch (e) {
      if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
      throw e;
    }
    const items = data?.items ?? [];
    const rows = items
      .map(
        (it) => `<tr>
          <td><a href="/value/${escape(it.brandSlug)}/${escape(it.itemSlug)}">${escape(it.label)}</a></td>
          <td>${it.headlineMedianCents != null ? dollars(it.headlineMedianCents) : "—"}</td>
          <td>${it.totalSampleSize}</td>
        </tr>`,
      )
      .join("");

    // Top brands by total comp depth (distinct, most-covered first).
    const brandDepth = new Map<string, number>();
    for (const it of items) {
      if (it.brand) brandDepth.set(it.brand, (brandDepth.get(it.brand) ?? 0) + it.totalSampleSize);
    }
    const topBrands = [...brandDepth.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([b]) => escape(b));

    const body = `<main class="container">
      <h1>What's It Worth — the Value Index</h1>
      <p>Look up what a specific pre-owned item is worth by <em>condition</em>. We grade and comp
      popular items on <a href="/grading-standard">GradeThread's objective 1.0&ndash;10.0 condition
      standard</a>, so you land on an exact-match answer for the brand and item you searched.</p>
      ${topBrands.length ? `<p class="muted">Popular brands: ${topBrands.join(" &middot; ")}</p>` : ""}
      ${
      items.length === 0
        ? `<p class="muted">The index is warming up — check back soon.</p>`
        : `<table>
            <thead><tr><th>Item</th><th>Value @ grade-8</th><th>Comps</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
    }
      <p class="muted">Aggregate resale estimates from condition-matched listings. Not guaranteed sale prices.</p>
      <p><a href="/tools/grade-checker">Value your own item &rarr;</a> &middot;
      <a href="/condition-index">Browse the Condition Index &rarr;</a></p>
    </main>`;

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "The GradeThread Value Index",
      description:
        // US-2847: same correction as the item pages. These are active listings.
        "Look up what pre-owned clothing is listed at by brand, item and condition — the asking price each grade commands on GradeThread's 1.0–10.0 condition standard, from condition-matched marketplace listings.",
      url: `${site}/value`,
    };

    return renderSsrResponse(
      {
        title: "What's It Worth — the GradeThread Value Index",
        description: "Look up what a specific pre-owned clothing item is worth by condition, from condition-matched resale comps.",
        canonicalUrl: `${site}/value`,
        bodyHtml: body,
        jsonLd: [jsonLd],
        gaMeasurementId: ga,
        twitterSite: twitterSiteHandle(env),
      },
      { cacheControl: SSR_CACHE_CONTROL },
    );
  }

  return notFoundResponse(env);
};

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);
