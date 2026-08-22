#!/usr/bin/env node
// Which modules in src/ does NO production file import?
//
// The edge has check-unwired-modules.mjs and its corpus is
// services/edge-functions/src/lib. The React app had nothing, and the reason it
// looked covered is worth writing down.
//
// scripts/audit-file-local-exports.mjs sweeps src/ already, and it CANNOT find
// this. It works one export at a time and sorts them into "drop the export
// keyword", "delete", and a third group it protects on purpose: 415 exports
// "imported ONLY by tests <- must NOT be un-exported". That instruction is
// right — un-exporting one breaks the test and shrinks nothing. But it means a
// module every one of whose exports is test-only reads as 415 correct entries
// rather than as one module that does not run. The audit asks whether an export
// keyword is load-bearing. This asks whether the MODULE is.
//
// It found src/lib/list-sort.ts on the first run: US-1651's client-side grade
// sort, superseded by US-2196 denormalizing overall_score onto submissions
// (migration 00494) so the page could order server-side. 58 lines and 9 passing
// tests describing an architecture the app stopped using, with a header
// explaining how the submissions list sorts that had not been true since.
//
// WHAT COUNTS AS A CALLER, because getting this wrong is what made an earlier
// version of this scan report 189 live pages as dead:
//   • dynamic `import("...")` — how every route in this app is loaded.
//   • vite.config.ts, scripts/, functions/ and e2e/ — all import from src/, and
//     an src-only corpus calls their targets dead. navigate-fallback-denylist.ts
//     is the case that proves it: nothing in src/ imports it and vite.config.ts
//     does, which is exactly where the file's own header says it lives.
//
// TESTS ARE NOT CALLERS. That is the whole point, and it is the same rule the
// iOS sweep (check-ios-orphans.mjs) uses for the same reason: a test proves the
// code works and says nothing about whether it runs.
//
//   node scripts/check-web-unwired.mjs
//   node scripts/check-web-unwired.mjs --list   # print, never fail

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (f) => relative(ROOT, f).split(sep).join("/");

/**
 * Modules no production file imports, and why each is allowed to be one.
 * Shrink-only, like ALLOWED_DEAD_MODULES: an entry that stops matching FAILS,
 * so wiring one up forces its reason out with it.
 *
 * Every entry here is the same legitimate shape — a spec or a rule set whose
 * consumer is a GUARD rather than a caller. buyer-legal-surfaces.ts is the
 * clearest: it records which buyer copy still needs a lawyer and what stops it
 * shipping meanwhile, and its test asserts the named env flag is compared
 * against "true" in the named file. Nothing imports it because nothing should;
 * importing it would not make it more true.
 *
 * That shape is fine. What is not fine is an IMPLEMENTATION landing here,
 * because an implementation nobody calls is a feature that does not run.
 */
const ALLOWED = {
  "src/lib/a11y/contrast.ts":
    "TEST TOOLING. WCAG luminance and contrast-ratio maths for the documented " +
    "contrast check (US-439). The app renders colours; it never computes a ratio.",
  "src/lib/buyer-legal-surfaces.ts":
    "SPEC, enforced by its test against the real routes. Records which buyer " +
    "surfaces make claims a court would read as claims, and what holds each one " +
    "honest — a kill-switch flag compared against \"true\" in a named file.",
  "src/lib/seo/interlink-rules.ts":
    "POLICY, enforced by its test against the live renderer. The test imports " +
    "linkGlossaryTerms from functions/_shared/blog-render.ts and asserts the " +
    "anchors it actually emits obey these rules; care-containment.test.ts uses " +
    "hubForPath and isCrossHubLinkAllowed against real page sources.",
  "src/lib/seo/jsonld-lint.ts":
    "TEST TOOLING. Lints the JSON-LD the prerender emits. Shipping a linter to " +
    "the browser would be shipping the ruler with the shelf.",
  "src/lib/seo/keyword-targets.ts":
    "SPEC, enforced by its test against the route registry: every route's title " +
    "or description must contain its primary keyword, so copy and targets " +
    "cannot drift apart silently.",
  "src/lib/support-attachment-contract.ts":
    "CROSS-PLATFORM SPEC (US-2561). Every value was read out of the running " +
    "edge code so iOS implements the protocol that exists rather than a Swift " +
    "re-reading of it; the guard compares each one back to its source.",
  "src/lib/use-case-taxonomy.ts":
    "CROSS-PLATFORM SPEC (US-2535). The four canonical use_case values and the " +
    "iOS mapping onto them. Its test reads the Swift enum body, and " +
    "ios/GradeThread/Onboarding/UseCaseSync.swift points back here for the " +
    "reasoning, so the mapping lives in one place rather than two.",
};

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js|jsx|html)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(p);
  }
  return out;
}

