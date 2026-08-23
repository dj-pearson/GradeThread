#!/usr/bin/env node
// US-2802: a form field the SERVER parses that no CLIENT can send.
//
// This is the hardest kind of dead code to see, because nothing about it looks
// dead. The parser is real, the validation is careful, the column exists, the
// pipeline reads it, and the certificate renders the result. Every piece is
// alive except the one that would put a value in — and that piece is in another
// language, in another directory, and its absence leaves no trace at all.
//
// FOUND BY THE FIRST RUN, 2026-08-22, all in routes/grade.ts:
//
//   live_capture_opt_in    WIRED 2026-08-22 by US-2802 (web). Kept in this
//   capture_sources        header because the shape is the lesson: the badge
//                          calls "the strongest provenance tier" has never been
//                          issued once. Its confidence boost has never applied.
//   verified_360_opt_in    same shape, same route, same sweep.
//   capture_360
//   style_attributes       the seller-declared "this distressing is intentional"
//                          hint. The allowlist has only ever filtered an empty
//                          list, so distressed denim grades as wear (US-2801).
//
// THE CONTRAST IS WHAT MAKES IT PROVABLE, and it is four adjacent lines of one
// insert: verified_capture_opt_in (grade.ts:839) IS posted by
// new-submission.tsx. The three below it are posted by nothing. Identical
// shape, identical neighbourhood, and only one of them works.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE CLIENT SIDE IS A BARE SUBSTRING SEARCH
//
// Deliberately loose. A client may build the field name from a constant, a
// helper, or an interpolation, and a strict matcher would report those as unfed
// and be switched off within a week. Searching for the bare name across every
// client file finds the constant too, so this only ever reports TOTAL absence:
// the name appears nowhere a client could reach. That is a weak test and a
// trustworthy one, which is the right trade for a gate.
//
// THE BOUNDARY IS NOT OPTIONAL, and the first run proved it. `_` is a word
// character, so a plain substring search finds `style_attributes` inside
// `detected_style_attributes` — a completely different thing (the MODEL's
// reading, which the certificate renders) — and reports the field as fed. The
// lookarounds below treat an underscore as part of the name, which is the only
// reading that makes `foo_bar` and `baz_foo_bar` distinct.
//
// The boundary is PROTECTIVE, not currently load-bearing, and a sabotage run
// says so: replacing it with a plain substring test leaves this green, because
// no field in the list collides today. It earned its place during development,
// when it was the difference between a true finding and a false all-clear, and
// it is the kind of thing that only ever bites once someone adds `foo` beside
// an existing `bar_foo`.
//
// WHAT THIS GUARD CANNOT SEE, stated so nobody trusts it further than it goes:
// a field MENTIONED by a client but never actually appended. `style_attributes`
// is exactly that — submission-detail.tsx reads it off a prior submission for
// the retake bridge and new-submission.tsx then ignores it, so the name is
// present on the client and no client sends it. This guard passes it, and
// US-2801 is the record instead. Catching that needs dataflow, not a search.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist", "build", ".git", "coverage"]);

/**
 * Fields the server parses that nothing sends, ON PURPOSE or pending work.
 *
 * Shrink-only, like the repo's other baselines: an entry that stops matching
 * FAILS, so a field that gets wired cannot keep its excuse. Every entry names
 * the story that owns it.
 */
const ALLOWED = {
  // live_capture_opt_in and capture_sources were here and are now WIRED
  // (US-2802): the web camera dialog stamps each photo's origin and
  // new-submission.tsx sends both, from src/lib/photo-capture-contract.ts.
  // Their removal is this list doing its job.
  verified_360_opt_in:
    "US-2802. Still unfed, and not for want of a decision: verified-360.ts " +
    "scores photogrammetric/LiDAR coverage metrics, which a BROWSER cannot " +
    "measure. Web has nothing honest to send. It waits on the iOS/Android " +
    "half, where the sensors exist.",
  capture_360:
    "US-2802. The device-reported metrics that verified_360_opt_in gates. " +
    "Same blocker, and deliberately NOT declared in photo-capture-contract.ts " +
    "meanwhile — naming it under src/ would read as fed here and disarm this " +
    "very entry.",

  forensic_grade:
    "Exercised by the edge suite only. The forensic add-on is chosen at grade " +
    "time through the tier/add-on path rather than as its own form field, so " +
    "the parser is a compatibility shim rather than a missing client.",
  regrade_of:
    "Exercised by the edge suite only. A regrade is initiated server-side " +
    "from the prior submission, not posted by a client.",
};

