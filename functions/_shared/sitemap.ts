// Shared helpers for the dynamic sitemap set (US-293).
//
// The sitemap builds itself from three sources so it never needs hand-editing:
//   1. static registry routes — dist/seo-manifest.json (emitted from
//      src/lib/seo/public-routes.ts by the Vite seoManifestPlugin, US-291)
//   2. published blog posts + tags — /api/content/public/sitemap.json
//   3. public certificates — /api/content/public/certificates.json (US-294)
//
// When the grand total exceeds SITEMAP_MAX_URLS, /sitemap.xml becomes a sitemap
// INDEX pointing at sitemap-static.xml / sitemap-blog.xml / sitemap-certs.xml,
// each of which stays under the 50k/50MB per-file limit.

import {
  escape,
  edgeApi,
  siteUrl,
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  type PagesEnv,
} from "./blog-render";
// US-2636: the SAME threshold and the SAME predicate the page uses to decide
// whether to noindex itself. Imported rather than restated — the module's own
// docblock says the citation-block and the indexing decisions "must not
// diverge", and the sitemap is the third decision in that set.
//
// Safe to reach into src/ here: report-thresholds.ts has zero imports and is
// pure constants plus pure functions, so nothing browser-shaped comes with it.
import {
  isPublishableReport,
  MIN_DURABILITY_COHORTS,
} from "../../src/lib/report-thresholds";

// Threshold from the AC. The real spec limit is 50,000 URLs / 50 MB per file;
// 5,000 keeps each file small and fast to generate at the edge.
export const SITEMAP_MAX_URLS = 5000;

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

interface ManifestRoute {
  path: string;
  title?: string;
  changefreq?: string;
  priority?: number;
  /** US-429: stable per-route content-change date (YYYY-MM-DD). */
  lastModified?: string;
  /**
   * US-2111: the route's share card, emitted from ROUTE_OG_IMAGES. Optional
   * because most routes have none — and because a manifest from a build that
   * predates this field must still parse.
   */
  image?: { file: string; alt: string };
  /**
   * US-9008: set when this route's canonical points at a DIFFERENT URL. Such a
   * route is skipped here. Optional because almost no route has one, and
   * because a manifest from a build that predates the field must still parse.
   */
  canonicalPath?: string;
}
interface SeoManifest {
  siteUrl: string;
  generatedAt: string;
  routes: ManifestRoute[];
}
interface BlogSitemap {
  posts: Array<{
    slug: string;
    published_at: string;
    updated_at: string;
    // US-975: hero image fields used by the image sitemap. Optional so a legacy
    // /sitemap.json response that predates the extra columns still parses.
    title?: string;
    hero_image_url?: string | null;
    hero_image_alt?: string | null;
    hero_image_caption?: string | null;
  }>;
  tags: string[];
}
interface CertSitemap {
  certificates: Array<{ id: string; updated_at: string }>;
  next_cursor: string | null;
}
interface PassportSitemap {
  passports: Array<{ slug: string; updated_at: string }>;
  next_cursor: string | null;
}
interface SellerSitemap {
  sellers: Array<{ handle: string; updated_at: string }>;
}
interface AuthorSitemap {
  authors: Array<{ slug: string; updated_at: string | null }>;
}

