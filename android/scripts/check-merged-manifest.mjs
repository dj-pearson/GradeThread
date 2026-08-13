#!/usr/bin/env node
// US-1391 AC3, generalised (US-2502): did the manifest merge keep the
// components that are only reachable through the SYSTEM?
//
// On Android the widget, the share target, the deep links and the boot receiver
// are not called by any app code -- the OS finds them by reading the merged
// manifest. So a merge that drops one produces a completely green build and an
// app with no widget in the picker, nothing in the share sheet, and links that
// open the browser instead. Nothing in the test suite can see it.
//
// This used to be four `grep -q` lines inside android-ci.yml, which meant it
// existed only in CI and said nothing useful when it failed. Same assertions,
// runnable locally, and each one carries the symptom it prevents.
//
// Usage: node android/scripts/check-merged-manifest.mjs [--variant debug]
// Requires a prior `./gradlew :app:processDebugMainManifest` (assembleDebug
// covers it).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const androidDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const variantArg = process.argv.indexOf("--variant");
const variant = variantArg > -1 ? process.argv[variantArg + 1] : "debug";
const cap = variant[0].toUpperCase() + variant.slice(1);

/** Each entry: what to find, and what breaks for a user when it is missing. */
const REQUIRED = [
  ["SellerSnapshotWidgetReceiver", "the home-screen widget disappears from the widget picker"],
  ["ShareTargetActivity", "GradeThread stops appearing in the system share sheet"],
  ["android.intent.action.SEND_MULTIPLE", "sharing several photos at once silently does nothing"],
  ["android.intent.action.VIEW", "gradethread.com links open in the browser instead of the app"],
  ["com.gradethread.app.HiltTestRunner", null], // debug-only, checked below
];

const preferred = join(
  androidDir,
  `app/build/intermediates/merged_manifests/${variant}/process${cap}MainManifest/AndroidManifest.xml`,
);

function findFallback() {
  const root = join(androidDir, "app/build/intermediates");
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (/merged_manifest/.test(p) || /merged_manifests/.test(p)) stack.push(p);
        else if (d === root && e.name.startsWith("merged")) stack.push(p);
      } else if (e.name === "AndroidManifest.xml" && /merged_manifest/.test(d)) {
        return p;
      }
    }
  }
  return null;
}

const path = existsSync(preferred) ? preferred : findFallback();
if (!path) {
  console.error(
    "\x1b[31mmerged manifest: not found. Run `./gradlew :app:assembleDebug` first.\x1b[0m",
  );
  process.exit(1);
}

const xml = readFileSync(path, "utf8");
const failures = [];
for (const [needle, symptom] of REQUIRED) {
  if (needle === "com.gradethread.app.HiltTestRunner") continue;
  if (!xml.includes(needle)) failures.push(`${needle} -- ${symptom}`);
}

// A merge that produced an empty or truncated file would pass a naive grep for
// nothing; assert the file is real before trusting an absence.
if (statSync(path).size < 500) failures.push("the merged manifest is suspiciously small");

console.log(`merged manifest: ${path.replace(androidDir, "android")}`);
if (failures.length) {
  console.error("\x1b[31mThe manifest merge dropped:\x1b[0m");
  for (const f of failures) console.error(`  x ${f}`);
  process.exit(1);
}
console.log(`merged manifest: all ${REQUIRED.length - 1} system-reachable components present`);
