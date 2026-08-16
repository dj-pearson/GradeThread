#!/usr/bin/env node
// prd-operator — what the OWNER has to do, pulled out of the backlog.
//
// WHY THIS EXISTS. Roughly half the open stories carry work no agent and no CI
// lane can do: rotate a key, approve a scope, click through a live sell form,
// run a query against prod. Each one is recorded honestly, and each one is
// recorded in a different place — halfway through a 4000-character note, in a
// title prefix, in an acceptance criterion. So the queue was real and
// unreadable, and the same stories kept getting re-opened, re-read and
// re-deferred.
//
// THE FLOOR CAVEAT AT THE BOTTOM OF THIS FILE IS NOT DECORATION. It was checked
// (2026-08-15) by scanning the same notes with a wider signal set: the queue
// reported 37 and the honest number was 49, with three of the eight misses at
// priority 25. The patterns had been tuned on stories that used the word
// "operator", so stories saying "a PROD query this host cannot run" or "not
// agent work" were invisible. Those phrasings are matched now. Re-measure
// rather than trusting the total — that is what the caveat is asking for.
//
// TWO SECTIONS, AND THE SPLIT IS THE POINT.
//
//   DECLARED   — an acceptance criterion that starts with `OPERATOR:`. Exact,
//                machine-readable, quoted verbatim. This is the convention;
//                write new operator work this way.
//   UNDECLARED — the note says somewhere that a human is needed, but the story
//                never says so structurally. The matched sentence is extracted
//                as EVIDENCE, not as an instruction: prose is not a contract,
//                and an extract can lose the qualifier that made it true.
//
// Reporting them merged would be the dishonest version — it would give a
// hand-pulled sentence the same authority as a declared criterion. Read the
// story before acting on anything in the second list.
//
// This is a REPORT, not a gate. It always exits 0. Nothing here should be able
// to fail a build: a backlog that has not adopted a convention yet is not a
// regression.
//
//   node scripts/prd-operator.mjs [--declared] [--json] [--all]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { comparePriority } from "./lib/prd-priority.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** An acceptance criterion is DECLARED operator work if it opens with the tag. */
// Bracketed form needs no separator ("[OPERATOR] apply 00589"); the bare word
// does ("OPERATOR: …"), or every criterion that happens to open with the word
// would qualify.
export const DECLARED_RE = /^\s*(?:\[(?:OPERATOR|OWNER|HUMAN)\]|(?:OPERATOR|OWNER|HUMAN)\s*[:\-])\s*/i;

/**
 * Patterns that mean "a person has to do THIS STORY's remaining work".
 *
 * Every one is anchored to a predicate, not to the bare word. That is not
 * fussiness — the first draft used plain substrings and immediately matched
 * prose ABOUT operators rather than work FOR one: `operator read` matched "an
 * operator reading that at 3am", and `operator-only` matched a visibility flag
 * described as "customer-readable vs operator-only". Both are stories with real
 * operator work, and both got quoted the wrong sentence, which is the same
 * failure as being wrong. A queue that cries wolf gets ignored, which is the
 * exact problem this script exists to fix.
 *
 * Ordered strongest first: the first match wins the quote.
 */
export const UNDECLARED_PATTERNS = [
  /REMAINING FOR THE OWNER/,
  /USER ACTION REQUIRED/,
  /\bis (?:an |a )?(?:genuinely )?operator (?:action|task|read|work)\b/i,
  /\b(?:are|is) (?:genuinely )?operator work\b/i,
  /\bis operator-only\b/i,
  /\bAC\d\b[^.]{0,40}\boperator[- ](?:only|action|work)\b/i,
  /\bis a human action\b/i,
  /\bneeds a logged-in human\b/i,
  /\bcannot be done from here\b/i,
  /\bnot automatable from this host\b/i,
  // Added after measuring the gap this file's own closing caveat predicted.
  // The first pattern set was tuned against stories that used the word
  // "operator", and it found 6 undeclared. A wider scan of the same notes found
  // 14 — eight stories saying a person is needed in words the queue could not
  // see, including three at priority 25. Each pattern below is still anchored to
  // a predicate, and each was checked against every quote it pulls.
  /\bthis host cannot run\b/i,
  /\bcannot be (?:done|run|verified|proven|answered) from (?:here|this host)\b/i,
  /\bnot agent work\b/i,
  /\bneeds a prod (?:query|read|session)\b/i,
  /\bneeds a partner answer\b/i,
  // "a human with the product open", "a human with the Stripe Dashboard".
  /\ba human with the\b/i,
  /\bis a Stripe (?:D|d)ashboard(?:\/API)? setting\b/i,
  // Third measurement, same day: after the seven above, exactly two stories were
  // still invisible and both used this one phrase. Eleven other candidate
  // phrasings ("only you can", "cannot be automated", "waiting on the owner")
  // matched NOTHING in the current backlog — so the floor is now close to the
  // census, and adding more speculative patterns would be tuning against
  // sentences nobody has written.
  /\bBLOCKED ON A HUMAN\b/i,
];

