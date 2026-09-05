import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLIC_ROUTES, getRouteMeta, normalizePath } from "../public-routes";

// The guard (US-291): a public, static, indexable router path that isn't in the
// registry would be invisible to the sitemap, prerender, and IndexNow. This
// test fails the build in that case, so a page can't ship un-indexable.

const routesSrc = readFileSync(
  resolve(process.cwd(), "src/routes/index.tsx"),
  "utf8",
);
const allRouterPaths = [...routesSrc.matchAll(/path:\s*"([^"]+)"/g)].map(
  (m) => m[1] as string,
);

// Auth-gated app surfaces — never indexable, so they must NOT be required in
// PUBLIC_ROUTES. `/buyer` is the buyer app (US-1802+), gated by ProtectedRoute +
// BuyerRoute; note this excludes only `/buyer` and `/buyer/*`, NOT the public
// `/buyer-guarantee` policy page (which stays registered + prerendered).
const DISALLOWED_PREFIXES = ["/dashboard", "/admin", "/auth", "/buyer"];
const AUTH_OR_FLOW_EXACT = new Set([
  "/login",
  "/signup",
  "/accept-invite",
  // Transient post-action confirmation page; noindex, not a static landing page.
  "/waitlist-pending",
  // US-867: buyer-guarantee claim intake form — an interactive flow page (posts
  // to the edge, no static content to index). The policy page /buyer-guarantee
  // IS registered + prerendered; the form itself is intentionally not.
  "/buyer-guarantee/claim",
  // Links the browser extension to the signed-in account (token flow) — a
  // utility page, not indexable content, so it's intentionally not in
  // PUBLIC_ROUTES. (Fixes the pre-existing CI web-lane red.)
  "/connect-extension",
  // US-1855: the public Showcase feed. Indexable, but its content changes every
  // time someone showcases a find or reacts to one, so it is edge-SSR'd by
  // functions/finds/[[path]].ts and listed in the sitemap by findsUrls() —
  // NOT prerendered at build like a static marketing page. Registering it here
  // would bake a snapshot of the feed into dist/ that _routes.json never serves
  // (the Function wins) and list /finds in the sitemap twice. Same treatment as
  // /cert/:id and /verified/:handle, which escape this guard only because they
  // carry a param.
  "/finds",
  // US-1856: the public reward leaderboards. Same treatment, same reason as
  // /finds — the rankings change as people grade, react and refer, so the page
  // is edge-SSR'd by functions/leaderboards/[[path]].ts and listed in the
  // sitemap by leaderboardUrls(). Registering it here would bake a stale
  // snapshot into dist/ that _routes.json never serves and list the path twice.
  "/leaderboards",
  // US-2506: the public Condition Index. Same treatment, same reason as /finds
  // and /leaderboards — the price-vs-grade curves are rebuilt as graded sales
  // land, so the page is edge-SSR'd by functions/condition-index/[[path]].ts and
  // listed in the sitemap by conditionIndexUrls() (functions/_shared/sitemap.ts:448).
  // It only gained a router path at all so the footer link MarketingLayout puts
  // on every public page stops falling through to the SPA 404; registering it
  // here would bake a stale snapshot into dist/ that _routes.json never serves
  // and list the path in the sitemap twice.
  "/condition-index",
  // US-2576: the public Help Center hub. Same treatment, same reason as /finds,
  // /leaderboards and /condition-index — articles are database rows an admin
  // edits without a deploy, so the page is edge-SSR'd by
  // functions/help/[[path]].ts and listed in the sitemap by sitemap-help.xml
  // (US-2578). Registering it here would bake a snapshot of the shelf into dist/
  // that _routes.json never serves (the Function wins) and list /help in the
  // sitemap twice. /help/:category and /help/:category/:slug escape this guard
  // on the param rule above.
  "/help",
  // US-2577: the help search-results page. noindex, follow — thin, infinite and
  // duplicative, so not something to rank, but its links must keep passing
  // equity to the articles it found. Registering it would put a noindex page in
  // the sitemap and prerender an empty result set into dist/.
  "/help/search",
  // US-9121: the OAuth consent screen. A flow page, not content — it exists to
  // be arrived at from /oauth/authorize carrying a query string, and without
  // one it renders "This connection link is incomplete". Registering it put a
  // page in the sitemap whose prerendered body was that error, which is how the
  // heading-outline guard found it had no h1 in that state.
  "/connect/claude",
]);

