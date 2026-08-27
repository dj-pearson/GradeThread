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
  - services/edge-functions/src/lib/grading-shadow-per-image.ts
  - services/edge-functions/src/lib/grading-pipeline.ts
  - supabase/migrations/00562_grade_prompt_surface_hash.sql
  - services/edge-functions/src/lib/prompt-blocks.ts
  - services/edge-functions/src/lib/listing-eval.ts
  - supabase/migrations/00563_prompt_block_versions.sql
reviewed: 2026-08-27
tags: [grading, prompts, security, injection, contract]
summary: Everything in a grading prompt is either server-generated trusted context or seller-supplied fenced text; the two channels must never be concatenated, and the test for which one a new block belongs to is who can influence its content.
---

# The two prompt channels

> [!note] Re-reviewed 2026-08-15 — the drift was a threshold, not a channel
> `grading-eval.ts` changed, so the guard fired. The change is the eval gate's
> default max MAE dropping from 1.0 to 0.5 (US-2301 AC6). This note is about
> which prompt SURFACES the eval can compare, and that is untouched — the gate
> still compiles the same text into both legs, and the suffix/hash rules are
> unchanged. The threshold itself now lives in [[grading-eval-gate]].

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
| Photo role context | a fixed per-`(image_type, image_role)` map in code — see the caveat below | US-2471 |

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

US-2215 (2026-08-17) is the same rule applied once more. That line can now read
`IT 48 ≈ US 38` — still a conclusion, and still one line. What did NOT happen is
the conversion table going into the prompt: the four corpus-derived offsets stay
in `size-systems.ts`, the grader is handed the answer, and a size the offsets
cannot reach renders exactly as it did before rather than as a hedge the model
has to interpret.

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
`+visual`, `+tag`, `+cat2`, `+roles`, in that fixed order — so accuracy-tracking can
attribute an era per block. Suffixes APPEND; reordering them would silently reinterpret
every version string already recorded against past grades. `+roles` (US-2471) went on
the end for exactly that reason, not because it belongs last.

## The photo role is a SELLER-CHOSEN selector over server-written sentences

US-2471 (flag `GRADING_PHOTO_ROLES`, **default off**) replaced "this is a detail
image" with the sentence for the role the seller assigned that slot —
`detail:fabric`, `label:care`, `detail:hardware` and eleven more, from
`IMAGE_ROLE_CONTEXT` in `ai-grading.ts`. The text is ours. **The choice of which
text is theirs**, and that is the US-2217 rule reappearing on a new surface:
selecting among trusted blocks is as powerful as writing one.

It is weaker than the style-code case, and the reason is worth being precise
about rather than reassuring about:

- The vocabulary is **closed** (`src/lib/photo-roles.ts`), so no seller string
  reaches the prompt. A role we do not recognise falls through to the type-level
  sentence, which is the pre-US-2471 text.
- A seller already controls **which photos they upload**, so a role cannot
  fabricate evidence that is not in the frame.
- But several of these sentences **do direct scoring**, in as many words:
  `detail:fabric` says "this is the primary evidence for fabric_condition, the
  heaviest factor in the grade", and `detail:hardware` says the same for
  `functional_elements`. So a mislabelled slot does not lie about the garment —
  it redirects which frame the grader treats as authoritative for the 30% factor.

That is the open question the flag exists to hold, and it is a question for the
canary rather than for a reviewer's intuition: does naming the role improve
accuracy by more than mislabelled slots cost? Nothing about this is settled by it
being off today. If it needs hardening, the shape is the one US-2217 already
used: prefer a role the SERVER can corroborate (the capture profile the photo was
taken under) over one a seller can retype afterwards.

Note the confidence side is untouched by design: `hasFabricCloseup` and
`NO_FABRIC_CLOSEUP_CONFIDENCE_CAP` still key off the image TYPE, so a role cannot
lift a cap. Widening them to roles would let a seller clear a cap by renaming a
slot, which is a different and worse bargain than the prompt one.

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
| `grading-shadow.ts` | composite only | **no** — it reuses the champion's per-image analyses |
| `grading-shadow-per-image.ts` | yes | **yes**, per block, since US-2443 |

So editing a user-message block changes live grading on the next deploy with no
gate available. That is why every one of them is **env-flag gated and additive**:
the flag is the only substitute, and byte-identity when off is what makes it a
real one.

**US-2443 changed one cell of that table and nothing else.** A per-image block
override can now be compared on live traffic, because
`grading-shadow-per-image.ts` re-analyzes the same photos under the challenger
block and re-composites. It does NOT make the eval gate cover the user message —
`runEval` still compiles the same text into both legs — and it is **off by
default**: it costs a vision call per photo plus one composite per sampled
submission, so it does nothing at all unless
`PER_IMAGE_SHADOW_DAILY_VISION_CAP` is set to a positive number AND a candidate
row carries a non-zero `shadow_sample_rate` and `shadow_daily_cap`. Three
deliberate switches, because a default here is a vision bill.

### What a flag carries, and what it does not

Worth stating flatly, because three flags in it is easy to read one as a gate:

