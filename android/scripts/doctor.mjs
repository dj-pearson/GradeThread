#!/usr/bin/env node
// Android toolchain doctor -- the thing Android Studio does silently on first
// open, made explicit and runnable.
//
//   node android/scripts/doctor.mjs          report only
//   node android/scripts/doctor.mjs --fix    also write android/local.properties
//
// Exits non-zero when the toolchain cannot build, so `npm run verify:android`
// can call it first and fail with a sentence a human can act on instead of
// AGP's bare version string.
//
// It never installs anything. Installing is a machine-level change with a real
// download behind it; this prints the exact command and stops.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

import {
  COMPILE_SDK,
  JDK_PREFERRED,
  androidDir,
  readLocalProperties,
  unescapedLocalPropertiesLine,
  resolveToolchain,
  writeLocalProperties,
} from "./toolchain.mjs";

const fix = process.argv.includes("--fix");
const isWindows = platform() === "win32";

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;
const line = (mark, label, detail) =>
  console.log(`  ${mark} ${label}${detail ? ` ${dim(detail)}` : ""}`);

const tc = resolveToolchain();
const fixes = [];

console.log(`\n${bold("Android toolchain")}  ${dim(androidDir)}\n`);

// ---------------------------------------------------------------- JDK
if (tc.jdk.ok) {
  line(ok("OK"), `JDK ${tc.jdk.major}`, `${tc.jdk.javaHome}  (${tc.jdk.source})`);
  if (tc.jdk.major !== JDK_PREFERRED) {
    console.log(
      `     ${warn("note")} CI builds on JDK ${JDK_PREFERRED}. This one works, but it is not the ` +
        "toolchain that produces the shipped artifact.",
    );
  }
} else {
  line(bad("MISSING"), "JDK", `need ${JDK_PREFERRED} (21-23 accepted)`);
  fixes.push(
    isWindows
      ? "scoop bucket add java && scoop install temurin21-jdk"
      : "install a Temurin 21 JDK (brew install --cask temurin@21, or your distro's temurin-21-jdk)",
  );
}
// Rejected candidates are printed because "no JDK" is almost never true -- the
// usual state is several JDKs, all wrong, and the reason each one was passed
// over is the actual answer.
for (const r of tc.jdk.rejected) {
  if (tc.jdk.ok && r.javaHome === tc.jdk.javaHome) continue;
  line(dim("--"), dim(`skipped ${r.source}`), `${r.why}`);
}

// ---------------------------------------------------------------- SDK
if (tc.sdk.ok) {
  line(ok("OK"), "Android SDK", tc.sdk.sdkDir);
  for (const [name, present] of Object.entries(tc.sdk.components)) {
    line(present ? ok("OK") : warn("--"), `  ${name}`);
  }
  if (!tc.sdk.components[`platforms/android-${COMPILE_SDK}`]) {
    fixes.push(`sdkmanager "platforms;android-${COMPILE_SDK}" "build-tools;${COMPILE_SDK}.0.0"`);
  }
  if (!tc.sdk.components.emulator || !tc.sdk.components["system-images (for the emulator)"]) {
    console.log(
      `     ${dim("the emulator pieces are only needed for instrumented tests; " +
        // US-2891: this named avd.mjs, which has never existed. The doctor is
        // the one script someone runs when nothing works, so a command that
        // fails with "cannot find module" is worse than no suggestion at all.
        "`node android/scripts/device.mjs avd create` installs them")}`,
    );
  }
} else {
  line(bad("MISSING"), "Android SDK", "set ANDROID_HOME, or install the commandline tools");
  fixes.push(
    "download commandlinetools from developer.android.com/studio#command-line-tools-only, " +
      "unzip to <sdk>/cmdline-tools/latest, then set ANDROID_HOME",
  );
}

// ---------------------------------------------------------------- Python
if (tc.python) {
  line(ok("OK"), `Python 3 (${tc.python})`, "runs the source guards in android/scripts/*.py");
} else {
  line(bad("MISSING"), "Python 3", "no-ungated-log / no-bare-strings / string-format guards");
  fixes.push(isWindows ? "scoop install python" : "install python3");
}

// ---------------------------------------------------------------- local.properties
const lp = readLocalProperties();
const lpPath = join(androidDir, "local.properties");
const unescaped = unescapedLocalPropertiesLine();
if (lp?.["sdk.dir"] && existsSync(lp["sdk.dir"]) && unescaped && fix) {
  // US-2602: the path resolves, so the old check called it OK — and lintDebug
  // failed the whole lane on PropertyEscape. Android Studio writes the
  // unescaped form, so the machine most likely to have this is the one that
  // opened the project in the IDE first. Rewrite it rather than report it: the
  // value is unchanged, only its spelling.
  writeLocalProperties(lp["sdk.dir"]);
  line(ok("FIXED"), "local.properties", `escaped for Android Lint (was: ${unescaped})`);
} else if (lp?.["sdk.dir"] && existsSync(lp["sdk.dir"]) && unescaped) {
  line(
    warn("--"),
    "local.properties",
    "sdk.dir has an unescaped ':' — Android Lint fails the build on this " +
      "(PropertyEscape). Re-run with --fix.",
  );
} else if (lp?.["sdk.dir"] && existsSync(lp["sdk.dir"])) {
  line(ok("OK"), "local.properties", `sdk.dir=${lp["sdk.dir"]}`);
} else if (tc.sdk.ok && fix) {
  writeLocalProperties(tc.sdk.sdkDir);
  line(ok("WROTE"), "local.properties", lpPath);
} else if (tc.sdk.ok) {
  // Not fatal: AGP falls back to ANDROID_HOME. It is still worth having,
  // because ANDROID_HOME is per-shell and local.properties is per-checkout.
  line(warn("--"), "local.properties", "absent (ANDROID_HOME covers it) -- write with --fix");
} else {
  line(bad("--"), "local.properties", "absent, and no SDK to point it at");
}

// ---------------------------------------------------------------- wrapper
const wrapper = join(androidDir, isWindows ? "gradlew.bat" : "gradlew");
line(existsSync(wrapper) ? ok("OK") : bad("MISSING"), "Gradle wrapper", wrapper);

// ---------------------------------------------------------------- verdict
if (tc.ok) {
  // One real invocation, so the report is evidence rather than a file-existence
  // survey. `-v` is the cheapest task that still starts the JVM Gradle will use.
  const r = spawnSync(wrapper, ["-v"], {
    cwd: androidDir,
    encoding: "utf8",
    env: { ...process.env, ...tc.env },
    shell: isWindows,
  });
  const jvm = (r.stdout ?? "").match(/Launcher JVM:\s+(.+)/)?.[1]?.trim();
  if (r.status === 0) line(ok("OK"), "gradlew -v", jvm ? `Launcher JVM ${jvm}` : "");
  else {
    line(bad("FAIL"), "gradlew -v", "the wrapper could not start");
    console.log(r.stdout ?? "", r.stderr ?? "");
    process.exit(1);
  }
  console.log(`\n${ok(bold("Toolchain is ready."))}  Next: ${bold("npm run verify:android")}\n`);
  process.exit(0);
}

console.log(`\n${bad(bold("Toolchain cannot build."))}`);
for (const p of tc.problems) console.log(`  ${bad("x")} ${p}`);
if (fixes.length) {
  console.log(`\n${bold("Run:")}`);
  for (const f of fixes) console.log(`  $ ${f}`);
  console.log(`\nThen re-run: ${bold("node android/scripts/doctor.mjs --fix")}\n`);
}
process.exit(1);
