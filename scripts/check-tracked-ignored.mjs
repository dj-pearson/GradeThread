#!/usr/bin/env node
// US-2437 AC4 — a file must not be both TRACKED and GITIGNORED.
//
// THE STATE THIS CATCHES. Git gives no warning when a file is committed AND
// matched by .gitignore. The ignore silently does nothing (gitignore only
// applies to UNtracked paths), so the file keeps showing as modified in every
// working tree forever, and everyone who notices adds another ignore line that
// also does nothing. supabase/.temp/cli-latest collected FOUR such lines before
// anybody worked out why they were not taking effect. A rule added four times is
// a rule that never worked.
//
// It is not only cosmetic. The state hides two opposite bugs and the fix differs:
//   - the TRACKING is wrong (generated output that was committed before the
//     ignore existed) — resolve with `git rm --cached`;
//   - the IGNORE is wrong (a file that must stay committed) — resolve by
//     deleting the ignore line. services/edge-functions/deno.lock was this one:
//     US-517's frozen-lockfile check requires it committed, and it was, while
//     .gitignore claimed the opposite.
// So this guard reports the class and makes someone choose. It does not guess.
//
// WHY IT LIVES IN verify AND NOT ONLY IN CI. The bug that filed US-2437 was
// eslint linting supabase/.temp/start-secrets/, which only appears after
// `supabase start`. CI never runs that, so CI could not have caught it; the
// people it broke were the ones following CLAUDE.md and booting the full local
// stack. This check needs nothing but git, so it runs everywhere.

import { execFileSync } from "node:child_process";

/**
 * Paths already in this state on 2026-08-08, each with the decision it is
 * waiting on. The list may only SHRINK: a path that leaves the state must leave
 * this list too, which is what stops a "temporary" baseline becoming permanent.
 *
 * None of these is resolvable as a side effect of a lint fix — every one changes
 * what a fresh clone receives, which is the repo owner's call.
 */
const KNOWN = [
  // supabase/.temp/ — written by `supabase start`. US-2437 AC3: this is the
  // original instance, and the one that cost four dead ignore lines.
  "supabase/.temp/cli-latest",

  // temp_prd/ — an unzipped .docx (FlipDesk_PRD_v1). Committed as loose OOXML
  // parts, then ignored as a directory. The .docx itself is the artifact worth
  // keeping; these 19 fragments are its extracted innards.
  "temp_prd/[Content_Types].xml",
  "temp_prd/_rels/.rels",
  "temp_prd/docProps/app.xml",
  "temp_prd/docProps/core.xml",
  "temp_prd/docProps/custom.xml",
  "temp_prd/word/_rels/comments.xml.rels",
  "temp_prd/word/_rels/document.xml.rels",
  "temp_prd/word/_rels/fontTable.xml.rels",
  "temp_prd/word/_rels/footer1.xml.rels",
  "temp_prd/word/_rels/footnotes.xml.rels",
  "temp_prd/word/_rels/header1.xml.rels",
  "temp_prd/word/comments.xml",
  "temp_prd/word/document.xml",
  "temp_prd/word/fontTable.xml",
  "temp_prd/word/footer1.xml",
  "temp_prd/word/footnotes.xml",
  "temp_prd/word/header1.xml",
  "temp_prd/word/numbering.xml",
  "temp_prd/word/settings.xml",
  "temp_prd/word/styles.xml",

  // Generated media / build debris committed before its ignore rule landed.
  "assets/hf_20260701_161519_a331a38a-3bfe-4cdf-a13a-eaa7a274f1ae.mp4",
  "assets/hf_20260701_162650_5b7b9767-c2a9-407a-855f-d90ed9f81ea2.mp4",
  "assets/hf_20260705_193157_0ce821b9-771d-4508-9d53-16c5f6385bd1.mp4",
  "assets/hf_20260705_193405_5aea28a7-852e-4b53-9186-e95db03acd1f.mp4",
  "assets/hf_20260705_201453_d8c8b99f-26ba-4a65-b357-1bf1b8689eba.png",
  "assets/hf_20260705_201507_904f7d95-4d69-484a-a500-0c7f99dad218.png",
  "assets/hf_20260705_201518_3844d0ee-1389-459c-8fb0-8ca46d99953f.png",
  "assets/hf_20260705_201527_0367e5bc-a60f-433a-9933-6648f764c801.png",
  "assets/hf_20260705_201537_db00d1fc-cff5-423e-91fd-cc5548ed5314.png",
  "ios-screenshots/screenshots-appstore/ipad-13/iPad Pro 13-inch (M4)-01_Home.png",
  "ios/Scripts/__pycache__/check-ats.cpython-313.pyc",
];

function trackedAndIgnored() {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--ignored", "--exclude-standard"],
    { encoding: "utf8" },
  );
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

const actual = trackedAndIgnored();
const known = new Set(KNOWN);
const added = actual.filter((p) => !known.has(p));
const resolved = KNOWN.filter((p) => !actual.includes(p));

let failed = false;

if (added.length > 0) {
  failed = true;
  console.error(
    `\n✗ ${added.length} file(s) are both TRACKED and GITIGNORED. The ignore does ` +
      `nothing (gitignore only applies to untracked paths), so each will read as ` +
      `modified in every working tree forever:\n` +
      added.map((p) => `    ${p}`).join("\n") +
      `\n\n  Decide which half is wrong, per file:\n` +
      `    the TRACKING is wrong (generated output) → git rm --cached <path>\n` +
      `    the IGNORE is wrong (must stay committed) → delete the .gitignore line\n` +
      `  Adding another ignore line will not help; that is how this bug hides.\n`,
  );
}

if (resolved.length > 0) {
  failed = true;
  console.error(
    `\n✗ ${resolved.length} path(s) in KNOWN are no longer tracked-and-ignored. ` +
      `Good — remove them from scripts/check-tracked-ignored.mjs. The list may only ` +
      `shrink, so a fixed entry left behind fails as loudly as a new one:\n` +
      resolved.map((p) => `    ${p}`).join("\n") + "\n",
  );
}

if (failed) process.exit(1);

console.log(
  `✓ no new tracked-and-ignored files (${KNOWN.length} known, awaiting an owner decision)`,
);
