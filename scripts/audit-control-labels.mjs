#!/usr/bin/env node
// US-2335 AC1: an EXACT count of form controls with no accessible name.
//
// WHY NOT JUST TURN ON jsx-a11y/control-has-associated-label. It was tried. It
// reports 612 violations across 175 files, and a sample of them are correct
// code: `<Label htmlFor="fullName">` beside `<Input id="fullName">` is a
// properly labelled control, and the rule flags it because it only understands
// NESTING and aria-*, not htmlFor↔id pairing across siblings. Adopting it would
// fail the build on hundreds of controls that are already fine, which is how a
// lint rule gets disabled for good.
//
// (The story's own estimate of ~359 is equally unfounded, in the other
// direction. Neither number came from resolving a label to a control.)
//
// So this resolves the pairing the way a browser does: an `id` is labelled if
// SOME `htmlFor` in the same file names it. Everything else that can give a
// control its name is honoured too — aria-label, aria-labelledby, title, an
// enclosing <label>, and the cases that need no name at all (hidden inputs,
// visually-hidden file pickers driven by a labelled button).
//
// It is deliberately CONSERVATIVE: anything ambiguous counts as LABELLED. An
// audit that over-reports gets argued with and then ignored; one that
// under-reports still gives a floor worth fixing.

import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");

/**
 * Elements that need an accessible name.
 *
 * `Select` is deliberately ABSENT while `SelectTrigger` is present. shadcn's
 * <Select> is a context provider that renders no focusable element; the trigger
 * is the button a user actually lands on. Counting both double-reported every
 * dropdown in the codebase — the first version of this script did exactly that,
 * and the inflated total is the sort of number that then gets quoted.
 */
const CONTROL = /<(input|textarea|Input|Textarea|SelectTrigger|Checkbox|Switch|RadioGroupItem)\b/g;

export function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * The attribute text of the tag starting at `from`, up to its closing `>`.
 *
 * SKIPS COMMENTS AND QUOTED STRINGS while walking, because both can contain a
 * `>` that is not the end of the tag. The case that found this (2026-08-10):
 * inline-cell.tsx explains its own label with an attribute-level comment
 * mentioning an input element in angle brackets, and the walk stopped at that
 * `>` — so the aria-label two lines below it was never seen and a correctly
 * labelled control was reported as unlabelled.
 *
 * That is the failure this script's header warns about, in its worst form: a
 * FALSE POSITIVE. The obvious response is to reword the comment, and the next
 * person writing `<input>` in a comment hits it again. Reading the tag
 * correctly is the fix.
 *
 * Note this still never rewrites `src` — it only advances the cursor — so every
 * offset stays what it was. That constraint is why the earlier blank-the-
 * comments attempt was reverted; see inComment() below.
 */
export function tagAttrs(src, from) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < src.length && i < from + 4000; i++) {
    const c = src[i];
    // Inside a quoted attribute value: only its own closing quote matters. This
    // is also what keeps a `//` in a URL from reading as a comment.
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl === -1) return src.slice(from, i);
      i = nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return src.slice(from, i);
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(from, i);
  }
  return src.slice(from, from + 4000);
}

/**
 * Does this control carry an accessible name?
 *
 * `htmlForIds` is every id named by a `htmlFor=` in the same file — that is the
 * pairing jsx-a11y misses and the reason its count is unusable here.
 */
