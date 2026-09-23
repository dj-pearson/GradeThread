#!/usr/bin/env node
// Rewrite the install block of sdk/gradethread-js/README.md from
// src/lib/sdk-release.ts (SDK_PUBLISHED). Run it after flipping the flag.
//
//   node scripts/sync-sdk-readme.mjs          write the README
//   node scripts/sync-sdk-readme.mjs --check  exit 1 if it is out of date
//
// Needs Node 22.18+ (type stripping on by default) to import the .ts module.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_PUBLISHED, withSdkReadmeInstallBlock } from "../src/lib/sdk-release.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = resolve(root, "sdk/gradethread-js/README.md");
const before = readFileSync(readmePath, "utf8");
const after = withSdkReadmeInstallBlock(before, SDK_PUBLISHED);

if (process.argv.includes("--check")) {
  if (before !== after) {
    console.error(`README install block does not match SDK_PUBLISHED=${SDK_PUBLISHED}. Run: node scripts/sync-sdk-readme.mjs`);
    process.exit(1);
  }
  console.log(`README install block matches SDK_PUBLISHED=${SDK_PUBLISHED}`);
} else if (before === after) {
  console.log(`README already matches SDK_PUBLISHED=${SDK_PUBLISHED}`);
} else {
  writeFileSync(readmePath, after);
  console.log(`README install block rewritten for SDK_PUBLISHED=${SDK_PUBLISHED}`);
}
