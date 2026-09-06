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
// a Chromium download would be fragile). Nothing renders a <head> server-side -
// react-helmet-async never did and was removed in US-3120 - so the <head> is
// assembled deterministically from the same data the client <SEO> uses. The SAME HTML is served to humans and crawlers (no
// cloaking); the SPA mounts over it with createRoot.
//
// Run: node scripts/prerender.mjs   (wired into `npm run build`)

import { createServer, loadEnv } from "vite";
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
// rel=canonical, or <meta name="description"> leaked into the SSR <body>.
// Called per route in the write loop; fails the build.
function countMatches(s, re) {
  return (s.match(re) ?? []).length;
}
// US-9007: an inline <svg> may carry its own <title>, and it means something
// completely different — it is the accessible name of the drawing, the SVG
// equivalent of an alt attribute. This guard is looking for a HEAD title that
// leaked into the body, so it has to stop counting the ones inside SVG or the
// only way to draw an accessible diagram is to make it inaccessible. Stripping
// the whole element is deliberate: <desc>, <text> and everything else inside an
// SVG are body content this guard has no business reading either.
function withoutSvg(html) {
  return html.replace(/<svg[\s\S]*?<\/svg>/gi, "");
}
function validateHeadIntegrity(rawHtml, rawBody, routePath) {
  const html = withoutSvg(rawHtml);
  const body = withoutSvg(rawBody);
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

// US-1950: build a `(routePath) => "<link rel=modulepreload ...>"` resolver from
// the client bundle manifest. Returns a resolver that always yields a string
// (possibly empty) — every failure mode degrades to "" (no preload) rather than
// throwing, so a manifest hiccup can never break the build.
function createPreloadResolver(bundlePath, routeModules) {
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  } catch (err) {
    console.warn(
      `[prerender] no chunk manifest at ${bundlePath.replace(root + "/", "")} ` +
        `(${err?.message ?? err}) — skipping route-chunk modulepreloads.`,
    );
    return () => "";
  }

  const chunkOf = (f) => bundle[f];

  // Transitive closure of a chunk's imported chunks (itself included).
  function closure(start) {
    const seen = new Set();
    const stack = Array.isArray(start) ? [...start] : [start];
    while (stack.length) {
      const f = stack.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      const info = chunkOf(f);
      if (info) for (const im of info.imports) if (!seen.has(im)) stack.push(im);
    }
    return seen;
  }

  // Chunks already loaded by the entry bootstrap (the entry chunk + everything it
  // statically imports). index.html modulepreloads these, so we must NOT repeat
  // them — the route only needs the DELTA.
  const entryChunks = Object.entries(bundle)
    .filter(([, info]) => info.isEntry)
    .map(([f]) => f);
  const eager = closure(entryChunks);

  // Index: page-module id (path suffix) → its built chunk filename. A page module
  // lands in exactly one chunk (its lazy() split point), matched by source path.
  function findChunkForModule(moduleId) {
    const needle = `${moduleId}.`; // ".tsx"/".ts" — avoids "foo" matching "foobar"
    for (const [file, info] of Object.entries(bundle)) {
      if (info.modules.some((m) => m.replace(/\\/g, "/").includes(needle))) {
        return file;
      }
    }
    return null;
  }

  const cache = new Map();
  let missWarned = false;

  return function resolvePreloads(routePath) {
    if (cache.has(routePath)) return cache.get(routePath);
    const moduleId = routeModules[routePath];
    let tags = "";
    if (moduleId) {
      const pageChunk = findChunkForModule(moduleId);
      if (pageChunk) {
        const needed = [...closure(pageChunk)].filter((f) => !eager.has(f));
        // Page chunk first (it's the leaf the router awaits), then its deps.
        needed.sort((a, b) => (a === pageChunk ? -1 : b === pageChunk ? 1 : 0));
        tags = needed
          .map((f) => `<link rel="modulepreload" crossorigin href="/${f}">`)
          .join("");
      } else if (!missWarned) {
        missWarned = true;
        console.warn(
          `[prerender] ${routePath}: no chunk found for module "${moduleId}" ` +
            `— route-chunk preload skipped (page still works, just not preloaded).`,
        );
      }
    }
    cache.set(routePath, tags);
    return tags;
  };
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

// `vite build` runs in production mode and loads `.env.production` (where the
// committed VITE_* build vars live — see that file's header), so the CLIENT
// bundle gets them. But the SSR server below defaults to DEVELOPMENT mode, which
// loads `.env`/`.env.development` and NOT `.env.production` — so the prerender's
// SSR eval of supabase.ts would crash with "Missing VITE_SUPABASE_URL" even
// though the var is committed and the client build has it. Seed the production
// env into process.env (without clobbering anything already set, e.g. real CI/
// dashboard vars) so Vite's loadEnv exposes them to import.meta.env regardless of
// the dev-mode server. Keeps prerender working off the committed file alone —
// immune to a dashboard/wrangler wipe, matching `.env.production`'s intent.
const prodEnv = loadEnv("production", root, "VITE_");
for (const [key, value] of Object.entries(prodEnv)) {
  if (process.env[key] === undefined) process.env[key] = value;
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
  const { renderRoute, PRERENDERABLE_PATHS, ROUTE_PAGE_MODULES } =
    await vite.ssrLoadModule("/src/prerender/entry-server.tsx");
  const { buildHeadTags, stripHeadTagsFromBody } = await vite.ssrLoadModule(
    "/src/prerender/head-builder.ts",
  );
  const { PUBLIC_ROUTES } = await vite.ssrLoadModule(
    "/src/lib/seo/public-routes.ts",
  );

  // US-1399: fetch the live transparency figures so /transparency's numeric
  // facts land in the crawlable HTML (AI answer engines don't run JS). ANY
  // failure degrades to the old placeholder render — this fetch must never
  // fail the build (the reason the story was once deferred).
  const { setTransparencySeed } = await vite.ssrLoadModule(
    "/src/lib/seo/transparency-seed.ts",
  );
  const edgeBase = (process.env.VITE_EDGE_API_URL || "https://functions.gradethread.com")
    .replace(/\/$/, "");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`${edgeBase}/api/grading/public/transparency`, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      setTransparencySeed(await res.json());
      console.log("[prerender] transparency seed fetched — live figures will be in the static HTML.");
    } else {
      console.warn(`[prerender] transparency seed fetch returned ${res.status} — rendering placeholders (non-fatal).`);
    }
  } catch (err) {
    console.warn(`[prerender] transparency seed fetch failed (${err?.message ?? err}) — rendering placeholders (non-fatal).`);
  }

  // US-976 / US-1775 (indexability): same build-time seed for the other
  // data-report pages, so their aggregate figures land in the crawlable HTML
  // (AI answer engines don't run JS). Generalized keyed seed — see
  // src/lib/seo/prerender-seed.ts. EVERY fetch is best-effort and non-fatal:
  // a failure just leaves that page rendering the pre-seed placeholders.
  const { setPrerenderSeed } = await vite.ssrLoadModule(
    "/src/lib/seo/prerender-seed.ts",
  );
  const SEEDED_REPORTS = [
    { key: "resale-condition-report", path: "/api/grading/public/resale-condition-report" },
    { key: "durability-report", path: "/api/grading/public/durability-report" },
    // US-2187: the seller directory and referral leaderboard also hydrate their
    // list client-side — seed them so the ranked rows land in the crawlable HTML
    // (and AI answer engines that don't run JS can cite the figures).
    { key: "verified-directory", path: "/api/content/public/sellers.json" },
    { key: "referral-leaderboard", path: "/api/content/public/referral-leaderboard.json" },
  ];
  for (const { key, path } of SEEDED_REPORTS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(`${edgeBase}${path}`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        setPrerenderSeed(key, await res.json());
        console.log(`[prerender] ${key} seed fetched — live figures will be in the static HTML.`);
      } else {
        console.warn(`[prerender] ${key} seed fetch returned ${res.status} — rendering placeholders (non-fatal).`);
      }
    } catch (err) {
      console.warn(`[prerender] ${key} seed fetch failed (${err?.message ?? err}) — rendering placeholders (non-fatal).`);
    }
  }
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

  // US-1950: build the per-route chunk-preload resolver from the client build's
  // module manifest (build-meta/bundle-modules.json, emitted by the
  // bundle-modules-manifest Vite plugin during `vite build`, which runs before
  // this script). For each prerendered route we resolve its page module → its
  // built chunk → the transitive set of chunks that chunk needs, MINUS the chunks
  // the entry bootstrap already modulepreloads (vendor-react/query/supabase +
  // index). Emitting <link rel="modulepreload"> for that delta means the route's
  // JS is already in flight when the client createRoot render begins, so it never
  // suspends into the full-screen spinner. Fail-SAFE: any resolution miss (no
  // manifest, unmapped route, chunk not found) just emits nothing for that route
  // — the page keeps its prior behavior, the build never breaks.
  const resolvePreloads = createPreloadResolver(
    join(root, "build-meta", "bundle-modules.json"),
    ROUTE_PAGE_MODULES ?? {},
  );

  // US-420: measure prerender duration so we can keep it flat as routes grow.
  const renderStart = performance.now();

  const renderOne = async (route) => {
    const body = stripHeadTagsFromBody(renderRoute(route.path));
    const head = buildHeadTags(route) + resolvePreloads(route.path);

    let html = beforeHead + head + afterHead;
    html = html.replace(BODY_MARKER, body);

    // US-432: assert head integrity on the FINAL document before writing it.
    //
    // ⚠ US-3120: THE LEAK THIS WAS WRITTEN FOR IS GONE, AND THE CHECK STAYS.
    // react-helmet-async (v3 fork) leaked <title>/<meta>/<link> into the SSR
    // body and stripHeadTagsFromBody removed them; the library is no longer a
    // dependency and <SEO> returns null, so there is nothing left to strip.
    // What this still catches is a PAGE that renders a head tag in its own
    // markup - duplicate <title>s or a <meta name=description> inside <body>,
    // both of which hurt indexing. Fail the build (CI) on any violation.
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

// US-1404: host the IndexNow key file. IndexNow verifies ownership by fetching
// https://<host>/<INDEXNOW_KEY>.txt and expecting it to contain exactly the key —
// so without this file, every submission (the publish hooks in content-blog.ts /
// grading-pipeline.ts and the deploy-time submit-indexnow.mjs) is rejected. We
// emit it as a STATIC dist file when INDEXNOW_KEY is present in the build env
// (no-op otherwise, matching the rest of the IndexNow infra). _routes.json is a
// specific allow-list (no "/*"), so this .txt is served as a static asset, not a
// Pages Function. The key is a 32–128 char hex/alphanumeric string.
const indexNowKey = (process.env.INDEXNOW_KEY ?? "").trim();
if (indexNowKey) {
  if (/^[a-zA-Z0-9-]{8,128}$/.test(indexNowKey)) {
    writeFileSync(join(distDir, `${indexNowKey}.txt`), indexNowKey);
    console.log(`[prerender] wrote IndexNow key file dist/${indexNowKey}.txt`);
  } else {
    console.warn(
      "[prerender] INDEXNOW_KEY is set but not a valid key (8–128 chars of [A-Za-z0-9-]) — skipping key file.",
    );
  }
} else {
  console.log("[prerender] INDEXNOW_KEY not set — IndexNow key file skipped (submissions no-op).");
}

// Force a clean exit. All work above is synchronous/awaited and finished by here
// (vite.close() ran, dist files + _headers + _redirects are written). Vite's
// middleware-mode dev server leaves dangling handles on Windows even after
// close() — the esbuild service child, chokidar watchers, the stdio pipe — so the
// Node event loop never drains and the process hangs at the end instead of
// exiting. That stalled every foreground `npm run build` (and leaked one
// prerender process + its esbuild workers per Ralph iteration). Exit explicitly.
process.exit(0);
