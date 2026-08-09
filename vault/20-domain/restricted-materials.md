---
title: Some materials are a legal question before they are a description
aliases: [CITES, exotic skins, real fur, restricted materials]
type: reference
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00460_luxury_outerwear_brand_knowledge.sql
  - supabase/migrations/00582_western_brand_knowledge.sql
  - services/edge-functions/src/tests/western-content_test.ts
reviewed: 2026-08-09
tags: [grading, compliance, materials, listings]
summary: Real fur and CITES-listed skins change what a listing may legally do, so they are named as compliance facts rather than material notes — and never identified from a photograph.
---

# Some materials are a legal question before they are a description

Most material facts are descriptive: a wool coat, a leather bag, a 50/50 blend.
Two are not. **Real fur** and **CITES-listed exotic skins** change what a listing
is allowed to do — where it can ship, which marketplaces will carry it, and what
documentation a buyer may need.

That makes them **listing-compliance facts**, and the knowledge base treats them
differently from every other material it records.

## The two established cases

| material | where it was recorded | why it matters |
|---|---|---|
| **Real coyote fur** on a Canada Goose parka | `00460` | Restricted on some marketplaces and in some jurisdictions. Fur-free since end of 2022, so it also dates the garment. |
| **Caiman, crocodile, alligator, python** on western boots | `00582` | CITES-listed. Crossing a border can require documentation, and the penalties for getting it wrong are not small. |

**Ostrich — the skin most associated with western boots — is generally not
CITES-listed.** The split does not track price or exoticness; it tracks the
treaty, which is why it has to be looked up rather than reasoned about.

## Three rules, and the second is the one that gets broken

1. **Name the material.** If a listing does not say a skin is caiman, nobody
   downstream can act on it.
2. **⚠ Never identify a restricted material from a photograph.** Caiman is
   routinely sold as alligator, and embossed cowhide is sold as both. A wrong
   species claim on an exotic is a **legal exposure**, not a description error —
   the asymmetry that makes this different from guessing a fabric. Assert only
   what the seller has stated.
3. **Flag, do not adjudicate.** Whether a specific shipment is lawful depends on
   two countries, the species, and the paperwork — none of which a grading system
   can see. The seeded tells say *this may require documentation for cross-border
   sale*; they never say *this is legal* or *this is not*.

> This is the same discipline as **never auto-authenticate**
> ([[brand-kb-negative-findings]]): state what is observable, refuse the verdict.
> Here the cost of overreaching is higher, because the wrong answer is not an
> unhappy buyer but a customs problem.

## Why it lives in `authentication_tells`

There is no schema column for "restricted material", and adding one would invite
a boolean that a grader could set from a photo — which rule 2 forbids. Recording
it as a tell keeps it as **prose a human or a prompt reads and acts on**, which is
the only safe shape for a fact whose consequence is legal.

## Related

- [[brand-kb-negative-findings]] — the never-auto-authenticate rule this mirrors
- [[grading-scale-and-weights]] — what consumes the tells
- [[uniform-and-scrubs]] — a different claim that must not travel onto a used item
