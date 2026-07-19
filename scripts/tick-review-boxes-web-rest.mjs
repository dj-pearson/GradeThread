#!/usr/bin/env node
// US-2089 triage: the last of the Web section.

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
    "**Referrals redeem/campaign/leaderboard are `try/finally` with no `catch`",
    "✅ **CLOSED** by US-1634: `referrals.tsx` now catches and surfaces the thrown error instead of leaving a silent unhandled rejection (edgeFetch throws on a network error or expired session, which is exactly when the user needs to be told).",
  ],
  [
    "**Self-imposed AI-cap semantics disagree across surfaces",
    "✅ **CLOSED** by US-1631: a shared `effectiveAiLimit` is used so the cap agrees across billing and usage surfaces, rather than each computing its own.",
  ],
  [
    "**Checkout-success toast/analytics/reconcile replay from bare URL params",
    "✅ **CLOSED** by US-1631: the success path is gated on a one-shot `CHECKOUT_INITIATED_KEY` set when we actually navigate to Stripe, so a bookmarked `?checkout=success` no longer re-fires the conversion event and inflates metrics.",
  ],
  [
    "**Offline intake queue replays duplicates",
    "✅ **CLOSED** by US-1634: the replay carries an idempotency key, so a re-flush after a succeeded-server-side-but-unacknowledged insert no longer duplicates the row.",
  ],
  [
    "**Record Sale: bulk listing-deactivation error ignored",
    "✅ **CLOSED** by the US-163x pass on `inventory-detail.tsx`, which surfaces the write errors this page previously swallowed.",
  ],
  [
    "**Grade-completion realtime invalidates two phantom keys",
    "✅ **CLOSED** by US-1633: the realtime handler invalidates the real keys, so the dashboard refreshes on grade completion.",
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
