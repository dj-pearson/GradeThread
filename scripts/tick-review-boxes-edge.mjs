#!/usr/bin/env node
// US-2089 triage, Edge tenant-isolation slice. Mechanics per tick-review-boxes.mjs.

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
    "**Per-grade checkout scoped to bare `userId` strands workspace-member submissions",
    "✅ **CLOSED**: `workspaceMiddleware` is now mounted on `/api/payments/*` (main.ts), so the checkout resolves the workspace owner rather than the bare caller.",
  ],
  [
    "**Account deletion orphans retained originals + dispute evidence",
    "✅ **CLOSED** by US-1637: `collectSubmissionImagePaths` sweeps `original_storage_path` (the EXIF/GPS-intact forensic original) and `disputes.evidence_paths` alongside `storage_path`, de-duplicated.",
  ],
  [
    "`grade.ts:792` `/status/:id` uses `select(\"*\")`",
    "✅ **CLOSED** by US-1638: the tenant-facing columns are whitelisted instead of `select(\"*\")`.",
  ],
  [
    "`lib/grade-billing.ts:252` `runPaymentPrecedence` marks paid by `.eq(\"id\",…)` alone",
    "✅ **CLOSED**: the mark-paid update now carries `.eq(\"user_id\", userId)` as defence in depth beneath the callers' owner check.",
  ],
  [
    "`notifications.ts:568` `/dispute-filed`",
    "✅ **CLOSED** by US-1638 (lookup scoped to the caller's own dispute) + US-1652 (race-safe `admin_alerted_at IS NULL` claim, so exactly one of N concurrent callers sends the admin email).",
  ],
  [
    "`notifications.ts:733` `/welcome` unauthenticated",
    "✅ **CLOSED**: the handler takes the id from the verified session, not the body, and `/api/notifications/*` is behind `authMiddleware`.",
  ],
  [
    "`flipdesk-ai.ts:364` inserts `ai_enrichment_log` before ownership check",
    "✅ **CLOSED** by US-1638: ownership is verified BEFORE any DB write keyed on the supplied `item_id`, so the insert can no longer act as a cross-tenant UUID-existence oracle.",
  ],
  [
    "`flipdesk-autolister.ts:1025/1183` use `${ownerId}/` not `${ownerId}/_staging/`",
    "✅ **CLOSED**: the staging paths are now `_staging/`-qualified throughout.",
  ],
  [
    "`flipdesk-listings.ts:287` `/cross-push` bare `.eq(\"id\",…)`",
    "✅ **CLOSED**: `/cross-push` resolves `ownerId` from the workspace context and rejects the draft unless the joined `inventory_items.user_id` matches — ownership via the parent row rather than a bare id filter.",
  ],
  [
    "`flipdesk-images.ts:53` `/remove-bg` can write a sensitive",
    "✅ **CLOSED** by US-1638: `SENSITIVE_ITEM_PHOTO_TYPES` blocks label/tag/certificate close-ups from the background-removal path, so they can't land in the public `item-photos` bucket.",
  ],
  [
    "`workspace.ts` — **zero** cases",
    "✅ **CLOSED** by US-2039 (2026-07-19): `resolveRequestedOwner` / `resolveWorkspaceAccess` were extracted from the middleware precisely so this surface could be tested, and now carry 13 cases — including fail-closed on a lookup error and a viewer resolving as exactly `viewer`, which is what `blockViewerWrites` (the C3 fix) keys on.",
  ],
  [
    "`notifications.ts`, `verified.ts`, `passport.ts tags/:tagId/revoke`",
    "✅ **CLOSED**: `tenant-isolation_test.ts` now carries cross-tenant cases across these surfaces.",
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
console.log("  NOTE: the flipdesk-auth-coverage regex-scope finding is left UNCHECKED —");
console.log("  the guard is still scoped to /api/flipdesk/* by design (US-2014 shipped an");
console.log("  eBay-specific coverage guard instead of inverting the middleware).");
