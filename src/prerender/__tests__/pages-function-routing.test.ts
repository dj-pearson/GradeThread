// A Pages Function that handles a bare hub path must actually be ROUTED that
// path in public/_routes.json.
//
// This caught a live production 404 on the site's cornerstone SEO destination.
// functions/condition-index/[[path]].ts implements two surfaces — a hub at
// /condition-index and detail pages at /condition-index/<slug> — but
// _routes.json only listed "/condition-index/*". Cloudflare therefore never
// invoked the function for the bare URL; it fell through to static assets,
// which have no condition-index.html, and 404'd. The footer of all 213 public
// pages linked there, as did the HTML sitemap. The sibling surfaces /value and
// /durability each correctly listed BOTH forms, which is what made the omission
// so easy to miss by eye.
//
// Nothing else can catch this: the function compiles, its tests pass, the build
// succeeds, and the page renders perfectly in local dev where routing rules do
// not apply. It only fails in production, silently, as a 404.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";
import { resolve } from "node:path";

const ROOT = process.cwd();

interface RoutesJson {
  version: number;
  include: string[];
  exclude?: string[];
}

const routes: RoutesJson = JSON.parse(
  readFileSync(resolve(ROOT, "public/_routes.json"), "utf8"),
);

/** Catch-all Pages Functions: functions/<name>/[[path]].ts */
function catchAllFunctions(): Array<{ name: string; source: string }> {
  const dir = resolve(ROOT, "functions");
  const out: Array<{ name: string; source: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const file = resolve(dir, entry.name, "[[path]].ts");
    if (existsSync(file)) {
      out.push({ name: entry.name, source: readFileSync(file, "utf8") });
    }
  }
  return out;
}

describe("Pages Functions are routed the paths they handle", () => {
  const fns = catchAllFunctions();

  it("finds catch-all functions at all", () => {
    // Without this the suite passes vacuously if the layout changes.
    expect(fns.length, "no functions/<name>/[[path]].ts found — the scan broke").toBeGreaterThan(0);
  });

  it("a function handling a bare hub path has that path in _routes.json", () => {
    const missing: string[] = [];

    for (const { name, source } of fns) {
      const bare = `/${name}`;
      // Only require the bare route when the function actually branches on it.
      // Matches `path === "/condition-index"` and the pathname equivalent.
      const handlesBare = new RegExp(
        `(?:path|pathname)\\s*===\\s*["'\`]${bare}["'\`]`,
      ).test(source);
      if (!handlesBare) continue;

      if (!routes.include.includes(bare)) {
        missing.push(
          `${bare} — functions/${name}/[[path]].ts handles it, but _routes.json ` +
            `lists only "${bare}/*", so Cloudflare serves a static 404 instead`,
        );
      }
    }

    expect(
      missing,
      "These Pages Functions implement a hub page that production never routes " +
        "to them:\n  " +
        missing.join("\n  ") +
        '\n\nAdd the bare path alongside the wildcard, as /value and /durability do.',
    ).toEqual([]);
  });

  it("every router route survives a hard load / refresh / shared link", () => {
    // This deployment has NO SPA fallback rewrite: public/_redirects ends in
    // `/* -> /404.html 404`, deliberately, so unmatched paths are real 404s
    // rather than soft-404 SPA shells. The consequence is easy to forget —
    // EVERY client-rendered namespace needs either a spa-shell Pages Function
    // or prerendered HTML, or it only works via in-app navigation.
    //
    // It was forgotten four times. /buyer/** (the whole authenticated buyer
    // portal) 404'd on refresh or bookmark; /claim/:token (emailed passport
    // claim links) and /t/:code (physical-tag QR scans) 404'd on every use,
    // since a scan or an emailed link is ALWAYS a cold load — the QR surface
    // was entirely non-functional. Three of them carried comments in
    // src/routes/index.tsx describing "a pure SPA route (no SSR Function)" as a
    // deliberate choice, which is exactly the misconception this guard exists
    // to make impossible.
    const router = readFileSync(resolve(ROOT, "src/routes/index.tsx"), "utf8");
    const routerPaths = [
      ...new Set([...router.matchAll(/path:\s*"(\/[^"]*)"/g)].map((m) => m[1]!)),
    ];
    expect(routerPaths.length, "no router paths parsed — the scan broke").toBeGreaterThan(50);

    const prerendered = new Set(PUBLIC_ROUTES.map((r) => r.path));

    const matchesInclude = (u: string) =>
      routes.include.some((r) =>
        r.endsWith("/*") ? u.startsWith(r.slice(0, -1)) : r === u,
      );

    const unreachable = routerPaths.filter((p) => {
      if (p.includes("*")) return false; // catch-all inside the SPA

      if (p.includes("/:")) {
        // A parameterised route is reachable when its prefix is served by a
        // Function, or when concrete instances are prerendered under it.
        const prefix = p.slice(0, p.indexOf("/:") + 1);
        if (matchesInclude(`${prefix}probe`)) return false;
        return ![...prerendered].some((r) => r.startsWith(prefix));
      }

      return !matchesInclude(p) && !prerendered.has(p);
    });

    expect(
      unreachable,
      "These routes exist in the router but nothing serves them on a cold " +
        "load, so a refresh, bookmark, QR scan or shared link returns 404:\n  " +
        unreachable.join("\n  ") +
        "\n\nAdd a functions/<namespace>/[[path]].ts calling serveSpaShell and " +
        "list the namespace in public/_routes.json (see functions/dashboard).",
    ).toEqual([]);
  });

  it("every wildcard include has a function directory behind it", () => {
    // The reverse rot: a route rule kept after its function was removed sends
    // real traffic into the Functions runtime for a handler that no longer
    // exists.
    const orphaned = routes.include
      .filter((r) => r.endsWith("/*"))
      .map((r) => r.slice(1, -2))
      .filter((name) => name && !name.includes("/") && !name.startsWith("."))
      .filter((name) => !existsSync(resolve(ROOT, "functions", name)))
      .filter((name) => !existsSync(resolve(ROOT, "functions", `${name}.ts`)));

    expect(
      orphaned,
      "Route rules pointing at functions that do not exist:\n  " + orphaned.join("\n  "),
    ).toEqual([]);
  });
});
