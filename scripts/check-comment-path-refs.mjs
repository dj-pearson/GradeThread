#!/usr/bin/env node
// US-2793: a comment that names a file should name a file that exists.
//
// scripts/doc-refs.mjs does this for the DOCS an agent reads every session.
// The code carries ~975 more path references and nothing has ever read one.
//
// WHY IT IS WORTH A GATE, since the raw count is small: all three findings on
// the first run were a comment naming a GUARD by a filename that had been
// renamed, while the guard itself was alive under another name.
//
//   src/lib/marketplace-specs.ts   said the byte-identical-mirror check was in
//                                  __tests__/marketplace-specs-sync.test.ts
//                                  (it is marketplace-specs.test.ts)
//   src/types/help-center.ts       said the seed comparison was in
//                                  help-categories.test.ts
//                                  (it is help-link-graph.test.ts)
//   scripts/style-code-coverage.mjs  said the precedence check was in
//                                  style-code-coverage-precedence.test.ts
//                                  (it is style-code-scripts.test.ts)
//
// Three for three. Someone who goes looking finds nothing and reasonably
// concludes the guard was deleted — which is the expensive reading, and the one
// this catches.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO TRAPS, BOTH MEASURED, AND THE FIRST IS DOCUMENTED IN doc-refs.mjs ALREADY
//
// 1. THE EXTENSION ALTERNATION MUST BE LONGEST-FIRST. With `ts` before `tsx`
//    the pattern matches the head of `routes/index.tsx` and reports
//    `routes/index.ts` missing; `js` before `json` does the same. A first pass
//    that got this wrong reported 182 findings against a real 14.
//
//    ⚠ BUT THE ORDERING IS NOT WHAT SAVES US HERE, measured rather than
//    assumed. Reversing it to `ts|tsx` and re-running changes nothing, because
//    the `(?![\w.])` after the capture refuses a match followed by `x`, and the
//    engine backtracks into `tsx`. Drop that lookahead and the wrong order
//    immediately yields `index.ts` and `a.json` -> `a.js`. So the lookahead is
//    the load-bearing part and the ordering is the belt to its braces; a
//    sabotage that only reverses the order passes, and that is correct.
//
// 2. A PATH IS RELATIVE TO ITS PACKAGE, not to the repo. The edge tree calls its
//    own tests `src/tests/foo_test.ts`, which is real under
//    services/edge-functions and absent from the root.
//
// A third, found here: a path must start at a SEGMENT boundary. Without that,
// `https://partnerapi.depop.com/api-docs/openapi.yaml` yields `docs/openapi.yaml`
// out of the middle of a URL.
//
//   node scripts/check-comment-path-refs.mjs
//   node scripts/check-comment-path-refs.mjs --list   # print, never fail

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (f) => relative(ROOT, f).split(sep).join("/");

const ROOTS = ["src", "services/edge-functions/src", "functions", "scripts"];
const SKIP = new Set(["node_modules", "dist", "build", ".git", "coverage"]);

/**
 * References that name a file which does not exist, ON PURPOSE.
 *
 * Shrink-only: an entry that stops matching fails, so a reference that becomes
 * real again cannot keep its excuse.
 */
const ALLOWED = {
  "src/lib/list-sort.ts":
    "check-web-unwired.mjs cites it as the module that gate found and that was " +
    "deleted because of it. Naming the file is the point of the sentence.",
  "src/pages/inventory.tsx":
    "the comment opens \"src/pages/inventory.tsx was DELETED\" (US-2362). It is " +
    "describing an absence.",
  "scripts/_placeholder-db-env.ts":
    "cron-render-scripts.test.mjs records what the case USED to assert before " +
    "US-2661 removed the shim.",
  "scripts/seed-demo-account.sql":
    "seed-demo-from-export.mjs names its own OUTPUT. It does not exist until " +
    "the script is run, which is the file's whole job.",
  "docs/bizdev/poshmark-rithum-decision.md":
    "an example inside vault-move.mjs's explanation of what a move renames.",
  "src/pages/inventory-detail.tsx":
    "listing-suggestions.tsx calls it \"a page that no longer exists\" while " +
    "explaining why the per-item component it fed was removed (US-2436). The " +
    "sentence needs the name to make sense.",
  "docs/STRUCTURED_DATA_LINT.md":
    "jsonld-schema-lint.test.ts names it to say it does not exist. Its header " +
    "used to promise this runbook; it now says so and points at the rules in " +
    "jsonld-lint.ts instead.",
  "docs/PRERENDER_PARITY.md":
    "crawl-parity.test.ts names it for the same reason — the header used to " +
    "point at a runbook nobody wrote, and now says the four bullets above it " +
    "are the checklist.",
  "services/edge-functions/src/lib/shipping-rates.ts":
    "src/lib/shipping-rates.ts records that there is deliberately NO edge " +
    "mirror of it. The absence is the point, and check-unwired-modules would " +
    "flag the mirror if one were added speculatively.",
};

// LONGEST FIRST. See trap 1.
const EXT =
  "(?:tsx|ts|mjs|cjs|jsonc|json|js|sql|swift|kt|md|toml|yaml|yml|py|sh|example)";