| | Flag | Prompt version |
|---|---|---|
| Reversible without a deploy | **yes** | yes |
| Cannot reach sellers unless someone decides | **yes** | yes |
| Measured against a golden set before it serves | **no** | yes |
| Compared on live traffic before it serves | **no** | yes, both stages (US-2443) |
| Identifiable afterwards on a grade record | **no** | yes |

A flag is a **switch**, not a gate. It answers "can we turn this off again?" and
says nothing about whether turning it on was a good idea. Treating one as
evidence is the mistake to avoid — and it is a comfortable mistake, because a
flag-gated rollout has the shape of a careful one.

The fingerprint is the partial remedy: `unversionedPromptSurfaceHash()`
(`ai-grading.ts`) digests the assembled user message, and every eval run reports
it as `unversioned_surface`. It cannot make a run safe — it makes two runs
**comparable or not**. Runs with different hashes measured different prompts, so
a promotion decision spanning that boundary is reading noise, however close the
MAE looks.

> [!note] `covered` is no longer `false` (US-2438, 2026-08-08)
> This paragraph used to quote the field as a literal `false`. It is now the
> LIST of block keys the registry versions, and the report carries a `blocks`
> field naming the active overrides — see "What was built" below for why the
> second field is load-bearing rather than decorative.

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

### What was built, and what the seam does NOT yet cover

Built 2026-08-08 (US-2438): `ai_prompt_block_versions` (migration 00563) and
`prompt-blocks.ts`. Two facts about it are load-bearing.

**It resolves nothing of its own.** `resolveSlotFromRows` and
`pickPromptForBucket` in `canary-rollout.ts` do the work, unchanged, exactly as
they do for the system prompt. A second copy of that precedence logic is how the
two would come to disagree about what a scoped row means, so the block path hands
the *same* functions a filtered row set and a per-block slot key. It also shares
the system prompt's cache signal (`"grading-prompt"`), so every existing
`invalidatePromptCache()` call site is already correct for blocks — two signals
would be two things to remember, failing silently when one was forgotten.

**An empty registry is byte-identical, and that is measured, not asserted.**
`unversionedPromptSurfaceHash()` was `baf5d4cb` before the seam and `baf5d4cb`
after. That is what let this ship without an eval run: it cannot change a prompt
until somebody activates a row.

**Coverage.** Seven blocks. Per-image: `garment_type_criteria`,
`category_criteria`, `per_image_response_schema`, `per_image_rules`. Composite:
`composite_factor_weights`, `composite_response_schema`, `composite_rules`. Every
static block of both user messages now has an identity; what remains outside the
registry is the *generated* context (baseline, fabric, tag), which is a different
thing — those are already flag-gated because their cost is a database read or a
vision call, not a string.

All five tails were extracted verbatim. The surface hash was `baf5d4cb` before
and `baf5d4cb` after every one of them, and that is the proof, not the intent.

**Schema and rules are split, in both stages.** The rules are what an operator
actually tunes — what counts as unassessable, how strict the manipulation check
is — while the schema is the contract the parser depends on. One block would mean
every rules tweak restates a ~55-line schema, which is the restating-an-invariant
shape this whole registry exists to avoid.

The factor-weights sentence is its **own** block rather than part of the schema.
It is the only line in the prompt that restates the contract in
[[grading-scale-and-weights]], so an override of it changes the arithmetic the
product is sold on and has to be reviewable by itself, not buried in a 38-line
schema diff.

Composite blocks deliberately **do not** accept an eval candidate. The gate
scores per-image block candidates; letting a composite block through without a
composite shadow path would give it a route to "qualified" the per-image blocks
do not have, and the two would then mean different things by *passed*.

**That sentence was true as a decision and false as a description, for months
(found 2026-08-09).** `compositeGrade()` refused the override, and said so in a
comment — but `runEval` never checked. It read the candidate row's `stage`,
accepted a composite block, built the override, and passed it to
`analyzeImage` **only**, whose per-image prompt contains no composite block. So
the run graded the CHAMPION end to end and wrote the result into
`grading_eval_runs` under the candidate's own `block:…` label.

Not a missing feature — a **false pass**, and the worst shape one: a gate whose
whole job is to say "this was measured and it qualified" saying exactly that
about a change that never ran. `grading-eval.ts` now refuses a composite block
explicitly, before the first vision call, and
`grading-eval-block-stage_test.ts` pins both halves — the refusal, and that
per-image candidates still reach `analyzeImage`.

The generalisable bit: **a decision recorded only as a comment is enforced
nowhere.** The refusing file and the calling file were different files, each
correct in isolation. Same lesson as the "no route does X" absence-claim in
[[shipped-but-unwired]] — if it is load-bearing, pin it with a test.

Half of the original reason is also now stale. US-2443 built a per-image shadow
path, so a per-image block has all three legs. A composite block still has none:
`grading-shadow.ts` compares two composite PROMPTS over reused per-image
evidence and has no notion of a block. Giving composite blocks a shadow leg is
what lifts the refusal.

`runEval`'s `unversioned_surface.covered` is therefore a LIST of block keys, not
a boolean. It stopped being the literal `false` the moment the registry could
version something — but a `true` would claim the gate measures a surface it does
not, and only a list can say which half.

