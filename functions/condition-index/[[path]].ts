// Catch-all Pages Function for the public Condition Index (US-621).
//   /condition-index          → hub (every curated item)
//   /condition-index/<slug>   → one item's price-vs-grade curve
//
// Edge-SSR'd (like /blog) so the pages are crawlable with real, honest data
// pulled from the edge API. Thin curves are suppressed upstream (US-622). Only
// fires for /condition-index/*; the SPA + static assets are unaffected.

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
  conditionDatasetLd,
  conditionFaqs,
  type ExampleCert,
  renderExampleCertificates,
  renderGradingFactors,
  renderMethodology,
  renderPerGradeSummary,
} from "../_shared/condition-index-render";
import { headOf } from "../_shared/head-of";

interface HubItem {
  slug: string;
  label: string;
  brand: string;
  currency: string;
  headlineMedianCents: number | null;
  totalSampleSize: number;
  refreshedAt: string;
}

interface CurvePoint {
  grade: number;
  lowCents: number | null;
  medianCents: number | null;
  highCents: number | null;
  sampleSize: number;
}

interface CurveDto {
  slug: string;
  label: string;
  brand: string;
  categoryId: string;
  currency: string;
  points: CurvePoint[];
  totalSampleSize: number;
  refreshedAt: string;
  // US-847: a few real public certificates of this item (best-effort, may be []).
  examples?: ExampleCert[];
}

function dollars(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(0)}`;
}

type Ctx = EventContext<PagesEnv, "path", Record<string, unknown>>;

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");
  const ga = ga4MeasurementId(env);
  const site = siteUrl(env);

  // Detail page: /condition-index/<slug>
  const detailMatch = path.match(/^\/condition-index\/([a-z0-9-]+)$/i);
  if (detailMatch) {
    const slug = detailMatch[1];
    if (!slug) return notFoundResponse(env);
    // US-2044: fetchJson now THROWS UpstreamUnavailable rather than returning
    // null when it could not reach the API — so a transient failure can never
    // again be reported to a crawler as "this page is gone".
    let data: { curve: CurveDto } | null;
    try {
      data = await fetchJson<{ curve: CurveDto }>(
      env,
      `/api/grading/public/condition-index/${encodeURIComponent(slug)}`,
    );
    } catch (e) {
      if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
      throw e;
    }
    if (!data?.curve) return notFoundResponse(env);
    const curve = data.curve;
    const canonical = `${site}/condition-index/${slug}`;
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

    const trail: BreadcrumbItem[] = [
      { name: "GradeThread", url: `${site}/` },
      { name: "Condition Index", url: `${site}/condition-index` },
      { name: curve.label, url: canonical },
    ];

    const body = `${renderBreadcrumbs(trail, site)}
    <main class="container">
      <h1>${escape(curve.label)} — value by condition</h1>
      <p>What a <strong>${escape(curve.label)}</strong> is worth at each
      <a href="/grading-standard">GradeThread condition grade</a>, from condition-matched resale comps.
      A grade-8 (&ldquo;Excellent&rdquo;) sits around <strong>${headline}</strong>.</p>
      ${renderPerGradeSummary(curve)}
      <h2>Full value-by-grade table</h2>
      <table>
        <thead><tr><th>Grade</th><th>Value range</th><th>Typical</th><th>Comps</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${renderGradingFactors()}
      ${renderExampleCertificates(curve)}
      ${renderMethodology(curve)}
      <p><a href="/snap">What's your item worth? &rarr;</a></p>
    </main>`;

    const faqLd = faqPageJsonLd(conditionFaqs(curve));
    const jsonLd: unknown[] = [
      conditionDatasetLd(curve, canonical, site),
      breadcrumbListLd(trail),
      ...(faqLd ? [faqLd] : []),
    ];

    return renderSsrResponse(
      {
        title: `${curve.label} resale value by condition — GradeThread Condition Index`,
        description: `What a ${curve.label} sells for at each condition grade, from condition-matched comps. Updated ${formatDate(curve.refreshedAt)}.`,
        canonicalUrl: canonical,
        bodyHtml: body,
        jsonLd,
        gaMeasurementId: ga,
        twitterSite: twitterSiteHandle(env),
      },
      { cacheControl: SSR_CACHE_CONTROL },
    );
  }

  // Hub page: /condition-index
  if (path === "/condition-index") {
    // US-2044: fetchJson now THROWS UpstreamUnavailable rather than returning
    // null when it could not reach the API — so a transient failure can never
    // again be reported to a crawler as "this page is gone".
    let data: { items: HubItem[] } | null;
    try {
      data = await fetchJson<{ items: HubItem[] }>(env, `/api/grading/public/condition-index`);
    } catch (e) {
      if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
      throw e;
    }
    const items = data?.items ?? [];
    const rows = items
      .map(
        (it) => `<tr>
          <td><a href="/condition-index/${escape(it.slug)}">${escape(it.label)}</a></td>
          <td>${it.headlineMedianCents != null ? dollars(it.headlineMedianCents) : "—"}</td>
          <td>${it.totalSampleSize}</td>
        </tr>`,
      )
      .join("");

    const body = `<main class="container">
      <h1>The Condition Index</h1>
      <p>The Condition Index is the record of what pre-owned clothing is really worth &mdash; by
      <em>condition</em>. We grade and comp popular items on
      <a href="/grading-standard">GradeThread's objective 1.0&ndash;10.0 condition standard</a>, so you
      can see exactly how much a grade-9 is worth versus a grade-6 &mdash; the resale value each grade
      commands, from condition-matched marketplace listings.</p>
      ${items.length === 0
        ? `<p class="muted">The index is warming up — check back soon.</p>`
        : `<table>
            <thead><tr><th>Item</th><th>Value @ grade-8</th><th>Comps</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
      <p class="muted">Aggregate resale estimates from condition-matched listings. Not guaranteed sale prices.</p>
      <p><a href="/snap">Value your own item &rarr;</a> &middot;
      <a href="/flipdesk">Price your inventory to these comps with FlipDesk &rarr;</a></p>
    </main>`;

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "The GradeThread Condition Index",
      description:
        // US-2847: these curves are built from ACTIVE Browse listings.
        // Marketplace Insights is ungranted, so "sold comps" was never true.
        "The record of asking price for pre-owned clothing by objective condition grade — what each item is listed at, at each grade on GradeThread's 1.0–10.0 condition standard, from condition-matched marketplace listings.",
      url: `${site}/condition-index`,
    };

    return renderSsrResponse(
      {
        title: "The Condition Index — what used clothing is worth by condition · GradeThread",
        description: "See how much popular pre-owned clothing is worth at each condition grade, from condition-matched resale comps.",
        canonicalUrl: `${site}/condition-index`,
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