const TOP = "(?:src|services|functions|scripts|supabase|ios|android|vault|docs|e2e|extension-unified)";
// (?<![\w/-]) so the path starts at a segment boundary — see trap 3.
// The trailing guard is `(?!\w|\.\w)`, NOT `(?![\w.])`.
//
// `(?![\w.])` was the first version and it silently dropped every path at the
// END OF A SENTENCE — "Runbook: docs/PRERENDER_PARITY.md." is followed by a full
// stop, so the lookahead refused the match and the reference was never checked.
// Two real findings were hidden that way, both of them a comment pointing at a
// runbook that does not exist, which is the exact defect this file is for.
//
// Rejecting `\.\w` instead keeps the protection that matters: `.ts` inside
// `.tsx` is followed by `x`, and `.js` inside `.json` by `o`, so both are still
// refused. A sentence-ending period is not followed by a word character and is
// now allowed through.
const PATH_RE = new RegExp(
  `(?<![\\w/-])(${TOP}\\/[A-Za-z0-9_./[\\]-]+\\.${EXT})(?!\\w|\\.\\w)`,
  "g",
);

/** Package roots a reference may be relative to. See trap 2. */
const BASES = [ROOT, join(ROOT, "services/edge-functions"), join(ROOT, "android"), join(ROOT, "ios")];

/**
 * A path written as an ILLUSTRATION rather than as a reference.
 *
 * Excluded by shape, not by allowlist, because these are not mistakes and there
 * is no end to them: every script that explains its own usage invents one.
 * `foo`, a single-letter basename, `NN-`, `YYYY-MM-DD` and the glob/brace forms
 * are what this repo's own examples actually look like.
 */
function isIllustration(p) {
  if (/[*?<>{}]/.test(p)) return true;
  if (/\bNNNNN\b|\bNN-|\bYYYY|\bMM-DD|\bfoo\b|\bbar\b|\bexample\b/i.test(p)) return true;
  const base = p.split("/").pop().replace(/\.[^.]+$/, "");
  return base.length <= 1; // vault/10-ops/x.md, docs/X.md
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry)) out.push(p);
  }
  return out;
}

/** Comments only: a path in a string literal is usually a real runtime path. */
function commentText(src) {
  const out = [];
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) out.push(m[0]);
  for (const line of src.split("\n")) {
    const i = line.indexOf("//");
    if (i >= 0) out.push(line.slice(i));
  }
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// US-2800: THE PATH EXISTING IS NOT THE WHOLE CLAIM.
//
// Everything above proves a named file exists. Three bugs found on 2026-08-22
// were one level past that: the path was real and the SYMBOL had moved or been
// deleted, so a reader following the comment lands in a genuine file with no
// such thing in it. That is the more expensive reading, because the file being
// there makes the sentence look confirmed.
//
//   inventory-import.ts  "Mirrors FILL_ITEM_FIELDS in src/pages/flipdesk/
//                        import.tsx" — US-2518 DELETED that list on purpose so
//                        the edge is single-source. The comment survived the
//                        refactor and now tells a reader to recreate the
//                        duplicate that story removed.
//   routes/grade.ts      "Mirror of STYLE_ATTRIBUTES in src/lib/constants.ts" —
//                        no such constant, and never was.
//
// SAME LINE ONLY, and that is measured. A +/-1 line window produced 44 hits, of
// which several were a symbol declared in the scanning file sitting next to an
// unrelated vault path the comment never tied it to. Same-line gives 5, of
// which 3 were real and 2 are the shapes excluded below.
const SYMBOL_RE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,})\b/g;

/**
 * Sentences naming a path and a symbol that legitimately do not go together.
 *
 * Shrink-only like ALLOWED above: an entry that stops matching fails.
 */
const ALLOWED_SYMBOL_REFS = {
  "src/components/verified/achievement-medals.tsx|TIER_COLOR":
    "the sentence names TWO pairs — TIER_FILL in achievement-medals.tsx AND " +
    "TIER_COLOR in the edge's cert-og-template.ts. Both claims are true; a " +
    "same-line rule cannot tell which symbol belongs to which path. Splitting " +
    "the sentence to satisfy a scanner would make it worse to read.",
};

/**
 * A symbol that is just the file's own name (PUBLIC_API.md → PUBLIC_API,
 * PLAY_STORE_SUBMISSION.md → PLAY_STORE_SUBMISSION). Naming a doc is not a
 * claim about its contents.
 */
function isOwnBasename(ref, sym) {
  const base = ref.split("/").pop().replace(/\.[^.]+$/, "");
  return base === sym;
}

const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
const SELF = fileURLToPath(import.meta.url);

const found = new Map();
const symbolMisses = [];
const symbolHits = new Set();
let refs = 0;
let symRefs = 0;
const bodyCache = new Map();
/** The named file's text, from whichever package root resolves it. */
function bodyOf(ref) {
  if (!bodyCache.has(ref)) {
    const base = BASES.find((b) => existsSync(join(b, ref)));
    bodyCache.set(ref, base ? readFileSync(join(base, ref), "utf8") : null);
  }
  return bodyCache.get(ref);
}

