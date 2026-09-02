---
title: How an item is identified — the precedence
type: contract
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/lib/visual-candidates.ts
  - services/edge-functions/src/lib/visual-identify-pass.ts
  - services/edge-functions/src/lib/visual-aspect-consensus.ts
  - services/edge-functions/src/lib/category-decision.ts
  - services/edge-functions/src/lib/scout-identify.ts
  - services/edge-functions/src/lib/prospect-identify.ts
  - services/edge-functions/src/lib/ai-extract.ts
  - services/edge-functions/src/lib/identification-provenance.ts
  - services/edge-functions/src/lib/listing-style-code.ts
  - services/edge-functions/src/lib/listing-registered-number.ts
reviewed: 2026-08-21
tags: [identification, ebay, ai, category, contract]
summary: Brand, style and category are decided by an ORDERING of evidence kinds - decoded style code, then tag wordmark, then visual consensus, then model knowledge - and not by whichever source reports the higher confidence.
---

# How an item is identified — the precedence

Two systems can name a garment and they fail in different places. eBay's visual
search reads silhouette, pattern and drape. Claude reads words photographed on a
tag. Neither covers the other's blind spot, which is why both run — and why the
order they run in is a contract rather than an implementation detail.

Measurements for the visual half live in [[ebay-visual-search]]. This note is
the decision rule they feed.

## The ordering

Strongest first. A lower row never overrides a higher one.

| # | Evidence | Why it sits here |
|---|---|---|
| 1 | **Decoded style code** | A number printed on the size tag. It decodes or it does not; there is nothing to be uncertain about. |
| 2 | **Tag wordmark** | Words photographed on the garment. The seller can re-read them. |
| 3 | **Visual consensus** | Live listings that LOOK like this. Confident either way. |
| 4 | **Model knowledge** | What the model recalls about the product line. |

`EVIDENCE_PRECEDENCE` in `visual-candidates.ts` is the only place this order
exists in code. A tie goes to the **incumbent**: a challenger of equal strength
adds no information, and changing a field for no reason is how a correct value
gets replaced by a plausible one.

> [!warning] This cannot be a confidence score, and that is the point
> These are different KINDS of claim, not different amounts of one. A visual
> match with forty supporting listings still loses to one legible tag — and it
> would win on any number, because it has forty of something. Replacing the
> ordering with a score silently inverts it.

## Before the ordering: which mechanism runs at all

The table above adjudicates between evidence that EXISTS. A separate decision
comes first — whether visual search is consulted for this item, and whether the
tag is read. It is made in `prospect-identify.ts` and it follows **what the
seller photographed**, which is the one signal neither mechanism can fake.

| What is in frame | What runs | Why |
|---|---|---|
| a `tag` or `label` photo | `extractMatchHints` reads the tag | Text printed on the garment is row 2, and it is what they went to the trouble of photographing. |
| `front` / `back` / `flatlay` only | eBay visual search | There is no text to read, so hints would be looking for something that is not there. Costs no metered AI action. |
| anything else, or unlabelled | the hints path, unchanged | An unlabelled photo is likelier to be a detail shot than a flatlay. |

When visual search carries it, `extractMatchHints` does not run at all — one
metered AI action per prospect instead of two. A visual search that declines or
finds nothing falls back to hints and pays the ordinary action; that fallback is
silent to the seller and visible in the `reason` field.

### Visual search is never shown a photo it cannot identify from

`roleCanIdentify` in `scout-identify.ts` gates the call on the photo's role, and
`IDENTIFYING_PHOTO_ROLES` is `{front, back, flatlay, label, tag}`. Every entry is
a measured result, not an opinion — see [[ebay-visual-search]].

This is a gate on the INPUT rather than a filter on the output, and that is the
whole design. A care label, a tape measure across a hem and a defect macro do
not return weak answers that could be filtered downstream; they return confident
ones about the wrong thing, indistinguishable in the response from the correct
ones. There is nothing to filter on, so the only place to decide is before the
call.

**An unknown role is refused, not permitted.** Neither route labels its photos
yet, so that default is currently what keeps visual search off on unlabelled
input.

### A guessed identity is never written as fact

Every `IdentifyOutcome` carries `identitySource` (`barcode` | `tag` | `visual`)
and `identityIsAuthoritative`. Only a barcode is authoritative. A tag read is
strong — row 2 — but still offered rather than saved, because OCR misreads and a
tag can name a parent brand or a licensee.

The two providers had opposite postures and the weaker one was the more
confident: `hintsProvider` already refused to prefill from a keyword hit, while
`ebayImageProvider` took `items[0].title` unconditionally from a pure similarity
match. `identifyConfidence` for a visual match is a flat 0.5 rather than a
borrowed number, because the measurement showed visual search being equally
confident when right and when wrong.

## What each source is trusted for

- **Visual search** is trusted to say where similar garments get LISTED
  (category) and what similar listings DECLARE (brand, type). It is not trusted
  to name the brand of the garment in front of you.
- **Claude** is trusted to read what is in the photo and to adjudicate. It is
  not trusted to inherit a candidate it cannot justify — see below.
- **Neither** is trusted to write a field the seller confirmed.

## The adjudication, and the trap in it

