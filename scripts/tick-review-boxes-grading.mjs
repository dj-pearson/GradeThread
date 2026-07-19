#!/usr/bin/env node
// US-2089 triage, Grading-engine slice. Mechanics per tick-review-boxes.mjs.

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
    "**Provenance boosts break min-of-caps composition",
    "✅ **CLOSED** by US-1622 (same defect as C9): `grading-pipeline.ts` carries a running confidence ceiling that every post-composite boost clamps to, enforced at 8 sites — the peer-norm cap, the partial-image shave and the manipulation-evidence floor are all floors a later provenance boost cannot cross.",
  ],
  [
    "**Escalation re-grade silently drops optional images without the partial-image cap",
    "✅ **CLOSED** by US-1642: the escalation path now surfaces `partialSuccess` when it drops an optional image, and the caller ORs it in so the partial-image confidence cap still applies.",
  ],
  [
    "**Seller `brand` reaches the trusted prompt channel via baseline generation",
    "✅ **CLOSED** by US-1642: `garment-baselines.ts` imports `sanitizeSellerText` and the generation is sanitized + fenced; the cache key was bumped v1→v2 so pre-hardening briefs are not reused.",
  ],
  [
    "Pipeline failure handler refunds a submission whose grade report was already inserted",
    "✅ **CLOSED**: the failure handler now returns EARLY when the grade report was already inserted — it logs \"grade stands; NOT marking failed, reversing charge, or notifying failure\" and rethrows, so the refund path is never reached for a graded submission.",
  ],
  [
    "`finalizeGradeReview` ignores the finalize UPDATE's `{error}`",
    "✅ **CLOSED** by US-1643: go-live is now gated on the finalize UPDATE actually succeeding.",
  ],
  [
    "Peer-norm cohort includes non-finalized preliminary grades",
    "✅ **CLOSED**: `peer-norm.ts` now carries `.not(\"finalized_at\", \"is\", null)` — the exact fix the finding recommended.",
  ],
  [
    "Eval/dry-run composite legs silently include the live exemplar block",
    "✅ **CLOSED** by US-1643: eval and dry-run legs set a flag that suppresses the live exemplar block, so the measurement is of the prompt rather than the prompt-plus-active-exemplars.",
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
