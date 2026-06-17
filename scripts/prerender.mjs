// Build-time prerender (US-292). Runs AFTER `vite build`. For every route in
// the SEO registry it:
//   1. SSR-renders the React page to an HTML body (src/prerender/entry-server)
//   2. builds the per-route <head> from the registry (src/prerender/head-builder)
//   3. injects both into the built dist/index.html template (between the
//      prerender:head markers and the #root prerender:body marker)
//   4. writes dist/<route>.html (flat file — NOT a directory index; see the
//      outPath note below for why directory-form output deadlocks redirects)
//
// No headless browser is needed (none is available in CI/Cloudflare builds, and
// a Chromium download would be fragile). react-helmet-async v3 renders no head
// server-side, so the <head> is assembled deterministically from the same data
// the client <SEO> uses. The SAME HTML is served to humans and crawlers (no
// cloaking); the SPA mounts over it with createRoot.
//
// Run: node scripts/prerender.mjs   (wired into `npm run build`)

import { createServer } from "vite";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { syncCspHash } from "./csp-hash.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const distDir = join(root, "dist");
const templatePath = join(distDir, "index.html");

const HEAD_START = "<!-- prerender:head:start";
const HEAD_END = "prerender:head:end -->";
const BODY_MARKER = "<!--prerender:body-->";

// US-420: render routes with bounded concurrency so build time stays flat as
// marketing/GEO pages multiply. Each route's SSR render + head build + write is
// independent, so we chunk the route list and await one chunk before starting
// the next (chunked Promise.all). Override with PRERENDER_CONCURRENCY.
const CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.PRERENDER_CONCURRENCY ?? "", 10) || 8,
);

// Run an async worker over `items` with at most `limit` in flight at once.
async function chunkedMap(items, limit, worker) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const settled = await Promise.all(chunk.map((item) => worker(item)));
    results.push(...settled);
  }
  return results;
}

function fail(msg) {
  console.error(`\n[prerender] ERROR: ${msg}\n`);
  process.exit(1);
}

