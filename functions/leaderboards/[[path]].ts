// Catch-all Pages Function for the public reward leaderboards (US-1856).
//   /leaderboards                    → the hub (all four boards, all-time top 5)
//   /leaderboards/<metric>           → one board, this week AND all time
//   /leaderboards/<metric>/b/<brand> → that board, one brand
//   /leaderboards/<metric>/c/<cat>   → that board, one garment category
//
// Edge-SSR'd (Model B, like /finds and /verified/:handle) so the rankings are
// crawlable with real data. The SPA route at /leaderboards is the in-app/dev
// renderer and reads the SAME payload (/api/content/public/leaderboards.json),
// so the two can never publish different rankings.
//
// The SSR renders from the PATH only and ignores query parameters: an
// edge-cached page keyed on a path must not depend on a query string, and a
// board worth indexing deserves a real URL. `?period=` exists solely as the
// SPA's opening-tab hint — both windows are on the page either way.

import {
  breadcrumbListLd,
  escape,
  fetchJson,
  ga4MeasurementId,
  notFoundResponse,
  renderBreadcrumbs,
  renderSsrResponse,
  siteUrl,
  twitterSiteHandle,
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  type BreadcrumbItem,
  type PagesEnv,
} from "../_shared/blog-render";
import { headOf } from "../_shared/head-of";

interface Metric {
  key: string;
  name: string;
  description: string;
  scoreLabel: string;
  secondaryLabel: string | null;
  facetable: boolean;
  icon: string;
}

interface Entry {
  rank: number;
  alias: string;
  handle: string | null;
  profile_url: string | null;
  score: number;
  secondary: number;
  tied: boolean;
}

interface Facet {
  label: string;
  slug: string;
  count: number;
}

interface HubResponse {
  hub: true;
  metrics: Metric[];
  boards: Array<{ metric: Metric; path: string; entries: Entry[] }>;
  listed: number;
}

interface BoardResponse {
  hub: false;
  metric: Metric;
  metrics: Metric[];
  window: { period: string; starts_at: string | null; ends_at: string | null };
  filters: { brand_slug: string | null; category: string | null };
  facet_applied: boolean;
  facet_supported: boolean;
  total: number;
  entries: Entry[];
  facets: { brands: Facet[]; categories: Facet[] };
  listed: number;
}

// Rankings move as the week runs, so this page is cached briefly — the same
// call /finds makes (SSR_CACHE_CONTROL's 1h is for mostly-static surfaces).
const LEADERBOARD_CACHE_CONTROL =
  "public, max-age=120, s-maxage=600, stale-while-revalidate=86400";

/** How many rows a board table renders. Bounded so the document stays small. */
const SSR_PAGE_SIZE = 25;

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function num(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(1);
}

function relPath(url: string | null): string | null {
  return url ? url.replace(/^https?:\/\/[^/]+/, "") : null;
}

/**
 * One board table.
 *
 * An alias that belongs to a publicly verified seller links to their profile —
 * that is the interlink AC3 asks for, and it is only ever emitted for a handle
 * the API already decided is public. An alias with no handle is plain text; it
 * must not become a link to anything, because there is nothing public to link to.
 */
