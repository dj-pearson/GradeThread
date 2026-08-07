#!/usr/bin/env node
// US-1884 (AC4) — CLI over scripts/lib/extension-overlay-css.cjs.
//
// Regenerates each extension's `overlay-css.js` from its authored `overlay.css`.
// The overlay mounts in a shadow root, which a document stylesheet cannot reach,
// so the sheet has to ship as a string the content script adopts itself. The
// rationale (and why this is generated rather than hand-pasted) lives in the lib.
//
// Usage:
//   node scripts/gen-extension-overlay-css.mjs           # write both files
//   node scripts/gen-extension-overlay-css.mjs --check   # exit 1 on drift

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TARGETS, drift, generate } = require("./lib/extension-overlay-css.cjs");

if (process.argv.includes("--check")) {
  const stale = drift();
  if (stale.length) {
    console.error(
      "gen-extension-overlay-css: stale generated file(s):\n  " +
        stale.join("\n  ") +
        "\nRun: node scripts/gen-extension-overlay-css.mjs",
    );
    process.exit(1);
  }
  console.log(`gen-extension-overlay-css: ${TARGETS.length} generated file(s) in sync.`);
} else {
  for (const out of generate()) console.log(`wrote ${out}`);
}
