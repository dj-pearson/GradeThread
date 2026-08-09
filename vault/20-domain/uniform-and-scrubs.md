---
title: Uniform is a category, not more apparel
aliases: [scrubs, uniform, medical apparel]
type: reference
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00580_scrubs_uniform_brand_knowledge.sql
  - services/edge-functions/src/tests/scrubs-uniform-content_test.ts
reviewed: 2026-08-09
tags: [grading, brands, uniform, scrubs]
summary: Scrubs size as independent separates, their colour is a compliance requirement rather than a preference, and their characteristic damage cannot be discounted into acceptability — and the same worn-and-faded photograph that is a premium in vintage tees is a failure here.
---

# Uniform is a category, not more apparel

Seeded with `00580` (US-2220). Scrubs are among the highest-volume resale
categories and the knowledge base had no coverage. Three things make them a
category rather than more garments, and none is the shape of the garment.

## 1. It is sold as separates that size independently

A scrub top and a scrub pant are two products with two size runs, routinely
bought in different sizes by the same person. So:

- **"Size M" has said half of what a buyer needs.** Both sizes belong in the
  listing.
- **A matched set is worth more than the two pieces apart**, and splitting a set
  to sell faster usually destroys that premium.
- **No per-brand size chart is seeded**, deliberately. One chart would flatten two
  independent runs into a claim neither supports. See [[brand-kb-sizing-units]]
  for the general rule this is an instance of.

## 2. Colour is compliance, not taste

Hospitals mandate scrub colour by role and by unit. That makes colour the
**primary search term** in the category rather than a preference, and it gives a
**discontinued colour a real premium** — a nurse whose unit wears it cannot
simply pick another.

Treat the colour name as part of the item's identity. Getting it approximately
right ("blue") is getting it wrong.

## 3. The defects are occupational, and they are terminal

Bleach spotting, betadine/iodine and blood are the characteristic damage. Unlike
almost everything else graded here, they cannot be discounted into acceptability:
the garment has to read as clean in a clinical setting.

> **Grade a bleach spot closer to a hole than to a stain.**

## ⚠ The same photograph, read two opposite ways

`00579` (vintage tees) and `00580` (scrubs) shipped the same day, and together
they are the clearest argument this epic has produced for per-category guidance:

| observation | vintage band tee | scrubs |
|---|---|---|
| thin, faded, softened | **the premium** — it is what the category is bought for | **the failure** |
| a matched set | not a concept | worth more than the parts |
| colour | a variant | a compliance requirement |

One condition rubric cannot hold both. A grader that learns "fade is wear" is
wrong half the time, and so is a grader that learns the opposite. See
[[brand-kb-negative-findings]] for the vintage side, and [[small-leather-goods]]
for a third category with its own inversion (patina).

## A finish claim does not survive resale

Antimicrobial and fluid-repellent finishes are **applied treatments** that degrade
with laundering, and there is no way to verify one on a used garment.

Carry the brand's claim as a fact about the **model**. Never state or imply that
*this* second-hand item still has it — that is advertising an entitlement the
object may no longer hold, the same discipline the guarantee wording follows.

## ⚠ "Dickies" on a scrub top is not the workwear house

Careismatic publishes its portfolio: Cherokee, Infinity, Healing Hands, **Dickies
Medical**, Med Couture, heartsoul, AllHeart, Medelita. So Dickies Medical carries
the Dickies name **under licence**, while `dickies` has pointed at the workwear
house since `00389` — whose pack, tells and sizing are about work pants.

Dickies Medical is therefore its **own canonical**, not a fold. A shared name is
not a shared brand, and resolving a scrub top onto the workwear pack would hand
it the wrong chart. This is the Fossil licensing trap in a new costume.

**WonderWink is deliberately not attributed to any parent.** It does not appear in
Careismatic's published portfolio — the obvious guess that every large scrub label
shares a parent is simply wrong — and no ownership could be sourced. An unsourced
corporate relationship is the same class of invention as an unsourced era.

## Related

- [[brand-kb-sizing-units]] — why no chart is seeded here
- [[brand-kb-negative-findings]] — the vintage-tee inversion, and the RN traps
- [[small-leather-goods]] — a third category whose wear reads backwards
- [[brand-kb-provenance]] — why an unsourced relationship is not seeded
