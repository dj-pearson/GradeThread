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

const DISALLOWED_PREFIXES = ["/dashboard", "/admin", "/auth"];
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
    for (const r of PUBLIC_ROUTES) {
      if (r.path.startsWith("/grading/")) {
        expect(hasGlossaryDynamicRoute).toBe(true);
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
