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
// CI uses 17, so 17 is what a local run should prefer: a lane that passes on a
// JDK the CI runner does not have is a lane that reports on a build nobody
// ships.
const JDK_MIN = 17;
const JDK_MAX = 23;
export const JDK_PREFERRED = 17;

// compileSdk in app/build.gradle.kts. Kept as a constant rather than parsed:
// the parse would be one more thing that can silently return undefined.
export const COMPILE_SDK = 35;

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
      rejected.push({ ...c, why: `Java ${major}; AGP 8.9 needs ${JDK_MIN}+` });
    } else if (major > JDK_MAX) {
      rejected.push({ ...c, why: `Java ${major}; Gradle 8.13 supports at most ${JDK_MAX}` });
    } else {
      usable.push({ ...c, major });
    }
  }
  if (!usable.length) return { ok: false, rejected };
  // Prefer the version CI runs; otherwise the lowest usable one, for the same
  // reason (closest to the build that actually ships).
  usable.sort((a, b) =>
    (a.major === JDK_PREFERRED ? -1 : b.major === JDK_PREFERRED ? 1 : a.major - b.major));
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
