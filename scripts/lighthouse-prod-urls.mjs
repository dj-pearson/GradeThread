#!/usr/bin/env node
// Pick the production URLs the weekly Lighthouse lane measures
// (.github/workflows/lighthouse.yml, job `prod-ssr`).
//
// The static lane measures prerendered pages from dist/. The pages that carry
// the search traffic are edge-SSR'd by Pages Functions (functions/) and never
// exist in dist/, so they can only be measured on the live site. Their slugs
// change as content is published, so they are read from the live sitemaps at
// run time rather than pinned here, where they would go stale and 404.
//
//   2 condition-index curves  <- /sitemap-condition.xml
//   1 blog post               <- /sitemap-blog.xml
//   1 certificate             <- /sitemap-certs.xml
//   /help                     (fixed)
//
// A sitemap that is unreachable or empty falls back to its hub page
// (/condition-index, /blog); there is no cert hub, so no cert is measured
// that week and the report says so.
//
// Usage: node scripts/lighthouse-prod-urls.mjs [--base https://gradethread.com]
// Prints one URL per line. Under GitHub Actions it also writes a multi-line
// `urls` output for the Lighthouse step.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_BASE = "https://gradethread.com";

/** Every <loc> value in a sitemap document, in order. */
export function locs(xml) {
  if (typeof xml !== "string") return [];
  const out = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    out.push(m[1].replace(/&amp;/g, "&"));
  }
  return out;
}

/**
 * Locs on `base`'s origin whose path is exactly `${prefix}/<one segment>`, so a
 * blog sitemap's /blog/page/2 and /blog/tag/x hubs are never taken for a post.
 */
function detailPages(xml, base, prefix) {
  const origin = new URL(base).origin;
  return locs(xml).filter((u) => {
    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      return false;
    }
    if (parsed.origin !== origin || !parsed.pathname.startsWith(`${prefix}/`)) return false;
    const rest = parsed.pathname.slice(prefix.length + 1).replace(/\/$/, "");
    return rest.length > 0 && !rest.includes("/");
  });
}

/**
 * The URL list, from the three sitemap bodies (null when a fetch failed).
 * Pure, so the selection rules are testable without the network.
 */
export function pickProdUrls({ condition, blog, certs }, base = DEFAULT_BASE) {
  const root = base.replace(/\/+$/, "");
  const urls = [];

  const curves = detailPages(condition, root, "/condition-index").slice(0, 2);
  urls.push(...(curves.length > 0 ? curves : [`${root}/condition-index`]));

  const posts = detailPages(blog, root, "/blog").slice(0, 1);
  urls.push(...(posts.length > 0 ? posts : [`${root}/blog`]));

  urls.push(...detailPages(certs, root, "/cert").slice(0, 1));

  urls.push(`${root}/help`);
  return urls;
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      console.error(`[lighthouse-prod-urls] ${url} answered ${res.status}; using the fallback`);
      return null;
    }
    return await res.text();
  } catch (e) {
    console.error(`[lighthouse-prod-urls] ${url} failed (${e}); using the fallback`);
    return null;
  }
}

async function main() {
  const i = process.argv.indexOf("--base");
  const base = (i > -1 ? process.argv[i + 1] : process.env.LH_PROD_BASE) || DEFAULT_BASE;
  const root = base.replace(/\/+$/, "");
  const [condition, blog, certs] = await Promise.all([
    fetchText(`${root}/sitemap-condition.xml`),
    fetchText(`${root}/sitemap-blog.xml`),
    fetchText(`${root}/sitemap-certs.xml`),
  ]);
  const urls = pickProdUrls({ condition, blog, certs }, root);
  console.log(urls.join("\n"));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `urls<<__LH_URLS__\n${urls.join("\n")}\n__LH_URLS__\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