const isTest = (f) => {
  const r = rel(f);
  return r.startsWith("src/test/") || /\/__tests__\//.test(r) || /\.(test|spec)\.(ts|tsx)$/.test(r);
};

const SELF = fileURLToPath(import.meta.url);

const srcFiles = walk(join(ROOT, "src"));
// THIS FILE IS NOT A CALLER. Its allowlist keys are src/ paths in string
// literals, which is exactly what the string-specifier rule below matches - so
// on the first run the guard read its own reasons as seven production imports
// and reported all seven allowlist entries as stale. A guard that satisfies
// itself is the failure mode this repo has hit three times.
const callers = [
  ...srcFiles,
  ...walk(join(ROOT, "scripts")),
  ...walk(join(ROOT, "functions")),
  ...walk(join(ROOT, "e2e")),
  ...["vite.config.ts", "vitest.config.ts", "playwright.config.ts", "index.html"]
    .map((f) => join(ROOT, f))
    .filter(existsSync),
].filter((f) => f !== SELF);

/** Every module specifier a file names, however it names it. */
function specifiers(s) {
  const out = [];
  for (const m of s.matchAll(/from\s+["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of s.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  for (const m of s.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push(m[1]);
  // A path named in a string — how scripts/ and the guards reach into src/.
  for (const m of s.matchAll(/["']([^"']*src\/[^"']+)["']/g)) out.push(m[1]);
  return out;
}

const specs = new Map(callers.map((f) => [f, specifiers(readFileSync(f, "utf8"))]));

// main.tsx is the browser entry; index.html loads it as a script, not an import.
const ENTRIES = new Set(["src/main.tsx"]);

const found = [];
for (const f of srcFiles) {
  if (isTest(f) || ENTRIES.has(rel(f))) continue;
  const base = f.split(sep).pop().replace(/\.(tsx?|jsx?)$/, "");
  const needle = base === "index" ? f.split(sep).slice(-2)[0] : base;
  let prod = 0;
  const testers = [];
  for (const c of callers) {
    if (c === f) continue;
    const hit = specs.get(c).some((sp) => {
      const b = sp.replace(/\.(tsx?|jsx?)$/, "").split("/").filter(Boolean).pop();
      return b === needle;
    });
    if (!hit) continue;
    if (isTest(c)) testers.push(c.split(sep).pop());
    else prod++;
  }
  if (prod === 0) found.push({ f: rel(f), testers });
}

if (process.argv.includes("--list")) {
  console.log(`\n${found.length} src module(s) no production file imports:\n`);
  for (const r of found) {
    console.log(`  ${r.f}`);
    console.log(`      ${r.testers.length ? "tests: " + r.testers.join(", ") : "NO references at all"}`);
    if (ALLOWED[r.f]) console.log(`      allowed: ${ALLOWED[r.f]}`);
  }
  process.exit(0);
}

const unexplained = found.filter((r) => !ALLOWED[r.f]);
const stale = Object.keys(ALLOWED).filter((p) => !found.some((r) => r.f === p));

if (unexplained.length === 0 && stale.length === 0) {
  console.log(
    `[web-unwired] OK  ${found.length} module(s) with no production caller, all accounted for.`,
  );
  process.exit(0);
}

if (unexplained.length > 0) {
  console.error("\n[web-unwired] src module(s) NO production file imports:\n");
  for (const r of unexplained) {
    console.error(`    ${r.f}`);
    console.error(`        ${r.testers.length ? "imported only by: " + r.testers.join(", ") : "imported by nothing at all"}`);
  }
  console.error(
    "\n  Passing tests around it prove it works, not that it runs. Decide which\n" +
      "  of these it is:\n\n" +
      "    SPEC / TEST TOOLING  its consumer is a guard, not a caller -> allowlist it\n" +
      "    NOT WIRED YET        a feature with no entry point -> wire it, or file it\n" +
      "    SUPERSEDED           something replaced it -> delete it, tests included\n\n" +
      "  Then add it to ALLOWED with that reason, or act on it.\n",
  );
}

if (stale.length > 0) {
  console.error("\n[web-unwired] ALLOWED entr(ies) that no longer match — wired up or deleted?\n");
  for (const p of stale) console.error(`    ${p}`);
  console.error("\n  Delete the entry. The list only shrinks.\n");
}

process.exit(1);
