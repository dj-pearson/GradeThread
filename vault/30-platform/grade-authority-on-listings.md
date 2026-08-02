---
title: How a grade appears on a listing — text only
aliases: [no badge overlay, no slab image, Condition Grade specific, cert number]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/routes/flipdesk-ebay.ts
  - services/edge-functions/src/lib/cert-number.ts
  - src/lib/listing-templates.ts
reviewed: 2026-08-01
tags: [ebay, listings, grading, policy, contract]
summary: A grade reaches a marketplace listing as text and a structured specific only — never burned into a photo, never as a QR slab image, never as a link.
---

# How a grade appears on a listing — text only

**Decision, 2026-06-25: a grade never touches a listing photo.** No badge burned
into the hero image, no QR "digital slab" image attached to the listing.
Marketplaces can suspend an account for third-party grading marks or QR codes on
listing **photos**, and the downside is asymmetric — a suspended account loses
every listing, while text carries the same information at zero risk.

This is a policy constraint, not a design preference. Do not reintroduce an image
treatment because it would look better.

## The three channels a grade actually uses

1. **Description text.** The client's `gradeBlock` (`src/lib/listing-templates.ts`)
   writes the grade line; the server appends the cert number in
   `applyGradeListingPromotion` (`flipdesk-ebay.ts`).
2. **A structured item specific.** `applyGradeListingPromotion` adds
   `"Condition Grade" → "X.X (GradeThread)"` to the aspect map. It is added
   **after** aspect sanitisation, so it always rides along.
3. **A cert number the buyer can type.** `grade_reports.certificate_number` — a
   unique Crockford-base32 `GT-XXXXXXX` minted at grade time by
   `generateUniqueCertNumber` (`lib/cert-number.ts`) and exposed on the public
   cert view. Buyers verify at **`/verify`**, which resolves the number
   anonymously. That is what replaces a clickable link.

The split between 1 and 2 is not arbitrary: the client writes the grade line
because the item row has the grade, and the **server** appends the cert number
because the unique number lives on the grade report, which the client does not
have. `ensureGradeLine` re-adds the line idempotently, keyed on the phrase
"Condition Grade" — an AI rewrite, especially "regenerate", writes a fresh
description that drops it, and the seller's preview would then show no grade on
an item publish is about to re-assert one for.

`applyGradeListingPromotion` runs for **every** graded item with no opt-in
toggle — it is zero-risk text, so a per-listing switch would only create a way to
publish an under-described listing. The old `badge_enabled`, `auto_grade_badge`,
`slab_image_mode` and `auto_slab_image` gates are gone from the publish path.

## No links. Not one.

A gradethread.com URL in a description reads to eBay as "offering to buy or sell
outside eBay" and **hides the listing** — an observed hit, not a theoretical
risk. See [[ebay-description-freshness]] for the policy and the reference number.

`stripCertLinks` scrubs links at **publish and revise**, including out of drafts
that were stored before the rule existed. It also runs for ungraded items,
because the legacy linked seller-credential block could be anywhere.

> A verified-seller block once reintroduced an `<a href>` and reached a real
> batch before it was caught. Any new listing-description feature must ship
> text-only: **no `<a>`, no URL, no bare domain.**

## What still exists but is no longer wired

The slab page (`functions/slab/cert/[id].ts`) is still there for social sharing
and standalone use — it is simply never attached to a listing. `grade-badge.ts`,
`src/lib/slab-image.ts` and the `listings.slab_image_mode` /
`flipdesk_settings.auto_grade_badge` columns are inert leftovers that publish no
longer reads.

Their inertness is worth knowing before someone "reconnects" one: this is a
deliberate policy retirement, which is exactly the distinction
[[shipped-but-unwired]] exists to draw.

A historical 422 "1 photo unreachable" on graded publishes was the slab URL
failing a HEAD probe. It cannot recur, since nothing attaches a slab.

## Related

- [[ebay-description-freshness]] — the no-links policy, and why descriptions freeze
- [[grading-scale-and-weights]] — what the number in that text means
- [[shipped-but-unwired]] — telling a retirement apart from an oversight
- [[INDEX]]
