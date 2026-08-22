#!/usr/bin/env node
// US-2016: which iOS features are BUILT, TESTED, and reachable by nobody?
//
// ConsumerGradeFlow is why this exists. The paid consumer grading path was
// implemented as a state machine with submit/pay/poll/result, given unit tests,
// and never presented by any view — so a seller could not start a paid grade at
// all. Its story read as done, and grading-pipeline-parity.test.ts passed,
// because that guard asks whether the SOURCE contains a call to each endpoint.
// It does. In two files nothing opens.
//
// That is a different failure from a dead module. The edge equivalent
// (check-unwired-modules.mjs) catches a FILE nobody imports. Swift has no
// imports between files in a module, so nothing there could have caught this:
// the file compiles, the type is public, and it is simply never constructed.
//
// THE RULE, and it is deliberately the strictest one that still works: a
// top-level struct or class the app declares and then never mentions again
// ANYWHERE in the app — not in another file, not even in its own. One mention
// means the declaration and nothing else.
//
// Looser rules do not survive contact. "Not referenced outside its own file"
// flags every sheet a view presents inline (BuyerAlertEditor, SourceEditorSheet
// and nine others), which is normal SwiftUI organisation, and a guard that
// cries wolf eleven times is one people switch off.
//
// TESTS DO NOT COUNT AS A CALLER, deliberately. Two of the three findings had
// unit tests. A test proves the thing works; it says nothing about whether a
// user can get to it, and treating it as a reference would have hidden exactly
// the cases worth finding.
//
//   node scripts/check-ios-orphans.mjs
//   node scripts/check-ios-orphans.mjs --list   # print, never fail

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = join(root, "ios", "GradeThread");

/**
 * Declared-and-never-mentioned types that are ALLOWED to be so, each with the
 * reason. Shrink-only in spirit, like ALLOWED_DEAD_MODULES: an entry that stops
 * matching fails this check, so ground gained cannot be given back quietly.
 *
 * A type reaches this list for one of two reasons and they are not the same:
 *
 *   SYSTEM-DISCOVERED — the OS finds it by conformance, not by our code. There
 *   is no caller to add and never will be.
 *
 *   UNREACHABLE — a real feature nobody can open. That is a BUG with a story,
 *   and the entry names it. These are here so the check can run green today
 *   without pretending they are fine.
 */
const ALLOWED = {
  GradeThreadAppShortcuts:
    "SYSTEM-DISCOVERED. An AppShortcutsProvider is found by iOS through its " +
    "conformance; app code never constructs one. No caller exists to add.",
  ConsumerGradeFlow:
    "UNREACHABLE (US-2016). The paid consumer grading path — submit, pay, " +
    "poll, result — is built and unit-tested and no view presents it. Needs " +
    "an entry point, which is a product decision recorded on that story.",
  WalkAroundGradeView:
    "UNREACHABLE (US-2504). Walk-around video grading. The recorder is wired " +
    "to this view and this view is opened by nothing, so the feature the " +
    "story calls web-only is in fact built on iOS and unreachable.",
  AIAttributeConfirmView:
    "UNREACHABLE (US-2791), and the starkest of the three: referenced nowhere " +
    "at all, not even by a test. US-826 closed on an AC reading \"AIExtractView " +
    "shows confirm chips\"; this is those chips, and AIExtractView has never " +
    "presented them.",
};

/** Top-level struct/class declarations. */
const DECL =
  /^(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+|internal\s+)?(?:final\s+)?(?:struct|class)\s+([A-Z]\w+)\s*(?::\s*[^{]*)?\{/gm;

function swiftFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) swiftFiles(p, out);
    else if (entry.endsWith(".swift")) out.push(p);
  }
  return out;
}

/** Source with comments removed, so a name in prose is not a reference. */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

const files = swiftFiles(APP_DIR);
if (files.length === 0) {
  // A partial checkout without the iOS tree is not a failure.
  console.log("[ios-orphans] no ios/GradeThread tree — skipped.");
  process.exit(0);
}

const cleaned = files.map((f) => [f, code(readFileSync(f, "utf8"))]);

const found = [];
for (const [file, src] of cleaned) {
  for (const m of src.matchAll(DECL)) {
    const name = m[1];
    let mentions = 0;
    for (const [, other] of cleaned) {
      mentions += (other.match(new RegExp("\\b" + name + "\\b", "g")) ?? []).length;
    }
    if (mentions <= 1) {
      found.push({ name, file: relative(root, file).split(sep).join("/") });
    }
  }
}

if (process.argv.includes("--list")) {
  console.log(`\n${found.length} declared-and-never-mentioned type(s):\n`);
  for (const f of found) {
    console.log(`  ${f.name.padEnd(30)} ${f.file}`);
    if (ALLOWED[f.name]) console.log(`      allowed: ${ALLOWED[f.name]}`);
  }
  process.exit(0);
}

const unexplained = found.filter((f) => !ALLOWED[f.name]);
const stale = Object.keys(ALLOWED).filter((n) => !found.some((f) => f.name === n));

if (unexplained.length === 0 && stale.length === 0) {
  console.log(
    `[ios-orphans] OK  ${found.length} unreachable type(s), all accounted for. ` +
      "Reasons in scripts/check-ios-orphans.mjs.",
  );
  process.exit(0);
}

if (unexplained.length > 0) {
  console.error("\n[ios-orphans] NEW type(s) the app declares and never mentions again:\n");
  for (const f of unexplained) console.error(`    ${f.file}  ->  ${f.name}`);
  console.error(
    "\n  It compiles, it may have tests, and no user can reach it. Decide which\n" +
      "  this is — they look identical from here:\n\n" +
      "    SYSTEM-DISCOVERED  the OS finds it by conformance -> allowlist WITH that reason\n" +
      "    UNREACHABLE        a feature nobody can open -> a bug; file it, then allowlist\n" +
      "    DEAD               nothing wants it -> delete it\n\n" +
      "  Then add it to ALLOWED with that verdict, or wire it up.\n",
  );
}

if (stale.length > 0) {
  console.error(
    "\n[ios-orphans] ALLOWED entr(ies) that no longer match — wired up or removed?\n",
  );
  for (const n of stale) console.error(`    ${n}`);
  console.error("\n  Delete the entry. The list only shrinks.\n");
}

process.exit(1);
