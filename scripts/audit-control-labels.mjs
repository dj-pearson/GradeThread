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

/** The attribute text of the tag starting at `from`, up to its closing `>`. */
export function tagAttrs(src, from) {
  let depth = 0;
  for (let i = from; i < src.length && i < from + 4000; i++) {
    const c = src[i];
    if (c === "{") depth++;
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
}

if (process.argv[1]?.endsWith("audit-control-labels.mjs")) main();
