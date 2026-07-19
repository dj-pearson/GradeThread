---
title: Review cadence
aliases: [maintenance, review queue, how often]
type: runbook
status: current
source_of_truth: vault
code_refs:
  - scripts/vault-lint.mjs
reviewed: 2026-07-19
tags: [meta, maintenance, process]
summary: Run the review queue when CI warns, not on a calendar — the observed drift rate is zero at 89 notes, so a fixed schedule would manufacture work.
---

# Review cadence

> [!important] Event-driven, not scheduled — and that is a measured decision
> US-2067 was written expecting to set a weekly or fortnightly cadence. The
> observed rate said otherwise: on day one, with **89 notes**, the review queue
> is **empty**. A fixed schedule would have manufactured ceremony and taught
> everyone to ignore it — which is exactly how a drift guard becomes wallpaper.

## The trigger

**Run `npm run vault:lint -- --report` when CI shows a vault warning**, and
before starting work in an area you have not touched recently.

The queue is bounded to **5 items** and ordered by consequence:

1. **`type: contract` with drift** — a stale contract is read as authoritative
   and then implemented. This is the tier that has actually caused incidents.
2. **Decisions past `revisit_by`** — expired without anyone re-arguing them.
3. **Everything else**, oldest `reviewed` first.

The cap is deliberate. An unbounded queue is the same failure as an unbounded
warning list wearing a different hat: a session that cannot end is a session
nobody starts.

## What a review actually is

**Re-read the `code_refs`. Confirm the note is still true. Then bump `reviewed`.**

Bumping the date without reading is the one failure no automation here can
catch — the guard compares dates, not meaning. It rests entirely on whoever
edits the file.

Two outcomes are both fine, and both should be recorded in the note:

- **Still true.** Say what changed and why it did not invalidate the note.
  US-2052's `measurement-accuracy` is the model: `measurements.ts` had changed,
  the commit added an eBay sync consumer, the tolerances were untouched.
- **No longer true.** Fix it, and record what was wrong. A silent correction
  loses the fact that someone was once misled.

## Worked example — the first pass

Run 2026-07-19 on `measurement-card-spec`, the oldest note (reviewed 07-06):

Its `code_ref` last changed 2026-07-03, *before* the review date, so the guard
correctly did not queue it. Re-read anyway, to prove the empty queue was
truthful rather than broken. Checked the note's **7.5 × 5.5 in trim** against
the code's **6 × 4 in marker rectangle** — consistent, markers inset 0.75 in per
edge. No correction; date bumped because it was genuinely re-read.

## When to revisit this cadence

If the queue starts arriving non-empty **more than once a week**, the trigger is
too loose and this becomes a scheduled task. If it is still empty in three
months, consider whether `code_refs` are too narrow to catch real change — an
empty queue can mean healthy notes *or* a guard watching the wrong files.

## Related

- [[CONTRACT]] — the re-review rule and what `reviewed` asserts
- [[benchmark-2026-07-19]] — why the vault is worth maintaining at all
- [[live-views]] — the same queue as a Dataview table, for humans
- [[INDEX]]