### The seam opened a hole in the fingerprint, and closing it is the subtle part

`unversionedPromptSurfaceHash()` digests the **code defaults**. The moment a row
can replace one of those at runtime, the hash stops describing what actually ran:
two eval runs under different block versions carry the **same** hash and read as
comparable. That is worse than having no fingerprint, because the hash's only job
is to say when two runs must *not* be compared — it converts "we do not know"
into "we checked", which is the exact failure mode this whole mechanism exists to
prevent.

So `runEval` now reports `unversioned_surface.blocks`: the ACTIVE block
overrides at run time, sorted, and logged beside the verdict as well as returned.
Canaries are excluded deliberately — an eval run has no `bucketKey`, so it never
takes a canary slice, and listing one would describe traffic the run did not
serve.

The general form worth carrying: **a fingerprint's blind spot grows every time
you add a way to vary what it fingerprints.** Adding a seam is also a change to
every guarantee that was resting on the absence of one.

### The gate can now hold ONE block variable

`runEval` takes an optional `blockCandidate`. When set, the SYSTEM prompt stays
whatever is active and exactly one user-message block is pinned to the candidate
row — the candidate merges *over* the resolved set, so every other block still
resolves the production way. An eval that also reverted the others to code
defaults would score the candidate against a prompt no customer gets.

Four decisions in there are worth not re-deriving:

- **An empty `block_text` is refused, not scored.** Empty means "the code default
  under this name" — the prompt already in production. Running anyway stamps a
  pass on a row that changes nothing, which later reads as a qualified change.
- **An unknown `block_key` is refused too**, which is the *opposite* of the
  serving rule. Inert is right when serving (a typo must not take down grading)
  and wrong at the gate (qualifying a row the resolver would never serve).
- **The case filter follows the block's own scope dimension.**
  `ai_prompt_versions.garment_scope` has always meant garment_category, but
  `garment_type_criteria` is scoped by garment_TYPE. Filtering that by category
  matches zero cases, and "no active eval cases" reads as a missing golden set
  rather than as a bug — a wrong answer wearing a plausible costume.
- **`grading_eval_runs.prompt_version_id` is NULL for a block run**, because that
  column is an FK to `ai_prompt_versions` and the id is from a different table.
  The run is identified by `prompt_version_name`, which carries the full
  `block:<key>[<scope>]=<version>` label. No migration was needed: the column has
  been nullable since 00050.

The verdict is written back to `ai_prompt_block_versions.eval_passed`. That table
has no `qualified_model`, deliberately: a block does not choose a model, it rides
whichever one its stage serves on, so US-2036's model-stamp check stays on the
stage's own prompt version.

### The env flags are KEPT, and the reason is a distinction worth stating

US-2438 AC4 asks whether `GRADING_BASELINES`, `GRADING_TAG_OCR` and
`GRADING_CATEGORY_CRITERIA_V2` are retired now that a real seam exists. All three
are kept, because **the registry versions TEXT and two of those flags gate WORK.**

| Flag | What it actually gates | Replaceable by the registry? |
|---|---|---|
| `GRADING_BASELINES` | a DB read plus, on a cache miss, an AI **generation** | no |
| `GRADING_TAG_OCR` | an entire extra **vision call** over the label photo | no |
| `GRADING_CATEGORY_CRITERIA_V2` | which of two in-code maps is read — pure text | in principle, yes |

A block override supplies a string. By the time a string is wanted, the
generation and the vision call have already been paid for, so no row can express
"skip the work". The third flag *could* go, and is still kept: retiring it today
would turn eleven categories' criteria on with no gate at all, which is the
opposite of the point. It retires when block rows for those categories exist and
have cleared the gate.

The general form: **a switch over a side effect and a switch over content are not
interchangeable, however similar they look at the call site.** Both render as
`block ? text : ""`. Only one of them saves a vision call.

That is also why every key in the vocabulary is backed by a static in-code
default, and why a test asserts the request array in `analyzeImage` contains no
`await`. A block whose default needed IO would be a block whose flag this
registry had silently failed to replace — while making that flag *look*
redundant.

`listing-eval.ts` reports `covered: []` and `blocks: []`, and that is not
boilerplate. The block registry is keyed by grading stage; `LISTING_GEN_TOOL` is
a tool schema, not a prompt block, so the registry cannot reach it. Now that both
gates have a field of the same name, borrowing the grading gate's coverage there
would be the easiest possible way to overstate it, and a test forbids it.

**Attribution landed at the per-image entry, deliberately.** A block override
appends `+blocks(key=version,…)` to `per_image_analysis[].prompt_version`, not to
`grade_reports.prompt_version`. That column already carries an ordered suffix
chain (`+baseline`/`+fabric`/`+visual`/`+tag`/`+cat2`) whose order reinterprets
every version string ever recorded if it moves, so a new suffix went onto the
carrier that has no ordering contract yet.

## Related

- [[grading-scale-and-weights]] — the factors these prompts produce.
- [[weighted-overall-lockstep]] — what happens to the scores afterwards.
