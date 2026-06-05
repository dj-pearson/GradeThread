// Catch-all Pages Function for the public Condition Index (US-621).
//   /condition-index          → hub (every curated item)
//   /condition-index/<slug>   → one item's price-vs-grade curve
//
// Edge-SSR'd (like /blog) so the pages are crawlable with real, honest data
// pulled from the edge API. Thin curves are suppressed upstream (US-622). Only
// fires for /condition-index/*; the SPA + static assets are unaffected.

import {
  escape,
  fetchJson,
  formatDate,
  ga4MeasurementId,
  notFoundResponse,
  renderLayout,
  siteUrl,
  SSR_CACHE_CONTROL,
  type PagesEnv,
} from "../_shared/blog-render";

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
    const data = await fetchJson<{ curve: CurveDto }>(
      env,
      `/api/grading/public/condition-index/${encodeURIComponent(slug)}`,
    );
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

    const body = `<main class="container">
      <p class="muted"><a href="/condition-index">← Condition Index</a></p>
      <h1>${escape(curve.label)} — value by condition</h1>
      <p>What a <strong>${escape(curve.label)}</strong> is worth at each GradeThread condition grade,
      from condition-matched resale comps. A grade-8 (&ldquo;Excellent&rdquo;) sits around <strong>${headline}</strong>.</p>
      <table>
        <thead><tr><th>Grade</th><th>Value range</th><th>Typical</th><th>Comps</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="muted">Estimates from ${curve.totalSampleSize} condition-matched listings ·
      updated ${formatDate(curve.refreshedAt)} · not a guaranteed sale price.
      Grades are GradeThread's objective 1.0&ndash;10.0 condition scale.</p>
      <p><a href="/snap">What's your item worth? &rarr;</a></p>
    </main>`;

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "Dataset",
      name: `${curve.label} — condition value index`,
      description: `Price-vs-condition resale value for ${curve.label}, by GradeThread grade.`,
      url: canonical,
      creator: { "@type": "Organization", name: "GradeThread" },
      dateModified: curve.refreshedAt,
      isAccessibleForFree: true,
    };

    return new Response(
      renderLayout({
        title: `${curve.label} resale value by condition — GradeThread Condition Index`,
        description: `What a ${curve.label} sells for at each condition grade, from condition-matched comps. Updated ${formatDate(curve.refreshedAt)}.`,
        canonicalUrl: canonical,
        bodyHtml: body,
        jsonLd: [jsonLd],
        gaMeasurementId: ga,
      }),
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": SSR_CACHE_CONTROL } },
    );
  }

  // Hub page: /condition-index
  if (path === "/condition-index") {
    const data = await fetchJson<{ items: HubItem[] }>(env, `/api/grading/public/condition-index`);
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
      <p>What pre-owned clothing is really worth — by <em>condition</em>. We grade and comp popular
      items across GradeThread's objective 1.0&ndash;10.0 scale, so you can see how much a grade-9 is worth
      versus a grade-6.</p>
      ${items.length === 0
        ? `<p class="muted">The index is warming up — check back soon.</p>`
        : `<table>
            <thead><tr><th>Item</th><th>Value @ grade-8</th><th>Comps</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
      <p class="muted">Aggregate resale estimates from condition-matched listings. Not guaranteed sale prices.</p>
      <p><a href="/snap">Value your own item &rarr;</a></p>
    </main>`;

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "The GradeThread Condition Index",
      description: "Resale value of popular pre-owned clothing by objective condition grade.",
      url: `${site}/condition-index`,
    };

    return new Response(
      renderLayout({
        title: "The Condition Index — what used clothing is worth by condition · GradeThread",
        description: "See how much popular pre-owned clothing is worth at each condition grade, from condition-matched resale comps.",
        canonicalUrl: `${site}/condition-index`,
        bodyHtml: body,
        jsonLd: [jsonLd],
        gaMeasurementId: ga,
      }),
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": SSR_CACHE_CONTROL } },
    );
  }

  return notFoundResponse(env);
};
