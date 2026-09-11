#!/usr/bin/env node
// US-3311: the two things about the Android screenshot suite that a text scan
// can settle in a second, and that otherwise cost a CI shard twenty minutes or
// nothing at all.
//
// BACKGROUND, because neither rule reads as urgent without it. On 2026-09-10
// thirteen of the 395 Roborazzi goldens were 93 percent of a 246-test-minute
// suite AND all thirteen failed, and the two facts were the same fact.
// `captureRoboImage` renders and then drains the Robolectric looper until the
// composition goes idle; Material 3's indeterminate CircularProgressIndicator
// and LinearProgressIndicator hold a `rememberInfiniteTransition` that asks for
// another frame forever, so the capture spun a core for 820 to 1202 seconds and
// then photographed the spinner at whatever angle it stopped on. US-3311 froze
// the indicator (BusySpinner / BusyBar reading LocalProgressAnimation) and the
// suite went to 2m26s with 0 red.
//
// RULE 1 IS THE HALF THE KOTLIN GUARD CANNOT SEE. BusyIndicatorUsageTest bans
// two COMPONENT NAMES. The mechanism is `rememberInfiniteTransition`, and it is
// available to anything: a shimmer, a pulsing dot, a blinking caret. A screen
// that grows one reproduces the twenty-minute hang exactly, and that guard stays
// green because no progress indicator is involved. So this one bans the
// MECHANISM in app code and makes every exception carry a checked reason.
//
// RULE 2 IS THE CHEAPEST ASSERTION IN THE SUITE AND NOTHING MADE IT. A golden
// no test names is a PNG that can never fail: delete the test and the file stays
// in the tree asserting nothing, at a few hundred KB a time. A name no golden
// backs is the inverse - `verifyRoborazziDebug` has nothing to compare, so the
// first run writes it and passes. Both are invisible to Gradle, to detekt and
// to review.
//
// NEITHER RULE RENDERS ANYTHING. What a render would tell you - whether a
// golden still matches its screen - is not decidable from the files, and this
// script deliberately does not guess at it. A commit-order heuristic (golden
// older than the screen it covers) was measured on this tree on 2026-09-11 and
// called 252 of 395 stale the day after the suite went green, because the fix
// touched 26 screen files and only 47 goldens changed pixels. That is a guard
// that fires at correct code, so it is not here.
//
//   node scripts/check-screenshot-goldens.mjs
//   node scripts/check-screenshot-goldens.mjs --list        # print, never fail
//   node scripts/check-screenshot-goldens.mjs --self-test   # prove it detects

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = join(ROOT, "android/app/src/main/java/com/gradethread/app");
const TESTS = join(ROOT, "android/app/src/test/java/com/gradethread/app/ui");
const GOLDENS = join(ROOT, "android/app/src/test/screenshots");
const rel = (f) => relative(ROOT, f).split(sep).join("/");

