#!/usr/bin/env node
// US-2631: every environment variable the code reads is in the env reference.
//
// `vault/10-ops/env-reference.md` is what a person follows when rebuilding this
// stack or standing up a new environment. Its whole job is "what to set, and
// where". A variable the code reads and the reference omits is not a
// documentation nit — it is a service that comes up misconfigured with no error,
// because almost every read here is `Deno.env.get(X) ?? default` and the default
// looks like a working system.
//
// THE SHORTHAND IS THE HARD PART, and getting it wrong is how a checker like
// this gets switched off. The reference writes families compactly:
//
//   `GOOGLE_PHOTOS_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI`
//   `STRIPE_PRICE_CREDITS_10` / `_25` / `_50` / `_100`
//   `APPLE_SEARCH_ADS_ORG_ID`, `_KEY_ID`, `_CLIENT_ID`, `_PRIVATE_KEY`
//
// A naive "replace the base's last segment" rule resolves `_SECRET` correctly
// (GOOGLE_PHOTOS_CLIENT_SECRET) and `_REDIRECT_URI` wrongly
// (GOOGLE_PHOTOS_CLIENT_REDIRECT_URI, when the real name is
// GOOGLE_PHOTOS_REDIRECT_URI). A first pass of this scan reported 88 gaps, of
// which about 70 were the shorthand it could not read — including every
// STRIPE_PRICE_*_YEARLY, which is the kind of false alarm that makes a reader
// stop trusting the whole list. So a suffix now resolves against EVERY prefix of
// its base, which covers both shapes.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const REPO = process.cwd();
const DOC = "vault/10-ops/env-reference.md";

/** Trees whose env reads count. Anything else is a host script, not the app. */
export const SCANNED = [
  "services/edge-functions/src",
  "functions",
  "src",
];

/**
 * Variables that are deliberately NOT in the reference, with the reason. Named
 * rather than pattern-matched, and an entry that stops matching is an error, so
 * this list can only shrink.
 */
export const NOT_DOCUMENTED = [];

/** Every VAR the code reads, mapped to the files that read it. */
export function scanReads(roots = SCANNED, repo = REPO) {
  const found = new Map();
  const note = (name, file) => {
    if (!found.has(name)) found.set(name, new Set());
    found.get(name).add(file);
  };
  for (const root of roots) {
    const abs = join(repo, root);
    try {
      statSync(abs);
    } catch {
      continue;
    }
    walk(abs, (p) => {
      if (!/\.(ts|tsx)$/.test(p)) return;
      // Test fixtures are not deployment configuration. The edge suite reads 44
      // TEST_USER_A_* ids that a person standing up an environment must never
      // set, and listing them in the reference would bury the ones that matter.
      // Structural rather than 44 named exemptions — but note this only skips
      // vars read ONLY from tests: GRADING_PHOTO_ROLES is read by ai-grading.ts
      // as well, so it still counts.
      const unix = p.split(sep).join("/");
      if (/\/tests?\//.test(unix) || /[._]test\.tsx?$/.test(unix)) return;
      const src = readFileSync(p, "utf8");
      const rel = p.slice(repo.length + 1).split(sep).join("/");
      for (const m of src.matchAll(/Deno\.env\.get\(\s*["'`]([A-Z0-9_]+)["'`]/g)) note(m[1], rel);
      for (const m of src.matchAll(/process\.env\.([A-Z0-9_]{3,})/g)) note(m[1], rel);
      for (const m of src.matchAll(/process\.env\[\s*["'`]([A-Z0-9_]+)["'`]/g)) note(m[1], rel);
      for (const m of src.matchAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) note(m[1], rel);
      // Pages Functions read from the typed `env` binding, not process.env.
      for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]{4,})\b/g)) note(m[1], rel);
    });
  }
  return found;
}

function walk(dir, fn) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, fn);
    else fn(p);
  }
}

/**
 * Every name the reference documents, expanding its suffix shorthand.
 *
 * A bare `_SUFFIX` resolves against every prefix of the preceding full name, so
 * both `GOOGLE_PHOTOS_CLIENT_ID` + `_SECRET` (drop one segment) and
 * `GOOGLE_PHOTOS_CLIENT_ID` + `_REDIRECT_URI` (drop two) land on the real name.
 * Over-generous on purpose: a checker that cries wolf is worse than one that
 * misses a name, because the first gets muted and the second gets fixed when
 * someone reads the list.
 */
export function documentedNames(markdown) {
  const names = new Set();
  // The base carries across a PARAGRAPH, not just a line: the reference wraps
  // prose, and "optional `_TEAM_ID` (defaults to the client id)" sits on the
  // line after the family it belongs to. Reset at a blank line so a suffix
  // cannot inherit a base from an unrelated section.
  let base = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim()) {
      base = null;
      continue;
    }
    const tokens = [...line.matchAll(/`(_?[A-Z0-9][A-Z0-9_]*)`/g)].map((m) => m[1]);
    for (const token of tokens) {
      if (!token.startsWith("_")) {
        base = token;
        names.add(token);
        continue;
      }
      if (!base) continue;
      // Pure append covers "`CONTENT_INTERNAL_JOB_SECRET` (+`_OLD`)" and
      // "`..._MONTHLY` / `_YEARLY`"; dropping segments covers
      // "`GOOGLE_PHOTOS_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI`". Both shapes
      // are in the reference and neither is going to be normalised, so read both.
      names.add(base + token);
      const segments = base.split("_");
      for (let keep = segments.length - 1; keep >= 1; keep--) {
        names.add(segments.slice(0, keep).join("_") + token);
      }
    }
  }
  return names;
}

export function findGaps(reads, documented, exempt = NOT_DOCUMENTED) {
  const exemptNames = new Set(exempt.map((e) => e.name));
  const missing = [...reads.keys()]
    .filter((v) => !documented.has(v) && !exemptNames.has(v))
    .sort();
  const staleExemptions = exempt.filter((e) => !reads.has(e.name));
  return { missing, staleExemptions };
}

function main() {
  const reads = scanReads();
  const documented = documentedNames(readFileSync(join(REPO, DOC), "utf8"));
  const { missing, staleExemptions } = findGaps(reads, documented);

  if (missing.length === 0 && staleExemptions.length === 0) {
    console.log(
      `\x1b[32m\x1b[1m[env-reference] OK\x1b[0m ${reads.size} variables read, all in ${DOC}.`,
    );
    return;
  }

  if (missing.length > 0) {
    console.error(
      `\x1b[31m\x1b[1m[env-reference] ${missing.length} variable(s) read by the code and absent from ${DOC}\x1b[0m`,
    );
    for (const name of missing) {
      console.error(`  ${name}`);
      for (const file of [...reads.get(name)].slice(0, 3)) console.error(`      ${file}`);
    }
    console.error(
      `\nAdd a row to ${DOC} saying WHERE it is set and what it does. That file ` +
        "is what someone follows when rebuilding this stack, and almost every " +
        "read here falls back to a default that looks like a working system.",
    );
  }

  if (staleExemptions.length > 0) {
    console.error(
      `\x1b[31m\x1b[1m[env-reference] ${staleExemptions.length} exemption(s) name a variable nothing reads\x1b[0m`,
    );
    for (const e of staleExemptions) console.error(`  ${e.name}`);
    console.error("\nDelete the entry — NOT_DOCUMENTED only shrinks.");
  }

  process.exit(1);
}

if (process.argv[1]?.endsWith("check-env-reference.mjs")) main();
