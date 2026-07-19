#!/usr/bin/env node
// US-2089 triage: DB/durable-jobs + web auth/client-security slices.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const NOTE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "vault",
  "90-archive",
  "code-review-2026-07-04.md",
);

const CLOSURES = [
  [
    "**Ten eBay endpoints 401 unconditionally",
    "✅ **CLOSED** by US-1623: the missing paths (incl. `analytics/*`) are in the per-path auth whitelist and also carry `workspaceMiddleware`. US-2014 later added `ebay-auth-coverage_test.ts`, which fails the build if any eBay route is neither auth-covered nor listed as self-authenticating with its mechanism NAMED — so this specific class cannot silently return.",
  ],
  [
    "`ebay-publish-due`, `promoted-sync`, `leave-feedback`, `sync/performance` crons are invisible to the `cron_runs` ledger",
    "✅ **CLOSED**: all are registered in `CRON_REGISTRY` with `recorded: true`, so they appear in the ledger and are covered by the stall detector (US-2004, whose AC3 test now asserts by name that the money/compliance crons are monitored).",
  ],
  [
    "New measure routes (`flipdesk-measure.ts:668,686`) have no `tenant-isolation_test.ts` cases",
    "✅ **CLOSED**: `tenant-isolation_test.ts` now carries measure cases. (Note the broader coverage question — cases that SKIP for want of a seeded fixture — is tracked separately by US-2039 and US-2078, which is a different failure than having no case at all.)",
  ],
  [
    "**Auth `token_hash` / recovery tokens ride in the URL query string",
    "✅ **CLOSED** by US-1635: `auth-confirm.tsx` scrubs the single-use `token_hash` from the visible URL via `history.replaceState` once React has read it, so it never reaches an analytics page-view.",
  ],
  [
    "**Financial PDF export HTML-injects unescaped cells",
    "✅ **CLOSED** by US-1635 (every cell now goes through the shared `escapeHtml`, not just `itemTitle`) and US-1636 (CSV cells route through the same escaper, which also neutralises formula injection).",
  ],
];

let src = readFileSync(NOTE, "utf8");
let ticked = 0;
const missed = [];

for (const [prefix, closure] of CLOSURES) {
  const needle = `- [ ] ${prefix}`;
  const at = src.indexOf(needle);
  if (at === -1) {
    missed.push(prefix);
    continue;
  }
  const lineEnd = src.indexOf("\n", at);
  const line = src.slice(at, lineEnd === -1 ? undefined : lineEnd);
  const updated = line.replace("- [ ] ", "- [x] ") +
    ` — ${closure} Verified against source 2026-07-19 (US-2089).`;
  src = src.slice(0, at) + updated + (lineEnd === -1 ? "" : src.slice(lineEnd));
  ticked++;
}

if (missed.length > 0) {
  console.error("✗ could not find these findings (text drifted?):");
  for (const m of missed) console.error(`   ${m}`);
  process.exit(1);
}

writeFileSync(NOTE, src);
const remaining = (src.match(/^- \[ \]/gm) ?? []).length;
const done = (src.match(/^- \[x\]/gm) ?? []).length;
console.log(`✓ ticked ${ticked}; note now ${done} checked / ${remaining} unchecked`);
