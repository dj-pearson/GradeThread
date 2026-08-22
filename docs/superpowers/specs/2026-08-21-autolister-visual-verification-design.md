# AutoLister visual verification and style-line expansion

Date: 2026-08-21
Stories: US-2778, US-2779, US-2780, US-2781

## The problem

Two provers look at the same garment and only one of them is in the room.

eBay's `search_by_image` was measured on production against 24 real thrift
photos (US-2758, `vault/30-platform/ebay-visual-search.md`). On a whole-garment
shot with no tag in frame it named the brand 5/5 and sometimes the exact style
down to the cuff detail. It costs no Claude tokens and takes about one second.

Claude reads tags, reasons about construction, and produces the listing. It is
also the half that guesses when the photo does not say, and a guess arrives
looking like a read.

The pairing is already built. `lib/visual-identify-pass.ts` runs the search,
`lib/visual-aspect-consensus.ts` agrees on what the matched listings declare,
and `lib/visual-candidates.ts` hands the result to Claude as an explicitly
unverified guess under a precedence ladder that a legible tag always wins.

It has one caller: `routes/flipdesk-ai.ts:234`, the single-item capture screen.

`generateListing` (`lib/ai-listing.ts:1488`) is the function AutoLister's batch
worker calls, and it never touches any of it. Grep for "visual" in that file
returns four prompt comments and zero calls.

Three consequences, which this spec addresses in order:

1. Every batch-generated listing is produced with no eBay corroboration.
2. The pass searches one photo. A garment has three or four usable angles and
   their agreement is the confidence signal that does not currently exist.
3. Style lines are dropped on the floor. `visual-aspect-consensus.ts` reads only
   structured item specifics, and thrift sellers rarely fill `Model` or
   `Product Line`. The style name is in the comp titles, which that module
   refuses to read.

## Non-goals

- Changing the precedence ladder. A tag beats a visual match, and that stays.
- Letting any visual result assert a value. Everything here offers; Claude and
  the seller dispose. `visual-aspect-prefill.ts` already establishes that
  posture and this follows it.
- Turning the flag on. `SCOUT_EBAY_IMAGE_SEARCH_ENABLED` stays owner-controlled.
  Every story below is byte-identical to today's behaviour with the flag off.
- Reading comp titles as consensus. `lib/style-code-aspects.ts` refuses to, for
  reasons the owner gave and that still hold. US-2781 does not overturn that
  rule; see its section.

## US-2778: AutoLister calls the visual pass

### Where it goes

`generateListing`, step 2, immediately after `loadItemPhotoUrls`. The call is
`startVisualPass(...)`, which returns a promise and is deliberately not awaited
there.

The three passes that follow it in that function are all network-bound and all
already run before generation: the MeasureCard autofill, the tag-OCR pass
(`extractTagGroundTruth`), and the size estimate. The visual pass overlaps them
and is awaited just before `generateListingFields`, so it costs no wall clock in
the common case.

### How the result reaches the model

A new optional `visualCandidates?: VisualCandidate[]` on `ListingGenInput`
(`lib/ai-listing.ts:205`). `generateListingFields` renders it with the existing
`buildCandidateBlock` from `lib/visual-candidates.ts` and appends it to the
`lines` array it already assembles.

Nothing about the block changes. Same wording, same precedence ladder, same
instruction to report a verdict per candidate.

### The gap this exposes, and what it does about it

`buildCandidateBlock` ends by telling the model to report every decision in
`visual_rulings`. `extractItemFields` has that field on its tool schema. The
`create_ebay_listing` tool does not.

So `LISTING_GEN_TOOL` gains an optional `visual_rulings` array with the same
four keys (`field`, `value`, `verdict`, `evidence`). Optional, so a prompt
version that never sees a candidate block is unaffected, and the parser treats
an absent array as an empty one.

Without this the block asks for a decision and gives it nowhere to go, which is
the exact failure the comment at `lib/visual-candidates.ts:113` records from the
first cut of the extract path.

