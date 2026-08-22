#!/usr/bin/env node
// US-2789: which guards READ a module that nothing ever CALLS?
//
// A source scan is the right instrument for a WIRING property — is this module
// mounted, does this registry list that route, do these two files agree. It is
// the wrong one for LOGIC, because it pins a spelling or a string position and
// stays green through any change that preserves them.
//
// That is not theoretical. Three guards here were found blind while reading as
// coverage, each measured on the same sabotages a behavioural test then caught:
//
//   US-2739  stepPrice           six cases asserting against a re-implementation
//   US-2719  buildSteps          scans 1 of 7, behavioural 7 of 7
//   US-2789  decideSubmitAction  scans 0 of 6, including its own double-charge bug
//   US-2789  paginationNav       scans 1 of 6, missing the duplicate-URL rule
//
// ⚠ WHAT THIS COUNTS, AND WHY THE FIRST VERSION COUNTED THE WRONG THING.
//
// It first counted files that scan and never call. That number CANNOT FALL as
// the work is done, because every conversion deliberately KEEPS its scan — the
// scan holds a wiring property the call cannot see, and deleting it would trade
// a weak guard for no guard. Two conversions later the count was still 63, so it
// was measuring effort spent rather than ground gained.
//
// What moves is the SUBJECT. A guard is a candidate only while the module it
// reads is called by no test at all. Convert one — extract the decision, import
// it somewhere, assert on what it returns — and the subject leaves this list
// whether or not its scan stays. That is the number worth watching.
//
// NOT A GATE, and it does not fail. Most listed files are correct as scans;
// composer-dirty-guard.test.ts tops the raw scan count and is right as it is,
// because its logic half already lives in composer-dirty.test.ts. A threshold
// would only invite a throwaway `expect(fn())` to duck under it.
//
//   node scripts/scan-only-guards.mjs            # the worklist
//   node scripts/scan-only-guards.mjs --count    # just the number, for a diff
//   node scripts/scan-only-guards.mjs --all      # include subjects already covered

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories holding vitest suites worth measuring. */
const DIRS = ["src/test", "src/lib/__tests__"];

/**
 * Where COVERAGE can come from, which is a wider set than where the scans live.
 *
 * ⚠ THIS WAS WRONG AND THE TOOL RECOMMENDED WORK ALREADY DONE. Coverage was
 * read from DIRS alone — the web suites — so an edge module tested by
 * `services/edge-functions/src/tests/*_test.ts` still counted as uncovered.
 * `ai-config.ts` was listed as a candidate immediately after a test importing
 * it was written and committed.
 *
 * A worklist that cannot see finished work is worse than no worklist: it sends
 * the next person to redo something, and the redundant second test then looks
 * like evidence the first was missing.
 */
const COVERAGE_DIRS = [
  "src/test",
  "src/lib/__tests__",
  "services/edge-functions/src/tests",
];

