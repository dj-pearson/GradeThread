#!/usr/bin/env node
// US-2495: the unwired-module gate.
//
// `scripts/audit-unwired-exports.mjs` finds edge lib modules that NO production
// file imports — the "green tests around a feature that never runs" shape that
// `vault/70-agent/shipped-but-unwired.md` catalogues. It has found a real defect
// on every sweep anyone has bothered to run: the unwired edge half of US-1891's
// title sync (P1, a shipped feature that did not run on most surfaces),
// buildListingPullPatch enforcing a stricter contract than the code that
// actually ran, and a superseded trigger engine still carrying 31 test refs.
//
// AND IT WAS ITSELF UNWIRED. The audit lived in `scripts/`, executable, in no
// npm script, no verify lane and no workflow — so it ran only when a human
// remembered it existed. A detector for shipped-but-unwired code that is itself
// shipped-but-unwired is the joke this file exists to stop telling. The audit
// says at the top "this is a REPORT, not a gate. Read it, don't CI-fail on it",
// and that instruction is why nothing read it: a report nobody is scheduled to
// read is indistinguishable from no report.
//
// SO THIS IS A DIFFERENT THING FROM THE AUDIT, not a stricter mode of it. The
// audit is right that most hits are legitimate. What is NOT legitimate is a NEW
// one arriving unnoticed. The allowlist below is the whole mechanism: every
// currently-dead module is named with the verdict a human already reached, and
// anything not on it fails. Same shape as the ui:check baseline, for the same
// reason — a number nobody has to justify becomes a budget.
//
// TWO DIRECTIONS OF STALENESS, and the second is the one that rots quietly:
//   • a NEW dead module → fails, with the triage question to answer.
//   • an allowlisted module that is now WIRED → also fails, because an
//     allowlist that outlives its entries starts silently excusing whatever
//     next takes that filename.
//
// Usage: node scripts/check-unwired-modules.mjs

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Modules a human has already triaged as legitimately uncalled, with the
 * verdict. A reason is required — "known" is not a verdict, and the next reader
 * needs to be able to tell a superseded engine from a half-wired feature
 * without re-deriving it. That is the exact distinction the audit's own closing
 * line says looks identical in its output.
 */
export const ALLOWED_DEAD_MODULES = {
  // marketplace-observations.ts came OFF this list on 2026-08-20: the entry's
  // own closing line said to remove it when the route imports it, and
  // routes/flipdesk-sync.ts imports planObservations and planSaleEffects. The
  // gate had been failing since that route landed, which is the allowlist doing
  // exactly what it is for.
  "drip-trigger.ts":
    "SUPERSEDED. US-933's unified trigger engine; jobs-journey-tick.ts does the " +
    "same work inline via switch(journey.trigger). Dead, not broken.",
  "rubric.ts":
    "PENDING, deliberately. The category-rubric registry for non-clothing " +
    "grading. US-1997 decided ACTIVATE, and Phase 2 (the pipeline actually " +
    "grading non-clothing) needs a golden set that does not exist yet. Its " +
    "client mirror src/lib/rubrics.ts IS live, and a shared behavioural " +
    "fixture pins the two.",
  // size-systems.ts came OFF this list on 2026-08-17 (US-2215): the reading half
  // shipped. usEquivalentForLabel is called from grading-size.ts's
  // sizeVerificationLine, which is the trusted block the old entry said a
  // converted size would have to go through first — so it went through it, and
  // the entry stopped being true. Left as a comment rather than deleted
  // silently, so the next reader sees a module that graduated rather than a
  // name that quietly vanished.
  "brand-seed.ts":
    "PENDING. The brand-KB seeding gate; see shipped-but-unwired.md for why it " +
    "could never have run as written.",
  // grading-reliability.ts came OFF this list on 2026-08-15 (US-2035): the
  // env-gated job that feeds it live re-grades now exists as
  // routes/jobs-grading-self-consistency.ts, so the module has a caller and the
  // entry stopped being true. Left as a comment rather than deleted silently,
  // because the entry it replaced said in as many words that being on this list
  // was not a verdict that nothing was wrong — and it was right.
  "seller-digest.ts":
    "PENDING, and the gate caught it the same day it landed. US-2828 shipped the "+
    "EDITORIAL half: composeSellerDigest is a pure function that decides whether "+
    "a seller has anything worth an email this week (NEWS -> send, CONTEXT only "+
    "-> null). What does NOT exist is the job that gathers DigestInputs and "+
    "delivers it, and it is blocked on two things named on the story: migration "+
    "00659 (seller_digest_log, the send ledger and the opt-out column) is HELD "+
    "and unapplied in prod, and the five analytics RPCs a job would naturally "+
    "read scope by auth.uid(), which is NULL under the service-role client the "+
    "edge uses, so they return nothing. seller-anomaly.ts is dead the same way "+
    "and is not listed separately because this module is its only importer, so "+
    "the audit reports the root and not the branch. Remove this entry when the "+
    "job imports composeSellerDigest; the gate fails if you forget.",
  "content-ai-email.ts":
    "SUPERSEDED. Zero test refs as well as zero callers, which is the one " +
    "combination that is safe to ignore: nothing is claiming it works.",
};

