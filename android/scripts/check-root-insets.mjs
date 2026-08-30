#!/usr/bin/env node
// US-2891: does every screen MainActivity composes DIRECTLY apply its own
// window insets?
//
// THE BUG THIS EXISTS TO CLOSE. API 36 makes edge-to-edge mandatory; the
// windowOptOutEdgeToEdgeEnforcement attribute that still worked at 35 is gone.
// Almost every screen in this app is safe by accident, because it sits inside
// AppShell's Material3 Scaffold and Scaffold applies the system-bar insets for
// free. The screens MainActivity composes directly have nothing above them.
// AuthScreen was one, and its headline drew straight over the status-bar clock
// on an API 36 emulator: present, readable-ish, and wrong on the FIRST screen
// anyone who installs the app ever sees.
//
// Nothing in the build can catch that. It compiles, it lints clean, it passes
// the unit suite, and the Roborazzi screenshots render at whatever inset the
// test host reports. It is only visible by looking at a running device, which
// is why it survived the whole targetSdk-36 story until someone did.
//
// So the guard is on the SHAPE rather than the pixels: a screen with no
// Scaffold above it must consume insets itself. Two halves, and the second
// matters more than the first:
//
//   1. every screen in ROOT_SCREENS applies insets, and
//   2. MainActivity's setContent block invokes NOTHING ELSE that looks like a
//      screen. Adding a third root screen fails here until it is listed, which
//      is the only way this check keeps working after today.
//
// Usage:
//   node android/scripts/check-root-insets.mjs
//   node android/scripts/check-root-insets.mjs --self-test

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const androidDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(androidDir, "app/src/main/java/com/gradethread/app");
const mainActivity = join(srcRoot, "MainActivity.kt");

/**
 * The screens MainActivity composes directly, and what a reader sees when the
 * insets go missing. Order matches the `when (authPhase)` arms.
 */
const ROOT_SCREENS = [
  ["LockScreen", "the lock icon and its message ride up under the status bar"],
  ["AuthScreen", "the 'Sign in' headline draws over the status-bar clock"],
  ["AppShell", "the whole shell loses its top and bottom inset at once"],
];

/**
 * Invocations inside setContent that are NOT screens, and so are exempt.
 * Anything capitalised in that block which is neither here nor in ROOT_SCREENS
 * is reported: it is either a new root screen (list it, after checking it) or a
 * new wrapper (list it here, and say why).
 */
const NOT_A_SCREEN = new Set([
  "GradeThreadTheme", // theme wrapper: provides colours, composes no layout
  "LaunchedEffect", // effect, draws nothing
  "AuthRepository", // the sealed Phase is matched on, not invoked
  "Unit", // the empty arm while the splash is up
  "SystemClock", // used for the splash-hold clock
  "WindowWidthSizeClass", // size-class comparison
  // US-3003: a Material 3 background + contentColor wrapper, not a screen.
  // It composes no layout of its own and passes its constraints straight
  // through, so it neither needs insets nor hides a screen that does - the
  // screens BELOW it are still checked individually by this guard. It is
  // there because setContent had no Surface, which left LocalContentColor
  // at Compose's default BLACK and made the sign-in headline invisible on a
  // dark-mode phone.
  "Surface",
]);

/** Any one of these means the composable has taken responsibility for insets. */
const INSET_MARKERS = [
  "safeDrawingPadding()",
  "systemBarsPadding()",
  "windowInsetsPadding(",
  "Scaffold(",
];

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".kt")) out.push(p);
  }
  return out;
}

/**
 * The body of `fun <name>(`, from the declaration to the matching close brace.
 * Brace counting rather than a regex, because these bodies are hundreds of
 * lines of nested lambdas and a lazy match would stop at the first `}`.
 */