function renderBoard(metric: Metric, entries: Entry[], caption: string): string {
  if (entries.length === 0) {
    return `<section class="board">
      <h3>${escape(caption)}</h3>
      <p class="muted">Nobody is on this board yet.</p>
    </section>`;
  }
  const hasSecondary = !!metric.secondaryLabel;
  const rows = entries
    .slice(0, SSR_PAGE_SIZE)
    .map((e) => {
      const profile = relPath(e.profile_url);
      const who = profile
        ? `<a href="${escape(profile)}">${escape(e.alias)}</a>`
        : escape(e.alias);
      return `<tr>
        <td>${e.rank}${e.tied ? "<span class=\"muted\">=</span>" : ""}</td>
        <td>${who}</td>
        <td>${escape(num(e.score))}</td>
        ${hasSecondary ? `<td>${escape(num(e.secondary))}</td>` : ""}
      </tr>`;
    })
    .join("");
  return `<section class="board">
    <h3>${escape(caption)}</h3>
    <table>
      <thead><tr>
        <th>#</th><th>Seller</th><th>${escape(metric.scoreLabel)}</th>
        ${hasSecondary ? `<th>${escape(metric.secondaryLabel as string)}</th>` : ""}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

/** Links to the other three boards — the interlink that makes the hub a hub. */
function renderMetricNav(metrics: Metric[], activeKey: string | null): string {
  const chips = metrics
    .map((m) =>
      `<li><a href="/leaderboards/${escape(m.key)}"${
        m.key === activeKey ? ` aria-current="page"` : ""
      }>${escape(m.name)}</a></li>`
    )
    .join("");
  return `<nav class="chips-nav"><h2>Boards</h2><ul class="chips">${chips}</ul></nav>`;
}

function renderFacets(metric: Metric, facets: { brands: Facet[]; categories: Facet[] }, activeBrand: string | null, activeCategory: string | null): string {
  if (!metric.facetable) return "";
  const chip = (href: string, label: string, count: number, active: boolean) =>
    `<li><a href="${escape(href)}"${active ? ` aria-current="page"` : ""}>${
      escape(label)
    } <span class="muted">${count}</span></a></li>`;
  const brands = facets.brands
    .slice(0, 16)
    .map((b) =>
      chip(`/leaderboards/${metric.key}/b/${b.slug}`, b.label, b.count, b.slug === activeBrand)
    )
    .join("");
  const cats = facets.categories
    .slice(0, 16)
    .map((cat) =>
      chip(
        `/leaderboards/${metric.key}/c/${cat.slug}`,
        titleCase(cat.label),
        cat.count,
        cat.slug === activeCategory,
      )
    )
    .join("");
  if (!brands && !cats) return "";
  return `<section class="board-facets">
    ${brands ? `<h2>By brand</h2><ul class="chips">${brands}</ul>` : ""}
    ${cats ? `<h2>By category</h2><ul class="chips">${cats}</ul>` : ""}
  </section>`;
}

/**
 * ItemList of the ranked aliases.
 *
 * Deliberately NOT Person markup. An alias is a chosen public handle, not a
 * claim about a named human, and describing it as a Person would assert an
 * identity the seller specifically opted out of publishing. A ListItem with a
 * name and (where one exists) a profile URL says exactly what is true.
 */
function boardItemListLd(
  entries: Entry[],
  canonical: string,
  name: string,
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    url: canonical,
    numberOfItems: entries.length,
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    itemListElement: entries.slice(0, SSR_PAGE_SIZE).map((e) => ({
      "@type": "ListItem",
      position: e.rank,
      name: e.alias,
      ...(e.profile_url ? { url: e.profile_url } : {}),
    })),
  };
}

const FOOTER_LINKS =
  `<p><a href="/finds">Browse the Finds feed &rarr;</a> &middot;
   <a href="/verified">Verified sellers directory &rarr;</a> &middot;
   <a href="/leaderboard">Top referrers &rarr;</a> &middot;
   <a href="/snap">Grade your own find &rarr;</a></p>`;

const OPT_IN_NOTE =
  `<p class="muted">Sellers choose whether to appear here, and choose the name they
   appear under. Rankings count finished, verified work only &mdash; certified
   grades, reactions from other people, and referrals that actually qualified.</p>`;

type Ctx = EventContext<PagesEnv, "path", Record<string, unknown>>;

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/leaderboards";
  const ga = ga4MeasurementId(env);
  const site = siteUrl(env);

  let metricKey: string | null = null;
  let brandSlug: string | null = null;
  let categorySlug: string | null = null;

  if (path !== "/leaderboards") {
    const brandMatch = path.match(/^\/leaderboards\/([a-z_]+)\/b\/([a-z0-9-]+)$/);
    const categoryMatch = path.match(/^\/leaderboards\/([a-z_]+)\/c\/([a-z0-9_]+)$/);
    const metricMatch = path.match(/^\/leaderboards\/([a-z_]+)$/);
    if (brandMatch) {
      metricKey = brandMatch[1] ?? null;
      brandSlug = brandMatch[2] ?? null;
    } else if (categoryMatch) {
      metricKey = categoryMatch[1] ?? null;
      categorySlug = categoryMatch[2] ?? null;
    } else if (metricMatch) {
      metricKey = metricMatch[1] ?? null;
    } else {
      return notFoundResponse(env);
    }
  }

  const canonical = `${site}${path}`;

  // ── The hub ───────────────────────────────────────────────────────────────
  if (!metricKey) {
    let data: HubResponse | null;
    try {
      // US-2044: a transient upstream failure must never be reported to a
      // crawler as "this page is gone".
      data = await fetchJson<HubResponse>(
        env,
        "/api/content/public/leaderboards.json?period=all_time",
      );
    } catch (e) {
      if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
      throw e;
    }

    const metrics = data?.metrics ?? [];
    const boards = data?.boards ?? [];
    const trail: BreadcrumbItem[] = [
      { name: "GradeThread", url: `${site}/` },
      { name: "Leaderboards", url: canonical },
    ];

    const body = `${renderBreadcrumbs(trail, site)}
      <main class="container">
        <h1>GradeThread leaderboards</h1>
        <p>Four boards, ranked over this week and over all time: reward XP,
        certificates published, the finds that earned the most reactions, and the
        sellers whose shares actually brought people in. Every ranked seller opted
        in and picked the name they appear under.</p>
        ${renderMetricNav(metrics, null)}
        ${
      boards
        .map((b) =>
          `<section class="board-group">
            <h2><a href="${escape(b.path)}">${escape(b.metric.name)}</a></h2>
            <p>${escape(b.metric.description)}</p>
            ${renderBoard(b.metric, b.entries, "All time")}
            <p><a href="${escape(b.path)}">See this week and the full ${
            escape(b.metric.name.toLowerCase())
          } board &rarr;</a></p>
          </section>`
        )
        .join("")
    }
        ${OPT_IN_NOTE}
        ${FOOTER_LINKS}
      </main>`;

    const jsonLd: unknown[] = [
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: "GradeThread leaderboards",
        description:
          "Public, opt-in leaderboards for GradeThread sellers: reward XP, certificates published, best finds and share-driven signups, weekly and all-time.",
        url: canonical,
      },
      breadcrumbListLd(trail),
    ];

    return renderSsrResponse(
      {
        title: "Leaderboards — top GradeThread sellers · GradeThread",
        description:
          "Opt-in leaderboards for GradeThread sellers: reward XP, certificates published, best finds and share-driven signups, ranked weekly and all-time.",
        canonicalUrl: canonical,
        bodyHtml: body,
        jsonLd,
        gaMeasurementId: ga,
        twitterSite: twitterSiteHandle(env),
      },
      { cacheControl: LEADERBOARD_CACHE_CONTROL },
    );
  }

  // ── One board, both windows ───────────────────────────────────────────────
  const params = new URLSearchParams({ metric: metricKey, limit: String(SSR_PAGE_SIZE) });
  if (brandSlug) params.set("brand_slug", brandSlug);
  if (categorySlug) params.set("category", categorySlug);

  let weekly: BoardResponse | null;
  let allTime: BoardResponse | null;
  try {
    [weekly, allTime] = await Promise.all([
      fetchJson<BoardResponse>(
        env,
        `/api/content/public/leaderboards.json?${params.toString()}&period=weekly`,
      ),
      fetchJson<BoardResponse>(
        env,
        `/api/content/public/leaderboards.json?${params.toString()}&period=all_time`,
      ),
    ]);
  } catch (e) {
    if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
    throw e;
  }

  const board = allTime ?? weekly;
  // An unknown metric key comes back without a `metric` object — that is a
  // genuinely non-existent page, not an empty one.
  if (!board?.metric) return notFoundResponse(env);
  const metric = board.metric;

  // A facet page with nobody on it is a thin, duplicate page that should never
  // be indexed. The metric hub stays live and explains itself while a board is
  // still warming up; a brand page with no ranked seller does not.
  const facetRequested = !!(brandSlug || categorySlug);
  const anyEntries = (weekly?.entries.length ?? 0) + (allTime?.entries.length ?? 0);
  if (facetRequested && (anyEntries === 0 || !board.facet_supported)) {
    return notFoundResponse(env);
  }

  const facetLabel = brandSlug
    ? board.facets.brands.find((b) => b.slug === brandSlug)?.label ?? titleCase(brandSlug)
    : categorySlug
      ? titleCase(categorySlug)
      : null;

  const heading = facetLabel
    ? `${metric.name} leaderboard — ${facetLabel}`
    : `${metric.name} leaderboard`;

  const trail: BreadcrumbItem[] = [
    { name: "GradeThread", url: `${site}/` },
    { name: "Leaderboards", url: `${site}/leaderboards` },
    { name: metric.name, url: `${site}/leaderboards/${metric.key}` },
    ...(facetLabel ? [{ name: facetLabel, url: canonical }] : []),
  ];

  const body = `${renderBreadcrumbs(trail, site)}
    <main class="container">
      <h1>${escape(heading)}</h1>
      <p>${escape(metric.description)}</p>
      ${renderMetricNav(board.metrics ?? [], metric.key)}
      ${renderBoard(metric, weekly?.entries ?? [], "This week")}
      ${renderBoard(metric, allTime?.entries ?? [], "All time")}
      ${renderFacets(metric, board.facets, brandSlug, categorySlug)}
      ${OPT_IN_NOTE}
      ${FOOTER_LINKS}
    </main>`;

  const listName = facetLabel
    ? `${metric.name} leaderboard — ${facetLabel}`
    : `${metric.name} leaderboard on GradeThread`;

  const jsonLd: unknown[] = [
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: listName,
      description: metric.description,
      url: canonical,
    },
    breadcrumbListLd(trail),
    ...((allTime?.entries.length ?? 0) > 0
      ? [boardItemListLd(allTime!.entries, canonical, listName)]
      : []),
  ];

  return renderSsrResponse(
    {
      title: `${heading} · GradeThread`,
      description: facetLabel
        ? `${metric.name} leaderboard for ${facetLabel} on GradeThread, ranked this week and all time. Opt-in, with every seller's public alias.`
        : `${metric.description} Ranked this week and all time on GradeThread.`.slice(0, 300),
      canonicalUrl: canonical,
      bodyHtml: body,
      jsonLd,
      gaMeasurementId: ga,
      twitterSite: twitterSiteHandle(env),
    },
    { cacheControl: LEADERBOARD_CACHE_CONTROL },
  );
};

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);
