// Build-time prerender (US-292). Runs AFTER `vite build`. For every route in
// the SEO registry it:
//   1. SSR-renders the React page to an HTML body (src/prerender/entry-server)
//   2. builds the per-route <head> from the registry (src/prerender/head-builder)
//   3. injects both into the built dist/index.html template (between the
//      prerender:head markers and the #root prerender:body marker)
//   4. writes dist/<route>/index.html
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
import { syncCspHash } from "./csp-hash.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const distDir = join(root, "dist");
const templatePath = join(distDir, "index.html");

const HEAD_START = "<!-- prerender:head:start";
const HEAD_END = "prerender:head:end -->";
const BODY_MARKER = "<!--prerender:body-->";

function fail(msg) {
  console.error(`\n[prerender] ERROR: ${msg}\n`);
  process.exit(1);
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

  for (const route of PUBLIC_ROUTES) {
    const body = stripHeadTagsFromBody(renderRoute(route.path));
    const head = buildHeadTags(route);

    let html = beforeHead + head + afterHead;
    html = html.replace(BODY_MARKER, body);

    // "/" → dist/index.html; "/privacy" → dist/privacy/index.html
    const outPath =
      route.path === "/"
        ? join(distDir, "index.html")
        : join(distDir, route.path.replace(/^\//, ""), "index.html");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html);
    written += 1;
    console.log(
      `[prerender] ${route.path.padEnd(18)} → ${outPath.replace(root + "/", "")} (${body.length} body bytes)`,
    );
  }
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