/** A router path that should have a static, indexable registry entry. */
function isStaticPublic(p: string): boolean {
  if (p === "*") return false; // 404 catch-all
  if (p.includes(":")) return false; // dynamic params (e.g. /cert/:id)
  if (!p.startsWith("/")) return false;
  if (AUTH_OR_FLOW_EXACT.has(p)) return false;
  if (
    DISALLOWED_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`))
  ) {
    return false;
  }
  return true;
}

describe("public-routes registry guard (US-291)", () => {
  it("extracted at least the known public router paths", () => {
    expect(allRouterPaths).toContain("/");
    expect(allRouterPaths).toContain("/privacy");
  });

  it("every static public router path is registered in PUBLIC_ROUTES", () => {
    const registered = new Set(PUBLIC_ROUTES.map((r) => r.path));
    const publicPaths = [...new Set(allRouterPaths.filter(isStaticPublic))];
    const missing = publicPaths.filter(
      (p) => !registered.has(normalizePath(p)),
    );
    expect(missing).toEqual([]);
  });

  it("every registered route exists in the router", () => {
    // Glossary hub pages (US-303) are registered as concrete indexable paths
    // (/grading/<slug>) but served by a single dynamic /grading/:slug route, so
    // they won't appear as literal paths. Accept them when that route exists.
    const hasGlossaryDynamicRoute = allRouterPaths.includes("/grading/:slug");
    // US-1688: reselling TOFU guides (/reselling/<slug>) are concrete indexable
    // paths served by the single dynamic /reselling/:slug route. The pillar
    // (/reselling) is a literal router path and is checked normally below.
    const hasResellingDynamicRoute = allRouterPaths.includes("/reselling/:slug");
    // US-1667: marketplace comparisons (/compare/<a>-vs-<b>) are concrete
    // indexable paths served by the single dynamic /compare/:slug route. The
    // hub (/compare) is a literal router path and is checked normally below.
    const hasCompareDynamicRoute = allRouterPaths.includes("/compare/:slug");
    // US-3093: the buyer-trust pages (/buying/<slug>) are concrete indexable
    // paths served by the single dynamic /buying/:slug route. There is
    // deliberately no /buying index page — one page with one link on it is a
    // crawl target with nothing to say — so nothing checks for the hub path.
    const hasBuyingDynamicRoute = allRouterPaths.includes("/buying/:slug");
    // US-9012: the flaw library moved from /grading/flaws to /care, where its 32
    // concrete indexable paths are served by the single dynamic /care/:flaw
    // route. Under /grading/ they were covered by the glossary clause above, so
    // the move needed its own; without it the guard reported all 32 as missing
    // from the router. The hub (/care) is a literal router path and is checked
    // normally below.
    const hasCareDynamicRoute = allRouterPaths.includes("/care/:flaw");
    for (const r of PUBLIC_ROUTES) {
      if (r.path.startsWith("/grading/")) {
        expect(hasGlossaryDynamicRoute).toBe(true);
        continue;
      }
      if (r.path.startsWith("/care/")) {
        expect(hasCareDynamicRoute).toBe(true);
        continue;
      }
      if (r.path.startsWith("/reselling/")) {
        expect(hasResellingDynamicRoute).toBe(true);
        continue;
      }
      if (r.path.startsWith("/compare/")) {
        expect(hasCompareDynamicRoute).toBe(true);
        continue;
      }
      if (r.path.startsWith("/buying/")) {
        expect(hasBuyingDynamicRoute).toBe(true);
        continue;
      }
      expect(allRouterPaths).toContain(r.path);
    }
  });

  it("no registered route lives under a noindex (auth/dashboard/admin) prefix", () => {
    for (const r of PUBLIC_ROUTES) {
      expect(isStaticPublic(r.path)).toBe(true);
    }
  });

  it("registry entries are well-formed", () => {
    for (const r of PUBLIC_ROUTES) {
      expect(r.path.startsWith("/")).toBe(true);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
      expect(r.priority).toBeGreaterThanOrEqual(0);
      expect(r.priority).toBeLessThanOrEqual(1);
    }
  });

  it("getRouteMeta normalizes trailing slashes", () => {
    expect(getRouteMeta("/privacy/")?.path).toBe("/privacy");
    expect(getRouteMeta("/")?.path).toBe("/");
    expect(getRouteMeta("/does-not-exist")).toBeUndefined();
  });
});
