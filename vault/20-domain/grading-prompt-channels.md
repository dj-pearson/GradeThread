---
title: The two prompt channels — trusted context and the untrusted fence
aliases: [trusted context, untrusted fence, prompt channels, US-346 fence]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/ai-grading.ts
  - services/edge-functions/src/lib/garment-baselines.ts
  - services/edge-functions/src/lib/fabric-criteria.ts
  - services/edge-functions/src/lib/tag-ground-truth.ts
  - services/edge-functions/src/lib/tag-era.ts
  - services/edge-functions/src/lib/grading-size.ts
reviewed: 2026-07-28
tags: [grading, prompts, security, injection, contract]
summary: Everything in a grading prompt is either server-generated trusted context or seller-supplied fenced text; the two channels must never be concatenated, and the test for which one a new block belongs to is who can influence its content.
---

# The two prompt channels

A grading prompt carries exactly two kinds of text, and which one a block belongs
to decides whether a seller can steer the grade.

## The channels

**UNTRUSTED — seller-supplied.** Brand, title, description and declared design
features, as typed at submit. Sanitized by `sanitizeSellerText`, wrapped by
`fenceUntrusted`, and labelled in the prompt as reference that must not affect
scoring. Established by US-346.

**TRUSTED — server-generated.** Reference material the server produced, which no
seller input can reach. Rendered OUTSIDE the fence, before it opens:

| Block | Source | Story |
|---|---|---|
| Garment baseline | generated brief, cached per brand+category | US-1533 |
| Fabric criteria | fiber content read off the label photo | US-1534 |
| Few-shot exemplars | past human-corrected grades | US-1067 |
| Label transcription | vision pass over the label photo alone | US-2210 |
| Tag generation (era) | matched against curated `tag_eras` on that same pass | US-2212 |
| Verified size | label read + measurements mapped to the brand's chart | US-2213 |

## The test for a new block

Not "is it accurate?" and not "did the model produce it?" — the model produces
both channels. The question is **who can influence its content**.

A seller types their brand, so the brand line is untrusted no matter how right it
looks. A seller cannot choose what a vision pass reads off their own care label,
so the transcription is trusted even though it names the same field. Two blocks
can state the same fact and belong to different channels.

## The rule that is easy to break

**Never concatenate the channels.** A trusted block that has seller text appended
to it lends that text its authority — which is the whole attack. This is not
theoretical: the tag read (US-2210) and the seller's declared brand are the same
field from two sources, and joining them into one "brand" line would have been
the natural-looking implementation. They are rendered separately and, when they
disagree, the disagreement is recorded rather than resolved (see
`tagDiscrepancies`).

The generated-brief case has its own hardening, because a brand name flows INTO
the generation: `briefLooksSafe` / `BRIEF_INJECTION_TELLS` reject a brief
carrying scoring directives, our JSON field names, or fence characters before it
is ever cached (US-1642). A poisoned brief would otherwise be served as trusted
context on every future grade sharing its key.

## A fourth channel that is deliberately NOT a prompt channel

US-2212 added a check that produces a finding no prompt ever sees: when a style
code's decoded year contradicts the label's matched tag generation, that conflict
is persisted for review and is **kept out of the grading prompt entirely**.

The reasoning generalises. Telling a grader "this garment may have been
relabelled" invites it to move a condition score on an authenticity suspicion,
which is exactly the coupling the factor weights exist to prevent. Review data
and prompt context are different destinations, and a signal earning one does not
earn the other.

## A trusted block carries the RESULT, not the reference data

US-2213 could have injected the brand's size chart into the composite alongside
the baseline and the fabric criteria. It does not, and the distinction is worth
keeping.

Baselines and fabric criteria belong in the composite because they inform *how a
factor is judged* — what the factory state was, what this fibre's honest wear
looks like. A size chart informs none of that. It is reference data for a
different question, so it goes to the focused size call that asks that question
(`estimateSize`, where US-1088 already injects it as authoritative reference),
and what reaches the grading block is one line naming the size **and how it was
established**.

The general form: a trusted block should carry a conclusion the grader can use,
not a table it has to reason over. Prompt noise on a paid call is a real cost.

## Choosing WHICH trusted block gets injected is itself privileged

Added 2026-07-28 (US-2217), and it is the subtlest rule on this page.

The baseline block is trusted context describing a garment's as-manufactured
state. US-2217 made it style-scoped, which raised a question the earlier blocks
never had to answer: **what picks the style?**

The obvious answer — match the seller's title against known style names — is an
injection vector, and a live one. A seller who types "Bedale" onto a quilted
Barbour Liddesdale gets a brief saying waxed cotton is expected and re-waxing is
maintenance. Genuine wear then reads as intentional finish, and the grade goes
up. **No untrusted string ever entered the trusted block**, and the attack still
works, because selecting among trusted blocks is as powerful as writing one.

So the selector takes a trusted input only: the tag read's `style_code`
(US-2210), read off the label by a vision pass over that photo alone. A
near-miss is refused rather than resolved — a wrong style silently swaps one
garment's factory state for another's, which is worse than having no baseline.

The general form: **a routing decision over trusted content inherits that
content's trust requirements.** Ask what picks the block, not just what is in it.

## Trusted does not mean scoring

Trusted context earns a place outside the fence; it does not earn the right to
move a number. Baselines and fabric criteria inform *how* a factor is judged. The
label transcription only says *what the item is* — it carries an explicit "must
NOT change any factor score" line, and a test pins that the factor weights and
the scoring instructions are byte-identical with and without it.

## Every trusted block is additive, and provable

An absent block renders as `""` and the prompt is byte-identical to a grade run
with the feature off — each has a test asserting exactly that. This is what makes
the flag-gated rollout meaningful: with `GRADING_BASELINES` or `GRADING_TAG_OCR`
off, the prompt is the previously-evaluated one, not a near-copy.

Each block also appends its own `prompt_version` suffix — `+baseline`, `+fabric`,
`+visual`, `+tag`, in that fixed order — so accuracy-tracking can attribute an era
per block. Suffixes APPEND; reordering them would silently reinterpret every
version string already recorded against past grades.

## Related

- [[grading-scale-and-weights]] — the factors these prompts produce.
- [[weighted-overall-lockstep]] — what happens to the scores afterwards.
