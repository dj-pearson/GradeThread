// Resolve the Android build toolchain WITHOUT Android Studio.
//
// Android Studio bundles a JDK, points Gradle at it, writes local.properties and
// hides all three. A checkout on a machine that has never opened Studio has none
// of that, and the failure it produces is famously unhelpful: AGP prints the raw
// java version string as the whole error message ("What went wrong: 25.0.2"),
// which names neither the JDK nor the fact that a JDK is the problem.
//
// Everything here is pure resolution + reporting. Nothing installs, nothing
// mutates outside the repo except writeLocalProperties(), which is called only
// from doctor.mjs --fix.
//
// Consumed by: android/scripts/doctor.mjs, scripts/verify.mjs (--android lane),
// android/scripts/device.mjs.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { resolvePython } from "../../scripts/lib/python.mjs";

export const androidDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = resolve(androidDir, "..");

const isWindows = platform() === "win32";
const exe = (name) => (isWindows ? `${name}.exe` : name);
const bat = (name) => (isWindows ? `${name}.bat` : name);

// Gradle 8.13 refuses to RUN on a JVM newer than 23, and AGP 8.9.2 needs 17+.
// CI and a local run must agree: a lane that passes on a JDK the CI runner does
// not have is a lane that reports on a build nobody ships.
//
// US-2891 moved the floor from 17 to 21, and the reason is worth keeping
// because nothing about it is obvious from either end of the chain. Play
// requires targetSdk 36 -> compileSdk 36 -> the Robolectric suite needs
// Robolectric's SDK 36 android-all jar -> that jar refuses to load on anything
// below Java 21: "Android SDK 36 requires Java 21 (have Java 17)". No part of
// the app's own code needs 21.
//
// So this is the JVM the BUILD runs on, not the bytecode it emits.
// sourceCompatibility, targetCompatibility and kotlinOptions.jvmTarget all stay
// at 17 in app/build.gradle.kts, deliberately: the shipped APK is unchanged by
// this, and minSdk 26 devices are unaffected. Do not "tidy" those three up to
// 21 to match - that would raise the floor on what the app can run on, which
// is a different decision entirely and not one this story made.
const JDK_MIN = 21;
const JDK_MAX = 23;
export const JDK_PREFERRED = 21;

// compileSdk in app/build.gradle.kts. Kept as a constant rather than parsed:
// the parse would be one more thing that can silently return undefined.
export const COMPILE_SDK = 36;

function javaMajor(javaHome) {
  const bin = join(javaHome, "bin", exe("java"));
  if (!existsSync(bin)) return null;
  const r = spawnSync(bin, ["-version"], { encoding: "utf8" });
  // `java -version` writes to stderr. A broken install (a half-deleted Studio
  // JBR, for instance) exits non-zero with no version at all, which is exactly
  // the state this machine was in when the lane was written.
  const out = `${r.stderr ?? ""}${r.stdout ?? ""}`;
  const m = out.match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const major = Number(m[1]);
  // 1.8.0_x style, still seen on older CI images.
  return major === 1 ? Number(m[2]) : major;
}

function globDirs(parent, test) {
  if (!existsSync(parent)) return [];
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory() && test(d.name))
      .map((d) => join(parent, d.name));
  } catch {
    return [];
  }
}

/**
 * Every JDK this machine could build with, best first.
 *
 * GRADETHREAD_ANDROID_JAVA_HOME wins outright so a machine with an unusual
 * layout has one thing to set, and so CI can pin without editing anything.
 */
