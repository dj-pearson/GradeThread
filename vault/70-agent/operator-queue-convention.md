---
title: Operator-queue convention
type: contract
status: current
source_of_truth: vault
code_refs:
  - scripts/prd-operator.mjs
  - src/test/prd-operator-queue.test.ts
reviewed: 2026-08-15
tags: [prd, backlog, operator, agent]
summary: Work only a person can do is declared as an acceptance criterion starting OPERATOR:, and `npm run prd:operator` is the queue.
---

# Operator-queue convention

Established by US-2604 on 2026-08-15.

## The rule

**Work no agent and no CI lane can do is declared as an acceptance criterion
that starts with `OPERATOR:`.** Not a note. Not a title prefix. A criterion.

```json
"acceptanceCriteria": [
  "OPERATOR: confirm SES is out of sandbox and that confirmation mail is delivered."
]
```

`npm run prd:operator` then lists it verbatim, and the owner can work the queue
without reading 115 stories.

## Why a criterion and not a note

A note is prose, and prose was where this work went to die. The same fact was
recorded three different ways across the backlog — a title prefix, a sentence
halfway through a 4000-character note, a parenthetical — so the queue existed
and nobody could read it. Six months of honest records produced no list.

A criterion is also the *right* place semantically: the story does not pass
until a person does the thing. Recording it anywhere else says the story is
complete when it is not.

## What the reporter does with everything else

`prd-operator.mjs` prints two sections, and the split is load-bearing:

- **Declared** — the criterion, quoted exactly.
- **Undeclared** — a note that *says* a human is needed, with the matched
  sentence pulled out as **evidence**. Read the story before acting on one:
  an extract can drop the qualifier that made the sentence true.

Merging them would give a hand-pulled sentence the same authority as a declared
criterion, which is the failure this note is trying to prevent, not repeat.

> [!warning] The count is a floor, not a census
> The reporter counts stories that *say* a person is needed, in a form it
> recognises. A story whose operator work is buried in prose it does not match
> is simply absent. That is an argument for the convention, not a reason to
> read the number as a total.

**And the floor was 24% low the first time anyone checked it (2026-08-15).**
Re-scanning the same notes with a wider signal set moved the queue from 37 to
49. Eight stories were saying a person was needed in words the patterns could
not see — "a PROD query this host cannot run", "not agent work", "a human with
the product open", "needs a partner answer" — because the first set was tuned on
stories that happened to use the word *operator*. Three of the eight were at
priority 25, so they were near the top of the backlog and invisible in the one
artifact meant to surface them.

Two things follow. The phrasings above are matched now, with near-miss negatives
pinned in the test (a note saying "verified by running the prod query against a
local stack" must not match). And the caveat is an instruction rather than a
disclaimer: **re-measure the floor periodically**, because writing "this is a
floor" costs nothing and finding out by how much is the only part that helps.

**Then I claimed it had converged, and that was wrong.** A second scan found two
more (`BLOCKED ON A HUMAN`), a third found zero, and I wrote here that the queue
was "close to a census". Within the hour US-2444 turned up saying **"STILL OPEN
AND ALL OWNER WORK"** — a phrasing none of the eleven candidates in that round
happened to include.

The error was the method, not the list. **A hand-picked phrase list can only
find phrasings someone already thought of, so reporting zero from one is a
statement about the list rather than about the backlog.** Three rounds of tuning
produced three rounds of increasing confidence and no bound at all.

So `npm run prd:operator -- --audit` stops guessing. It returns a **reading
list**: every open, non-queued story whose relevant note segments mention
anything that could mean a person. It reports around 29 against 121 open
stories, most of them false positives, and it says so. One line of reading beats
a story nobody ever does. Trust the DECLARED section; treat the total as a floor
however many rounds it has had.

**"Relevant segments" is not "the last segment", and US-1880 is why.** The first
version read only the newest note, on the reasoning that notes are append-only
so the latest one is current. US-1880's remaining work — live-site QA of five
marketplace adapters, which no agent can do — is stated in a July segment, and
the three segments after it are all corrections about a migration's held status.
The last note was about a different topic entirely, so the story read as
unblocked.

**Latest is not the same as current.** A correction appended about one topic
does not supersede an open claim about another. The audit now also reads any
earlier segment carrying an explicit open-work claim (`STILL BLOCKS`,
`NOT DONE`, `REMAINING`, `cannot be done autonomously`) that no later segment
closes — the same segment-order resolution `prd-lint`'s `findUnresolvedDeferrals`
and its held-migration check already use, for the same reason.

**Declaring is better than detecting.** Every story the scans surfaced got an
`OPERATOR:` criterion written from its own evidence, which moves it into the
exact list and makes the detection unnecessary for that story. The undeclared
section is a migration aid, not the destination.

## The false positives that shipped first

The undeclared patterns are anchored to a predicate (`is an operator action`,
`REMAINING FOR THE OWNER`), never to the bare word. The first draft used plain
substrings and matched prose *about* operators instead of work *for* one:
`operator read` inside "an operator reading that at 3am", and `operator-only`
inside "customer-readable vs operator-only". Both were on stories that do have
operator work, and both got quoted the wrong sentence — which is the same
failure as being wrong, and worse, because it looks checked.

`src/test/prd-operator-queue.test.ts` pins both directions, including a
structural case asserting no pattern matches a bare mention.

Related: [[backlog-priority-contract]] for how the queue is ordered,
[[ralph-learnings]] for the loop's other recurring gotchas.