/** Directories a CLIENT could send a field from. */
const CLIENT_ROOTS = ["src", "ios", "android", "extension-unified", "functions", "e2e"];
const CLIENT_EXT = /\.(ts|tsx|swift|kt|js|jsx)$/;

const EDGE_ROOT = "services/edge-functions/src";
const EDGE_EXT = /\.ts$/;

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.test(entry)) out.push(p);
  }
  return out;
}

const rel = (p) => relative(ROOT, p).replaceAll("\\", "/");
const isTest = (p) => /__tests__|[\\/]tests?[\\/]|\.test\.|_test\.|Tests[\\/]/.test(p);

// ── The server side: every field name read off a multipart form ─────────────
const READ = /formData\.(?:get|getAll)\(\s*["']([a-z0-9_]+)["']\s*\)/g;
const parsed = new Map();
for (const f of walk(join(ROOT, EDGE_ROOT), EDGE_EXT).filter((p) => !isTest(p))) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(READ)) {
    if (!parsed.has(m[1])) parsed.set(m[1], new Set());
    parsed.get(m[1]).add(rel(f));
  }
}

// ── The client side: one big haystack, searched for the bare name ───────────
const clientFiles = CLIENT_ROOTS
  .flatMap((r) => walk(join(ROOT, r), CLIENT_EXT))
  .filter((p) => !isTest(p));
const haystack = clientFiles.map((p) => {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}).join("\n");

/** An underscore is a word character, so a regex word boundary will NOT
 *  separate foo_bar from baz_foo_bar. These lookarounds do. */
function mentioned(field) {
  return new RegExp(`(?<![A-Za-z0-9_])${field}(?![A-Za-z0-9_])`).test(haystack);
}

const unfed = [...parsed.entries()]
  .filter(([field]) => !mentioned(field))
  .map(([field, where]) => ({ field, where: [...where] }));

if (process.argv.includes("--list")) {
  console.log(
    `\n${parsed.size} form field(s) parsed by the edge; ${unfed.length} that no client mentions:\n`,
  );
  for (const u of unfed) {
    console.log(`  ${u.field}`);
    console.log(`      parsed in: ${u.where.join(", ")}`);
    console.log(`      ${ALLOWED[u.field] ? `allowed: ${ALLOWED[u.field]}` : "NOT ALLOWED"}\n`);
  }
  process.exit(0);
}

const unexplained = unfed.filter((u) => !ALLOWED[u.field]);
const stale = Object.keys(ALLOWED).filter(
  (f) => !unfed.some((u) => u.field === f),
);

if (unexplained.length === 0 && stale.length === 0) {
  console.log(
    `[unfed-fields] OK  ${parsed.size} form field(s) checked, ` +
      `${unfed.length} accounted for.`,
  );
  process.exit(0);
}

if (unexplained.length > 0) {
  console.error(
    "\n[unfed-fields] the edge parses these and no client can send them:\n",
  );
  for (const u of unexplained) {
    console.error(`    ${u.field}`);
    console.error(`        parsed in: ${u.where.join(", ")}`);
  }
  console.error(
    "\n  Either the client half was never built — which is worth a story, not a\n" +
      "  silent allowlist entry — or the field is server-initiated and belongs in\n" +
      "  ALLOWED with that reason written down.\n",
  );
}

if (stale.length > 0) {
  console.error(
    "\n[unfed-fields] ALLOWED entr(ies) that are now fed — drop them:\n",
  );
  for (const f of stale) console.error(`    ${f}`);
  console.error(
    "\n  Good news: something wired one up. Remove the entry so the list keeps\n" +
      "  shrinking.\n",
  );
}

process.exit(1);