/** Reading source rather than exercising it. */
const SCAN = /toContain\(|toMatch\(|readFileSync|\.test\(\s*(?:src|code|text)\b/g;

/**
 * Does this suite import something from the app and EXERCISE it?
 *
 * ⚠ THE OBVIOUS TEST IS WRONG, and it over-flags. This was
 * `/expect\(\s*[a-z]\w*\s*\(/` — matching `expect(fn(x)).toBe(y)`. That misses
 * the more common shape by far:
 *
 *     const res = await refundPack(io, input);
 *     assertEquals(res.ok, false);
 *
 * a call, then an assertion on the RESULT. Applying the same heuristic to the
 * 824-file edge suite reported 9 scan-only guards; the corrected one reports 4.
 * Among the five false positives was admin-pack-refund_test.ts, which drives
 * TWENTY cases of a money path through injected IO. "Converting" that would
 * have meant bolting redundant tests onto one of the better suites here.
 *
 * So the question is not how the assertion is written. It is whether the file
 * imports an application symbol and USES it anywhere.
 *
 * ⚠ AND "USES" IS NOT "CALLS". Requiring a call missed the case where the
 * exports that matter are DATA. disclosure-version.test.ts imports
 * DISCLOSURE_ARCHIVE and asserts that the archived copy equals the copy in the
 * source — the strongest form that property can take, because it is a
 * compliance record of the words a subscriber was actually shown. There is no
 * function to call and nothing to convert, yet it flagged as debt.
 *
 * A symbol referenced anywhere outside its own import line is being exercised,
 * whether that reads `fn(x)` or `toEqual(ARCHIVE)`.
 */
function usesApp(src) {
  const named = [...src.matchAll(
    /import\s*\{([^}]+)\}\s*from\s*["'](?:@\/|\.\.?\/)[^"']*["']/g,
  )];
  const dynamic = [...src.matchAll(/const\s*\{([^}]+)\}\s*=\s*await\s+import\(/g)];
  const names = [...named, ...dynamic]
    .flatMap((m) => m[1].split(","))
    .map((x) => x.trim().split(/\s+as\s+/).pop().replace(/^type\s+/, "").trim())
    // Values, not types. `PascalCase` is a Type or a <Component>; neither is a
    // thing a guard exercises. SCREAMING_CASE and camelCase both are.
    .filter((n) => n && /^[A-Za-z][A-Za-z0-9_]*$/.test(n) && !/^[A-Z][a-z]/.test(n));
  // Referenced OUTSIDE the import lines that introduced it — otherwise every
  // import counts as its own use and nothing is ever scan-only.
  const body = src.replace(/^\s*import\b[^;]*;?$/gm, "");
  return names.some((n) => new RegExp("\\b" + n + "\\b").test(body));
}

/** Repo-relative paths a test names as a string — the files it reads. */
const SUBJECT = /["'`]((?:src|functions|services|scripts|supabase|android|ios)\/[^"'`\n]+?\.[a-z]{2,4})["'`]/g;

/**
 * Modules a test IMPORTS, normalised toward a repo-relative-ish tail.
 *
 * BOTH FORMS, and the second is not optional here. The edge suites cannot use a
 * static import for anything that reaches `lib/supabase.ts`: that module reads
 * env at load, so the tests set dummy credentials first and then
 * `await import("../lib/ai-config.ts")`. Matching only `from "…"` therefore
 * misses the entire Deno side and reports its modules as untested — which it
 * did, for `ai-config.ts`, immediately after a test importing it was committed.
 */
const IMPORT = /(?:from\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["'])/g;

function count(re, s) {
  return (s.match(re) ?? []).length;
}

function testFiles(dirs) {
  const out = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(join(root, dir));
    } catch {
      continue; // may not exist in a partial checkout
    }
    for (const name of entries) {
      // Deno suites are `*_test.ts`; vitest suites are `*.test.ts`.
      if (!/(\.(test|spec)\.tsx?|_test\.ts)$/.test(name)) continue;
      out.push({ rel: `${dir}/${name}`, src: readFileSync(join(root, dir, name), "utf8") });
    }
  }
  return out;
}

/** The files examined for scan-only-ness. */
const files = testFiles(DIRS);

/** Every file that can COUNT as coverage, which is a wider set. */
const coverageFiles = testFiles(COVERAGE_DIRS);

/**
 * Every module tail any test imports.
 *
 * Tails rather than resolved paths: an import is written `@/lib/submit-action`,
 * `../composer-dirty` or `../../functions/_shared/blog-pagination`, and the
 * shared, comparable part is the end. Matching on the last two segments is
 * loose enough to survive all three spellings and tight enough that `index.ts`
 * files do not collide with each other.
 */
const importedTails = new Set();
for (const f of coverageFiles) {
  for (const m of f.src.matchAll(IMPORT)) {
    const spec = (m[1] ?? m[2]).replace(/\.[tj]sx?$/, "");
    if (spec === "vitest" || spec.startsWith("node:")) continue;
    const parts = spec.split("/").filter((p) => p && p !== "." && p !== "..");
    if (parts.length) importedTails.add(parts.slice(-2).join("/"));
  }
}

function tailOf(path) {
  return path.replace(/\.[a-z]+$/, "").split("/").slice(-2).join("/");
}

/**
 * Is this subject a place where "extract the decision and call it" is even
 * possible?
 *
 * A guard reading a PAGE or a ROUTE component is very often correct forever:
 * the property is structural (this page has a heading, that tab sets a header,
 * this route is mounted) and there is no pure function to lift out. Counting
 * those as debt makes the number unactionable, which is how the first version
 * of this script produced a total nobody could move — two conversions later it
 * still read 63.
 *
 * Library modules are the opposite. A lib file no test imports is a file whose
 * behaviour nothing checks, and lifting a decision out of it is exactly the
 * move US-2739, US-2719 and US-2789 each made.
 */
function isLiftable(path) {
  return (
    path.startsWith("src/lib/") ||
    path.startsWith("functions/_shared/") ||
    path.startsWith("scripts/lib/") ||
    /^services\/[^/]+\/src\/lib\//.test(path)
  );
}

/**
 * Does this guard assert a property across a whole TREE rather than about one
 * module?
 *
 * A corpus guard walks a directory and checks something of everything it finds:
 * "no browser file uploads straight to storage", "no site compares a confidence
 * against a literal", "no private-bucket signed URL exceeds 900s". Those are
 * NEGATIVES OVER A SET, and no unit test can express one — you cannot call a
 * function to prove that nothing anywhere does a thing.
 *
 * They are also the best guards in the repo. signed-url-ttl.test.ts scans real
 * call sites across three trees, refuses a TTL that is not statically checkable,
 * and asserts it found call sites AT ALL so it cannot pass by matching nothing.
 * Listing those as debt would be exactly backwards.
 *
 * Detected by the walk itself. A file reaching for readdirSync is not examining
 * one module, whatever its subjects list says.
 */
function isCorpusGuard(src) {
  return /readdirSync|globSync|walkSync|readdir\(/.test(src);
}

const rows = [];
for (const f of files) {
  const scans = count(SCAN, f.src);
  if (scans < 6 || usesApp(f.src)) continue;
  if (isCorpusGuard(f.src)) continue;

  const subjects = [...new Set([...f.src.matchAll(SUBJECT)].map((m) => m[1]))]
    // A subject the guard PARSES is being used as data, not scanned as text —
    // `JSON.parse(read("…/ebay-aspect-registry.json"))` is the JSON equivalent
    // of importing and calling. Flagging it says "nothing exercises this file"
    // about a file the test is actively driving.
    .filter((s) => !(s.endsWith(".json") && /JSON\.parse/.test(f.src)));
  const uncovered = subjects
    .filter((s) => !importedTails.has(tailOf(s)))
    .filter(isLiftable);
  rows.push({
    rel: f.rel,
    scans,
    subjects: subjects.length,
    uncovered,
    covered: subjects.length > 0 && uncovered.length === 0,
  });
}

const showAll = process.argv.includes("--all");
/**
 * A candidate has at least one uncovered library subject to act on.
 *
 * NOT `!covered`, which was the earlier test and produced six entries reading
 * "0 uncovered" — guards whose subjects the path regex never matched at all
 * (they name files through a helper, or build the path from a variable). Those
 * listed as work with nothing beside them to do, which is the same noise the
 * page-subject and corpus-walker exclusions removed.
 *
 * A guard the regex cannot read is invisible here rather than falsely flagged.
 * That is the safe direction for a worklist: a missed candidate costs one guard
 * left as it is, a false one costs somebody's afternoon.
 */
const candidates = rows.filter((r) => r.uncovered.length > 0);
const shown = showAll ? rows : candidates;
shown.sort((a, b) => b.uncovered.length - a.uncovered.length || b.scans - a.scans);

if (process.argv.includes("--count")) {
  console.log(candidates.length);
  process.exit(0);
}

console.log(
  `\nScan-only guards, excluding corpus walkers: ${rows.length}\n` +
    `Of those, reading a LIBRARY module no test ever calls: ${candidates.length}\n\n` +
    "Not a failure list. A scan is right for WIRING and wrong for LOGIC — the\n" +
    "question per file is which it holds.\n\n" +
    "Two exclusions, each because counting them made the number unactionable:\n" +
    "  • CORPUS guards (they walk a tree) assert a negative over a SET — nothing\n" +
    "    anywhere uploads to storage, no site compares against a literal. You\n" +
    "    cannot call a function to prove an absence. These are the repo's best\n" +
    "    guards, not its debt.\n" +
    "  • PAGE and ROUTE subjects. The property there is structural and there is\n" +
    "    no pure function to lift out.\n",
);
for (const r of shown) {
  const flag = r.covered ? "covered" : `${r.uncovered.length} uncovered`;
  console.log(`  ${String(r.scans).padStart(3)} scans  ${flag.padEnd(13)} ${r.rel}`);
  for (const u of r.uncovered.slice(0, 3)) console.log(`        ${u}`);
}
