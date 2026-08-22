#!/usr/bin/env node
// US-2772: a commit subject may not announce a close that prd.json contradicts.
//
// The failure this catches, in full: commit 68b3f103a is titled "docs(prd):
// close US-2729, US-2686 and US-2772". Two were archived by it. The third
// stayed at passes:false with zero notes while its code was already live, and
// was picked up again later BECAUSE it looked untouched. `markDone` writes
// all-or-nothing and throws on an unknown id, so nothing half-failed — the id
// was never passed to it, and the subject asserted an outcome nobody checked.
//
// A backlog that errs toward MORE work left is the expensive direction: the
// cost is somebody re-implementing shipped work before noticing.
//
// WHAT COUNTS AS A CLAIM, deliberately narrow. Only the SUBJECT line, and only
// the ids inside the close clause — a subject may say "close US-1; note US-2"
// and US-2 is not checked, because "note" is not a claim about state. The body
// may discuss any story freely. Narrow beats clever here: a guard that fires on
// prose is one people disable.
//
//   node scripts/check-close-claims.mjs <commit-msg-file>
//   node scripts/check-close-claims.mjs --subject "docs(prd): close US-123"

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The ids a subject line CLAIMS to have closed.
 *
 * `\bclos` with the word boundary is load-bearing: without it "disclose"
 * matches, and the first run of this logic reported two false positives from
 * subjects like "confirm + disclose before an in-place plan upgrade".
 */
export function closeClaims(subject) {
  const m = /\bclos(?:e|ed|es|ing)\b\s+(.+)$/i.exec(subject);
  if (!m) return [];
  // Stop at the first clause that is no longer about closing. A subject
  // routinely closes some stories and merely notes others.
  const clause = m[1].split(/;|\bnotes?\b|\bnoted\b|\bre-?opens?\b/i)[0];
  return [...new Set(clause.match(/US-\d+/g) ?? [])];
}

/**
 * Is this story actually closed?
 *
 * Archived counts, and so does passes:true still sitting in prd.json — the
 * archive move is a separate step (`--no-archive` skips it for a bulk close)
 * and failing on that would make this guard fire on a correct workflow.
 * A story in NEITHER file is not a pass: an id that exists nowhere is a typo in
 * the subject, which is the same lie in a different form.
 */
export function closeState(id, prd, archive) {
  if (archive.has(id)) return "archived";
  const story = prd.get(id);
  if (!story) return "unknown";
  return story.passes === true ? "passes" : "open";
}

function loadStories(file) {
  const raw = JSON.parse(readFileSync(resolve(root, file), "utf8"));
  return raw.userStories ?? [];
}

function main(argv) {
  let subject;
  const subjIdx = argv.indexOf("--subject");
  if (subjIdx !== -1) {
    subject = argv[subjIdx + 1] ?? "";
  } else {
    const file = argv.find((a) => !a.startsWith("--"));
    if (!file) {
      console.error("usage: check-close-claims.mjs <commit-msg-file>");
      return 2;
    }
    // A commit message file carries comment lines; the subject is the first
    // line that is not one, not the literal first line.
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    subject = lines.find((l) => l.trim() && !l.startsWith("#")) ?? "";
  }

  const claims = closeClaims(subject);
  if (claims.length === 0) return 0;

  let prd, archive;
  try {
    prd = new Map(loadStories("prd.json").map((s) => [s.id, s]));
    archive = new Set(loadStories("prd.archive.json").map((s) => s.id));
  } catch (err) {
    // Never block a commit because the backlog files could not be read. This
    // guard's job is to catch a specific mistake, not to gate on JSON health —
    // prd-lint owns that and runs in CI.
    console.error(`[close-claims] skipped: ${err.message}`);
    return 0;
  }

  const bad = claims
    .map((id) => [id, closeState(id, prd, archive)])
    .filter(([, state]) => state === "open" || state === "unknown");

  if (bad.length === 0) return 0;

  console.error("");
  console.error("  This commit message says it closes a story that is not closed.");
  console.error("");
  for (const [id, state] of bad) {
    console.error(
      state === "unknown"
        ? `    ${id}  is in neither prd.json nor prd.archive.json`
        : `    ${id}  is still passes:false in prd.json`,
    );
  }
  console.error("");
  console.error("  Close it first, then commit:");
  console.error(`    node scripts/prd-story.mjs done ${bad.map(([i]) => i).join(" ")} --note "…"`);
  console.error("");
  console.error("  Or reword the subject if the commit does not actually close it.");
  console.error("  (US-2772: this exact mistake left a shipped security story open,");
  console.error("   and it was nearly re-implemented because it looked untouched.)");
  console.error("");
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-close-claims.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
