#!/usr/bin/env node
// US-1879: run the browser-extension test suite in CI (wired into verify:web).
//
// The extensions ship unpacked / to the stores, so they have no framework test
// runner — their checks are zero-dependency node assertion scripts
// (extension-condition/test/*.test.cjs: the pure image/URL/config helpers and the
// bundled⇄hosted config sync guard). This runner discovers and runs them all so a
// broken adapter helper or a config drift fails the build like any other lane.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = resolve(root, "extension-condition", "test");

const files = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.cjs"))
  .sort();

if (files.length === 0) {
  console.error("test-extensions: no *.test.cjs found in extension-condition/test");
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [resolve(testDir, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}

if (failed) {
  console.error(`\ntest-extensions: ${failed} of ${files.length} test file(s) FAILED.`);
  process.exit(1);
}
console.log(`\ntest-extensions: all ${files.length} test file(s) passed.`);