export function isLabelled(attrs, htmlForIds) {
  if (/\baria-label\b/.test(attrs)) return true;
  if (/\baria-labelledby\b/.test(attrs)) return true;
  if (/\btitle\s*=/.test(attrs)) return true;
  // Hidden inputs and visually-hidden file pickers are operated by a labelled
  // control elsewhere; a name on them would be read out for nothing.
  if (/type\s*=\s*["']hidden["']/.test(attrs)) return true;
  if (/type\s*=\s*["']file["']/.test(attrs) && /\b(hidden|sr-only)\b/.test(attrs)) {
    return true;
  }
  // A control that SPREADS PROPS may receive its name from the caller, and no
  // amount of reading this file can tell. Same rule as the dynamic id below:
  // assume labelled rather than accuse.
  //
  // The two sites this exists for are components/ui/input.tsx and
  // components/ui/textarea.tsx — the shadcn PRIMITIVES. Their whole job is to
  // forward `{...props}`, so every `aria-label` in this audit's fixes lands on
  // them at runtime. Counting them meant the baseline could never reach zero
  // and that two of the remaining "violations" were unfixable by construction:
  // there is nothing to label, because the thing being labelled is every input
  // in the app.
  if (/\{\s*\.\.\.\s*\w+\s*\}/.test(attrs)) return true;
  // A dynamic id (id={foo}) cannot be resolved textually — assume labelled
  // rather than accuse.
  const id = /\bid\s*=\s*["']([^"']+)["']/.exec(attrs);
  if (!id) return /\bid\s*=\s*\{/.test(attrs);
  return htmlForIds.has(id[1]);
}

/**
 * Is the match at `i` inside a comment rather than in real JSX?
 *
 * THE KNOWN OVER-COUNT, FIXED (2026-08-09) — and the shape of the fix is the
 * point. billing-actions-card.tsx carries a doc comment reading
 * "ISO timestamp -> value for <input type=\"datetime-local\">", and this script
 * counted it as an unlabelled input.
 *
 * A previous pass tried BLANKING comments before the scan and reverted it,
 * correctly: `tagAttrs` finds a tag's closing `>` by counting braces, blanking
 * changes that balance, and the blanked run started reporting photo-uploader's
 * two hidden file inputs — driven by a labelled button, and precisely the false
 * positive this script exists to avoid. That fix traded one wrong hit for two.
 *
 * This one cannot: it FILTERS MATCHES and never touches `src`, so every offset
 * `tagAttrs` walks is the offset it always was. Same defect, opposite blast
 * radius — worth remembering the next time a scan wants preprocessing.
 */
export function inComment(src, i) {
  const lineStart = src.lastIndexOf("\n", i) + 1;
  const line = src.slice(lineStart, i);
  // A `//` earlier on the same line, but not one inside a string (a URL).
  const slashes = line.indexOf("//");
  if (slashes !== -1 && !/["'`]/.test(line.slice(slashes - 1, slashes))) return true;
  // Inside a /* … */ block: the nearest opener before `i` has no closer between.
  const open = src.lastIndexOf("/*", i);
  if (open !== -1 && src.indexOf("*/", open) > i) return true;
  return false;
}

export function auditFile(src) {
  const htmlForIds = new Set(
    [...src.matchAll(/htmlFor\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]),
  );
  // A control wrapped directly in <label> gets its name from the wrapper.
  const wrapped = /<label\b[^>]*>[\s\S]{0,400}?<(input|Input|Checkbox|Switch|textarea|Textarea)\b/g;
  const wrappedAt = new Set();
  for (const m of src.matchAll(wrapped)) wrappedAt.add(m.index + m[0].lastIndexOf("<"));

  const unlabelled = [];
  CONTROL.lastIndex = 0;
  for (const m of src.matchAll(CONTROL)) {
    if (wrappedAt.has(m.index)) continue;
    if (inComment(src, m.index)) continue;
    const attrs = tagAttrs(src, m.index);
    if (!isLabelled(attrs, htmlForIds)) {
      unlabelled.push({
        tag: m[1],
        line: src.slice(0, m.index).split("\n").length,
      });
    }
  }
  return unlabelled;
}

// ── US-2834: the second floor — names that DISTINGUISH ─────────────────────
//
// Everything above measures whether a control HAS a name. US-2450 proved that
// is only half the property: every control in a FlipDesk listings row was
// named the same thing, this audit reported zero for that file, and the table
// was still unusable with a screen reader. Someone arrowing through eight rows
// heard "Delete rule, button" eight times with nothing to say which rule.
//
// A missing name at least reads as unknown. A repeated one reads as
// UNDERSTOOD, which is worse in front of a destructive control.
//
// The detectable shape is narrow on purpose: a CONSTANT string aria-label on a
// control rendered inside a `.map()` callback. Interpolated labels are correct
// by construction and never reported, matching the conservative stance the
// rest of this file takes — an audit that over-reports gets argued with and
// then ignored.

/** Buttons count here even though they are not in CONTROL: a per-row delete is
 *  the case this exists for, and it is almost always a button. */
const ROW_CONTROL =
  /<(input|textarea|Input|Textarea|SelectTrigger|Checkbox|Switch|RadioGroupItem|button|Button)\b/g;

/** Start and end offsets of every `.map(` callback, paren-matched. */
export function mapBodies(src) {
  const out = [];
  for (const m of src.matchAll(/\.map\s*\(/g)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (i < src.length) out.push([m.index, i]);
  }
  return out;
}

/** Controls in `src` that will announce the same words on every row. */
export function auditDistinctness(src) {
  const bodies = mapBodies(src);
  if (bodies.length === 0) return [];
  const hits = [];
  ROW_CONTROL.lastIndex = 0;
  for (const m of src.matchAll(ROW_CONTROL)) {
    if (inComment(src, m.index)) continue;
    if (!bodies.some(([a, b]) => m.index > a && m.index < b)) continue;
    const attrs = tagAttrs(src, m.index);
    // `"[^"{]*"` rather than `"[^"]*"`: a label built with a template literal
    // inside quotes is not a thing, but being explicit here documents that an
    // interpolation anywhere in the value makes it fine.
    const lit = /\baria-label\s*=\s*"([^"{]*)"/.exec(attrs);
    if (!lit) continue;
    hits.push({
      tag: m[1],
      name: lit[1],
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return hits;
}

// ── US-2834: the shape a regex could not see ───────────────────────────────
//
// A per-row button whose only name is its VISIBLE TEXT. Every row announces
// "Refund", or "Reject", or "End", and nothing says which one.
//
// repeated-labels.test.ts has recorded this as unguarded since US-2450,
// because the version that tried it flagged every button on every page. Two
// more regex attempts on 2026-08-23 failed the same way and then failed
// worse — one matched nothing and reported a confident zero, which is
// indistinguishable from a clean codebase.
//
// The blocker was always the same: finding where the opening tag ENDS.
// `onClick={() => setPeriod(p)}` contains a `>` that is not the tag's. So
// this parses instead of matching. TypeScript is already a dependency and
// hands over the tag boundary, the attribute list and the children.

const TEXT_NAMED = new Set(["Button", "button"]);

/**
 * Controls inside a `.map()` whose accessible name is static visible text.
 *
 * Three things make a hit, and dropping any one of them is what produced the
 * earlier false-positive floods:
 *   1. it is inside a `.map()` callback, so it repeats;
 *   2. it carries no aria-label / aria-labelledby, so the text IS the name;
 *   3. its children are static text with no interpolation — an interpolated
 *      child already names the row and is correct.
 */
export function auditRepeatedText(src, fileName = "x.tsx") {
  const sf = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const out = [];
  let mapDepth = 0;

  const isMapCall = (n) =>
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === "map";

  function visit(node) {
    if (isMapCall(node)) mapDepth++;
    if (mapDepth > 0 && ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName.getText(sf);
      if (TEXT_NAMED.has(tag)) {
        const named = node.openingElement.attributes.properties.some(
          (a) =>
            ts.isJsxAttribute(a) &&
            /^aria-label(ledby)?$/.test(a.name.getText(sf)),
        );
        const interpolated = node.children.some(
          (c) => ts.isJsxExpression(c) && c.expression,
        );
        const text = node.children
          .filter((c) => ts.isJsxText(c))
          .map((c) => c.text.trim())
          .filter(Boolean)
          .join(" ");
        if (!named && !interpolated && text) {
          out.push({
            tag,
            text,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
    if (isMapCall(node)) mapDepth--;
  }

  visit(sf);
  return out;
}

function main() {
  const rows = [];
  let total = 0;
  for (const file of walk(SRC)) {
    const hits = auditFile(readFileSync(file, "utf8"));
    if (hits.length) {
      rows.push([file.replace(`${SRC}\\`, "").replace(`${SRC}/`, ""), hits]);
      total += hits.length;
    }
  }
  rows.sort((a, b) => b[1].length - a[1].length);
  console.log(`Controls with no resolvable accessible name: ${total} across ${rows.length} files`);
  console.log("(conservative — anything ambiguous counts as labelled)\n");
  for (const [file, hits] of rows.slice(0, 25)) {
    console.log(`  ${String(hits.length).padStart(3)}  ${file}`);
    if (process.argv.includes("--lines")) {
      console.log(`        ${hits.map((h) => `${h.tag}:${h.line}`).join(", ")}`);
    }
  }
  if (rows.length > 25) console.log(`  … and ${rows.length - 25} more files`);

  const repeated = [];
  for (const file of walk(SRC)) {
    for (const h of auditDistinctness(readFileSync(file, "utf8"))) {
      repeated.push({ ...h, file: file.replace(`${SRC}\\`, "").replace(`${SRC}/`, "") });
    }
  }
  console.log(
    `\nPer-row controls whose name is the SAME on every row: ${repeated.length}`,
  );
  console.log("(a constant aria-label inside a .map() — US-2834)\n");
  for (const h of repeated) {
    console.log(`  ${h.file}:${h.line}  <${h.tag}> aria-label="${h.name}"`);
  }
}

if (process.argv[1]?.endsWith("audit-control-labels.mjs")) main();