function composableBody(source, name) {
  const decl = source.indexOf(`fun ${name}(`);
  if (decl === -1) return null;
  // Balance the PARAMETER list first. `fun AppShell(statusBar: @Composable () ->
  // Unit = {})` puts a default lambda before the body, so the first `{` after
  // the declaration opens and closes in the same breath and a naive counter
  // returns an empty body -- which reads as "this screen has no Scaffold" and
  // is how the first cut of this guard reported AppShell as broken.
  let i = source.indexOf("(", decl);
  let paren = 0;
  for (; i < source.length; i++) {
    if (source[i] === "(") paren++;
    else if (source[i] === ")") {
      paren--;
      if (paren === 0) break;
    }
  }
  const open = source.indexOf("{", i);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/** The `setContent { ... }` block of a MainActivity source. */
function setContentBlock(source) {
  const at = source.indexOf("setContent {");
  if (at === -1) return null;
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

function check(activitySource, files) {
  const problems = [];

  const block = setContentBlock(activitySource);
  if (!block) {
    problems.push("MainActivity has no setContent { } block - this guard is reading the wrong file");
    return problems;
  }

  // Half 1: each listed screen consumes insets somewhere in its own body.
  const known = new Set(ROOT_SCREENS.map(([n]) => n));
  for (const [name, symptom] of ROOT_SCREENS) {
    let body = null;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!src.includes(`fun ${name}(`)) continue;
      body = composableBody(src, name);
      if (body) break;
    }
    if (body === null) {
      problems.push(`${name}: listed as a root screen but no composable of that name was found`);
      continue;
    }
    if (!INSET_MARKERS.some((m) => body.includes(m))) {
      problems.push(
        `${name}: composed directly by MainActivity with no Scaffold above it, and applies no `
          + `window insets. At API 36 edge-to-edge is mandatory, so ${symptom}. `
          + `Add Modifier.safeDrawingPadding() to its root.`,
      );
    }
  }

  // Half 2: nothing new slipped into setContent unlisted.
  for (const m of block.matchAll(/(?:^|[^A-Za-z0-9_.])([A-Z][A-Za-z0-9_]*)\s*[({]/g)) {
    const name = m[1];
    if (known.has(name) || NOT_A_SCREEN.has(name)) continue;
    problems.push(
      `${name}: invoked inside MainActivity's setContent but is neither a listed root screen nor a `
        + `listed non-screen. If it is a screen, check its insets on an API 36 device and add it to `
        + `ROOT_SCREENS; if it is not, add it to NOT_A_SCREEN with the reason.`,
    );
  }

  return problems;
}

// ---------------------------------------------------------------------------

if (process.argv.includes("--self-test")) {
  // Mode 6 of "guards that do not guard": a check that passes because it never
  // matched anything. Each case below must FAIL for the stated reason, and the
  // clean case must pass, or the guard is decorative.
  const clean = {
    activity: `class MainActivity { fun onCreate() { setContent { GradeThreadTheme { AuthScreen() } } } }`,
    files: [`@Composable fun AuthScreen() { Column(Modifier.fillMaxSize().safeDrawingPadding()) { } }`],
  };
  const stripped = {
    activity: clean.activity,
    files: [`@Composable fun AuthScreen() { Column(Modifier.fillMaxSize()) { } }`],
  };
  // The shape that broke the first cut of this guard: a default lambda in the
  // PARAMETER list, so the first { after the declaration is not the body.
  const defaultLambda = {
    activity: clean.activity,
    files: [`@Composable fun AuthScreen(slot: @Composable () -> Unit = {}) { Scaffold( ) { } }`],
  };
  const smuggled = {
    activity: `class MainActivity { fun onCreate() { setContent { GradeThreadTheme { AuthScreen(); OnboardingScreen() } } } }`,
    files: clean.files,
  };

  const run = (c) => {
    const problems = [];
    const block = setContentBlock(c.activity);
    const known = new Set(["AuthScreen"]);
    for (const name of known) {
      const src = c.files.find((f) => f.includes(`fun ${name}(`));
      const body = src ? composableBody(src, name) : null;
      if (!body || !INSET_MARKERS.some((m) => body.includes(m))) problems.push(`${name}: no insets`);
    }
    for (const m of block.matchAll(/(?:^|[^A-Za-z0-9_.])([A-Z][A-Za-z0-9_]*)\s*[({]/g)) {
      if (!known.has(m[1]) && !NOT_A_SCREEN.has(m[1])) problems.push(`${m[1]}: unlisted`);
    }
    return problems;
  };

  const failures = [];
  if (run(clean).length) failures.push("clean fixture should pass, reported: " + run(clean).join("; "));
  if (!run(stripped).some((p) => p.includes("no insets"))) failures.push("a screen with the insets removed did not fail");
  if (!run(smuggled).some((p) => p.includes("unlisted"))) failures.push("an unlisted screen in setContent did not fail");
  if (run(defaultLambda).length) failures.push("a screen with a default-lambda parameter was misread as having no body, reported: " + run(defaultLambda).join("; "));

  if (failures.length) {
    console.error("check-root-insets self-test FAILED:");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }
  console.log("check-root-insets self-test ok (4 cases)");
  process.exit(0);
}

const files = walk(srcRoot).filter((f) => statSync(f).isFile());
const problems = check(readFileSync(mainActivity, "utf8"), files);

if (problems.length) {
  console.error("check-root-insets FAILED:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`check-root-insets ok (${ROOT_SCREENS.length} root screens consume window insets)`);
