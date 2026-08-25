#!/usr/bin/env node
// US-2868 AC3. Scores the user-facing copy this repo can actually extract, and
// reports what reads above a sixth-grade level or leans on a word the user has
// no way to know.
//
// REPORT-ONLY, ON PURPOSE. It exits 0 whatever it finds unless you pass
// --max-offenders. Reading level is a heuristic over a syllable guess: it is
// good at ranking a hundred strings worst-first and bad at judging any one of
// them, so a build gate on the raw score would fail on correct copy ("eBay"
// scores as two syllables of nothing) and get switched off within a week. Use
// it to find the work, not to prove the work is done.
//
// WHY AN AST AND NOT A REGEX. A regex over TSX cannot tell a button label from
// a query key, a route path, a className or a test id, and this repo has far
// more of those than it has copy. The first cut of this script scored every
// string literal in src/ and reported 14,000 "strings", most of them
// "flipdesk_search" and "h-4 w-4". Extracting only from known copy positions
// takes it to a number a person can read.
//
//   node scripts/check-copy-reading-level.mjs            # summary + worst 25
//   node scripts/check-copy-reading-level.mjs --all      # every offender
//   node scripts/check-copy-reading-level.mjs --jargon   # untagged jargon only
//   node scripts/check-copy-reading-level.mjs --json

import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const ARGS = new Set(process.argv.slice(2));

/** The reading level the house style asks for. */
export const TARGET_GRADE = 6;

/**
 * Below this many words a grade score is noise: "Save changes" scores 5.6 and
 * "Reconcile payouts" scores 14.9, and neither number means anything. Short
 * labels are still checked for JARGON, just not for grade.
 */
const MIN_WORDS_FOR_GRADE = 8;

// ---------------------------------------------------------------------------
// Where copy lives.
// ---------------------------------------------------------------------------

/**
 * JSX attributes and object keys that hold something a user reads.
 *
 * Deliberately NOT here: `name`, `id`, `value`, `key`, `type`, `href`, `to`,
 * `slug`, `className`. Each of those is a string a user never sees, and each
 * was in the first version of this list.
 */
const COPY_PROPS = new Set([
  "title",
  "subtitle",
  "description",
  "label",
  "placeholder",
  "helperText",
  "emptyTitle",
  "emptyDescription",
  "confirmLabel",
  "cancelLabel",
  "clearLabel",
  "retryLabel",
  "heading",
  "message",
  "tooltip",
  "reason",
  "teaches",
  "mustAnswer",
]);

/**
 * Components whose "copy" props are metadata, not interface text. Their strings
 * are recorded so the extraction total stays honest, and never scored.
 */
const META_ELEMENTS = new Set(["SEO", "Helmet", "HelmetProvider", "Meta"]);

/** Call expressions whose first string argument is shown to a user. */
const COPY_CALLS = /^(toast\.(success|error|warning|info|message)|toast|confirm|alert)$/;

/**
 * WHO IS READING THIS STRING. The single most important thing this script does,
 * and the thing the first version got wrong.
 *
 * Scored across all of src/, the worst copy in this codebase is the Terms of
 * Service (grade 29.6) and the admin credit ledger ("one idempotent flow").
 * Neither is what US-2868 is about. Legal text is reviewed by somebody who is
 * not me and simplifying it is not a copy decision; admin surfaces are read by
 * the two people who run the platform, for whom "idempotent" is the precise
 * word and a plain tag would be noise.
 *
 * Reporting one number over all four audiences produces 1,438 offenders, which
 * is the same shape of bad number as US-2866's 158: technically counted,
 * useless for deciding what to fix. Each row is classified and the CUSTOMER
 * number is the one that means anything.
 */
export function audienceOf(rel) {
  if (rel.startsWith("src/pages/legal/")) return "legal";
  if (rel.includes("/admin/") || rel.startsWith("src/pages/admin")) return "operator";
  if (
    rel.startsWith("src/pages/marketing/") ||
    rel.startsWith("src/pages/landing") ||
    rel.startsWith("src/pages/blog") ||
    rel.startsWith("src/lib/seo/") ||
    rel.startsWith("src/prerender/")
  ) {
    return "marketing";
  }
  return "customer";
}

