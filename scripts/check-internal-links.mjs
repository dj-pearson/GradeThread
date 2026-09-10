#!/usr/bin/env node
// Internal-link reachability gate over the prerendered dist/.
//
// The registry guards prove a public page is REGISTERED. Nothing proved it was
// LINKED. Those are different failures: a page can carry a perfect title, a
// canonical, JSON-LD and a sitemap entry and still be a page the site itself
// never mentions, which is the version of "indexed" that ranks for nothing.
//
// Three checks, in the order they matter:
//
//   1. UNREACHABLE — no path of links from "/" reaches it. Fatal. The sitemap
//      will still hand it to a crawler, so this shows up as a page that gets
//      fetched, gets no internal signal, and sits there.
//   2. NO CONTEXTUAL INBOUND — every inbound link comes from the global header
//      or footer, which every page has, so none of them is a statement about
//      THIS page. Fatal. Chrome is identified by measurement (a target linked
//      from ~every page) rather than by parsing the layout components, so a nav
//      rewrite cannot quietly turn the check off.
//   3. DEEP — five or more clicks from the home page. Fatal at 5, reported at
//      4. Four is a legitimate depth for a four-level cluster; five means the
//      hub that should carry it does not link it.
//
// Measured on the 2026-09-10 baseline: 276 routes, 0 unreachable, 0 without a
// contextual inbound link, deepest page at 3. So all three thresholds are at
// zero and a regression is the only thing that can trip them.
//
// Reads dist/, so it runs AFTER `npm run build` — same position as the other
// check-*.mjs gates in scripts/verify.mjs.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const MANIFEST = resolve(root, "dist/seo-manifest.json");

/** A target linked from at least this share of pages is global chrome. */
const CHROME_SHARE = 0.9;
/** Click depth that fails the build. */
const MAX_DEPTH = 5;

if (!existsSync(MANIFEST)) {
  console.error(
    "[internal-links] dist/seo-manifest.json is missing — run `npm run build` first.",
  );
  process.exit(1);
}

const routes = JSON.parse(readFileSync(MANIFEST, "utf8")).routes.map((r) => r.path);
const known = new Set(routes);

/** The prerenderer writes `<path>.html`; the root is `index.html`. */
function fileFor(path) {
  for (const rel of [
    path === "/" ? "dist/index.html" : `dist${path}.html`,
    `dist${path}/index.html`,
  ]) {
    if (existsSync(resolve(root, rel))) return rel;
  }
  return null;
}

const unrendered = [];
const links = new Map();
for (const path of routes) {
  const file = fileFor(path);
  if (!file) {
    unrendered.push(path);
    continue;
  }
  // Body only. A canonical or an alternate in <head> is not an internal link.
  const html = readFileSync(resolve(root, file), "utf8");
  const body = html.slice(html.indexOf("<body"));
  const out = new Set();
  for (const m of body.matchAll(/href="(\/[^"#?]*)"/g)) {
    const target = m[1].replace(/\/$/, "") || "/";
    if (known.has(target) && target !== path) out.add(target);
  }
  links.set(path, out);
}

// Depth by breadth-first search from the home page.
const depth = new Map([["/", 0]]);
let frontier = ["/"];
while (frontier.length > 0) {
  const next = [];
  for (const from of frontier) {
    for (const to of links.get(from) ?? []) {
      if (depth.has(to)) continue;
      depth.set(to, depth.get(from) + 1);
      next.push(to);
    }
  }
  frontier = next;
}

const inbound = new Map(routes.map((p) => [p, 0]));
for (const outs of links.values()) for (const to of outs) inbound.set(to, inbound.get(to) + 1);

const crawled = links.size;
const chrome = new Set(routes.filter((p) => inbound.get(p) >= crawled * CHROME_SHARE));

const contextual = new Map(routes.map((p) => [p, 0]));
for (const outs of links.values()) {
  for (const to of outs) if (!chrome.has(to)) contextual.set(to, contextual.get(to) + 1);
}

const unreachable = routes.filter((p) => !depth.has(p));
// Chrome pages are linked from every page by definition; the check is about
// pages that depend on a contextual link and do not have one.
const uncontextual = routes.filter((p) => !chrome.has(p) && contextual.get(p) === 0);
const tooDeep = routes.filter((p) => (depth.get(p) ?? 0) >= MAX_DEPTH);
const deepish = routes.filter((p) => depth.get(p) === MAX_DEPTH - 1);

const deepest = Math.max(...[...depth.values()]);
console.log(
  `[internal-links] ${crawled} prerendered routes · ${chrome.size} global-chrome targets · ` +
    `deepest page ${deepest} click(s) from /`,
);

const fail = (label, list) => {
  if (list.length === 0) return false;
  console.error(`\n[internal-links] ${label} (${list.length}):`);
  for (const p of list) console.error(`  ${p}`);
  return true;
};

let failed = false;
failed = fail("registered but not prerendered", unrendered) || failed;
failed = fail("no path of links reaches these from /", unreachable) || failed;
failed =
  fail(
    "linked only by the header/footer, so nothing on the site says what they are about",
    uncontextual,
  ) || failed;
failed = fail(`${MAX_DEPTH}+ clicks from /`, tooDeep) || failed;

if (deepish.length > 0) {
  console.log(
    `[internal-links] ${deepish.length} page(s) at ${MAX_DEPTH - 1} clicks — allowed, worth a hub link: ` +
      deepish.slice(0, 10).join(" "),
  );
}

if (failed) {
  console.error(
    "\n[internal-links] FAILED. Link the page from the hub that owns it; " +
      "registering it is not the same as linking it.",
  );
  process.exit(1);
}
console.log("[internal-links] OK");
