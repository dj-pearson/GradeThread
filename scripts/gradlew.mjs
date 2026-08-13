#!/usr/bin/env node
// US-2502: run a Gradle task in android/ with the toolchain already resolved.
//
//   node scripts/gradlew.mjs :app:testDebugUnitTest
//   node scripts/gradlew.mjs :app:spotlessApply --stacktrace
//
// This exists because `cd android && ./gradlew <task>` picks up whatever `java`
// is first on PATH. On the machine this was written for that was a half-deleted
// Android Studio JBR, and before that a JBR 25 that Gradle 8.13 refuses to run
// on -- and AGP reports the second case as `What went wrong: 25.0.2`, which
// names neither the JDK nor the fact that a JDK is the problem.
//
// Wrapping it means every `npm run android:*` script gets the same JDK the
// verify lane and CI use, and a missing toolchain produces the doctor's
// sentence instead of Gradle's.

import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";

import { androidDir, resolveToolchain } from "../android/scripts/toolchain.mjs";

const tc = resolveToolchain();
if (!tc.ok) {
  console.error("\x1b[31mAndroid toolchain is not ready:\x1b[0m");
  for (const p of tc.problems) console.error(`  x ${p}`);
  console.error("\nRun: \x1b[1mnpm run android:doctor\x1b[0m");
  process.exit(1);
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: node scripts/gradlew.mjs <task> [gradle args]");
  process.exit(1);
}

const isWindows = platform() === "win32";
const gw = join(androidDir, isWindows ? "gradlew.bat" : "gradlew");

const r = spawnSync(gw, args, {
  cwd: androidDir,
  stdio: "inherit",
  env: { ...process.env, ...tc.env },
  shell: isWindows,
});
process.exit(r.status ?? 1);