### Provenance

`generateListing` writes `identification_provenance` through the existing
`buildExtractionRow` / writer in `lib/identification-provenance.ts`, keyed to
the item and the `ai_enrichment_log` row generation already writes.

Best-effort, exactly as the capture path treats it: a failed provenance write
must never fail a generation. That property is already in that module and this
story does not weaken it.

### Ownership and isolation

`generateListing` is already ownership-scoped: it loads the item with
`.eq("user_id", ownerId)` at line 1497 and every write descends from that row.
The provenance write takes `ownerUserId` from the same `ownerId` argument, never
from a request body. A `tenant-isolation_test.ts` case pins that the row lands
on the owning workspace.

`ownItemIds` is passed so a seller's own live eBay listings cannot corroborate
their own item. `routes/flipdesk-ai.ts` already computes this set; the batch
path needs the same lookup.

### Acceptance

- Flag off: `generateListing` makes zero eBay image calls and the assembled
  prompt content is byte-identical to today. Asserted by a test that captures
  the content array.
- Flag on with a front photo: the candidate block appears in the prompt, and a
  provenance row is written carrying both what was offered and what was ruled.
- Flag on with only detail/measurement photos: the pass declines with
  `role_not_identifying`, no block appears, and generation proceeds unchanged.
- An eBay outage, a timeout, or a malformed response degrades to no block. Never
  an error, never a partial application.

## US-2779: read the scorecard

`identification_provenance` has a writer, a test, and an entry in the rls-guard
list. Nothing reads it. Three greps across the repo confirm it.

The point of the table is answering "why was this wrong", and the distinction it
was built to preserve is that *nothing offered*, *offered and ignored*, and
*offered and refused* are three different findings with three different fixes.
A number that collapses them is worse than no number.

### What it produces

An admin endpoint under the existing `routes/admin-*` surface plus a small page,
reporting over a date range:

- Candidates offered, by field.
- Verdicts, by field: accepted, rejected, and *never ruled on* (offered, absent
  from `visual_rulings`). The third is a prompt bug, not a model judgement, and
  it must not be counted as a rejection.
- On acceptances, the evidence kind the model named, so `visual_consensus`
  acceptances can be separated from ones a tag or a style code backed.
- Decline reasons for runs that produced no candidates at all, so
  `role_not_identifying` and `no_matches` are distinguishable.

### Acceptance

- The aggregation is a pure function over rows, unit-tested with no database.
- Never-ruled is its own bucket, asserted by a test with a candidate absent from
  the rulings array.
- Admin-gated the way the other admin reads are, with the same MFA step-up.
- Read-only. This story writes nothing.

## US-2780: multi-photo corroboration

### The case it fixes

From the measurement note: a teal sleeveless tank, flatlay, no brand mark
anywhere in the photo, returned five Lululemon tanks. It may be right. eBay
expressed no doubt and the photo cannot settle it.

A second angle can. If the back shot of that tank returns generic tanks, the
brand has one photo behind it, not five listings.

### The rule

Search up to three photos instead of one. Prefer `front`, then `back`, then
`flatlay`, at most one per role, hard cap of three. `label` and `tag` stay
eligible only when fewer than three garment shots exist, because the measured
tag result depends on a legible wordmark we cannot detect from the role.

A candidate's value must win a majority of the photos that returned anything.
`tallyAspect` already implements exactly this and already refuses ties, so the
voting rule is reused rather than reinvented.

`VisualCandidate` gains `photosAgreeing` and `photosSearched`.
`buildCandidateBlock` renders them: "declared by 3 of 5 similar listings, on 2
of 3 photos searched".

A 1-of-3 candidate is offered **with that number attached**, not suppressed.
Claude can see the photos and this module cannot; hiding a weak signal is
deciding on its behalf, which is the posture the whole block exists to avoid.

### Cost

Three search calls, still zero Claude tokens, run concurrently. Median measured
latency at 1600px/q75 is 935ms, so concurrency keeps this near the single-photo
cost.

