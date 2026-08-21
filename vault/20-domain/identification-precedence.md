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
  - services/edge-functions/src/lib/ai-extract.ts
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

## Related

- [[ebay-visual-search]] — what visual search measured, per photo type
- [[style-code-index-evidence]] — why titles were rejected as a source
- [[sync-source-of-truth]] — the wider provenance model
- [[brand-kb-decoder-bar]] — when a tag code may recover a brand at all
