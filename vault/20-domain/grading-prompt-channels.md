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
  - services/edge-functions/src/lib/grading-eval.ts
  - services/edge-functions/src/lib/grading-shadow.ts
  - services/edge-functions/src/lib/grading-pipeline.ts
  - supabase/migrations/00562_grade_prompt_surface_hash.sql
reviewed: 2026-08-08
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
| Category criteria | a fixed per-`garment_category` map in code | US-2222 |

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
`+visual`, `+tag`, `+cat2`, in that fixed order — so accuracy-tracking can attribute
an era per block. Suffixes APPEND; reordering them would silently reinterpret every
version string already recorded against past grades.

## A third split, orthogonal to trust: versioned vs not

Trusted/untrusted decides whether a seller can steer the grade. It says nothing
about whether a change to a block can be **gated**, and those are different
questions with different answers.

**Only the SYSTEM prompt is versioned.** `resolveActivePrompt` returns
`{ text, versionName }` and `text` becomes the `system` block. Everything above —
baselines, fabric criteria, category criteria, the label transcription, the
response schema, even the factor-weights sentence — is assembled into the **user
message** by `buildUserPrompt` / `buildCompositeUserPrompt`, which no
`ai_prompt_versions` row can reach.

The consequences, verified 2026-08-08:

| Mechanism | Covers the system prompt | Covers the user message |
|---|---|---|
| `ai_prompt_versions` override | yes | **no** — the row has one `prompt_text` |
| Canary (`shouldUseCanary`) | yes | **no** — it picks between two system texts |
| `runEval` golden-set gate | yes | **no** — both legs compile in the same block |
| `grading-shadow.ts` | composite only | **no**, and there is no per-image shadow at all |

So editing a user-message block changes live grading on the next deploy with no
gate available. That is why every one of them is **env-flag gated and additive**:
the flag is the only substitute, and byte-identity when off is what makes it a
real one.

### What a flag carries, and what it does not

Worth stating flatly, because three flags in it is easy to read one as a gate:

| | Flag | Prompt version |
|---|---|---|
| Reversible without a deploy | **yes** | yes |
| Cannot reach sellers unless someone decides | **yes** | yes |
| Measured against a golden set before it serves | **no** | yes |
| Compared on live traffic before it serves | **no** | composite only |
| Identifiable afterwards on a grade record | **no** | yes |

A flag is a **switch**, not a gate. It answers "can we turn this off again?" and
says nothing about whether turning it on was a good idea. Treating one as
evidence is the mistake to avoid — and it is a comfortable mistake, because a
flag-gated rollout has the shape of a careful one.

The fingerprint is the partial remedy: `unversionedPromptSurfaceHash()`
(`ai-grading.ts`) digests the assembled user message, and every eval run reports
it as `unversioned_surface: { hash, covered: false }`. It cannot make a run
safe — it makes two runs **comparable or not**. Runs with different hashes
measured different prompts, so a promotion decision spanning that boundary is
reading noise, however close the MAE looks.

### What a grade record can now answer

Attribution used to be thinner than it looked, in two separate ways. Both are
closed (US-2432, migration 00562), and it is worth keeping WHAT each one fixed
distinct, because they failed differently.

| Field | Where it lives | Answers |
|---|---|---|
| `prompt_version` | `grade_reports` column | which composite SYSTEM prompt, plus which blocks were switched ON (the suffixes) |
| `prompt_surface_hash` | `grade_reports` column | which CONTENT those user-message blocks held |
| `prompt_version` | each entry of `per_image_analysis` | which per-image prompt produced that image's analysis |

**The per-image gap had no carrier at all.** `PER_IMAGE_PROMPT_VERSION` was a
display constant: `grade_reports.prompt_version` is written by the composite
stage alone, so bumping the per-image constant changed a string and nothing a
graded row could report — while *reading* as compliance with the prompt
lifecycle. It is now stamped on each `PerImageAnalysis`, which the pipeline
already persists wholesale, so it needed no column. It carries the **resolved**
`versionName`, not the constant, so a DB override or a canary slice is
attributable rather than reported as the default it did not run.

**The suffixes record presence, not content.** Editing the text inside
`FABRIC_CRITERIA` still reports `+fabric`, so before and after read as one era.
`prompt_surface_hash` is what splits them — the same digest the eval gate
reports, so a grade and an eval run can be compared for whether they ran the
same surface.

It is NULL on every historical row, and there is no backfill: the surface those
grades ran under is not recoverable, and stamping today's hash would assert an
era they never had. **Absent means unknown.**

> [!warning] Attribution is not a gate
> All three fields answer "what ran?" after the fact. None of them can stop a
> user-message edit from reaching sellers ungated — that still needs a versioned,
> overridable seam, which is US-2432's remaining half. The decision on which seam
> is below.

### The seam decision: a second versioned artifact, per block

Decided 2026-08-08 (US-2432 AC1). The two candidates were folding the
user-message blocks into the existing versioned `prompt_text`, or giving the user
message its own versioned artifact. The deciding question is whether a
category-scoped row can vary ONE block without restating the whole prompt.

**Folding fails that test, and `ai_prompt_versions` already shows why.** The
table has had a `garment_scope` column since 00050, and `resolveActivePrompt`
resolves it as a WHOLE-TEXT override: scoped row, else global row, else the code
default. There is no composition. So a row that wanted to change only
`CATEGORY CRITERIA` for `jeans` would have to carry a full copy of the ~90-line
response schema and the Rules block along with it — and with 19 categories
scoped, 19 copies of an invariant.

That is not a size objection. It is the same shape as the two `title-sync`
copies (US-1995): duplicate an invariant across N homes and the copies drift,
with nothing able to tell you which one a given grade ran under. The user message
is already **composed of blocks with their own identities** —
`GARMENT_TYPE_CRITERIA[type]`, `categoryCriteriaFor(category)`, the baseline, the
fabric criteria, the schema tail — so the seam belongs at the block, keyed by
`(stage, block_key, garment_scope)`, resolved by the same active/canary logic
that already serves the system prompt.

**Not built yet.** The decision is recorded here so the build does not have to
re-derive it; `prompt_surface_hash` is what makes the ungated window *visible*
in the meantime, not what closes it.

## Related

- [[grading-scale-and-weights]] — the factors these prompts produce.
- [[weighted-overall-lockstep]] — what happens to the scores afterwards.
