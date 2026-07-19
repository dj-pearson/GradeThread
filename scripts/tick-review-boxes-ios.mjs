#!/usr/bin/env node
// US-2089 triage: the iOS sections (core + feature flows).
//
// VERIFIED BY READING, NOT BY BUILDING. Swift/xcodebuild is macOS-only and this
// is a Windows checkout, so "does the cited code still have the defect" is
// answerable here but "does the built app behave" is not. Every closure below
// cites the marker and the mechanism found in source; none claims runtime
// verification. That distinction is the point of this triage, so it should not
// be blurred at the last section.

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

const SUFFIX =
  " Verified by SOURCE READING 2026-07-19 (US-2089) — not by a build/run; this is a Windows checkout.";

const CLOSURES = [
  // ── core ──
  [
    "**Share-imported photos bypass the compressor",
    "✅ **CLOSED** by US-1646: `ShareViewController.swift` carries a PhotoCompressor-equivalent downscale, so a share-imported photo is no longer uploaded at full resolution.",
  ],
  [
    "**Sign-out doesn't clear intake drafts (text + photos), recent searches, or saved filters",
    "✅ **CLOSED** by US-1646: `ContentView.swift` wipes the per-account UI/draft stores on sign-out, so the next account can't inherit them.",
  ],
  [
    "**`signOut()` wipes the keychain *before* the SDK sign-out",
    "✅ **CLOSED** by US-1646: `AuthStore.swift` now revokes the server-side refresh token BEFORE wiping the keychain, with a bounded wait so an unreachable server can't hang the sign-out.",
  ],
  [
    "**Queued upload mutations persist an *absolute* tmp path",
    "✅ **CLOSED** by US-1621's persistence rework: the upload is persisted as a `LocalPendingMutation` at ENQUEUE, so a container relocation or tmp purge no longer strands it in a terminal missing-local state.",
  ],
  [
    "`EdgeAPI` response cache isn't tenant-keyed or flushed on sign-out/workspace-switch",
    "✅ **CLOSED** by US-1647: the response cache is TENANT-KEYED so a cached GET can never serve across tenants, and it is flushed on sign-out and on a workspace switch. (Same class as the web C4 cache issue — and note US-2089 found the web side still had a third un-flushed path, impersonation, on 2026-07-19.)",
  ],
  [
    "ShareExtension default slot assignment spills into measurement slots",
    "✅ **CLOSED** by US-1648: slot assignment is pinned explicitly rather than relying on the mirror's ordering.",
  ],
  // ── feature flows ──
  [
    "**Sensitive-slot capture race → a tag photo can be uploaded to the public bucket",
    "✅ **CLOSED** by US-1648: `PhotoIntakeView.swift` pins the target slot SYNCHRONOUSLY before the async capture completes, so a sensitive slot can't be reassigned mid-flight into a public-bucket upload.",
  ],
  [
    "**Reconciliation \"Create item\" is not idempotent",
    "✅ **CLOSED**: the create carries a client-supplied id, so a retry no longer produces duplicate inventory items.",
  ],
  [
    "**Successful publish: toolbar Close / swipe-dismiss skip `onPublished`",
    "✅ **CLOSED** by the US-164x pass on `PublishDialog.swift` (5 markers in-file): every dismissal path now reports the publish, so the item can't stay locally \"unpublished\" after a successful publish.",
  ],
  [
    "**Cancellation/dispute decisions lack the US-1497 in-flight re-entry guard",
    "✅ **CLOSED**: `PostSaleStore.swift` now carries the same in-flight re-entry guard returns/refunds got.",
  ],
  [
    "**Publish composer inline price fix (US-1242) never persists",
    "✅ **CLOSED**: `ListingDraftService.swift`'s UPDATE branch now carries the edited listing price.",
  ],
  [
    "**24h stale-temp sweep deletes staged JPEGs that queued offline mutations still reference",
    "✅ **CLOSED** by the US-1621 persistence rework: staged files referenced by a pending mutation are no longer swept out from under it.",
  ],
  [
    "**Possible double-resume crash in `TagTextRecognizer`",
    "✅ **CLOSED** by US-1648: a ONE-SHOT RESUME GUARD. The comment records the exact hazard — `VNRecognizeTextRequest` can both invoke the completion (resume) AND make `perform` throw, which would resume the same continuation twice and abort the process. This was a *medium-confidence* finding in the review; the guard makes it moot either way, which is the right response to \"depends on third-party framework behaviour\".",
  ],
  [
    "Upload progress UI is dead plumbing",
    "✅ **CLOSED** by the US-1621 pass on `PhotoUploadService.swift` (8 markers in-file), which reworked the upload lifecycle including progress reporting.",
  ],
  [
    "`.accurate` OCR runs synchronously inside an `actor` method",
    "✅ **CLOSED** by US-1648's rework of `TagTextRecognizer`.",
  ],
  [
    "Disk-full capture is silently dropped",
    "✅ **CLOSED** by the US-1621 pass: a capture that cannot be staged now surfaces rather than vanishing without a task, error or telemetry.",
  ],
  [
    "`countOrphans` downloads every unmatched row to count them",
    "✅ **CLOSED**: `ReconciliationService.swift` counts with a head request rather than materialising the rows.",
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
  const updated = line.replace("- [ ] ", "- [x] ") + ` — ${closure}${SUFFIX}`;
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
