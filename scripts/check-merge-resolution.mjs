#!/usr/bin/env node
// US-3408: check that a merge resolution's own scope survived the resolution.
//
// See scripts/lib/merge-resolution-check.mjs for what it reports and why it is
// not simply `tsc -b`.
//
// Usage:
//   node scripts/check-merge-resolution.mjs                 # the merge in progress, else HEAD if HEAD is a merge
//   node scripts/check-merge-resolution.mjs --range A..B    # every merge commit in the range
//   node scripts/check-merge-resolution.mjs --all-changed A # every file changed since A, merge or not
//   node scripts/check-merge-resolution.mjs <files…>
//
// Exit 1 when a file is reported. Exit 0 when there is nothing to check: a push
// that carries no merge is not this gate's business.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFiles, formatFindings } from "./lib/merge-resolution-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", ...opts }).trim();
}

function gitQuiet(args) {
  try {
    return git(args);
  } catch {
    return "";
  }
}

function gitDir() {
  return gitQuiet(["rev-parse", "--git-dir"]) || ".git";
}

/** Files a merge commit changed relative to its FIRST parent — the resolution. */
function filesOfMerge(sha) {
  const parents = gitQuiet(["rev-list", "--parents", "-n", "1", sha]).split(/\s+/).slice(1);
  if (parents.length < 2) return [];
  return gitQuiet(["diff", "--name-only", `${parents[0]}`, sha]).split("\n").filter(Boolean);
}

function mergesInRange(range) {
  const out = gitQuiet(["rev-list", "--merges", range]);
  return out ? out.split("\n").filter(Boolean) : [];
}

function resolveTargets(argv) {
  const rangeIdx = argv.indexOf("--range");
  if (rangeIdx !== -1) {
    const range = argv[rangeIdx + 1];
    if (!range) fail("--range needs A..B");
    const files = new Set();
    // Read each file AS THE MERGE LEFT IT, not as the worktree has it now —
    // otherwise checking a past merge silently checks today's fixed files.
    const contents = new Map();
    for (const sha of mergesInRange(range)) {
      for (const f of filesOfMerge(sha)) {
        files.add(f);
        const blob = gitQuiet(["show", `${sha}:${f}`]);
        if (blob) contents.set(f, blob);
      }
    }
    return { why: `merges in ${range}`, files: [...files], contents };
  }

  const allIdx = argv.indexOf("--all-changed");
  if (allIdx !== -1) {
    const base = argv[allIdx + 1];
    if (!base) fail("--all-changed needs a base revision");
    const files = gitQuiet(["diff", "--name-only", base]).split("\n").filter(Boolean);
    return { why: `everything changed since ${base}`, files };
  }

  const explicit = argv.filter((a) => !a.startsWith("-"));
  if (explicit.length) return { why: "files named on the command line", files: explicit };

  // A merge in progress: the working tree is the resolution, so check the files
  // that had conflicts plus everything the merge brought in.
  const dir = path.resolve(ROOT, gitDir());
  if (existsSync(path.join(dir, "MERGE_HEAD"))) {
    const other = gitQuiet(["rev-parse", "MERGE_HEAD"]);
    const files = new Set(
      gitQuiet(["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean),
    );
    for (const f of gitQuiet(["diff", "--name-only", "HEAD"]).split("\n").filter(Boolean)) {
      files.add(f);
    }
    return { why: `the merge in progress with ${other.slice(0, 9)}`, files: [...files] };
  }

  const headFiles = filesOfMerge("HEAD");
  if (headFiles.length) return { why: "HEAD, which is a merge commit", files: headFiles };
  return { why: "", files: [] };
}

function fail(msg) {
  console.error(`[merge-resolution] ${msg}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const { why, files, contents } = resolveTargets(argv);

if (!files.length) {
  console.log("[merge-resolution] no merge resolution to check — ok");
  process.exit(0);
}

const { checked, skipped, findings } = checkFiles(files, { root: ROOT, contents });

if (findings.length) {
  console.error(`[merge-resolution] ${why}`);
  console.error(formatFindings(findings));
  console.error("");
  console.error(
    "[merge-resolution] This is the shape of a conflict resolved by interleaving\n" +
      "both sides: bodies from one, declarations from the other. Re-resolve the\n" +
      "file by choosing a side, then run this again. It is not bypassable with\n" +
      "--no-verify because it runs from .githooks/reference-transaction, at the\n" +
      "ref update, not at the push.",
  );
  process.exit(1);
}

const note = skipped.length ? ` (${skipped.length} skipped)` : "";
console.log(`[merge-resolution] ${checked.length} file(s) clean${note} — ${why}`);
