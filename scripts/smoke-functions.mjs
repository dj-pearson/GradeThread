#!/usr/bin/env node
// Post-deploy smoke check for Pages Function routes (US-424).
//
// _routes.json (public/_routes.json) is an allowlist: only the listed paths
// invoke a Pages Function — everything else falls through to a static asset or
// the SPA shell. This script proves, against a live deploy, that each dynamic
// route is actually served by its Function and NOT shadowed by the SPA shell.
//
// It asserts a Function-only marker per route (JSON-LD type, XML root element,
// directive header, …). The SPA shell (dist/index.html) contains none of these,
// so a regression to "SPA fallback shadows the Function" fails the check.
//
// Usage:
//   node scripts/smoke-functions.mjs [baseUrl] [--cert <id>] [--verified <handle>]
//   BASE_URL=https://gradethread.com node scripts/smoke-functions.mjs
//
// Wired into LAUNCH_CHECKLIST.md §6 (run after every prod deploy). Exit code is
// non-zero if any required check fails, so it can gate a deploy pipeline.

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    flags[a.slice(2)] = args[i + 1];
    i++;
  } else {
    positional.push(a);
  }
}

const BASE = (positional[0] || process.env.BASE_URL || "https://gradethread.com").replace(/\/+$/, "");
const certId = flags.cert || process.env.SMOKE_CERT_ID;
const verifiedHandle = flags.verified || process.env.SMOKE_VERIFIED_HANDLE;

// A marker is a substring that ONLY a Function-rendered response contains.
// `optional: true` checks skip (warn, don't fail) when no sample id is supplied.
const checks = [
  { name: "robots.txt", path: "/robots.txt", marker: "User-agent", contentType: "text/plain" },
  { name: "llms.txt", path: "/llms.txt", marker: "GradeThread", contentType: "text/" },
  { name: "sitemap.xml", path: "/sitemap.xml", marker: "<urlset", contentType: "xml" },
  { name: "sitemap-static.xml", path: "/sitemap-static.xml", marker: "<urlset", contentType: "xml" },
  { name: "rss.xml", path: "/rss.xml", marker: "<rss", contentType: "xml" },
  {
    name: "cert SSR",
    path: certId ? `/cert/${encodeURIComponent(certId)}` : null,
    // Function-rendered cert carries Product + Review JSON-LD (US-300); the SPA
    // shell never does. This is the AC's headline assertion.
    marker: '"@type": "Product"',
    contentType: "text/html",
    optional: true,
    optionalHint: "pass --cert <id> of a known public certificate",
  },
  {
    name: "verified profile SSR",
    path: verifiedHandle ? `/verified/${encodeURIComponent(verifiedHandle)}` : null,
    marker: "<h1",
    contentType: "text/html",
    optional: true,
    optionalHint: "pass --verified <handle> of a known seller",
  },
];

// Marker proving a response IS the SPA shell — its presence on a Function route
// is a hard failure (the SPA shadowed the Function).
const SPA_SHELL_MARKERS = ['<div id="root"></div>', "/src/main.tsx"];

let failed = 0;
let warned = 0;

async function run() {
  console.log(`Smoke-checking Pages Functions on ${BASE}\n`);
  for (const c of checks) {
    if (!c.path) {
      console.log(`  ⚠ ${c.name}: SKIPPED (${c.optionalHint})`);
      warned++;
      continue;
    }
    const url = `${BASE}${c.path}`;
    try {
      const res = await fetch(url, { redirect: "follow" });
      const body = await res.text();
      const ct = res.headers.get("content-type") || "";

      const problems = [];
      if (!res.ok) problems.push(`HTTP ${res.status}`);
      if (c.contentType && !ct.toLowerCase().includes(c.contentType)) {
        problems.push(`content-type "${ct}" lacks "${c.contentType}"`);
      }
      if (!body.includes(c.marker)) problems.push(`missing marker ${JSON.stringify(c.marker)}`);
      const shellHit = SPA_SHELL_MARKERS.find((m) => body.includes(m));
      if (shellHit) problems.push(`served SPA shell (found ${JSON.stringify(shellHit)})`);

      if (problems.length) {
        console.log(`  ✗ ${c.name} (${c.path}): ${problems.join("; ")}`);
        failed++;
      } else {
        console.log(`  ✓ ${c.name} (${c.path})`);
      }
    } catch (err) {
      console.log(`  ✗ ${c.name} (${c.path}): ${err?.message ?? err}`);
      failed++;
    }
  }

  console.log("");
  if (failed > 0) {
    console.error(`✗ ${failed} check(s) failed${warned ? `, ${warned} skipped` : ""}.`);
    process.exit(1);
  }
  console.log(`✓ All required Function routes verified${warned ? ` (${warned} optional skipped)` : ""}.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