/**
 * Audiences whose reading level is NOT this story's business.
 *
 * marketing: a landing-page paragraph is allowed to be a paragraph, and scoring
 *   it beside a button label buries the button labels.
 * legal: reviewed text. Not mine to rewrite.
 * operator: two readers, both of whom know what a webhook is.
 *
 * Jargon is still reported for marketing, because "aspects" is no more
 * knowable on a marketing page than in the composer.
 */
const GRADE_AUDIENCES = new Set(["customer"]);
const JARGON_AUDIENCES = new Set(["customer", "marketing"]);

const SKIP_DIRS = new Set(["node_modules", "__tests__", "dist", "coverage"]);

/**
 * eBay's and the industry's words. Each MAY stay, and each needs a short plain
 * tag the first time a surface uses it. The tag is what makes it learnable;
 * replacing every one of them would make the product disagree with the
 * marketplace the seller is actually looking at.
 *
 * `hint` is the tag this script suggests. It is a suggestion, not a required
 * string -- a surface that explains the word in its own sentence passes.
 */
export const JARGON = [
  { term: "aspect", hint: "eBay's word for item details" },
  { term: "aspects", hint: "eBay's word for item details" },
  { term: "item specifics", hint: "eBay's word for item details" },
  { term: "provenance", hint: "where a value came from" },
  { term: "orphan", hint: "a row with nothing linked to it" },
  { term: "reconcile", hint: "match your payouts to your sales" },
  { term: "reconciliation", hint: "matching payouts to sales" },
  { term: "comp", hint: "what similar items sold for" },
  { term: "comps", hint: "what similar items sold for" },
  { term: "sku", hint: "your own code for an item" },
  { term: "payload", hint: "the data being sent" },
  { term: "webhook", hint: "an automatic message between apps" },
  { term: "idempotent", hint: "safe to run twice" },
  { term: "backfill", hint: "fill in past records" },
  { term: "canonical", hint: "the one official version" },
  { term: "taxonomy", hint: "eBay's category tree" },
  { term: "throttle", hint: "slow down on purpose" },
  { term: "quota", hint: "how much you get this month" },
];

/**
 * Words that, appearing NEAR a jargon term, count as the plain tag. A surface
 * that already explains itself must not be reported; an audit that fires on
 * copy which is fine is an audit that gets ignored.
 */
const TAG_SIGNALS =
  /\b(that is|which is|means|meaning|i\.?e\.?|eBay'?s word|eBay calls|in other words|the ones|what similar|match(ing)? your)\b/i;

// ---------------------------------------------------------------------------
// Reading level.
// ---------------------------------------------------------------------------

/**
 * Syllables, by vowel groups, with the usual silent-e correction.
 *
 * This is a guess and is documented as one. It is wrong on "grade" (says 1,
 * correct) and wrong on "reconcile" (says 3, correct) and wrong on "eBay"
 * (says 2, arguably 2) -- but it is wrong CONSISTENTLY, which is all a ranking
 * needs.
 */
export function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "")
    .replace(/^y/, "")
    .match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Flesch-Kincaid grade level. Higher is harder. */
export function readingGrade(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  const words = clean.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w));
  if (!words.length) return null;
  // A string with no terminal punctuation is still one sentence.
  const sentences = Math.max(1, (clean.match(/[.!?]+(\s|$)/g) ?? []).length);
  const syl = words.reduce((s, w) => s + syllables(w), 0);
  const grade =
    0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59;
  return Math.round(grade * 10) / 10;
}

export function wordCount(text) {
  return text.trim().split(/\s+/).filter((w) => /[a-zA-Z]/.test(w)).length;
}

// ---------------------------------------------------------------------------
// Extraction.
// ---------------------------------------------------------------------------

function walk(dir, exts, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => p.endsWith(e)) && !/\.test\.[tj]sx?$/.test(p)) {
      out.push(p);
    }
  }
  return out;
}