/** Sentence around `idx`, trimmed to something a terminal line can hold. */
export function extractSentence(text, idx, max = 260) {
  const before = text.lastIndexOf(". ", idx);
  const segment = text.lastIndexOf(" | ", idx);
  const start = Math.max(before === -1 ? 0 : before + 2, segment === -1 ? 0 : segment + 3);
  let end = text.indexOf(". ", idx);
  if (end === -1) end = text.length;
  const raw = text.slice(start, Math.min(end + 1, start + max * 2)).trim();
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

export function collect(stories) {
  const open = stories.filter((s) => !s.passes);
  const declared = [];
  const undeclared = [];

  for (const s of open) {
    const acs = (s.acceptanceCriteria ?? []).filter((a) => DECLARED_RE.test(a));
    if (acs.length > 0) {
      declared.push({ id: s.id, priority: s.priority, title: s.title, items: acs });
      // A story that declares its operator work is NOT also listed as
      // undeclared, even when the note repeats it in prose. One row per story
      // in the queue, at the highest fidelity that story offers.
      continue;
    }
    const notes = s.notes ?? "";
    const titleTagged = /^\s*\[OPERATOR\]/i.test(s.title);
    const hits = [];
    for (const pattern of UNDECLARED_PATTERNS) {
      const m = pattern.exec(notes);
      if (m) hits.push(extractSentence(notes, m.index));
    }
    if (hits.length === 0 && !titleTagged) continue;
    undeclared.push({
      id: s.id,
      priority: s.priority,
      title: s.title,
      titleTagged,
      // Dedupe: two phrases often land in the same sentence.
      evidence: [...new Set(hits)],
    });
  }

  declared.sort(comparePriority);
  undeclared.sort(comparePriority);
  return { declared, undeclared, openCount: open.length };
}

function rank(s) {
  return s.priority === undefined || s.priority === null ? "  -" : String(s.priority).padStart(3);
}

function main() {
  const argv = process.argv.slice(2);
  const prd = JSON.parse(fs.readFileSync(path.join(ROOT, "prd.json"), "utf8"));
  const { declared, undeclared, openCount } = collect(prd.userStories ?? []);

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ declared, undeclared, openCount }, null, 2));
    return;
  }

  const total = declared.length + undeclared.length;
  console.log(
    `\nOperator queue: ${total} of ${openCount} open stories wait on a person.\n`,
  );

  console.log(`DECLARED (${declared.length}) — an OPERATOR: acceptance criterion, quoted exactly`);
  if (declared.length === 0) console.log("  (none)");
  for (const s of declared) {
    console.log(`\n  ${rank(s)} ${s.id}  ${s.title}`);
    for (const item of s.items) console.log(`        - ${item.replace(DECLARED_RE, "").trim()}`);
  }

  if (argv.includes("--declared")) return;

  console.log(
    `\n\nUNDECLARED (${undeclared.length}) — the note says a human is needed; the story never`,
  );
  console.log("says so structurally. Sentences below are EVIDENCE, not instructions.");
  console.log("Read the story before acting: an extract can drop the qualifier.\n");
  const shown = argv.includes("--all") ? undeclared : undeclared.slice(0, 20);
  for (const s of shown) {
    console.log(`  ${rank(s)} ${s.id}  ${s.title.slice(0, 78)}`);
    for (const e of s.evidence.slice(0, 2)) console.log(`        > ${e}`);
    if (s.evidence.length === 0) console.log("        > (title tag only — no sentence to quote)");
  }
  if (shown.length < undeclared.length) {
    console.log(`\n  … ${undeclared.length - shown.length} more. Pass --all to see them.`);
  }

  console.log(
    "\nTo move a story from the second list to the first, add an acceptance",
  );
  console.log("criterion that starts with OPERATOR: and says what to do.");
  console.log(
    "\nTHIS IS A FLOOR, NOT A CENSUS. It counts stories that SAY a person is",
  );
  console.log(
    "needed, in a form this script recognises. A story whose operator work is",
  );
  console.log(
    "buried in prose it does not match is simply absent — which is the argument",
  );
  console.log("for the convention, not a reason to trust the number as a total.\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