function jdkCandidates() {
  const home = homedir();
  const out = [];
  const push = (p, source) => { if (p && existsSync(p)) out.push({ javaHome: p, source }); };

  push(process.env.GRADETHREAD_ANDROID_JAVA_HOME, "GRADETHREAD_ANDROID_JAVA_HOME");
  push(process.env.JAVA_HOME, "JAVA_HOME");

  // scoop, which is how CLAUDE.md tells this project's Windows machines to get
  // their toolchain.
  push(join(home, "scoop", "apps", "temurin21-jdk", "current"), "scoop temurin21-jdk");
  // 17 stays on the search path: it is below JDK_MIN so it can never be
  // CHOSEN, but finding it lets the doctor say "you have 17, you need 21"
  // instead of "no JDK at all", which are different problems.
  push(join(home, "scoop", "apps", "temurin17-jdk", "current"), "scoop temurin17-jdk");
  for (const d of globDirs(join(home, "scoop", "apps"), (n) => /^(temurin|openjdk|zulu)\d*-?jdk/.test(n))) {
    push(join(d, "current"), `scoop ${d.split(/[\\/]/).pop()}`);
  }

  // Where JetBrains Toolbox and Android Studio drop downloaded JDKs. Usually a
  // JBR 21, which Gradle 8.13 is happy with -- worth finding before falling
  // back to the bundled runtime, which is often too new.
  for (const d of globDirs(join(home, ".jdks"), () => true)) push(d, "~/.jdks");

  for (const parent of [
    "C:/Program Files/Eclipse Adoptium",
    "C:/Program Files/Java",
    "C:/Program Files/Microsoft",
    "C:/Program Files/Amazon Corretto",
    "/usr/lib/jvm",
    "/Library/Java/JavaVirtualMachines",
  ]) {
    for (const d of globDirs(parent, (n) => /jdk/i.test(n))) {
      // macOS nests the real home two levels down.
      push(existsSync(join(d, "Contents", "Home")) ? join(d, "Contents", "Home") : d, parent);
    }
  }

  // Android Studio's bundled runtime, LAST. It is usually far newer than Gradle
  // supports (this repo's host shipped JBR 25), and a second Studio install can
  // leave a gutted copy behind whose java.exe exists but cannot start.
  for (const p of [
    "C:/Program Files/Android/Android Studio/jbr",
    "C:/Program Files/Android/Android Studio1/jbr",
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
  ]) {
    push(p, "Android Studio JBR");
  }

  const seen = new Set();
  return out.filter((c) => {
    const key = resolve(c.javaHome).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * @returns {{ok: boolean, javaHome?: string, major?: number, source?: string,
 *            rejected: Array<{javaHome: string, source: string, why: string}>}}
 */
export function resolveJdk() {
  const rejected = [];
  const usable = [];
  for (const c of jdkCandidates()) {
    const major = javaMajor(c.javaHome);
    if (major === null) {
      rejected.push({ ...c, why: "no runnable java (broken or incomplete install)" });
    } else if (major < JDK_MIN) {
      // Names Robolectric, not AGP: AGP is happy on 17, and someone reading
      // "AGP needs 21" would go looking in the wrong place. See JDK_MIN.
      rejected.push({ ...c, why: `Java ${major}; Robolectric's SDK ${COMPILE_SDK} jar needs ${JDK_MIN}+` });
    } else if (major > JDK_MAX) {
      rejected.push({ ...c, why: `Java ${major}; Gradle 8.13 supports at most ${JDK_MAX}` });
    } else {
      usable.push({ ...c, major });
    }
  }
  if (!usable.length) return { ok: false, rejected };
  // Prefer the version CI runs; otherwise the lowest usable one, for the same
  // reason (closest to the build that actually ships).
  //
  // US-2891: this comparator used to be
  //   (a.major === JDK_PREFERRED ? -1 : b.major === JDK_PREFERRED ? 1 : a - b)
  // which returns -1 for BOTH orderings when two candidates share the preferred
  // major - an inconsistent comparator, so the winner was whatever the sort
  // happened to do. It never mattered while the machine had exactly one usable
  // JDK. The moment a second 21 appeared it silently picked Android Studio's
  // bundled JBR over the scoop install, which is the one source this project
  // has been bitten by before (Studio rewrites its own toolchain on open, and
  // did exactly that during US-2502).
  //
  // Ranking the preferred major as -1 and everything else as itself keeps the
  // comparator consistent, so equal ranks compare 0 and Array.sort's stability
  // preserves jdkCandidates() order - which already encodes the source
  // preference, with the Studio JBR deliberately last.
  const rank = (major) => (major === JDK_PREFERRED ? -1 : major);
  usable.sort((a, b) => rank(a.major) - rank(b.major));
  return { ok: true, ...usable[0], rejected };
}

function sdkCandidates() {
  const home = homedir();
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    readLocalProperties()?.["sdk.dir"],
    join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Android", "Sdk"),
    join(home, "Android", "Sdk"),
    join(home, "Library", "Android", "sdk"),
    "/usr/local/lib/android/sdk", // the GitHub ubuntu runner image
  ].filter((p) => p && existsSync(p));
}

export function readLocalProperties() {
  const f = join(androidDir, "local.properties");
  if (!existsSync(f)) return null;
  const out = {};
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)$/);
    // Java .properties escapes the Windows backslash; undo it so the value is a
    // real path again.
    if (m) out[m[1]] = m[2].trim().replace(/\\\\/g, "\\").replace(/\\:/g, ":");
  }
  return out;
}

/**
 * Is the file on disk written the way Android Lint demands?
 *
 * US-2602: lintDebug FAILS the whole Android lane on `PropertyEscape` when
 * `sdk.dir` carries an unescaped drive colon — "Windows file separators (\) and
 * drive letter separators (':') must be escaped". Android Studio writes the
 * unescaped form, so any machine set up through the IDE has a local.properties
 * that makes `npm run verify:android` red for a reason that has nothing to do
 * with the code being verified. CI never sees it: there is no local.properties
 * on a runner, where AGP reads ANDROID_HOME.
 *
 * Returns null when there is nothing to fix (no file, or already escaped), and
 * the offending raw line when there is.
 */