// The mechanism, not the component. Both spellings, because either one alone
// keeps a composition non-idle forever.
const INFINITE = /\b(rememberInfiniteTransition|infiniteRepeatable)\s*\(/;

/**
 * App files allowed to hold an infinite animation, and the reason each is
 * allowed to.
 *
 * THE REASON IS CHECKED, NOT TAKEN ON TRUST. `unreachableSymbols` names the
 * chain that makes the excuse true; if any main file outside `declaredIn`
 * mentions one of them, the animation has become reachable from a screen and
 * the entry fails with the file that wired it. An excuse nobody can re-verify
 * is how a golden of a spinner sat in the tree for eleven days.
 *
 * Shrink-only: an entry whose file no longer holds an infinite animation also
 * fails, so a fix takes its excuse out with it.
 */
const ALLOWED_INFINITE = {
  "android/app/src/main/java/com/gradethread/app/ui/components/Skeleton.kt": {
    why:
      "SkeletonShape runs a shimmer sweep unless rememberReducedMotion() is " +
      "true, and under Robolectric it is false: ANIMATOR_DURATION_SCALE is " +
      "unset, so the read falls back to its 1f default. A capture that reaches " +
      "this hangs exactly the way the thirteen spinner goldens did. It does " +
      "not hang today only because nothing on any screen reaches it - the one " +
      "caller of SkeletonBlock/SkeletonCircle is CachedThumbnail, and " +
      "CachedThumbnail is itself called by nothing but its own @Preview. " +
      "Wiring CachedThumbnail into a screen is the moment this becomes the " +
      "same defect again, so that is what the next two fields check. The fix " +
      "when it comes is one line, the same one BusySpinner took: read " +
      "LocalProgressAnimation and skip the transition when it is false.",
    declaredIn: [
      "android/app/src/main/java/com/gradethread/app/ui/components/Skeleton.kt",
      "android/app/src/main/java/com/gradethread/app/ui/components/CachedThumbnail.kt",
    ],
    unreachableSymbols: ["SkeletonBlock", "SkeletonCircle", "CachedThumbnail"],
  },
};

// CRLF FIRST. Without the newline normalisation `//.*$` cannot reach the end of
// a CRLF line and the whole strip is a no-op on a Windows checkout, which is
// how check-ios-orphans.mjs passed here and failed in CI for thirty-two
// commits (US-2794).
function strip(src) {
  return src
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

function walkKt(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "build" || entry === ".gradle") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkKt(p, out);
    else if (entry.endsWith(".kt")) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 1: no unfreezable animation in app code.
// ---------------------------------------------------------------------------

/** @param {Map<string,string>} sources path -> comment-stripped Kotlin */
export function infiniteAnimationProblems(sources, allowed = ALLOWED_INFINITE) {
  const problems = [];
  const holders = [...sources.entries()]
    .filter(([, src]) => INFINITE.test(src))
    .map(([path]) => path);

  for (const path of holders) {
    if (!allowed[path]) {
      problems.push(
        `${path} holds an infinite animation. A composition holding one never ` +
          `goes idle, so captureRoboImage spins a core until the shard is ` +
          `killed and then photographs a frame nobody chose. Gate it on ` +
          `LocalProgressAnimation the way BusySpinner does, or add an entry to ` +
          `ALLOWED_INFINITE in ${rel(fileURLToPath(import.meta.url))} naming ` +
          `the symbols that keep it unreachable.`,
      );
    }
  }

  for (const [path, entry] of Object.entries(allowed)) {
    if (!holders.includes(path)) {
      problems.push(
        `ALLOWED_INFINITE lists ${path}, which no longer holds an infinite ` +
          `animation. Delete the entry; the list only shrinks.`,
      );
      continue;
    }
    const declaredIn = new Set(entry.declaredIn);
    for (const [other, src] of sources) {
      if (declaredIn.has(other)) continue;
      for (const symbol of entry.unreachableSymbols) {
        if (new RegExp(`\\b${symbol}\\s*\\(`).test(src)) {
          problems.push(
            `${other} now calls ${symbol}, so the infinite animation in ${path} ` +
              `is reachable from app code. That is the excuse in ` +
              `ALLOWED_INFINITE expiring, not a lint nit: every golden of a ` +
              `screen that reaches it will hang its capture. Freeze it on ` +
              `LocalProgressAnimation before wiring it up.`,
          );
        }
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Rule 2: the golden directory and the screenshot tests name the same set.
// ---------------------------------------------------------------------------

const CAPTURE_PATH = 'captureRoboImage("src/test/screenshots/$name.png")';

/**
 * Golden names a test file declares, or a reason the names cannot be read.
 *
 * EVERY SHAPE IS PINNED, and that is deliberate rather than lazy. All 55
 * classes route through one `private fun capture(name: String, ...)` helper
 * whose body is the single line above. A file that captures some other way is
 * not an error in itself - it is this scan going blind, and a scan that goes
 * blind reports a clean tree. So an unrecognised shape FAILS instead of
 * returning nothing (mode 6 in the guards-that-do-not-guard notes).
 */
export function goldenNamesIn(fileLabel, rawSrc) {
  const src = strip(rawSrc);
  const problems = [];
  const roboCalls = (src.match(/captureRoboImage\s*\(/g) ?? []).length;
  if (roboCalls !== 1 || !src.replace(/\s+/g, "").includes(CAPTURE_PATH.replace(/\s+/g, ""))) {
    problems.push(
      `${fileLabel} does not capture through the one shape this scan can read ` +
        `(${CAPTURE_PATH}, called once, from a private capture(name: String) ` +
        `helper). Its golden names cannot be checked, so it is reported rather ` +
        `than skipped.`,
    );
    return { names: [], problems };
  }
  const body = src.replace(/fun\s+capture\s*\(/g, "fun CAPTURE_DECL(");
  const callSites = (body.match(/\bcapture\s*\(/g) ?? []).length;
  const named = [...body.matchAll(/\bcapture\s*\(\s*"([a-z0-9][a-z0-9-]*)"/g)].map((m) => m[1]);
  if (callSites !== named.length) {
    problems.push(
      `${fileLabel} has ${callSites} capture() call(s) but ${named.length} with ` +
        `a plain golden name. A name built at runtime cannot be matched against ` +
        `the directory, so this is reported rather than skipped.`,
    );
  }
  return { names: named, problems };
}

export function goldenSetProblems(testSources, pngNames) {
  const problems = [];
  const named = new Map();
  for (const [label, src] of testSources) {
    const { names, problems: p } = goldenNamesIn(label, src);
    problems.push(...p);
    for (const n of names) {
      if (!named.has(n)) named.set(n, []);
      named.get(n).push(label);
    }
  }
  const onDisk = new Set(pngNames);
  for (const n of [...onDisk].sort()) {
    if (!named.has(n)) {
      problems.push(
        `${n}.png is in the golden directory and no screenshot test names it. ` +
          `Nothing compares it, so it can never fail. Delete it, or restore the ` +
          `test that lost it.`,
      );
    }
  }
  for (const [n, where] of [...named.entries()].sort()) {
    if (!onDisk.has(n)) {
      problems.push(
        `${where.join(", ")} captures "${n}" and no ${n}.png is committed. ` +
          `verifyRoborazziDebug has nothing to compare, so the first run writes ` +
          `it and passes. Record and commit the golden.`,
      );
    }
    if (where.length > 1) {
      problems.push(
        `"${n}" is captured by ${where.join(" and ")}. Two tests writing one ` +
          `golden means whichever runs last decides what the other asserts.`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Self-test: each rule has to still fire on an offence.
// ---------------------------------------------------------------------------

export function selfCheckProblems() {
  const fails = [];
  const check = (label, ok) => {
    if (!ok) fails.push(label);
  };

  const skel = "android/app/src/main/java/com/gradethread/app/ui/components/Skeleton.kt";
  const thumb = "android/app/src/main/java/com/gradethread/app/ui/components/CachedThumbnail.kt";
  const fixtureAllowed = {
    [skel]: {
      why: "fixture",
      declaredIn: [skel, thumb],
      unreachableSymbols: ["SkeletonBlock", "CachedThumbnail"],
    },
  };
  const clean = new Map([
    [skel, "val t = rememberInfiniteTransition(label = \"x\")\nfun SkeletonBlock() {}"],
    [thumb, "fun CachedThumbnail() { SkeletonBlock() }"],
    ["android/app/src/main/java/com/gradethread/app/home/HomeScreen.kt", "fun Home() {}"],
  ]);
  check("rule 1 is quiet on the allowed, unreachable case", infiniteAnimationProblems(clean, fixtureAllowed).length === 0);

  const wired = new Map(clean);
  wired.set("android/app/src/main/java/com/gradethread/app/home/HomeScreen.kt", "fun Home() { CachedThumbnail() }");
  check("rule 1 fires when the excuse is wired up", infiniteAnimationProblems(wired, fixtureAllowed).length === 1);

  const newHolder = new Map(clean);
  newHolder.set(
    "android/app/src/main/java/com/gradethread/app/home/HomeScreen.kt",
    "fun Dot() { val t = rememberInfiniteTransition(label = \"dot\") }",
  );
  check("rule 1 fires on a new infinite animation", infiniteAnimationProblems(newHolder, fixtureAllowed).length === 1);

  const otherSpelling = new Map(clean);
  otherSpelling.set(
    "android/app/src/main/java/com/gradethread/app/home/HomeScreen.kt",
    "val spec = infiniteRepeatable(animation = tween(900))",
  );
  check("rule 1 fires on infiniteRepeatable too", infiniteAnimationProblems(otherSpelling, fixtureAllowed).length === 1);

  const fixed = new Map(clean);
  fixed.set(skel, "fun SkeletonBlock() {}");
  check("rule 1 fires on an entry that no longer matches", infiniteAnimationProblems(fixed, fixtureAllowed).length === 1);

  // The corpus reaches rule 1 already stripped, so the CRLF case exercises the
  // stripper on the path main() uses. Without the newline normalisation the
  // comment survives, prose counts as code, and the rule fires on a file that
  // only TALKS about the mechanism - the false-positive direction, which is the
  // expensive one, because the message accuses you of the thing it exists for.
  const commentOnly = new Map(clean);
  commentOnly.set(
    "android/app/src/main/java/com/gradethread/app/home/HomeScreen.kt",
    strip("// used to call rememberInfiniteTransition(label = \"x\")\r\n/* and infiniteRepeatable( */\r\nfun Home() {}"),
  );
  check(
    "rule 1 does not fire on a CRLF comment that names the mechanism",
    infiniteAnimationProblems(commentOnly, fixtureAllowed).length === 0,
  );

  const goodTest = [
    "class FooScreenshotTest {",
    '  @Test fun light() = capture("screen-foo-light") { Foo() }',
    "  @Test fun dark() = capture(",
    '    "screen-foo-dark",',
    "    dark = true,",
    "  ) { Foo() }",
    "  private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {",
    '    captureRoboImage("src/test/screenshots/$name.png") { ScreenshotTheme(dark) { content() } }',
    "  }",
    "}",
  ].join("\n");
  check(
    "rule 2 reads both the one-line and the wrapped call shape",
    goldenNamesIn("Foo.kt", goodTest).names.join(",") === "screen-foo-light,screen-foo-dark",
  );
  check(
    "rule 2 is quiet when the directory matches",
    goldenSetProblems([["Foo.kt", goodTest]], ["screen-foo-light", "screen-foo-dark"]).length === 0,
  );
  check(
    "rule 2 fires on a golden no test names",
    goldenSetProblems([["Foo.kt", goodTest]], ["screen-foo-light", "screen-foo-dark", "screen-gone-light"]).length === 1,
  );
  check(
    "rule 2 fires on a name with no golden",
    goldenSetProblems([["Foo.kt", goodTest]], ["screen-foo-light"]).length === 1,
  );
  check(
    "rule 2 fires when two tests write one golden",
    goldenSetProblems(
      [
        ["Foo.kt", goodTest],
        ["Bar.kt", goodTest.replace("FooScreenshotTest", "BarScreenshotTest")],
      ],
      ["screen-foo-light", "screen-foo-dark"],
    ).length === 2,
  );
  check(
    "rule 2 fires rather than going quiet on a shape it cannot read",
    goldenNamesIn("Odd.kt", 'captureRoboImage("src/test/screenshots/screen-odd-light.png") { Odd() }').problems
      .length === 1,
  );
  check(
    "rule 2 fires on a golden name built at runtime",
    goldenNamesIn("Odd.kt", goodTest.replace('capture("screen-foo-light")', "capture(nameFor(variant))")).problems
      .length === 1,
  );

  return fails;
}

/** The number of detection cases above, so a silently shrunk self-test shows. */
export const SELF_CHECK_CASES = 13;

// ---------------------------------------------------------------------------

/**
 * Scan the real tree. Returns counts alongside the findings, because a run that
 * read nothing produces the same empty findings list as a clean one.
 */
export function run() {
  if (!existsSync(MAIN) || !existsSync(TESTS) || !existsSync(GOLDENS)) {
    return { skipped: true, mainSources: 0, tests: 0, goldens: 0, problems: [] };
  }

  const mainSources = new Map(walkKt(MAIN).map((f) => [rel(f), strip(readFileSync(f, "utf8"))]));
  const testFiles = readdirSync(TESTS).filter((f) => f.endsWith("ScreenshotTest.kt"));
  const testSources = testFiles.map((f) => [
    `android/app/src/test/java/com/gradethread/app/ui/${f}`,
    readFileSync(join(TESTS, f), "utf8"),
  ]);
  const pngNames = readdirSync(GOLDENS)
    .filter((f) => f.endsWith(".png"))
    .map((f) => f.replace(/\.png$/, ""));

  return {
    skipped: false,
    mainSources: mainSources.size,
    tests: testSources.length,
    goldens: pngNames.length,
    problems: [
      ...infiniteAnimationProblems(mainSources),
      ...goldenSetProblems(testSources, pngNames),
    ],
  };
}

function main() {
  if (process.argv.includes("--self-test")) {
    const fails = selfCheckProblems();
    if (fails.length) {
      console.error("\n[screenshot-goldens] SELF-TEST FAILED - the scan no longer detects:\n");
      for (const f of fails) console.error(`    ${f}`);
      console.error("\n  A rule that has stopped detecting reports a clean tree.\n");
      process.exit(1);
    }
    console.log(`[screenshot-goldens] self-test OK  ${SELF_CHECK_CASES} detection case(s)`);
    return;
  }

  const { skipped, mainSources, tests, goldens, problems } = run();
  if (skipped) {
    console.log("[screenshot-goldens] no android/ screenshot tree - skipped.");
    return;
  }

  // A walk that found nothing reads exactly like a clean tree. The floors sit
  // well under today's numbers (478 sources, 55 tests, 395 goldens on
  // 2026-09-11) and well over zero.
  const scale = [];
  if (mainSources < 200) scale.push(`only ${mainSources} app sources were read; the walk broke`);
  if (tests < 40) scale.push(`only ${tests} screenshot tests were found; the directory or the suffix moved`);
  if (goldens < 200) scale.push(`only ${goldens} goldens were found; the directory moved`);
  const all = [...scale, ...problems];

  if (process.argv.includes("--list")) {
    console.log(`\n${mainSources} app sources, ${tests} screenshot tests, ${goldens} goldens\n`);
    for (const p of all) console.log(`  - ${p}`);
    if (!all.length) console.log("  (no findings)");
    return;
  }

  if (all.length === 0) {
    console.log(
      `[screenshot-goldens] OK  ${goldens} golden(s) all named by ${tests} test(s); ` +
        `${Object.keys(ALLOWED_INFINITE).length} allowed infinite animation, still unreachable.`,
    );
    return;
  }

  console.error("\n[screenshot-goldens] findings:\n");
  for (const p of all) console.error(`    ${p}\n`);
  process.exit(1);
}

// fileURLToPath, not string surgery: `file://${argv[1]}` differs from
// import.meta.url on Windows, so a naive compare never runs main().
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
