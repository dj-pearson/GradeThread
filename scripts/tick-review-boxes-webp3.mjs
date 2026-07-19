#!/usr/bin/env node
// US-2089 triage: web P3 tail. Almost all of this slice is US-1636, which
// evidently swept the whole P3 list in one pass.

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
    "**Date-only defaults use `toISOString()` (UTC)",
    "✅ **CLOSED** by US-1636: `src/lib/local-date.ts` exists specifically so date-only defaults reflect the USER'S local calendar day rather than UTC — the bug that made an evening user record tomorrow's date and broke tax-year boundaries and payout matching.",
  ],
  [
    "**Dashboard inventory/passport queries swallow errors",
    "✅ **CLOSED** by US-1636: both query paths surface failures instead of collapsing them into a zero-state, so \"no data\" and \"the query failed\" are no longer rendered identically.",
  ],
  [
    "**Auth profile-load failure nukes profile/workspaces and stamps the dedup window",
    "✅ **CLOSED** by US-1636: the dedup window is stamped ONLY on success, and a transient profile-load failure no longer clobbers a loaded profile — so a paid user can't be shown as free with the retry suppressed.",
  ],
  [
    "**Photo preview object URLs leak",
    "✅ **CLOSED** by US-1636: previews are revoked on unmount as well as on replace/remove.",
  ],
  [
    "**Tax P&L summary sums raw floats",
    "✅ **CLOSED** by US-1636: the summary sums in integer CENTS, so it can no longer disagree with \"add up the printed column\" by a cent.",
  ],
  [
    "**Assorted stale-invalidation / swallowed-write gaps",
    "✅ **CLOSED** by US-1636 across the cited sites (`use-google-sheets.ts`, `flipdesk/sources.tsx`, `use-workspace`).",
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
