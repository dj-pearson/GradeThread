#!/usr/bin/env node
// US-2611 — does the DEPLOY serve what the registry claims?
//
// CI proves the BUILD emits every public route. Nothing proved the deploy
// serves them, and those are different failures. vault/10-ops/deploy.md records
// the one that bit: a Cloudflare Pages rewrite canonicalises into a 308 and
// drops deep paths to the 404 catch-all — reproduced on the raw pages.dev URL,
// so it was Pages behaviour rather than a stale deploy. A route that stops
// serving looks exactly like a route that was never added, and the sitemap
// keeps advertising it either way.
//
// RUNS ON A SCHEDULE, NEVER IN THE PR LANE. It tests a deployment. Wiring it to
// a pull request would fail on code that is correct and simply not shipped yet,
// and a check that fails for a reason the author cannot fix gets switched off —
// the lesson already written into scripts/db-denied-rpc-crash-check.mjs and
// US-1927's notes.
//
//   node scripts/probe-public-routes.mjs [--origin https://gradethread.com] [--json]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The registry is TypeScript, so this reads it with a regex — and then asserts
 * a floor, because a parser that silently matches nothing would report a
 * perfectly healthy zero routes. Same reasoning as the "parsed only N fields —
 * parser broke" guard in cert-public-allowlist_test.ts.
 */
const MIN_EXPECTED_ROUTES = 30;

