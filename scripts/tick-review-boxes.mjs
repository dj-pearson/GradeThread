#!/usr/bin/env node
// One-shot helper for the US-2089 triage: tick a finding's box in the archived
// 2026-07-04 review and append the closing story + verification date.
//
// A script rather than inline shell because the finding text is dense with
// backticks and arrows, and passing it through a shell string mangled it twice
// (bash command substitution on backticks, and lost regex escapes). Matching on
// a short unique prefix avoids reproducing the whole line.

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

// [unique prefix of the finding, closing note]
const CLOSURES = [
  [
    "**Workspace-scoped queries not owner-keyed",
    "✅ **CLOSED** by US-1624: `switchWorkspace()` calls `queryClient.clear()` before changing the active owner, so the un-keyed queries refetch under the new scope. The keys still omit the owner deliberately — the clear IS the isolation mechanism (US-2089 later extended it to impersonation).",
  ],
  [
    "**Bulk submission has no synchronous double-submit guard",
    "✅ **CLOSED** by US-1625: `submitLockRef` rejects a re-entrant double-click synchronously, before the `disabled={isSubmitting}` re-render lands.",
  ],
  [
    "**`compressImage` double-applies EXIF orientation",
    "✅ **CLOSED** by US-1626 (see the comment at `image-utils.ts:363`).",
  ],
  [
    "**PhotoUpload loses staged photos when stepping back from Review",
    "✅ **CLOSED** by US-1627 (PhotoUpload stays mounted once reached) and US-1636 (object-URL revoke handling).",
  ],
  [
    "**Detail-page realtime invalidates a phantom key",
    "✅ **CLOSED** by US-1633: the realtime handler now invalidates the real keys (`submissions`, `submission/:id`).",
  ],
  [
    "**Auto-delist stamp cleared even when the extension hard-fails",
    "✅ **CLOSED** by US-1629: `delist-confirm` fires only when `res.ok`; a hard failure keeps the stamp so it stays retryable, and `useMarkDelistDone` covers the manual path.",
  ],
  [
    "**Inventory-detail writes never invalidate any query",
    "✅ **CLOSED**: `inventory-detail.tsx` now uses `useQueryClient` and invalidates `items_full` / `inventory` / `inventory-listings`.",
  ],
  [
    "**Adding an inventory item invalidates nothing",
    "✅ **CLOSED**: `inventory-add.tsx` now imports `useQueryClient` and invalidates on create.",
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
  // Tick the box, and append the closure at the END of that line so the
  // original evidence (file:line, failure scenario, suggested fix) survives.
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