export function unescapedLocalPropertiesLine() {
  const f = join(androidDir, "local.properties");
  if (!existsSync(f)) return null;
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    if (!/^\s*sdk\.dir\s*=/.test(line)) continue;
    return unescapedPropertyValue(line.slice(line.indexOf("=") + 1)) ? line.trim() : null;
  }
  return null;
}

/**
 * Does this .properties VALUE contain a separator Lint would reject?
 *
 * Walked rather than matched with a lookbehind, because the escape character is
 * also one of the characters being escaped: in `C\:/Users`, the backslash is the
 * fix, not the problem, and a naive "a colon or backslash not preceded by a
 * backslash" test flags the very form Lint asks for. So: a backslash consumes
 * the next character and is fine when that character is `\` or `:`; anything
 * else after it is a lone separator, and a bare `:` is one too.
 */
export function unescapedPropertyValue(value) {
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\") {
      const next = value[i + 1];
      if (next === "\\" || next === ":") {
        i++;
        continue;
      }
      return true; // a backslash escaping something that is not a separator
    }
    if (c === ":") return true;
  }
  return false;
}

/**
 * The SDK, plus which of its pieces are present.
 *
 * `components` is reported rather than gated on, because the pieces are needed
 * by different lanes: a unit-test run needs the platform, an emulator run needs
 * emulator + a system image, and sdkmanager is only needed to install more.
 */
export function resolveSdk() {
  const dirs = sdkCandidates();
  if (!dirs.length) return { ok: false, components: {} };
  const sdkDir = dirs[0];
  const buildTools = globDirs(join(sdkDir, "build-tools"), () => true).map((d) => d.split(/[\\/]/).pop());
  const platforms = globDirs(join(sdkDir, "platforms"), () => true).map((d) => d.split(/[\\/]/).pop());
  const systemImages = globDirs(join(sdkDir, "system-images"), () => true).map((d) => d.split(/[\\/]/).pop());
  const components = {
    [`platforms/android-${COMPILE_SDK}`]: platforms.includes(`android-${COMPILE_SDK}`),
    "build-tools": buildTools.length > 0,
    "platform-tools (adb)": existsSync(join(sdkDir, "platform-tools", exe("adb"))),
    "cmdline-tools/latest (sdkmanager)": existsSync(
      join(sdkDir, "cmdline-tools", "latest", "bin", bat("sdkmanager")),
    ),
    emulator: existsSync(join(sdkDir, "emulator", exe("emulator"))),
    "system-images (for the emulator)": systemImages.length > 0,
  };
  return { ok: true, sdkDir, buildTools, platforms, systemImages, components };
}

/**
 * The interpreter for the four guard scripts in android/scripts/*.py.
 *
 * MOVED to scripts/lib/python.mjs and re-exported here: the iOS guards need the
 * same resolution, and reaching into the Android toolchain for it would have
 * made an unrelated lane depend on this file. Callers here are unchanged.
 */
// Imported as well as re-exported: `export … from` creates no local binding, and
// resolveToolchain() below calls it.
export { resolvePython };

export function adbPath(sdkDir) {
  return join(sdkDir, "platform-tools", exe("adb"));
}

/** Writes android/local.properties (gitignored). Returns the path. */
export function writeLocalProperties(sdkDir) {
  const f = join(androidDir, "local.properties");
  // A .properties file treats \ as an escape, so a raw Windows path silently
  // becomes a different path. Escape both the separator and the drive colon.
  const escaped = sdkDir.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  writeFileSync(
    f,
    [
      "# Generated by android/scripts/doctor.mjs --fix. Gitignored, machine-local.",
      "# Regenerate any time: node android/scripts/doctor.mjs --fix",
      `sdk.dir=${escaped}`,
      "",
    ].join("\n"),
  );
  return f;
}

/**
 * One call for everything a build needs, with the environment already assembled.
 * `env` is meant to be merged into process.env by the caller.
 */
export function resolveToolchain() {
  const jdk = resolveJdk();
  const sdk = resolveSdk();
  const python = resolvePython();
  const problems = [];
  if (!jdk.ok) problems.push(`No usable JDK (need ${JDK_MIN}-${JDK_MAX}).`);
  if (!sdk.ok) problems.push("No Android SDK found.");
  else if (!sdk.components[`platforms/android-${COMPILE_SDK}`]) {
    problems.push(`SDK platform android-${COMPILE_SDK} is not installed.`);
  }
  if (!python) problems.push("No Python 3 on PATH (the android/scripts/*.py guards need it).");
  return {
    ok: problems.length === 0,
    jdk,
    sdk,
    python,
    problems,
    env: {
      ...(jdk.ok ? { JAVA_HOME: jdk.javaHome } : {}),
      ...(sdk.ok ? { ANDROID_HOME: sdk.sdkDir, ANDROID_SDK_ROOT: sdk.sdkDir } : {}),
    },
  };
}