/** A string that is obviously not prose, whatever position it sits in. */
function looksLikeCode(s) {
  if (!/[a-zA-Z]/.test(s)) return true;
  if (/^[a-z0-9_]+$/.test(s) && s.includes("_")) return true; // snake_case key
  if (/^(https?:|\/|#|\?|\.|@)/.test(s)) return true; // url / route / selector
  if (/^[\w-]+\/[\w-]+/.test(s)) return true; // path-ish
  if (/^[a-z]+([A-Z][a-z]+)+$/.test(s)) return true; // camelCase identifier
  if (/^\s*$/.test(s)) return true;
  // Tailwind-ish: several tokens, all of them hyphen/colon/number soup.
  const toks = s.trim().split(/\s+/);
  if (toks.length > 1 && toks.every((t) => /^[a-z0-9:[\]/.-]+$/.test(t))) return true;
  return false;
}

/** Every user-facing string in one .tsx/.ts file, with its line. */
export function extractFromTs(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = [];

  const push = (text, node, kind) => {
    const t = String(text).replace(/\s+/g, " ").trim();
    if (!t || looksLikeCode(t)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push({ text: t, line: line + 1, kind });
  };

  const literalText = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }
    // A template with holes: score the fixed prose, drop the holes. Copy like
    // `You have ${n} drafts` is real copy and must not be skipped.
    if (ts.isTemplateExpression(node)) {
      return (
        node.head.text +
        node.templateSpans.map((s) => " " + s.literal.text).join("")
      );
    }
    return null;
  };

  const visit = (node) => {
    // 1. Text between JSX tags.
    if (ts.isJsxText(node) && node.text.trim()) push(node.text, node, "jsx");

    // 2. A copy-bearing JSX attribute: title="…", description={`…`}.
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      // WHOSE attribute. <SEO title description> is a meta tag written for a
      // search result, not a sentence in the interface, and it is allowed to
      // be denser than a button label. Scoring the two together put four meta
      // descriptions in the worst-fifty list and would have had me "fixing"
      // them down to grade 6, which is an SEO change dressed as a copy fix.
      const owner = ts.isJsxSelfClosingElement(node.parent.parent)
        ? node.parent.parent.tagName.getText(sf)
        : ts.isJsxOpeningElement(node.parent.parent)
          ? node.parent.parent.tagName.getText(sf)
          : "";
      if (META_ELEMENTS.has(owner)) {
        // fall through: recorded, but never scored.
        const init = ts.isJsxExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
        const t = init && literalText(init);
        if (t) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          found.push({ text: String(t).replace(/\s+/g, " ").trim(), line: line + 1, kind: "meta", meta: true });
        }
      } else if (COPY_PROPS.has(name)) {
        const init = ts.isJsxExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
        const t = init && literalText(init);
        if (t) push(t, node, `prop:${name}`);
      }
    }

    // 3. A copy-bearing object key: { label: "…" }.
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
        ? node.name.text
        : null;
      if (name && COPY_PROPS.has(name)) {
        const t = literalText(node.initializer);
        if (t) push(t, node, `key:${name}`);
      }
    }

    // 4. toast.error("…") and friends.
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (COPY_CALLS.test(callee) && node.arguments.length) {
        const t = literalText(node.arguments[0]);
        if (t) push(t, node, "toast");
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Swift copy, by regex.
 *
 * There is no Swift parser here and adding one is not worth it: SwiftUI puts
 * nearly all of its copy in `Text("…")` and a handful of labelled arguments,
 * and those are unambiguous enough to match. This UNDER-reports (a string built
 * from a variable is invisible to it) and says so rather than pretending.
 */
export function extractFromSwift(source) {
  const found = [];
  const lines = source.split("\n");
  const patterns = [
    [/\bText\(\s*"([^"\\]{2,})"\s*\)/g, "Text"],
    [/\bLabel\(\s*"([^"\\]{2,})"/g, "Label"],
    [/\.navigationTitle\(\s*"([^"\\]{2,})"\s*\)/g, "navigationTitle"],
    [/\b(?:title|subtitle|message|label|description|placeholder):\s*"([^"\\]{2,})"/g, "arg"],
  ];
  lines.forEach((line, i) => {
    // Skip comments: a source scan otherwise fires on the prose written
    // about it, which has happened four times on this epic already.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const [re, kind] of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        const t = m[1].replace(/\s+/g, " ").trim();
        if (t && !looksLikeCode(t)) found.push({ text: t, line: i + 1, kind });
      }
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// Jargon.
// ---------------------------------------------------------------------------

/** Untagged jargon in one string, or [] if every term present is explained. */
export function untaggedJargon(text) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const j of JARGON) {
    const re = new RegExp(`\\b${j.term.replace(/\s/g, "\\s+")}\\b`, "i");
    if (!re.test(lower)) continue;
    // A parenthetical right after the word, or an explaining phrase anywhere in
    // the same string, counts as the tag.
    const tagged =
      new RegExp(`\\b${j.term.replace(/\s/g, "\\s+")}\\b[^.]{0,4}\\(`, "i").test(text) ||
      TAG_SIGNALS.test(text);
    if (!tagged) hits.push(j);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

export function collect() {
  const rows = [];

  for (const abs of walk(resolve(ROOT, "src"), [".tsx", ".ts"])) {
    const rel = relative(ROOT, abs).replace(/\\/g, "/");
    if (rel.startsWith("src/test/")) continue;
    const audience = audienceOf(rel);
    for (const s of extractFromTs(abs, readFileSync(abs, "utf8"))) {
      rows.push({
        ...s,
        file: rel,
        platform: "web",
        audience: s.meta ? "marketing" : audience,
      });
    }
  }

  const iosDir = resolve(ROOT, "ios/GradeThread");
  let iosOk = false;
  try {
    statSync(iosDir);
    iosOk = true;
  } catch {
    /* iOS sources absent (a web-only checkout) */
  }
  if (iosOk) {
    for (const abs of walk(iosDir, [".swift"])) {
      const rel = relative(ROOT, abs).replace(/\\/g, "/");
      if (/Tests?\//.test(rel)) continue;
      for (const s of extractFromSwift(readFileSync(abs, "utf8"))) {
        // Every shipped iOS surface is a customer surface: there is no
        // admin app, and the legal text is a web view.
        rows.push({ ...s, file: rel, platform: "ios", audience: "customer" });
      }
    }
  }

  for (const r of rows) {
    r.words = wordCount(r.text);
    r.grade = r.words >= MIN_WORDS_FOR_GRADE ? readingGrade(r.text) : null;
    r.jargon = JARGON_AUDIENCES.has(r.audience) ? untaggedJargon(r.text) : [];
  }
  return rows;
}

function main() {
  const rows = collect();
  const scored = rows.filter(
    (r) => r.grade !== null && GRADE_AUDIENCES.has(r.audience),
  );
  const hard = scored
    .filter((r) => r.grade > TARGET_GRADE)
    .sort((a, b) => b.grade - a.grade);
  const jargon = rows.filter((r) => r.jargon.length);

  if (ARGS.has("--json")) {
    console.log(JSON.stringify({ rows: rows.length, scored: scored.length, hard, jargon }, null, 2));
    return;
  }

  const byPlatform = (p) => rows.filter((r) => r.platform === p).length;
  console.log(`[copy] ${rows.length} user-facing strings extracted ` +
    `(web ${byPlatform("web")}, ios ${byPlatform("ios")}).`);
  const counts = {};
  for (const r of rows) counts[r.audience] = (counts[r.audience] ?? 0) + 1;
  console.log(
    "[copy] by audience: " +
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") +
      ". Only CUSTOMER copy is scored.",
  );
  console.log(`[copy] ${scored.length} customer strings are long enough to ` +
    `score (>= ${MIN_WORDS_FOR_GRADE} words).`);
  const median = scored.length
    ? [...scored].sort((a, b) => a.grade - b.grade)[Math.floor(scored.length / 2)].grade
    : 0;
  console.log(`[copy] median grade ${median}, target ${TARGET_GRADE}.`);
  console.log(`[copy] ${hard.length} above target; ${jargon.length} carry untagged jargon.`);

  if (!ARGS.has("--jargon")) {
    const show = ARGS.has("--all") ? hard : hard.slice(0, 25);
    if (show.length) {
      console.log(`\n--- hardest to read (${show.length} of ${hard.length}) ---`);
      for (const r of show) {
        console.log(`  grade ${String(r.grade).padStart(5)}  ${r.file}:${r.line}`);
        console.log(`         ${JSON.stringify(r.text).slice(0, 150)}`);
      }
    }
  }

  const showJ = ARGS.has("--all") || ARGS.has("--jargon") ? jargon : jargon.slice(0, 25);
  if (showJ.length) {
    console.log(`\n--- jargon with no plain tag (${showJ.length} of ${jargon.length}) ---`);
    for (const r of showJ) {
      const terms = r.jargon.map((j) => `${j.term} -> "${j.hint}"`).join("; ");
      console.log(`  ${r.file}:${r.line}  [${terms}]`);
      console.log(`         ${JSON.stringify(r.text).slice(0, 150)}`);
    }
  }

  console.log(
    "\n[copy] report-only: this never fails a build. Reading level is a " +
      "heuristic over a syllable guess, good for ranking and bad for judging.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