Candidates go to the model in their own prompt block, headed
`UNVERIFIED EXTERNAL GUESS`, stating the ordering above and saying the tag wins
however many listings agreed.

They do **not** go in the neighbouring `ALREADY KNOWN` block. That one is
rendered as *"ground truth — do not contradict, only fill gaps"*, and a
similarity match placed there would settle the question before the model looked
at a photo. A teal tank with no brand mark anywhere in frame returned five
Lululemon tanks with no expressed doubt; that is not ground truth.

Two rules that exist because instructions alone do not hold:

1. The block **licenses rejection explicitly**. Without that line a model reads
   rejecting as failing to be useful.
2. An acceptance naming no evidence is **dropped server-side**. "Accept only
   with evidence" is an instruction, and a model under pressure to help will
   accept anyway. Same posture as `RESEARCH_MIN_CONFIDENCE`, which drops
   low-confidence identifications rather than trusting self-censorship.

## Category is decided separately, and by votes

Category was `suggestCategories(query)[0]` — the first keyword hit on a phrase
the model wrote. `category-decision.ts` replaces it with, in order: what the
seller already set, then the **leaf** that visually similar listings sit in,
then that same keyword search as the floor.

Three rules worth knowing:

- **Only leaves vote.** Five listings agreeing on "Women's Clothing" tells you
  nothing and cannot be listed into. Measured on a real response: five matching
  half-zips agreed 5-0 on the ancestor and split 3-1-1 across three leaves.
- **A tie loses.** It falls through to keywords. Breaking a tie by array order
  is the same reflex as taking hit number one, in nicer clothes.
- **The leaf check fails open.** An eBay outage must not silently downgrade
  every listing to the weaker path during the incident nobody is watching.

## Evidence quality is inherited from the style-code index

The rule that a listing contributes only through **structured item specifics**,
never its title, and that our own listings are excluded by id, is not a new
decision here. It was settled in [[style-code-index-evidence]] after title
consensus shipped and had to be deleted. The same two reasons apply unchanged:
a title is marketing text, and our own sellers publish titles our AI wrote, so
mining them reads our own guesses back as corroboration.

Also inherited: somebody else's **size** is never harvested. A visual match is a
different physical garment that happens to be the same product.

## The AutoLister call sites (2026-09-02)

Row 1 of the ordering did not reach the listing until this date. `generateListing`
handed the OCR'd code to `resolveStyleCode`, the sneaker resolver, which
returns null for every apparel brand, so the decoded code was null, the Style
Code aspect stayed empty and every mined product name was dropped for want of a
code to file it under. Prod on 2026-09-02: 1,001 items, none with a Style Code
aspect, 71 Lululemon items titled "Pullover" and "Tank".

`lib/listing-style-code.ts` now owns which code the listing files under, in
this order: the label the OCR just read, what an earlier pass stored on
`attributes.mpn`, the sneaker resolver. It decodes inside the brand's own pack
and canonicalises the spelling (US-2714). The size-dot decoder stays off here as
everywhere: it is region-scoped and nothing isolates the dot yet.

Two things the index adds, and the line between them:

- A **resolved** name (a source in a position to know, per
  [[style-code-index-evidence]]) is a fact. It becomes `knownFields.style`
  unless the seller typed a style, a labelled line in the tag ground-truth
  block, and `attributes.model`, which the aspect registry projects onto the
  leaf's Model aspect.
- An **observation-only** name (one listing's title, trimmed) is offered under
  the same `UNVERIFIED EXTERNAL GUESS` block as a visual candidate, and written
  nowhere. It can corroborate; it cannot assert.

The RN the OCR reads was passed to the prompt and discarded.
`lib/listing-registered-number.ts` applies [[rn-lookup]]'s rules on the listing
side: a match stores the number and registrant on the item, a contradiction
caps the brand's confidence below the review threshold and never changes the
brand, and an unknown number is recorded as a sighting. The RN is never an eBay
aspect.

## Where the decisions are recorded

Everything above is decided per run and would otherwise be recomputed and
thrown away. `identification_provenance` (migration 00641) keeps one row per
identification run: the category METHOD that won, the support behind a winning
vote, the reason a losing one lost, and the model's verdict on every candidate.

The row keeps **what was offered** as well as **what came back**, in two
separate columns, and that is the only interesting thing about its shape. Three
outcomes have to stay tellable apart:

| In the data | What it means | What to do about it |
|---|---|---|
| no candidates offered | visual search found nothing, or never ran | look at the photo-role gate |
| offered, no matching ruling | the model ignored the candidate | look at the prompt block |
| offered, verdict `rejected` | refused on tag evidence | the provider was wrong — measure it |

A table storing only the rulings would collapse the first and the third, which
is exactly the question it exists to answer: is visual search earning its
latency. Operator table, deny-all; nothing seller-facing reads it.

## Related

- [[ebay-visual-search]] — what visual search measured, per photo type
- [[style-code-index-evidence]] — why titles were rejected as a source
- [[sync-source-of-truth]] — the wider provenance model
- [[brand-kb-decoder-bar]] — when a tag code may recover a brand at all
- [[rn-lookup]] — what an RN may and may not say about a brand
