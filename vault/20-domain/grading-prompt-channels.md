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
