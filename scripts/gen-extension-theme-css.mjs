#!/usr/bin/env node
// US-3055 — CLI over scripts/lib/theme-css.cjs.
//
//   node scripts/gen-extension-theme-css.mjs           # write popup-theme.css + compare-theme.css
//   node scripts/gen-extension-theme-css.mjs --check   # exit 1 on drift
//
// The overlay's forced-theme rules are appended by the overlay generator
// (scripts/gen-extension-overlay-css.mjs), since that sheet ships as a string.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TARGETS, drift, generate } = require("./lib/theme-css.cjs");

if (process.argv.includes("--check")) {
  const stale = drift();
  if (stale.length) {
    console.error("gen-extension-theme-css: stale generated file(s):\n  " + stale.join("\n  ") + "\nRun: node scripts/gen-extension-theme-css.mjs");
    process.exit(1);
  }
  console.log(`gen-extension-theme-css: ${TARGETS.length} generated file(s) in sync.`);
} else {
  for (const out of generate()) console.log(`wrote ${out}`);
}