Aspect reads stay capped at `MAX_ASPECT_READS = 5` **in total**, not per photo.
Those are the expensive half (one extra Browse call each, because
`item_summary` does not carry `localizedAspects`) and tripling them to sharpen a
vote the first few already decide is the trade that module explicitly refused.

Photo fetches are deduplicated: one download per distinct URL regardless of how
many roles map to it.

### Acceptance

- Photo selection is a pure function, unit-tested against role lists including
  duplicates, unknown roles, and empty.
- A field agreed by two photos and contradicted by a third is offered with
  `photosAgreeing: 2, photosSearched: 3`.
- A field where two photos tie is dropped, per `tallyAspect`.
- Total aspect reads across all photos never exceed `MAX_ASPECT_READS`.
- One photo available behaves identically to US-2778.

## US-2781: the style-line miner

### The refusal this respects

`lib/style-code-aspects.ts` opens by recording why titles are not evidence:

1. A title is marketing text, written by a seller who may have guessed.
2. Our own sellers publish to eBay with titles our AI wrote, so reading them
   back counts three copies of one guess as three witnesses.

That reasoning is correct and this story does not overturn it. The change is
narrower: a title may **generate** a candidate. It may never **confirm** one.

### The two stages

**Mine.** A new pure module `lib/visual-style-names.ts` takes the comp titles
and produces candidate names. It strips the brand, size tokens, condition
tokens ("EUC", "NWT"), and colourway noise, then collects word groups of two to
five words appearing in at least two listings. Our own listing ids are excluded
first, using the `ownItemIds` set the pass already carries.

**Corroborate.** A mined name survives only with a second source that is not a
title:

- an existing `brand_styles` row for that brand whose name matches, or
- a `brand_style_codes` decoder hit from a style code read off the tag by the
  OCR pass (`resolveStyleCode`, `lib/brand-normalize.ts:1818`), or
- the `Model` or `Product Line` aspect consensus that
  `lib/visual-aspect-consensus.ts` already computes.

Corroborated, it becomes a `style` candidate in the same block with evidence
kind `visual_consensus`. Claude can still reject it against the photos.

Uncorroborated, it goes nowhere near the listing. It is written to the existing
US-2216 style-code review queue as a candidate name for the owner to approve,
which is the machine `routes/admin-brand-knowledge.ts` and
`lib/style-code-review.ts` already run for exactly this purpose. An approved
name becomes a `brand_styles` row and corroborates the next garment itself.

That closes the loop the vault note asks for: the KB gets denser from real
listings, and it gets denser only through a human.

### Acceptance

- The miner is pure and unit-tested: brand stripping, size and condition token
  removal, n-gram support counting, own-listing exclusion.
- A name with no second source never reaches `visualCandidates`. Asserted
  directly.
- A name with a second source is offered with `evidence: "visual_consensus"` and
  is still rejectable by the model.
- Queue writes are best-effort and never fail a generation.
- Flag off, the miner does not run.

## Rollout

Ship in id order. US-2778 alone makes AutoLister no worse and starts filling the
table. US-2779 is what says whether US-2780 and US-2781 are worth having, and it
is deliberately placed before them for that reason.

The flag stays off until the owner turns it on. Every story is a no-op in that
state, which is what makes shipping them in sequence safe.

## Testing

Every new decision module is pure and tested without a network:

- photo selection and multi-photo agreement (US-2780)
- the name miner and its corroboration gate (US-2781)
- the provenance aggregation (US-2779)

The pass itself is tested through the injected `searchByImage` seam that
`src/tests/visual-identify-pass_test.ts` already uses.

New tenant-isolation cases cover the provenance write and the review-queue write
from the batch path, per US-268.

No migration is expected. `identification_provenance` exists, and the style-code
review tables exist. If US-2781 needs a column for the queue's source, it
carries the US-1108 triple and is held per the standing rule.