function registeredPaths() {
  const src = fs.readFileSync(
    path.join(ROOT, "src/lib/seo/public-routes.ts"),
    "utf8",
  );
  const paths = [...src.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (paths.length < MIN_EXPECTED_ROUTES) {
    throw new Error(
      `parsed only ${paths.length} routes out of public-routes.ts — the parser ` +
        `broke, and a probe that checks nothing reports success. Fix the regex.`,
    );
  }
  return [...new Set(paths)];
}

/**
 * Surfaces that are Pages Functions rather than prerendered files. They fail
 * differently — a missing Function is a 404 on a URL the sitemap advertises —
 * so they are checked by name rather than left to the registry.
 */
const DYNAMIC = [
  { path: "/robots.txt", type: /^text\/plain/ },
  { path: "/sitemap.xml", type: /^application\/xml/ },
  { path: "/rss.xml", type: /^application\/rss\+xml/ },
  { path: "/llms.txt", type: /^text\/plain/ },
  { path: "/llms-full.txt", type: /^text\/plain/ },
  // US-2618: `mustLink` catches the failure a status code cannot. Both of these
  // are INDEXES — their whole job is to link to what they index — and an empty
  // one still answers 200 with a full page of chrome.
  //
  // Not hypothetical. On 2026-08-15 /help served 200 at 15KB with ZERO article
  // links, while 83 written articles sat in content/help/ and the loader that
  // puts them in the database was wired to nothing. A live, empty hub is worse
  // than no page: thin content on a domain with an unresolved indexing problem,
  // and every check we had said it was fine.
  { path: "/blog", type: /^text\/html/, mustLink: /href="\/blog\/[^"]+"/ },
  { path: "/help", type: /^text\/html/, mustLink: /href="\/help\/[^"]+"/ },
];

/**
 * Indexes known to be empty right now, each with the work that removes it.
 *
 * SHRINK-ONLY. An entry is a promise to fix, not a category: when the content
 * lands, delete the line and the check starts failing if it empties again.
 * Adding a path here to turn a red run green is the misuse — an entry has to
 * name the work.
 *
 * Reported rather than failed, because this condition is TRUE TODAY. A check
 * that is red on the day it ships gets ignored before it earns any authority,
 * which is why scripts/db-denied-rpc-crash-check.mjs is advisory and what
 * US-1927's notes record happening to a permanently-red guard.
 */
const KNOWN_EMPTY_INDEXES = new Map([
  [
    "/help",
    "US-2618 — 83 articles exist in content/help/ and none are in the database. " +
      "Run `npm run help:seed` against production with the service-role key, " +
      "then delete this entry.",
  ],
]);

/**
 * The deploy runbook's own diagnostic, verbatim: an app route must be 200
 * through its Pages Function and a junk path must be 404. A 308 on a real app
 * route is the documented failure — it means a missing Function or a missing
 * _routes.json entry.
 */
const APP_SHELL = ["/dashboard/flipdesk/inventory", "/admin", "/login"];
const JUNK = "/this-path-should-not-exist-9f3a2b";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function probe(url, opts = {}) {
  try {
    const res = await fetch(url, { redirect: "manual" });
    const body = res.status === 200 ? await res.text() : "";
    return {
      status: res.status,
      type: res.headers.get("content-type") ?? "",
      location: res.headers.get("location") ?? "",
      title: (/<title[^>]*>([^<]*)<\/title>/i.exec(body) ?? [, ""])[1].trim(),
      canonical: (/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i.exec(body) ?? [, ""])[1],
      bytes: body.length,
      // Kept only when a caller looks inside. Holding 42 route bodies in memory
      // is pointless when all we read from them is a title.
      body: opts.keepBody ? body : "",
    };
  } catch (err) {
    return {
      status: 0,
      type: "",
      location: String(err).slice(0, 80),
      title: "",
      canonical: "",
      bytes: 0,
      body: "",
    };
  }
}

async function main() {
  const origin = (arg("origin", "https://gradethread.com")).replace(/\/+$/, "");
  const failures = [];
  const knownGaps = [];
  const note = (route, got, why) => failures.push({ route, got, why });

  const routes = registeredPaths();
  for (const p of routes) {
    const r = await probe(`${origin}${p}`);
    if (r.status !== 200) {
      // A 308 here is the documented Pages rewrite failure, so say so rather
      // than leaving the reader to recognise the number.
      const hint = r.status === 308
        ? "308 — the Cloudflare Pages rewrite failure in vault/10-ops/deploy.md"
        : `HTTP ${r.status}${r.location ? ` → ${r.location}` : ""}`;
      note(p, hint, "registered public route did not serve");
      continue;
    }
    if (!r.title) note(p, "empty <title>", "prerendered head is missing");
    const want = `${origin}${p}`;
    if (r.canonical && r.canonical.replace(/\/$/, "") !== want.replace(/\/$/, "")) {
      note(p, r.canonical, "canonical does not point at this URL");
    }
  }

  for (const d of DYNAMIC) {
    const r = await probe(`${origin}${d.path}`, { keepBody: Boolean(d.mustLink) });
    if (r.status !== 200) {
      note(d.path, `HTTP ${r.status}`, "dynamic surface did not serve");
      continue;
    }
    if (!d.type.test(r.type)) note(d.path, r.type || "(none)", `expected ${d.type}`);
    if (d.mustLink && !d.mustLink.test(r.body)) {
      const known = KNOWN_EMPTY_INDEXES.get(d.path);
      if (known) knownGaps.push(`${d.path}: ${known}`);
      else {
        note(
          d.path,
          `200, ${r.bytes} bytes, no matching links`,
          "an index that links to nothing — the page renders, the content is absent",
        );
      }
    }
  }

  for (const p of APP_SHELL) {
    const r = await probe(`${origin}${p}`);
    if (r.status !== 200) {
      note(p, `HTTP ${r.status}${r.location ? ` → ${r.location}` : ""}`,
        "app route must serve 200 through its Pages Function");
    }
  }

  const junk = await probe(`${origin}${JUNK}`);
  if (junk.status !== 404) {
    // The other half of the runbook's diagnostic, and the one nobody checks: a
    // catch-all that stopped 404ing means every typo now returns the app shell,
    // and Google indexes soft-404s.
    note(JUNK, `HTTP ${junk.status}`, "a junk path must 404, not fall through");
  }

  const checked = routes.length + DYNAMIC.length + APP_SHELL.length + 1;
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ origin, checked, failures, knownGaps }, null, 2));
  } else {
    console.log(`probed ${checked} URLs against ${origin}`);
    // Printed before the verdict, always. A known gap that only appears in a
    // failing run is invisible on exactly the runs where it is the whole story.
    if (knownGaps.length > 0) {
      console.log(`\n! ${knownGaps.length} known gap(s), reported not failed:`);
      for (const g of knownGaps) console.log(`   ${g}`);
      console.log("");
    }
    if (failures.length === 0) {
      console.log(`✓ all clear — ${routes.length} registered routes, ${DYNAMIC.length} dynamic surfaces, ${APP_SHELL.length} app routes, 1 junk path`);
    } else {
      console.error(`\n✗ ${failures.length} problem(s):\n`);
      for (const f of failures) console.error(`   ${f.route}\n      got: ${f.got}\n      ${f.why}`);
      console.error(
        "\nA registered route that stops serving looks identical to one that was " +
          "never added, and the sitemap advertises it either way.",
      );
    }
  }
  if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
