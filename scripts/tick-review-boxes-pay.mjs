#!/usr/bin/env node
// US-2089 triage, Payments slice — plus C7, which I left unchecked one pass ago
// and which turns out to BE fixed. Recording that correction rather than
// quietly ticking it: I said C7 was "the one Critical whose status is genuinely
// unknown", and the honest follow-up is that I hadn't looked hard enough, not
// that the code changed.

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
    "**C7 · App Store webhook failure permanently loses the event",
    "✅ **CLOSED** by US-1620 — VERIFIED 2026-07-19 (initially left unchecked in this triage for lack of verification, then confirmed): a transient DB error is raised as a `TransientWebhookError`, the idempotency claim is RELEASED, and the handler returns 500 so Apple's retry re-processes. Side effects are idempotent, so the retry is safe.",
  ],
  [
    "**Delayed App Store EXPIRED/REVOKE clobbers a since-created active Stripe subscription",
    "✅ **CLOSED** by the mobile-billing batch: the update is `billing_source`-aware, so a late Apple notification no longer overwrites a Stripe subscription created after it.",
  ],
  [
    "**Per-grade checkout: duplicate payment for the same submission silently kept",
    "✅ **CLOSED** by US-1637 + the webhook idempotency claim: the checkout resolves the submission's workspace owner and the webhook skips a duplicate delivery rather than granting twice.",
  ],
  [
    "**100%-discount pack checkout has `payment_intent=null`",
    "✅ **CLOSED**: the grant idempotency no longer depends on a `payment_intent` that a fully-discounted checkout never produces.",
  ],
  [
    "**Affiliate payout Stripe idempotency keys expire ~24h",
    "✅ **CLOSED**: `findExistingTransfer` does a PRE-FLIGHT `transfers.list` lookup before creating, so a payout retried after the key's ~24h TTL is recognised as already-transferred rather than double-paid. (The consignor engine uses the same defence — see US-2022.)",
  ],
  [
    "**SNS verification has no `Timestamp` freshness check",
    "✅ **CLOSED** by US-1641: `sns-verify.ts` rejects a message whose `Timestamp` is absent, unparseable, or older than the freshness window, closing the replay window.",
  ],
  [
    "**Admin `/charges/:id/refund` partial refunds carry no idempotency key",
    "✅ **CLOSED**: the refund now carries `admin-refund:${chargeId}:${amount ?? \"full\"}` — keyed on the AMOUNT too, so a partial and a later full refund are distinct operations rather than colliding on one key.",
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
console.log("  NOTE: the out-of-order Stripe subscription-event finding is left");
console.log("  UNCHECKED — the review itself marks it 'mitigated', and 'mitigated'");
console.log("  is not the same claim as 'closed'.");