/**
 * Modules that must NEVER be allowlisted, whatever the audit says, because
 * being uncalled is the POINT and the reason is load-bearing.
 *
 * `title-sync.ts` is the one that earned this list. It is the reference the
 * Swift port mirrors AND one half of the behavioural parity fixture both suites
 * assert, so deleting it would remove a side of the only guard keeping the two
 * live implementations honest. Its module header already carries a DO NOT WIRE
 * THIS instruction explaining that this audit will keep reporting it and that
 * the report is correct — see US-1995. If it ever shows up here, the answer is
 * neither "wire it" nor "allowlist it": it is already handled.
 */
export const DOCUMENTED_UNCALLED_BY_DESIGN = new Set(["title-sync.ts"]);

/** Parse the audit's `--module` section into filenames. */
export function parseDeadModules(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s{2}(\S+\.ts)\s+\d+ export\(s\)/);
    if (m) out.push(m[1]);
  }
  return out;
}

export function classify(found, allowed = ALLOWED_DEAD_MODULES) {
  const known = new Set(Object.keys(allowed));
  const foundSet = new Set(found);
  return {
    fresh: found.filter((f) => !known.has(f) && !DOCUMENTED_UNCALLED_BY_DESIGN.has(f)),
    // An allowlist entry whose module is now imported (or deleted) is stale.
    stale: [...known].filter((k) => !foundSet.has(k)),
    byDesign: found.filter((f) => DOCUMENTED_UNCALLED_BY_DESIGN.has(f)),
  };
}

function main() {
  const res = spawnSync(
    process.execPath,
    [join(ROOT, "scripts", "audit-unwired-exports.mjs"), "--module"],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    console.error("[unwired] the audit itself failed to run:");
    console.error(res.stderr || res.stdout);
    process.exit(1);
  }

  const found = parseDeadModules(res.stdout);
  const { fresh, stale, byDesign } = classify(found);

  for (const f of byDesign) {
    console.log(`[unwired] ${f}: uncalled BY DESIGN — see its module header. No action.`);
  }

  if (!fresh.length && !stale.length) {
    console.log(
      `[unwired] OK  ${found.length} dead module(s), all triaged. ` +
        "Reasons in scripts/check-unwired-modules.mjs.",
    );
    return;
  }

  if (fresh.length) {
    console.error("\n[unwired] NEW module(s) that no production file imports:\n");
    for (const f of fresh) console.error(`    services/edge-functions/src/lib/${f}`);
    console.error(
      "\n  Its tests pass and its feature does not run. Decide which this is —\n" +
        "  they look identical in the audit's output:\n" +
        "    SUPERSEDED  something else does the job now  -> delete it\n" +
        "    PENDING     built ahead of the thing that will call it -> allowlist WITH the reason\n" +
        "    HALF-WIRED  a shipped feature that never ran -> a bug, file it\n" +
        "  Then add it to ALLOWED_DEAD_MODULES with that verdict, or wire it up.\n",
    );
  }

  if (stale.length) {
    console.error("\n[unwired] allowlist entries that are no longer dead:\n");
    for (const f of stale) console.error(`    ${f}`);
    console.error(
      "\n  Each is now imported, or gone. Remove it from ALLOWED_DEAD_MODULES —\n" +
        "  an allowlist that outlives its entries silently excuses whatever\n" +
        "  next takes that filename.\n",
    );
  }
  process.exit(1);
}

// Same entry guard as check-ui-antipatterns.mjs — the Windows path form is why
// it is spelled twice rather than compared once.
if (import.meta.url === `file://${process.argv[1]?.split("\\").join("/")}` ||
    process.argv[1]?.endsWith("check-unwired-modules.mjs")) {
  main();
}
