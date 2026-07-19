#!/usr/bin/env node
// US-2089 triage, the Critical block.
//
// The note's own header already asserts these are closed ("verified by reading
// the cited code on 2026-07-19" — US-2057), yet every box was still unchecked.
// That inconsistency is the exact "an unchecked box carries no signal" problem
// this triage exists to end: the document contradicted itself, so a reader had
// to decide which half to believe.
//
// C1 and C9 were re-verified directly here rather than taken on trust — one
// billing, one grading — because a header assertion is the same kind of claim
// the rest of this exercise exists to check. The others carry the story ids the
// header names.

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
    "**C1 · Google Play subscription token entitles unlimited accounts",
    "✅ **CLOSED** — RE-VERIFIED DIRECTLY 2026-07-19: `google-play/verify.ts` now reads `obfuscatedExternalAccountId` off the purchase, and migration `00353_google_purchase_token_unique.sql` adds the uniqueness guarantee the finding said was missing. Both halves of the recommended fix are present.",
  ],
  [
    "**C2 · Apple credit-pack REFUND/REVOKE never claws back credits",
    "✅ **CLOSED** by the mobile-billing batch (US-1614/1615/1618/1619/1620).",
  ],
  [
    "**C3 · FlipDesk write/spend routes never enforce `workspaceRole`",
    "✅ **CLOSED** by US-1616 + US-1928 (`blockViewerWrites` is mounted across `/api/flipdesk/*` and `/api/grade/*`; US-2039 later added unit coverage proving a viewer resolves as exactly `viewer`, which is what that middleware keys on).",
  ],
  [
    "**C4 · Same-device cross-account data exposure",
    "✅ **CLOSED** by US-1617 (sign-out clear), extended by US-1624 (workspace switch) and US-2089 (impersonation, both directions — that third path was still missing as of 2026-07-19).",
  ],
  [
    "**C5 · `billing_source` one-way ratchet",
    "✅ **CLOSED** by the mobile-billing batch (US-1614/1615/1618/1619/1620).",
  ],
  [
    "**C6 · Google Play subscriptions never lapse server-side",
    "✅ **CLOSED** by the mobile-billing batch (US-1614/1615/1618/1619/1620).",
  ],
  [
    "**C8 · iOS photo upload queue is in-memory only",
    "✅ **CLOSED** by US-1621.",
  ],
  [
    "**C9 · Grading auto-finalizes a certificate for a below-threshold-confidence gr",
    "✅ **CLOSED** by US-1622 — RE-VERIFIED DIRECTLY 2026-07-19: `grading-pipeline.ts` carries a running confidence ceiling that every post-composite boost is clamped to, enforced at five separate sites (the peer-norm cap, the partial-image shave and the manipulation-evidence floor are all floors a later provenance boost cannot cross).",
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
  const updated = line.replace("- [ ] ", "- [x] ") + ` — ${closure}`;
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
console.log("  NOTE: C7 (App Store webhook loses the event) left UNCHECKED — not");
console.log("  named in the header's six and not verified here.");
