---
title: Memory vs the vault — what the audit actually found
type: learning
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-07
tags: [meta, memory, knowledge]
summary: The premise that memory duplicates the vault and wins by default is only half right — memory is frequently the MORE detailed source, so pointing at a note can lose information. US-2093 then promoted the whole store and found the audit's other premise wrong.
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

> [!warning] Corrected 2026-08-07 — "not stale at all" was wrong
> The audit checked whether each cited path **exists**. That is not the same
> question as whether each claim is **true**, and reading the files one at a time
> (US-2093) found 15 false or stale claims plus 4 orphaned mechanisms. The
> worst kind passes an existence check perfectly: `item-canvas.tsx` was cited as
> a live instruction in four memories *after it was deleted*, and the paths
> around it all resolved.
>
> So a staleness sweep over prose cannot be automated at all — not because the
> matching is hard, but because the property being checked is semantic. The only
> thing that found these was reading the claim and then reading the code. That
> is the argument for **verify**-then-promote-then-point, not just
> promote-then-point.

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

## Two injected sources can contradict each other, and nothing goes red

The vault has a drift guard, a lint and a CI lane. Memory has none of those, and
every file in it is injected at once. So two memories can state opposite things
and both keep arriving in every session, forever, with no surface that reports
the disagreement.

This was not hypothetical. `android-local-toolchain` said this host builds
Android and names the exact gradle command; `android-backend-deps` said the
Android client "needs Gradle/SDK + an Android CI lane, none of which exist on
this Windows host." Both true when written, nine months apart. An agent reading
both picks one, and which one it picks is not a decision anybody made.

> A vault note that goes stale is *findable* — it has a `reviewed` date, a
> `code_refs` list and a lint that fails on drift. A memory that goes stale is
> just a sentence that keeps showing up.

That asymmetry, not duplication, is the real reason project facts belong in the
vault. Duplication merely wastes tokens; an unguarded injected surface makes
being wrong permanent.

## Scope of what was done

**US-2062 (2026-07-19)** folded the eBay aspect memory's extra detail into
[[ebay-aspect-value-limit]] and stopped there — the audit showed the rest
accurate and frequently richer than their vault counterparts, so a wholesale
reduction would have cost information.

**US-2093 (2026-08-01 → 2026-08-07)** did the file-by-file promotion. Every
`type: project` memory was read, its claims verified against current code, the
uncovered detail folded into a note (19 new notes; ~12 existing ones extended),
and only then was the memory reduced to a one-paragraph pointer.

Final state of the store: it began at 64 files, had grown to **74** by the time
the promotion started, and ends at **71** — of which **63 are pointers** and
**8 are kept deliberately**. The kept 8 are working agreements, standing user
instructions, and facts about *this laptop* (that it has an Android toolchain;
that `gh` is installed but off `PATH`). Those are exactly what memory is for,
and putting them in a git-tracked vault would tell every future reader something
true only of one machine.

**3 were deleted** as superseded. Two of them described a backlog-triage world
that no longer exists — the loop is handed its story now rather than choosing
one, and Android turned out to be buildable here — so they were not merely
stale, they contradicted [[ralph-learnings]] on a point it states explicitly.
The third had "SUPERSEDED" in its own description and a rule already owned by
the `tenant-isolation` skill. Deleting beats pointing when what survives is a
false instruction: a pointer would have preserved it.

Three things the exercise produced besides the notes, all of which came from
verifying rather than transcribing:

- **15 false or stale claims corrected**, several of which would have sent the
  next reader hunting a bug that did not exist.
- **4 orphaned mechanisms found** — code with no remaining caller — all from the
  single `item-canvas.tsx` deletion (US-2381), plus one that was *obsolete by
  architecture* rather than orphaned. Telling those two apart needed the code,
  not the commit message; see [[shipped-but-unwired]].
- **2 CI breakages fixed**, one of them caused by these very edits: notes with
  hand-written copies shipped in the admin UI break `runbook-sync` when only one
  copy is edited. See [[runbook-copies]].

## Related

- [[agent-knowledge-surfaces]] — the four surfaces and their intended split
- [[ebay-aspect-value-limit]] — the worked example
- [[INDEX]]