for (const f of files) {
  if (f === SELF) continue; // its own allowlist names files that do not exist
  const src = readFileSync(f, "utf8");
  const seen = new Set();
  for (const m of commentText(src).matchAll(PATH_RE)) {
    const ref = m[1];
    if (seen.has(ref) || isIllustration(ref)) continue;
    seen.add(ref);
    refs++;
    if (BASES.some((b) => existsSync(join(b, ref)))) continue;
    if (!found.has(ref)) found.set(ref, []);
    found.get(ref).push(rel(f));
  }

  // US-2800: the symbol half. Walk COMMENT LINES so a path and a symbol only
  // pair up when they were written in the same sentence.
  for (const raw of src.replace(/\r\n?/g, "\n").split("\n")) {
    const i = raw.indexOf("//");
    const star = raw.trimStart().startsWith("*") ? raw.indexOf("*") : -1;
    const at = i >= 0 ? i : star;
    if (at < 0) continue;
    const line = raw.slice(at);
    const paths = [...new Set([...line.matchAll(PATH_RE)].map((p) => p[1]))]
      .filter((p) => !isIllustration(p));
    if (paths.length === 0) continue;
    const syms = [...new Set([...line.matchAll(SYMBOL_RE)].map((s) => s[1]))];
    if (syms.length === 0) continue;
    for (const ref of paths) {
      const body = bodyOf(ref);
      if (body == null) continue; // the missing-path pass above owns that case
      for (const sym of syms) {
        if (isOwnBasename(ref, sym)) continue;
        symRefs++;
        const key = `${ref}|${sym}`;
        if (body.includes(sym)) continue;
        symbolHits.add(key);
        if (ALLOWED_SYMBOL_REFS[key]) continue;
        symbolMisses.push({ where: rel(f), ref, sym, line: line.trim().slice(0, 120) });
      }
    }
  }
}

if (process.argv.includes("--list")) {
  console.log(`\n${refs} path reference(s) in comments; ${found.size} resolve nowhere:\n`);
  for (const [ref, where] of found) {
    console.log(`  ${ref}`);
    console.log(`      named in: ${where.join(", ")}`);
    if (ALLOWED[ref]) console.log(`      allowed: ${ALLOWED[ref]}`);
  }
  process.exit(0);
}

const unexplained = [...found].filter(([ref]) => !ALLOWED[ref]);
const stale = Object.keys(ALLOWED).filter((ref) => !found.has(ref));
const staleSymbols = Object.keys(ALLOWED_SYMBOL_REFS).filter(
  (key) => !symbolHits.has(key),
);

if (
  unexplained.length === 0 && stale.length === 0 &&
  symbolMisses.length === 0 && staleSymbols.length === 0
) {
  console.log(
    `[comment-paths] OK  ${refs} path reference(s) and ${symRefs} ` +
      `path+symbol claim(s) checked, ${found.size} accounted for.`,
  );
  process.exit(0);
}

if (symbolMisses.length > 0) {
  console.error(
    "\n[comment-paths] comment(s) naming a REAL file that does not contain " +
      "the symbol they cite:\n",
  );
  for (const m of symbolMisses) {
    console.error(`    ${m.where}`);
    console.error(`        ${m.line}`);
    console.error(`        -> ${m.sym} is not in ${m.ref}\n`);
  }
  console.error(
    "  The file existing is what makes this expensive: the sentence reads as\n" +
      "  confirmed. Check whether the symbol MOVED (fix the path), was RENAMED\n" +
      "  (fix the name), or was deliberately DELETED — that last one is the\n" +
      "  dangerous case, because the comment then tells the next reader to\n" +
      "  recreate a duplicate that a story removed on purpose.\n" +
      "  If the sentence names two pairs at once, add it to\n" +
      "  ALLOWED_SYMBOL_REFS with the reason.\n",
  );
}

if (staleSymbols.length > 0) {
  console.error(
    "\n[comment-paths] ALLOWED_SYMBOL_REFS entr(ies) that now resolve — drop them:\n",
  );
  for (const k of staleSymbols) console.error(`    ${k}`);
  console.error("");
}

if (unexplained.length > 0) {
  console.error("\n[comment-paths] comment(s) naming a file that does not exist:\n");
  for (const [ref, where] of unexplained) {
    console.error(`    ${ref}`);
    console.error(`        named in: ${where.join(", ")}`);
  }
  console.error(
    "\n  Usually the file was RENAMED and the comment was not. Check before\n" +
      "  deleting the sentence: all three of the first findings named a guard\n" +
      "  that is alive under another name, and the fix was the filename.\n" +
      "  If the reference is deliberate, add it to ALLOWED with the reason.\n",
  );
}

if (stale.length > 0) {
  console.error("\n[comment-paths] ALLOWED entr(ies) that now resolve — drop them:\n");
  for (const ref of stale) console.error(`    ${ref}`);
  console.error("");
}

process.exit(1);