// Fetch a same-origin static asset (the build-emitted manifest). Falls back to
// null so the sitemap still renders (blog/cert sections) if it's missing.
async function fetchManifest(env: PagesEnv): Promise<SeoManifest | null> {
  try {
    const res = await fetch(`${siteUrl(env)}/seo-manifest.json`, {
      signal: AbortSignal.timeout(8_000),
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) return null;
    return (await res.json()) as SeoManifest;
  } catch {
    return null;
  }
}

/**
 * US-2097: THROW on an unreachable upstream instead of returning null.
 *
 * Returning null made a transient edge failure indistinguishable from "this
 * section is legitimately empty": each *Urls() generator fell back to [], and
 * the result was a structurally valid sitemap missing entire URL classes —
 * served 200 and cached for an hour, telling crawlers those pages do not exist.
 *
 * Worse, a dropped section could push the total back under SITEMAP_MAX_URLS and
 * flip /sitemap.xml from a sitemapindex to a truncated single urlset, changing
 * the document's SHAPE based on a network blip.
 *
 * rss.xml.ts was hardened against exactly this in US-2044 (UpstreamUnavailable
 * + a 503). The sitemap never got the same treatment; this is that port.
 */
async function fetchEdgeJson<T>(env: PagesEnv, path: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`${edgeApi(env)}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit);
  } catch (e) {
    // Network error / timeout — we do NOT know what is there.
    console.error(`[sitemap] upstream unreachable for ${path}:`, e);
    throw new UpstreamUnavailable(e instanceof Error ? e.name : "unknown");
  }
  if (!res.ok) {
    // A 404 is a real answer ("no such collection") and stays null; anything
    // else means we could not determine the contents.
    if (res.status === 404) return null;
    console.error(`[sitemap] upstream ${res.status} for ${path}`);
    throw new UpstreamUnavailable(`status ${res.status}`);
  }
  try {
    const json = (await res.json()) as T;
    // US-2096: uncursored feeds report their own truncation via `truncated`.
    // Checked here rather than per-generator so a feed that grows the flag
    // later is covered without touching every call site.
    if ((json as { truncated?: boolean } | null)?.truncated) {
      console.error(
        `[sitemap] upstream reports a TRUNCATED response for ${path} — this ` +
          `sitemap section is incomplete and the feed needs cursor pagination.`,
      );
    }
    return json;
  } catch (e) {
    console.error(`[sitemap] malformed JSON from ${path}:`, e);
    throw new UpstreamUnavailable("malformed-json");
  }
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * US-2100: the newest lastmod among a set of URLs (ISO YYYY-MM-DD sorts
 * lexicographically, so a string compare is correct here).
 */
export function newestLastmod(urls: readonly SitemapUrl[]): string | undefined {
  let newest: string | undefined;
  for (const u of urls) {
    const lm = u.lastmod;
    if (!lm) continue;
    if (!newest || lm > newest) newest = lm;
  }
  return newest;
}

/**
 * US-2100: give a hub URL the lastmod of its NEWEST CHILD instead of today().
 *
 * ROUTE_LAST_MODIFIED enforces an explicit "NEVER the build timestamp" contract
 * for static routes (US-429), precisely so an unchanged page keeps a steady
 * lastmod and crawlers stop re-fetching it. The dynamic generators ignored that
 * discipline and stamped today() on every hub, every day — so every sub-sitemap
 * claimed it changed today, forever. That does not just waste crawl budget: a
 * lastmod that is always "now" is a signal crawlers learn to discount, which
 * devalues the honest dates on the 213 static routes too.
 *
 * Every generator here builds the hub at index 0 and appends children, so this
 * rewrites in place. If there are NO children the hub keeps today(): an empty
 * hub genuinely has no content date to inherit, and inventing an older one
 * would be a different lie.
 */
export function withHubLastmod(urls: SitemapUrl[]): SitemapUrl[] {
  const hub = urls[0];
  if (!hub) return urls;
  const newest = newestLastmod(urls.slice(1));
  if (newest) hub.lastmod = newest;
  return urls;
}

// US-1679: a route is "grading pSEO" if it lives under /grading/ (the scale,
// methodology, disambiguation, glossary hub + terms, and the tier/factor spokes).
// Splitting these into their own segment lets GSC report the pSEO indexation rate
// separately from the marketing pages — the whole point of segmentation.
function isGradingRoute(path: string): boolean {
  return path === "/grading" || path.startsWith("/grading/");
}

/**
 * US-9015: the care cluster gets its OWN sitemap segment rather than sitting in
 * the marketing one.
 *
 * A sitemap segment is a statement about what a group of pages is. 32 care
 * pages listed beside the pricing page, the comparisons and the calculators
 * says they are the same kind of thing, and the whole containment decision is
 * that they are not. Its own segment also makes the ratio below measurable in
 * one place instead of by grepping.
 */
function isCareRoute(path: string): boolean {
  return path === "/care" || path.startsWith("/care/");
}

/** US-3093: the buyer-trust cluster, /buying/*. */
function isBuyingRoute(path: string): boolean {
  return path === "/buying" || path.startsWith("/buying/");
}

function manifestRouteToUrl(base: string, r: ManifestRoute, generatedAt: string): SitemapUrl {
  return {
    loc: r.path === "/" ? `${base}/` : `${base}${r.path}`,
    // US-429: prefer the route's stable content-change date so an unchanged page
    // keeps a steady lastmod across deploys; fall back to the build time only for
    // legacy manifests that predate the per-route field.
    lastmod: (r.lastModified ?? generatedAt).slice(0, 10),
    changefreq: r.changefreq,
    priority: r.priority,
  };
}

/**
 * US-2636: registry routes whose PAGE decides at render time whether to be
 * indexed, and the question it asks.
 *
 * MEASURED, not theorised. GET https://gradethread.com/state-of-durability
 * returned 200 with `<meta name="robots" content="noindex, follow">` while
 * /sitemap.xml advertised it at priority 0.8, changefreq weekly. Both halves are
 * individually right: the report has `sufficient_cohorts: 0` against a floor of
 * 8, so the page correctly refuses to be indexed (US-2098 — inviting citation of
 * a finding we do not have is worse than having no report page). Nothing
 * reconciled them, so we told Google to crawl it often and then told Google to
 * drop it.
 *
 * FAILURE DIRECTION IS DELIBERATE. A predicate that cannot reach the upstream
 * returns false and the URL is omitted — which is exactly what the PAGE does,
 * because it reads the same data through a prerender seed and treats an absent
 * seed as not-publishable. Matching the page is the whole point; an omitted URL
 * costs a crawl of a page that is linked anyway, while an advertised noindex
 * costs the contradiction.
 */
const CONDITIONALLY_INDEXED: Record<string, (env: PagesEnv) => Promise<boolean>> = {
  "/state-of-durability": async (env) => {
    const report = await fetchEdgeJson<{ sample?: { sufficient_cohorts?: number } }>(
      env,
      "/api/grading/public/durability-report",
    );
    return isPublishableReport(report?.sample?.sufficient_cohorts, MIN_DURABILITY_COHORTS);
  },
};

/** Which conditional routes may be advertised right now. */
async function indexableConditionalPaths(env: PagesEnv): Promise<Set<string>> {
  const paths = Object.keys(CONDITIONALLY_INDEXED);
  const verdicts = await Promise.all(
    paths.map(async (p) => {
      try {
        return await CONDITIONALLY_INDEXED[p]!(env);
      } catch {
        return false;
      }
    }),
  );
  return new Set(paths.filter((_, i) => verdicts[i]));
}

/** US-1679: partition the manifest routes into marketing vs grading pSEO. */
async function partitionedStaticUrls(
  env: PagesEnv,
): Promise<{
  marketing: SitemapUrl[];
  grading: SitemapUrl[];
  care: SitemapUrl[];
  buying: SitemapUrl[];
}> {
  const base = siteUrl(env);
  const manifest = await fetchManifest(env);
  if (!manifest) {
    // Manifest missing — at least advertise the home page (a marketing URL).
    return {
      marketing: [{ loc: `${base}/`, lastmod: today(), changefreq: "weekly", priority: 1.0 }],
      grading: [],
      care: [],
      buying: [],
    };
  }
  const indexable = await indexableConditionalPaths(env);
  const marketing: SitemapUrl[] = [];
  const grading: SitemapUrl[] = [];
  const care: SitemapUrl[] = [];
  const buying: SitemapUrl[] = [];
  for (const r of manifest.routes) {
    if (r.path in CONDITIONALLY_INDEXED && !indexable.has(r.path)) continue;
    // US-9008: a route whose canonical points elsewhere stays live and linked,
    // but advertising it here would contradict the canonical we just served.
    if (r.canonicalPath && r.canonicalPath !== r.path) continue;
    const url = manifestRouteToUrl(base, r, manifest.generatedAt);
    if (isCareRoute(r.path)) care.push(url);
    // US-3093: checked before grading for the same reason care is — a /buying
    // page talks about condition and would otherwise be filed as grading, which
    // would hide it inside the segment it is supposed to be measured against.
    else if (isBuyingRoute(r.path)) buying.push(url);
    else if (isGradingRoute(r.path)) grading.push(url);
    else marketing.push(url);
  }
  return { marketing, grading, care, buying };
}

/** US-1679: marketing (non-grading) static routes → sitemap-marketing.xml. */
export async function marketingUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  return (await partitionedStaticUrls(env)).marketing;
}

/** US-1679: grading pSEO routes (/grading/*) -> sitemap-grading.xml. */
export async function gradingUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  return (await partitionedStaticUrls(env)).grading;
}

/** US-9015: the care cluster (/care/*) -> sitemap-care.xml, on its own. */
export async function careUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  return (await partitionedStaticUrls(env)).care;
}

/**
 * US-9015 AC4: care URLs as a share of all static URLs.
 *
 * THE CEILING IS 40% and the reasoning is in
 * vault/40-growth/seo-strategy-options-2026-08.md. Past that share, the care
 * cluster is the majority of what the domain is about, and Google's read of the
 * entity follows the content. This function is what makes the ceiling
 * checkable instead of aspirational.
 */
/** US-3093: the buyer-trust cluster (/buying/*) -> sitemap-buying.xml, on its own. */
export async function buyingUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  return (await partitionedStaticUrls(env)).buying;
}

/**
 * US-3093 AC2: buying URLs as a share of all static URLs.
 *
 * THE CEILING IS 10%, a quarter of care's 40%, and the difference is the point.
 * Care is off-topic but harmless: nobody confuses a laundry guide for a product
 * page. /buying is written for the WRONG PERSON — a buyer, on a site whose
 * customer is a seller — so its risk is not that the domain reads as being
 * about laundry, it is that the domain reads as being FOR BUYERS. That misreads
 * the entity in the direction the business is sold on, so the tolerance is much
 * smaller.
 *
 * Four pages is the planned ceiling anyway (US-3093 builds one and gates the
 * other three on a SERP check), so 10% is generous against the plan and tight
 * against the failure. This function is what makes it checkable instead of
 * aspirational.
 */
export async function buyingRatio(
  env: PagesEnv,
): Promise<{ buying: number; total: number; pct: number }> {
  const { marketing, grading, care, buying } = await partitionedStaticUrls(env);
  const total = marketing.length + grading.length + care.length + buying.length;
  return {
    buying: buying.length,
    total,
    pct: total === 0 ? 0 : Math.round((buying.length / total) * 1000) / 10,
  };
}

export async function careRatio(
  env: PagesEnv,
): Promise<{ care: number; total: number; pct: number }> {
  const { marketing, grading, care, buying } = await partitionedStaticUrls(env);
  // US-3093: buying counts in the DENOMINATOR. Leaving it out would shrink the
  // total and quietly inflate care's share, which is a ceiling reading high
  // rather than low — the safe direction, but still a wrong number.
  const total = marketing.length + grading.length + care.length + buying.length;
  return {
    care: care.length,
    total,
    pct: total === 0 ? 0 : Math.round((care.length / total) * 1000) / 10,
  };
}

/**
 * All static registry routes (marketing + grading). Kept for the legacy
 * sitemap-static.xml alias + the single-file /sitemap.xml path; the index now
 * links the marketing/grading split instead (US-1679).
 */
export async function staticUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const { marketing, grading, care } = await partitionedStaticUrls(env);
  return [...marketing, ...grading, ...care];
}

export async function blogUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const data = await fetchEdgeJson<BlogSitemap>(
    env,
    "/api/content/public/sitemap.json",
  );
  const urls: SitemapUrl[] = [
    { loc: `${base}/blog`, lastmod: today(), changefreq: "daily", priority: 0.9 },
  ];
  if (data) {
    for (const p of data.posts) {
      urls.push({
        loc: `${base}/blog/${p.slug}`,
        lastmod: p.updated_at?.slice(0, 10),
        changefreq: "weekly",
        priority: 0.8,
      });
    }
    // US-2099 AC4: the paginated hub pages. Without these, /blog/page/2+ exists
    // and is crawlable from the hub but is not advertised — and the whole point
    // of the pagination is that older posts become discoverable.
    const BLOG_PAGE_SIZE = 20;
    const pages = Math.ceil((data.posts?.length ?? 0) / BLOG_PAGE_SIZE);
    for (let n = 2; n <= pages; n++) {
      urls.push({
        loc: `${base}/blog/page/${n}`,
        lastmod: newestLastmod(urls.slice(1)),
        changefreq: "weekly",
        priority: 0.5,
      });
    }

    // Tag archives are deliberately NOT listed.
    //
    // They were 138 of the ~892 URLs here against ~61 published posts, so most
    // tags carry one or two articles whose content exists in full on the post
    // page — thin, near-duplicate URLs. The sitemap is a statement about which
    // pages we want ranked, and these are now served `noindex, follow`
    // (functions/blog/[[path]].ts renderTag). Listing a noindexed URL sends
    // Google two contradictory signals and spends crawl budget on the losing
    // one, which a domain with no external authority cannot spare.
    //
    // They remain fully crawlable and linked from every post's tag list — this
    // removes an indexing CLAIM, not the pages or their internal links. Undo by
    // restoring this loop and dropping the `robots` override in renderTag; the
    // two must change together.
  }
  // US-2100: hub inherits its newest child's date instead of today().
  return withHubLastmod(urls);
}

// US-2096: the certificates endpoint is cursor-paginated (`next_cursor`, keyed
// on created_at) and hard-caps `limit` at 5,000. certUrls() used to make ONE
// unparameterised request and drop the cursor on the floor, so the certificate
// sitemap silently stopped at the first page — the default limit of 1,000.
//
// Certificates are the highest-volume indexable asset class in the product, so
// this was a growth ceiling that reported itself as success: a well-formed 200
// listing exactly 1,000 URLs, with no error and no log line.
const CERT_PAGE_SIZE = 5000; // the endpoint's own maximum
// The sitemap spec's real per-file ceiling is 50,000 URLs. sitemap-certs.xml
// emits a single <urlset>, so that — not SITEMAP_MAX_URLS (5,000), which only
// decides the ROOT document's index-vs-urlset shape — is the binding limit here.
const CERT_MAX_URLS = 50_000;

/**
 * US-2748: the Lululemon style-code lookup pages that are worth indexing.
 *
 * THE SET IS DELIBERATELY SMALL. It is the codes we can NAME, not the codes we
 * have seen — and the second number is far larger. Listing every code we have
 * ever encountered would put thousands of "we do not know this yet" pages in
 * front of a crawler, which is thin content and costs the whole domain rather
 * than just this section.
 *
 * The edge endpoint applies the SAME predicate the page uses to decide noindex
 * (a style_code_names row that is not rejected), which is what stops the two
 * from drifting. A URL in a sitemap that renders noindex is the specific
 * contradiction that gets a section ignored.
 */
export async function styleCodeUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const data = await fetchEdgeJson<{
    truncated?: boolean;
    codes: Array<{ code: string; updated_at?: string | null }>;
  }>(env, "/api/content/public/style-codes.json");
  if (!data) return [];

  return data.codes.map((c) => ({
    loc: `${base}/style/${c.code}`,
    lastmod: c.updated_at?.slice(0, 10),
    // A resolved name changes when a stronger source answers — a seller
    // correction over a market consensus — which is neither rare nor frequent.
    changefreq: "monthly" as const,
    priority: 0.6,
  }));
}

/**
 * The RN lookup URLs (US-9032).
 *
 * THE SET IS DELIBERATELY SMALL, for the same reason styleCodeUrls above is:
 * it is the numbers we can NAME, not the numbers we have seen. The edge
 * endpoint applies the SAME predicate the page uses to decide noindex (a
 * registry row with a company), which is what stops the two from drifting. A
 * URL in a sitemap that renders noindex is the specific contradiction that
 * gets a section ignored.
 *
 * RN only. A CA number answers when asked for and stays out of the sitemap:
 * there is no measured demand for the Canadian register, and a sitemap entry
 * is a claim that a URL is worth crawling.
 */
export async function rnUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const data = await fetchEdgeJson<{
    truncated?: boolean;
    numbers: Array<{ digits: string; updated_at?: string | null }>;
  }>(env, "/api/content/public/registered-numbers.json");
  if (!data) return [];

  return data.numbers.map((n) => ({
    loc: `${base}/rn/${n.digits}`,
    lastmod: n.updated_at?.slice(0, 10),
    // A registrant's name changes when a company is bought or renamed, which
    // is rare. The sighting count moves more often and is not in the markup a
    // crawler is being asked to re-read.
    changefreq: "monthly" as const,
    priority: 0.6,
  }));
}

export async function certUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const urls: SitemapUrl[] = [];
  let cursor: string | null = null;

  while (urls.length < CERT_MAX_URLS) {
    const qs = new URLSearchParams({ limit: String(CERT_PAGE_SIZE) });
    if (cursor) qs.set("cursor", cursor);
    const data: CertSitemap | null = await fetchEdgeJson<CertSitemap>(
      env,
      `/api/content/public/certificates.json?${qs}`,
    );
    if (!data) break;

    for (const cI of data.certificates) {
      urls.push({
        loc: `${base}/cert/${cI.id}`,
        lastmod: cI.updated_at?.slice(0, 10),
        changefreq: "monthly",
        priority: 0.7,
      });
    }

    const next: string | null = data.next_cursor ?? null;
    // Guard against a non-advancing cursor. The endpoint derives next_cursor
    // from the last row of the RAW page (so a fully-withheld page still
    // advances), but a bug or a duplicate created_at upstream must not spin
    // this loop at the edge.
    if (!next || next === cursor) break;
    cursor = next;
  }

  // Never truncate silently — that is the exact defect this story exists to fix.
  if (urls.length >= CERT_MAX_URLS) {
    console.error(
      `[sitemap] certificate sitemap hit the ${CERT_MAX_URLS}-URL ceiling and is ` +
        `now TRUNCATED. It must be split into numbered sub-sitemaps ` +
        `(sitemap-certs-1.xml …) before certificate volume grows further.`,
    );
  }
  return urls;
}

// US-2110: /passport/:slug is SSR'd with full Product JSON-LD and is designed to
// be indexed, but had no generator — the pages were reachable only via inbound
// links. Cursor-paginated from the start, following US-2096 rather than
// repeating the bug it fixed.
const PASSPORT_PAGE_SIZE = 5000;
const PASSPORT_MAX_URLS = 50_000;

export async function passportUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const urls: SitemapUrl[] = [];
  let cursor: string | null = null;

  while (urls.length < PASSPORT_MAX_URLS) {
    const qs = new URLSearchParams({ limit: String(PASSPORT_PAGE_SIZE) });
    if (cursor) qs.set("cursor", cursor);
    const data: PassportSitemap | null = await fetchEdgeJson<PassportSitemap>(
      env,
      `/api/content/public/passports.json?${qs}`,
    );
    if (!data) break;

    for (const p of data.passports) {
      urls.push({
        loc: `${base}/passport/${p.slug}`,
        lastmod: p.updated_at?.slice(0, 10),
        changefreq: "monthly",
        priority: 0.6,
      });
    }

    const next: string | null = data.next_cursor ?? null;
    if (!next || next === cursor) break;
    cursor = next;
  }

  if (urls.length >= PASSPORT_MAX_URLS) {
    console.error(
      `[sitemap] passport sitemap hit the ${PASSPORT_MAX_URLS}-URL ceiling and is ` +
        `now TRUNCATED; it must be split into numbered sub-sitemaps.`,
    );
  }
  return urls;
}

export async function sellerUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  // US-863: lead with the public directory/leaderboard hub, then each profile.
  const urls: SitemapUrl[] = [
    { loc: `${base}/verified`, lastmod: today(), changefreq: "weekly", priority: 0.7 },
  ];
  const data = await fetchEdgeJson<SellerSitemap>(
    env,
    "/api/content/public/sellers.json",
  );
  for (const s of data?.sellers ?? []) {
    urls.push({
      loc: `${base}/verified/${encodeURIComponent(s.handle)}`,
      lastmod: s.updated_at?.slice(0, 10),
      changefreq: "weekly",
      priority: 0.6,
    });
  }
  // US-2100: hub inherits its newest child's date instead of today().
  return withHubLastmod(urls);
}

// US-874: public author (E-E-A-T) pages — the /authors hub + each profile.
export async function authorUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const urls: SitemapUrl[] = [
    { loc: `${base}/authors`, lastmod: today(), changefreq: "weekly", priority: 0.5 },
  ];
  const data = await fetchEdgeJson<AuthorSitemap>(
    env,
    "/api/content/public/authors.json",
  );
  for (const a of data?.authors ?? []) {
    urls.push({
      loc: `${base}/authors/${encodeURIComponent(a.slug)}`,
      lastmod: a.updated_at?.slice(0, 10),
      changefreq: "monthly",
      priority: 0.5,
    });
  }
  // US-2100: hub inherits its newest child's date instead of today().
  return withHubLastmod(urls);
}

// US-621: public Condition Index hub + per-item pages.
export async function conditionIndexUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const data = await fetchEdgeJson<{ items: Array<{ slug: string; refreshedAt?: string }> }>(
    env,
    "/api/grading/public/condition-index",
  );
  const urls: SitemapUrl[] = [
    { loc: `${base}/condition-index`, lastmod: today(), changefreq: "weekly", priority: 0.7 },
  ];
  for (const it of data?.items ?? []) {
    urls.push({
      loc: `${base}/condition-index/${it.slug}`,
      lastmod: it.refreshedAt?.slice(0, 10),
      changefreq: "weekly",
      priority: 0.6,
    });
  }
  // US-2100: hub inherits its newest child's date instead of today().
  return withHubLastmod(urls);
}

/**
 * US-1855: the public Showcase feed — the /finds hub plus its BRAND and
 * CATEGORY facet pages.
 *
 * Only facets the feed actually reports are listed. A facet page with no finds
 * 404s (thin/duplicate), so listing one from a hand-written guess would put a
 * known-dead URL in the sitemap. `finds.json` returns the facets it computed
 * over the live window, which is exactly the set of pages that render.
 */
export async function findsUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const data = await fetchEdgeJson<{
    finds?: Array<{ showcased_at?: string }>;
    facets?: {
      brands?: Array<{ slug: string }>;
      categories?: Array<{ slug: string }>;
    };
  }>(env, "/api/content/public/finds.json?sort=recent&limit=1");

  const newest = data?.finds?.[0]?.showcased_at?.slice(0, 10);
  const urls: SitemapUrl[] = [
    { loc: `${base}/finds`, lastmod: newest ?? today(), changefreq: "daily", priority: 0.7 },
  ];
  for (const b of data?.facets?.brands ?? []) {
    urls.push({
      loc: `${base}/finds/b/${b.slug}`,
      lastmod: newest,
      changefreq: "weekly",
      priority: 0.5,
    });
  }
  for (const cat of data?.facets?.categories ?? []) {
    urls.push({
      loc: `${base}/finds/c/${cat.slug}`,
      lastmod: newest,
      changefreq: "weekly",
      priority: 0.5,
    });
  }
  // US-2100: hub inherits its newest child's date instead of today().
  return withHubLastmod(urls);
}

/**
 * US-2578: the Help Center — the /help hub, one page per non-empty category, and
 * every published PUBLIC article.
 *
 * VISIBILITY IS NOT FILTERED HERE, and that is deliberate. The endpoint this
 * calls is the anonymous one, which can only ever return visibility='public'.
 * Re-filtering in this file would create a second copy of the rule that could
 * drift from the first; not calling the anonymous endpoint is the mistake to
 * guard against, and src/test/help-ssr.test.ts is what guards it.
 *
 * lastmod is DERIVED from the article's reviewed_at (falling back to
 * updated_at), never today(). A sitemap that stamps today on an unchanged page
 * teaches crawlers to ignore the field — and the whole point of reviewed_at
 * (US-2591) is that it moves when somebody actually re-read the article.
 *
 * An EMPTY category is skipped: a shelf with nothing on it is a thin page, and a
 * thin page in the sitemap is a page Google decides the section is like.
 */
export async function helpUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const data = await fetchEdgeJson<{
    categories?: Array<{ key: string; slug: string; article_count?: number }>;
    articles?: Array<{
      slug: string;
      category_key: string;
      updated_at: string;
      reviewed_at?: string | null;
    }>;
  }>(env, "/api/content/public/help");

  const articles = data?.articles ?? [];
  const categories = data?.categories ?? [];
  const slugForKey = new Map(categories.map((c) => [c.key, c.slug]));

  const dateOf = (a: { updated_at: string; reviewed_at?: string | null }) =>
    (a.reviewed_at ?? a.updated_at)?.slice(0, 10);

  const urls: SitemapUrl[] = [
    { loc: `${base}/help`, changefreq: "weekly", priority: 0.7 },
  ];

  const counts = new Map<string, number>();
  const newestPerCategory = new Map<string, string>();
  for (const a of articles) {
    counts.set(a.category_key, (counts.get(a.category_key) ?? 0) + 1);
    const d = dateOf(a);
    if (d && (newestPerCategory.get(a.category_key) ?? "") < d) {
      newestPerCategory.set(a.category_key, d);
    }
  }

  for (const c of categories) {
    const count = c.article_count ?? counts.get(c.key) ?? 0;
    if (count === 0) continue;
    urls.push({
      loc: `${base}/help/${c.slug}`,
      lastmod: newestPerCategory.get(c.key),
      changefreq: "weekly",
      priority: 0.6,
    });
  }

  for (const a of articles) {
    const categorySlug = slugForKey.get(a.category_key);
    // An article whose category is missing from the payload has no canonical
    // URL to advertise. Guessing one from the key would put a 301 in the
    // sitemap, which is a URL crawlers then have to be told twice about.
    if (!categorySlug) continue;
    urls.push({
      loc: `${base}/help/${categorySlug}/${a.slug}`,
      lastmod: dateOf(a),
      changefreq: "monthly",
      priority: 0.6,
    });
  }

  // US-2100: the hub inherits its newest child's date instead of today().
  return withHubLastmod(urls);
}

/**
 * US-1856: the reward leaderboards — the /leaderboards hub, one page per metric,
 * and the brand/category facet pages of the two boards that can be faceted.
 *
 * A metric page is listed unconditionally: it is a real page that explains its
 * board and stays live while the board warms up. A FACET page is listed only
 * when the API reports that facet AND the board has somebody on it, because
 * `functions/leaderboards/[[path]].ts` 404s an empty facet as a thin page —
 * listing one from a guess would put a known-dead URL in the sitemap.
 *
 * US-2100: the lastmod is DERIVED, never today(). A ranking has no single row
 * whose timestamp means "this changed", so the honest date is the instant the
 * live weekly ranking window opened — which the API returns as `current_week`
 * precisely so this file does not have to own a second Monday calendar. It moves
 * once a week rather than every day, which under-reports rather than crying wolf.
 */
export async function leaderboardUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const hub = await fetchEdgeJson<{
    metrics?: Array<{ key: string; facetable: boolean }>;
    boards?: Array<{ metric: { key: string }; entries: unknown[] }>;
    current_week?: { starts_at?: string | null };
  }>(env, "/api/content/public/leaderboards.json?period=all_time");

  const windowOpened = hub?.current_week?.starts_at?.slice(0, 10);
  const urls: SitemapUrl[] = [
    { loc: `${base}/leaderboards`, lastmod: windowOpened, changefreq: "daily", priority: 0.6 },
  ];
  const populated = new Set(
    (hub?.boards ?? [])
      .filter((b) => (b.entries?.length ?? 0) > 0)
      .map((b) => b.metric?.key)
      .filter(Boolean) as string[],
  );

  for (const m of hub?.metrics ?? []) {
    urls.push({
      loc: `${base}/leaderboards/${m.key}`,
      lastmod: windowOpened,
      changefreq: "daily",
      priority: 0.5,
    });
    if (!m.facetable || !populated.has(m.key)) continue;
    const board = await fetchEdgeJson<{
      facets?: { brands?: Array<{ slug: string }>; categories?: Array<{ slug: string }> };
    }>(env, `/api/content/public/leaderboards.json?metric=${m.key}&period=all_time&limit=1`);
    for (const b of board?.facets?.brands ?? []) {
      urls.push({
        loc: `${base}/leaderboards/${m.key}/b/${b.slug}`,
        lastmod: windowOpened,
        changefreq: "weekly",
        priority: 0.4,
      });
    }
    for (const cat of board?.facets?.categories ?? []) {
      urls.push({
        loc: `${base}/leaderboards/${m.key}/c/${cat.slug}`,
        lastmod: windowOpened,
        changefreq: "weekly",
        priority: 0.4,
      });
    }
  }
  return urls;
}

/**
 * Value Index URLs (US-1747): the hub + one brand/item page per published curve.
 * Bounded to curves with real comp depth — the /api/grading/public/value hub is
 * already MIN_INDEX_TOTAL_SAMPLE-filtered, so no thin page enters the sitemap.
 * Per-condition pages are interlinked from the item pages (crawlable) but left
 * out of the sitemap so a condition band without comp support is never listed.
 */
export async function valueIndexUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const data = await fetchEdgeJson<{
    items: Array<{ brandSlug: string; itemSlug: string; refreshedAt?: string }>;
  }>(env, "/api/grading/public/value");
  const urls: SitemapUrl[] = [
    { loc: `${base}/value`, lastmod: today(), changefreq: "weekly", priority: 0.7 },
  ];
  for (const it of data?.items ?? []) {
    if (!it.brandSlug || !it.itemSlug) continue;
    urls.push({
      loc: `${base}/value/${it.brandSlug}/${it.itemSlug}`,
      lastmod: it.refreshedAt?.slice(0, 10),
      changefreq: "weekly",
      priority: 0.6,
    });
  }
  // US-2100: hub inherits its newest child's date instead of today().
  return withHubLastmod(urls);
}

// US-1774: public Durability Rankings hub + per-brand pages. The
// /api/grading/public/durability hub is already sample-gated (sufficient
// cohorts only), so no thin cohort enters the sitemap.
export async function durabilityUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const data = await fetchEdgeJson<{
    items: Array<{ brandSlug: string; refreshedAt?: string }>;
  }>(env, "/api/grading/public/durability");
  const urls: SitemapUrl[] = [
    { loc: `${base}/durability`, lastmod: today(), changefreq: "weekly", priority: 0.7 },
  ];
  for (const it of data?.items ?? []) {
    if (!it.brandSlug) continue;
    urls.push({
      loc: `${base}/durability/${it.brandSlug}`,
      lastmod: it.refreshedAt?.slice(0, 10),
      changefreq: "weekly",
      priority: 0.6,
    });
  }
  // US-2100: hub inherits its newest child's date instead of today().
  return withHubLastmod(urls);
}

export function urlsetXml(urls: SitemapUrl[]): string {
  const body = urls
    .map(
      (u) =>
        `<url><loc>${escape(u.loc)}</loc>` +
        (u.lastmod ? `<lastmod>${escape(u.lastmod)}</lastmod>` : "") +
        (u.changefreq ? `<changefreq>${u.changefreq}</changefreq>` : "") +
        (u.priority !== undefined ? `<priority>${u.priority.toFixed(1)}</priority>` : "") +
        `</url>`,
    )
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    body +
    `\n</urlset>\n`
  );
}

/** US-2100: an index entry, optionally carrying its sub-sitemap's real date. */
export type SitemapIndexEntry = string | { name: string; lastmod?: string };

/**
 * US-2100 AC2: every index entry used to claim today(), so the index asserted
 * that all ten sub-sitemaps changed every single day. Callers now pass the
 * newest lastmod from the URLs they already built for each section.
 *
 * A section with no derivable date falls back to today() rather than being
 * omitted: <lastmod> is optional in the spec, but dropping it for some entries
 * and keeping it for others makes the index harder to read than a conservative
 * date does.
 */
export function sitemapIndexXml(
  env: PagesEnv,
  names: SitemapIndexEntry[],
): string {
  const base = siteUrl(env);
  const fallback = today();
  const body = names
    .map((entry) => {
      const n = typeof entry === "string" ? entry : entry.name;
      const lm = (typeof entry === "string" ? undefined : entry.lastmod) ?? fallback;
      return `<sitemap><loc>${escape(`${base}/${n}`)}</loc><lastmod>${lm}</lastmod></sitemap>`;
    })
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    body +
    `\n</sitemapindex>\n`
  );
}

export const SITEMAP_HEADERS = {
  "Content-Type": "application/xml; charset=utf-8",
  "Cache-Control": "public, max-age=600, s-maxage=3600",
} as const;

// ── Image sitemap (US-975) ────────────────────────────────────────────────
// A Google image sitemap groups the indexable images that appear ON a page
// under that page's <url> entry, so crawlers can discover images they might not
// reach by parsing HTML. We list the public marketing share images + each blog
// post's hero image, each with a descriptive title + caption.

/** One image entry inside a page's <url> block. */
export interface SitemapImage {
  loc: string;
  title?: string;
  caption?: string;
}

/** A page URL plus the images that appear on it. */
export interface ImageSitemapEntry {
  loc: string;
  images: SitemapImage[];
}

// US-2111: FALLBACK ONLY — the live source is dist/seo-manifest.json, whose
// `image` field is emitted from ROUTE_OG_IMAGES by the Vite seoManifestPlugin.
// This is the same cross-boundary pattern llms.txt uses (Pages Functions cannot
// import from src/, so the build emits data and the function fetches it).
//
// This list was previously the ONLY source, carried a "KEEP IN SYNC with
// ROUTE_OG_IMAGES" comment, and had no guard enforcing it — so a new share card
// silently never reached the image sitemap. It is kept, deliberately, for the
// case where the manifest fetch fails at the edge: a stale-but-correct set of
// marketing images beats an EMPTY image sitemap, which would tell Google we
// removed every image we have. It may drift; that is acceptable precisely
// because it only serves a transient failure. Do not add new cards here — add
// them to ROUTE_OG_IMAGES and they arrive automatically.
const FALLBACK_MARKETING_IMAGES: Array<{
  path: string;
  image: string;
  title: string;
  caption: string;
}> = [
  {
    path: "/",
    image: "/og-image.png",
    title: "GradeThread — AI clothing condition grading",
    caption:
      "GradeThread delivers objective AI condition grading and verifiable certificates for pre-owned clothing.",
  },
  {
    path: "/how-it-works",
    image: "/social/how-it-works.png",
    title: "How GradeThread grading works",
    caption:
      "How GradeThread grades pre-owned clothing across five weighted factors.",
  },
  {
    path: "/pricing",
    image: "/social/pricing.png",
    title: "GradeThread pricing",
    caption:
      "GradeThread pricing — a free plan, pay-per-grade tiers, and FlipDesk subscriptions.",
  },
  {
    path: "/for-resellers",
    image: "/social/for-resellers.png",
    title: "GradeThread for resellers",
    caption:
      "GradeThread for resellers — standardized condition grades that build buyer trust.",
  },
  {
    path: "/condition-grading",
    image: "/social/condition-grading.png",
    title: "Clothing condition grading guide",
    caption:
      "A guide to clothing condition grading: the 1.0–10.0 scale, seven tiers, five factors.",
  },
  {
    path: "/grading-standard",
    image: "/social/grading-standard.png",
    title: "The GradeThread grading standard",
    caption:
      "The GradeThread grading standard — a published 1.0–10.0 rubric with confidence scoring.",
  },
  {
    path: "/transparency",
    image: "/social/transparency.png",
    title: "GradeThread grading transparency report",
    caption:
      "GradeThread's published grading accuracy and AI-vs-human agreement report.",
  },
  {
    path: "/faq",
    image: "/social/faq.png",
    title: "GradeThread FAQ",
    caption:
      "GradeThread FAQ — AI grading, the 1.0–10.0 scale, disputes, certificates, and the API.",
  },
];

/**
 * Static marketing image entries, derived from the build-emitted manifest so
 * they cannot drift from ROUTE_OG_IMAGES (US-2111).
 *
 * Falls back to FALLBACK_MARKETING_IMAGES when the manifest is unreachable or
 * carries no image-bearing routes. The empty-image-set case is treated as a
 * failure rather than as "there are no marketing images": a manifest emitted by
 * an older build predates the `image` field entirely, and reading that as an
 * intentional zero would silently empty the image sitemap on the first deploy
 * after a rollback.
 */
export async function marketingImageUrls(
  env: PagesEnv,
): Promise<ImageSitemapEntry[]> {
  const base = siteUrl(env);
  const manifest = await fetchManifest(env);
  const fromManifest = (manifest?.routes ?? []).filter((r) => r.image?.file);

  if (fromManifest.length > 0) {
    return fromManifest.map((r) => ({
      loc: r.path === "/" ? `${base}/` : `${base}${r.path}`,
      images: [
        {
          loc: `${base}${r.image!.file}`,
          title: r.title || undefined,
          caption: r.image!.alt || undefined,
        },
      ],
    }));
  }

  console.error(
    "[sitemap] seo-manifest carried no route images; serving the static " +
      "fallback marketing set, which MAY BE STALE.",
  );
  return FALLBACK_MARKETING_IMAGES.map((m) => ({
    loc: m.path === "/" ? `${base}/` : `${base}${m.path}`,
    images: [
      { loc: `${base}${m.image}`, title: m.title, caption: m.caption },
    ],
  }));
}

/** Blog hero images grouped under each post URL (skips posts with no hero). */
export async function blogImageUrls(env: PagesEnv): Promise<ImageSitemapEntry[]> {
  const base = siteUrl(env);
  const data = await fetchEdgeJson<BlogSitemap>(
    env,
    "/api/content/public/sitemap.json",
  );
  const entries: ImageSitemapEntry[] = [];
  for (const p of data?.posts ?? []) {
    const hero = (p.hero_image_url ?? "").trim();
    if (!hero) continue;
    entries.push({
      loc: `${base}/blog/${p.slug}`,
      images: [
        {
          loc: hero,
          title: p.title || undefined,
          // Caption prefers an explicit hero caption, else the alt text.
          caption: p.hero_image_caption || p.hero_image_alt || undefined,
        },
      ],
    });
  }
  return entries;
}

/** All image-sitemap entries: marketing images + blog hero images. */
export async function imageUrls(env: PagesEnv): Promise<ImageSitemapEntry[]> {
  const [marketing, blog] = await Promise.all([
    marketingImageUrls(env),
    blogImageUrls(env),
  ]);
  return [...marketing, ...blog];
}

/** Serialize image-sitemap entries to a Google image-sitemap <urlset>. */
export function imageSitemapXml(entries: ImageSitemapEntry[]): string {
  const body = entries
    .filter((e) => e.images.length > 0)
    .map((e) => {
      const imgs = e.images
        .map(
          (img) =>
            `<image:image><image:loc>${escape(img.loc)}</image:loc>` +
            (img.title ? `<image:title>${escape(img.title)}</image:title>` : "") +
            (img.caption
              ? `<image:caption>${escape(img.caption)}</image:caption>`
              : "") +
            `</image:image>`,
        )
        .join("");
      return `<url><loc>${escape(e.loc)}</loc>${imgs}</url>`;
    })
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ` +
    `xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
    body +
    `\n</urlset>\n`
  );
}

/**
 * US-2097: wrap a sub-sitemap's build so an unreachable upstream serves 503
 * rather than a silently-incomplete 200 (or, once fetchEdgeJson throws, a bare
 * 500).
 *
 * Exists as ONE helper rather than eleven try/catches because there are eleven
 * sub-sitemap routes with an identical shape — and the failure this guards
 * against is precisely the kind that gets fixed in one file and left in ten.
 */
export async function sitemapResponse(
  route: string,
  build: () => Promise<SitemapUrl[]>,
): Promise<Response> {
  let urls: SitemapUrl[];
  try {
    urls = await build();
  } catch (e) {
    if (e instanceof UpstreamUnavailable) {
      console.error(`[${route}] upstream unavailable — serving 503:`, e.message);
      return upstreamUnavailableResponse();
    }
    throw e;
  }
  return new Response(urlsetXml(urls), {
    status: 200,
    headers: { ...SITEMAP_HEADERS },
  });
}
