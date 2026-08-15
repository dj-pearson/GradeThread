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
 * Paths in this state that the owner has decided to keep. EMPTY, and that is
 * the finished condition rather than a coincidence.
 *
 * US-2437 AC3 (owner, 2026-08-15): all 32 were untracked with
 * `git rm --cached`. Every one was generated or extracted output that ALSO
 * carried a gitignore line — 20 unzipped fragments of FlipDesk_PRD_v1.docx (the .docx
 * itself is tracked and is the artifact), 9 generated hf_* media files, one
 * App Store screenshot, one .pyc, and supabase/.temp/cli-latest. Nothing in
 * the repo referenced any of them, and the ignore line was already somebody
 * saying they should not be tracked.
 *
 * Nothing was lost: the files stay on disk and stay in git history, so the
 * repository does not shrink — what stops is the state where an ignore rule
 * does nothing and a regenerated file reads as modified forever.
 *
 * The list may only SHRINK, so re-adding an entry is not the way to make this
 * check pass. If a new path shows up, it is a new instance of the same bug and
 * the fix is to decide which half is wrong, per the message below.
 */
const KNOWN = [];

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
  KNOWN.length === 0
    ? "✓ no tracked-and-ignored files, and no known exceptions"
    : `✓ no new tracked-and-ignored files (${KNOWN.length} known, awaiting an owner decision)`,
);