// US-432: post-prerender head-integrity guard. Asserts each generated document
// has exactly one <title> and one rel=canonical, and that no <title>,
// rel=canonical, or <meta name="description"> leaked into the SSR <body> (i.e.
// the Helmet strip worked). Called per route in the write loop; fails the build.
function countMatches(s, re) {
  return (s.match(re) ?? []).length;
}
function validateHeadIntegrity(html, body, routePath) {
  const titles = countMatches(html, /<title[\s>]/gi);
  if (titles !== 1) {
    fail(`${routePath}: expected exactly 1 <title>, found ${titles}.`);
  }
  const canon = countMatches(html, /<link[^>]+rel=["']?canonical["']?/gi);
  if (canon !== 1) {
    fail(`${routePath}: expected exactly 1 rel=canonical, found ${canon}.`);
  }
  const desc = countMatches(html, /<meta[^>]+name=["']?description["']?/gi);
  if (desc !== 1) {
    fail(`${routePath}: expected exactly 1 <meta name=description>, found ${desc}.`);
  }
  // Nothing head-only may survive inside the rendered body (Helmet leak check).
  const leaks = [
    [/<title[\s>]/i, "<title>"],
    [/<link[^>]+rel=["']?canonical["']?/i, "rel=canonical"],
    [/<meta[^>]+name=["']?description["']?/i, "<meta name=description>"],
  ];
  for (const [re, label] of leaks) {
    if (re.test(body)) {
      fail(`${routePath}: ${label} leaked into <body> — Helmet strip failed.`);
    }
  }
}

if (!existsSync(templatePath)) {
  fail(`dist/index.html not found — run \`vite build\` before prerendering.`);
}

const template = readFileSync(templatePath, "utf8");
if (!template.includes(HEAD_START) || !template.includes(HEAD_END)) {
  fail(`index.html is missing the prerender:head markers.`);
}
if (!template.includes(BODY_MARKER)) {
  fail(`index.html is missing the ${BODY_MARKER} marker.`);
}

const vite = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});

let written = 0;
// Captured inside the try (PUBLIC_ROUTES is loaded via ssrLoadModule) for use
// by the trailing-slash _redirects generation after vite closes (US-426).
let prerenderedPaths = [];
try {
  const { renderRoute, PRERENDERABLE_PATHS } = await vite.ssrLoadModule(
    "/src/prerender/entry-server.tsx",
  );
  const { buildHeadTags, stripHeadTagsFromBody } = await vite.ssrLoadModule(
    "/src/prerender/head-builder.ts",
  );
  const { PUBLIC_ROUTES } = await vite.ssrLoadModule(
    "/src/lib/seo/public-routes.ts",
  );
  prerenderedPaths = PUBLIC_ROUTES.map((r) => r.path);

  // Guard: every registered route must be renderable, and vice versa, so a new
  // public page can't silently skip prerendering.
  const registered = PUBLIC_ROUTES.map((r) => r.path).sort();
  const renderable = [...PRERENDERABLE_PATHS].sort();
  if (JSON.stringify(registered) !== JSON.stringify(renderable)) {
    fail(
      `route registry and prerender entry are out of sync.\n` +
        `  registry:   ${registered.join(", ")}\n` +
        `  entry-server: ${renderable.join(", ")}\n` +
        `Add the new page to src/prerender/entry-server.tsx (and the registry).`,
    );
  }

  const headStartIdx = template.indexOf(HEAD_START);
  const headEndIdx = template.indexOf(HEAD_END) + HEAD_END.length;
  const beforeHead = template.slice(0, headStartIdx);
  const afterHead = template.slice(headEndIdx);

  // US-420: measure prerender duration so we can keep it flat as routes grow.
  const renderStart = performance.now();

  const renderOne = async (route) => {
    const body = stripHeadTagsFromBody(renderRoute(route.path));
    const head = buildHeadTags(route);

    let html = beforeHead + head + afterHead;
    html = html.replace(BODY_MARKER, body);

    // US-432: assert head integrity on the FINAL document before writing it.
    // react-helmet-async (v3 fork) leaks <title>/<meta>/<link> into the SSR body;
    // stripHeadTagsFromBody removes them, but a brittle regex could silently
    // miss one — yielding duplicate <title>s or a <meta name=description> inside
    // <body> (both hurt indexing). Fail the build (CI) on any violation.
    validateHeadIntegrity(html, body, route.path);

    // "/" → dist/index.html; "/privacy" → dist/privacy.html (FLAT file, not a
    // directory index). This is load-bearing: a directory-form dist/privacy/
    // index.html makes Cloudflare Pages 308-redirect /privacy → /privacy/, which
    // then collides with the US-426 trailing-slash 301 (/privacy/ → /privacy)
    // generated below — an infinite redirect loop (ERR_TOO_MANY_REDIRECTS). A
    // flat privacy.html is served at /privacy with a clean 200 (no slash added),
    // so the no-slash canonical and the 301 agree. Nested routes still nest
    // (/a/b → dist/a/b.html); mkdirSync handles the parent dir.
    const outPath =
      route.path === "/"
        ? join(distDir, "index.html")
        : join(distDir, route.path.replace(/^\//, "") + ".html");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html);
    console.log(
      `[prerender] ${route.path.padEnd(18)} → ${outPath.replace(root + "/", "")} (${body.length} body bytes)`,
    );
  };

  await chunkedMap(PUBLIC_ROUTES, CONCURRENCY, renderOne);
  written = PUBLIC_ROUTES.length;

  const renderMs = Math.round(performance.now() - renderStart);
  console.log(
    `[prerender] rendered ${PUBLIC_ROUTES.length} route(s) in ${renderMs}ms ` +
      `(concurrency ${CONCURRENCY}, ~${Math.round(renderMs / Math.max(1, PUBLIC_ROUTES.length))}ms/route).`,
  );
} catch (e) {
  console.error(e);
  fail(`prerender failed: ${e?.message ?? e}`);
} finally {
  await vite.close();
}

console.log(`\n[prerender] wrote ${written} static page(s).`);

// US-358: regenerate the CSP inline-script hash from the BUILT bootstrap (which
// esbuild may have minified) and rewrite dist/_headers, so the served CSP can
// never drift from the served index.html. The inline bootstrap sits after the
// prerender:head markers and is preserved byte-for-byte across all routes, so
// hashing the root dist/index.html covers every page.
const headersPath = join(distDir, "_headers");
if (existsSync(headersPath)) {
  const builtIndex = readFileSync(templatePath, "utf8");
  const headers = readFileSync(headersPath, "utf8");
  try {
    const synced = syncCspHash(builtIndex, headers);
    if (synced !== headers) {
      writeFileSync(headersPath, synced);
      console.log("[prerender] synced CSP inline-script hash in dist/_headers.");
    } else {
      console.log("[prerender] CSP inline-script hash already current.");
    }
  } catch (e) {
    fail(`CSP hash sync failed: ${e?.message ?? e}`);
  }
} else {
  fail("dist/_headers not found — cannot sync the CSP inline-script hash.");
}

// US-426: enforce a single trailing-slash canonical policy — NO trailing slash
// (except root "/"). The prerendered + client canonicals already use the
// no-slash form (head-builder absoluteUrl / <SEO> normalizePath). Here we emit
// an explicit 301 for each prerendered route's slash variant so "/pricing/"
// permanently redirects to "/pricing", deterministically (no reliance on
// Cloudflare Pages' auto trailing-slash behavior) and ahead of the SPA fallback.
// First match wins in _redirects, so these are prepended before "/* /index.html".
// hreflang/x-default: intentionally OMITTED — GradeThread is single-locale
// (en), so emitting hreflang would add noise with no benefit (US-426 AC3).
const redirectsPath = join(distDir, "_redirects");
if (existsSync(redirectsPath)) {
  const existing = readFileSync(redirectsPath, "utf8");
  const slashRules = prerenderedPaths
    .filter((p) => p !== "/")
    .map((p) => `${p}/ ${p} 301`);
  const block =
    "# US-426: trailing-slash → canonical (no slash). Generated by prerender.\n" +
    slashRules.join("\n");
  // Idempotent: only prepend if not already present.
  if (!existing.includes("US-426: trailing-slash")) {
    writeFileSync(redirectsPath, `${block}\n\n${existing}`);
    console.log(
      `[prerender] prepended ${slashRules.length} trailing-slash 301(s) to dist/_redirects.`,
    );
  } else {
    console.log("[prerender] trailing-slash 301s already present in dist/_redirects.");
  }
} else {
  fail("dist/_redirects not found — cannot enforce the trailing-slash policy.");
}

// Force a clean exit. All work above is synchronous/awaited and finished by here
// (vite.close() ran, dist files + _headers + _redirects are written). Vite's
// middleware-mode dev server leaves dangling handles on Windows even after
// close() — the esbuild service child, chokidar watchers, the stdio pipe — so the
// Node event loop never drains and the process hangs at the end instead of
// exiting. That stalled every foreground `npm run build` (and leaked one
// prerender process + its esbuild workers per Ralph iteration). Exit explicitly.
process.exit(0);
