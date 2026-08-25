---
title: Copy style, and which words we keep
type: contract
status: current
source_of_truth: vault
code_refs:
  - scripts/check-copy-reading-level.mjs
  - src/lib/product-terms.ts
  - src/test/copy-reading-level.test.ts
reviewed: 2026-08-25
tags: [copy, ux, vocabulary, reading-level]
summary: Sixth-grade target, why the ratchet sits on the tail and not the mean, and the standing list of borrowed words that stay with a plain tag rather than being renamed.
---

# Copy style, and which words we keep

Written for US-2868 so the next person writing a button label does not
re-derive any of this. The measuring tool is
`scripts/check-copy-reading-level.mjs`; the rules it cannot check are here.

## The target

Sixth-grade reading level. Short sentences. Plain words. Where a technical word
is unavoidable, a short plain tag on first use: *item specifics (eBay's word for
item details)*.

## Four audiences, and only one of them is scored

The single most important decision in this note, because scoring them together
produces a number nobody can act on.

| Audience | Where | Scored? | Why |
|---|---|---|---|
| customer | everything else, plus all of `ios/` | **yes** | The people this style guide is for. |
| operator | `**/admin/**` | no | Two readers, both of whom know what a webhook is. A plain tag there is noise. |
| legal | `src/pages/legal/**` | no | Reviewed text. Simplifying it is a change to what we promise, not a copy fix. |
| marketing | `src/pages/marketing/**`, landing, blog, `<SEO>` props | jargon only | A landing paragraph is allowed to be a paragraph, and a meta description is written for a search result. Jargon still counts: *aspects* is no more knowable on a marketing page. |

Scored over all four, the worst copy in the repo is the Terms of Service
(grade 29.6) and an admin credit-ledger panel that says *one idempotent flow*.
Neither is a defect. The all-audience number was 1,438 offenders; the customer
number was 809. Same shape of mistake as US-2866's *158 list surfaces with no
empty state*, which was really four.

## The ratchet is on the tail, not the mean

Median customer copy already scores **5.9**, under target. The strings that
actually defeat a reader are the tail, so `src/test/copy-reading-level.test.ts`
ratchets two counts (above grade 12, and above grade 15) and lets everything
else alone. They may fall and never rise, and a count that drops well below its
ceiling gets the ceiling lowered in the same commit.

Gating on "above target" would mean hundreds of failures on sentences that are
perfectly clear, which is how a check gets switched off for good.

**Never gate the build on the raw score.** Reading level here is
Flesch-Kincaid over a syllable *guess*. The guess undercounts adjacent vowels
(*reconciliation* scores 5, not 6) and knows nothing about proper nouns. It is
good at ranking a hundred strings worst-first and bad at judging any one of
them.

## Words we keep, and words we do not

The product has two kinds of hard word and they get different treatment.

**Invented by GradeThread** — FlipDesk, AutoLister, Snap to Value, MeasureCard,
Scout, Prospect, Passport, Trust Score, Thrift Radar, Drop. These are ours.
Defined in `src/lib/product-terms.ts` (US-2864) and reachable from
`/dashboard/help/glossary`.

**Borrowed from eBay and the trade** — *item specifics* / *aspects*, *SKU*,
*provenance*, *taxonomy*. These **stay**. Renaming eBay's own vocabulary makes
the app disagree with the site the seller has open in the next tab, which is
worse than a word they have to learn once. US-2868 put them in the *same*
registry as the invented ones, because a second glossary is how the two end up
disagreeing.

*aspects* is registered as an alias of *Item specifics*: eBay's API says one and
eBay's own interface says the other, and a seller arriving with either word has
to land somewhere.

### How a borrowed word earns its place

One of:

- wrapped in `<Term name="…">` so it gets the dotted underline and the popover, or
- followed by a parenthetical on first use in that surface, or
- explained by the sentence it sits in.

The scorer treats all three as tagged. It does **not** ask every occurrence to
be wrapped — US-2864 settled that, and the reasoning still holds: *FlipDesk*
appears in 106 files and *Comp* in 161, mostly as route strings, type names and
headings, where a dotted underline on a page's own title reads as a defect.
Wrap where the word is doing explanatory work.

## Rules that are not about reading level

- **No em dash as the default connector.** Commas, parentheses, semicolons.
- **Name the number.** "You have 12 drafts, none matching that search" beats
  "no matches". US-2867 made the row count a REQUIRED prop of
  `src/components/flipdesk/filter-empty.tsx` for exactly this reason: "none
  match" reads as "you have none" unless the number is on screen.
- **A failed read is never an empty state.** US-436. An outage that says "you
  have no listings" is a lie with a friendly face.
- **One action, one label.** "Add item" is not also "Add an item", "New item"
  and "Intake an item" (US-2860). Where three surfaces offer the same action,
  the label is a shared constant, not three strings.

## Running it

```bash
node scripts/check-copy-reading-level.mjs           # summary + worst 25
node scripts/check-copy-reading-level.mjs --all     # everything
node scripts/check-copy-reading-level.mjs --jargon  # untagged jargon only
```

Report-only by design; it exits 0 whatever it finds. The ratchet in
`src/test/copy-reading-level.test.ts` is what actually fails.

## What US-2868 did not do

It did not review all 9,615 customer strings by hand. It rewrote the tail
(everything above grade 12 that was interface copy rather than a legal hedge),
took *above grade 15* from 22 to 6, and left the tool behind so the rest is
findable. A hedge doing legal work — "not a professional appraisal or
guarantee" — was left alone on purpose: a simpler sentence there is a different
promise, not a clearer one.
