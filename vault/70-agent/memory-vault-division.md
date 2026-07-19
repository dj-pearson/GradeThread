---
title: Memory vs the vault — what the audit actually found
type: learning
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [meta, memory, knowledge]
summary: The premise that memory duplicates the vault and wins by default is only half right — memory is frequently the MORE detailed source, so pointing at a note can lose information.
---

# Memory vs the vault — what the audit actually found

US-2062 set out to reduce Claude memory to pointers, on the reasoning that
memory is **injected** rather than fetched, so it wins silently whenever it
disagrees with a note. That reasoning still holds. The audit's premise — that
memory would be stale and duplicative — did not survive contact with the files.

## What the audit found (64 files, 2026-07-19)

**Memory is not stale at all.** Every file path referenced across all 64
memories was checked against a 6,070-file index of the repo. **Zero** stale
references.

Getting to that number took two corrections, both instructive:

1. A first pass reported ~25 missing paths. Wrong — memories use shorthand like
   `lib/fcm.ts` for `services/edge-functions/src/lib/fcm.ts`, and the check
   resolved them repo-root-relative.
2. The one survivor was `concurrent-ralph-agent` citing
   `00090_growth_suite.sql`. Also wrong — that memory *describes a rename*
   ("a migration I created as `00090…` was auto-renamed to `00102…`"). The file
   correctly does not exist under the old name. It is an anecdote, not a claim.

Both false positives looked exactly like the real thing, which is the point: an
automated staleness check over prose produces confident wrong answers unless
someone reads the hit.

**Memory is often the RICHER source.** The sharpest case is the eBay aspect cap:

- The **memory** stated plainly that `errorId 25002` is *overloaded*, and added
  that `isOfferAlreadyExistsError` guards it by requiring the message text too,
  that a stuck offer self-heals on retry, and that the cap is send-time only.
- The **vault note** written in US-2042 was drafted from a *summary* of that
  memory and lost the overloading entirely.
- US-2053 then re-derived the overloading from code and recorded it as a
  correction — framed as "the note came from memory and was imprecise."

That framing was wrong. The memory was precise; **the summary of it was not.**
The information was lost in transit, not at the source.

## The lesson that generalises

> Summarising a source into a note is a lossy operation, and the loss is
> invisible afterwards — the note reads as authoritative precisely because it is
> shorter.

This is why the migration stories in this epic insisted on reading the *code*
rather than trusting either document, and why "promote, then point" is the right
order. Pointing first destroys the detail you have not yet moved.

## The division, restated

- **Memory** — user preferences, working agreements, standing instructions, and
  pointers. Things about *how we work*.
- **The vault** — project knowledge, with `code_refs` and a drift guard. Things
  about *what is true*.

Overlap is still a bug, and memory still wins by default when the two disagree.
But the fix is to **promote the detail into the note first**, and reduce the
memory to a pointer only once the note is genuinely the better source. Doing it
in the other order loses knowledge silently, which is the failure this epic
exists to prevent.

## Scope of what was done

The eBay aspect memory's extra detail was folded into
[[ebay-aspect-value-limit]]. The remaining memories were **not** reduced to
pointers in this pass: the audit showed them accurate and frequently richer than
their vault counterparts, so a wholesale reduction would have cost information
for a benefit the audit did not support. Doing it properly means promoting
detail file by file, which is real work and should be a story rather than a
side-effect.

## Related

- [[agent-knowledge-surfaces]] — the four surfaces and their intended split
- [[ebay-aspect-value-limit]] — the worked example
- [[INDEX]]
