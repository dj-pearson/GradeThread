---
title: How a grade appears on a listing — text only
aliases: [no badge overlay, no slab image, Condition Grade specific, cert number]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/routes/flipdesk-ebay.ts
  - services/edge-functions/src/lib/cert-number.ts
  - services/edge-functions/src/lib/gt-grade-standard.ts
  - src/lib/listing-templates.ts
  - src/test/no-dead-column-writes.test.ts
  - src/components/flipdesk/composer/photos-card.tsx
reviewed: 2026-09-02
tags: [ebay, listings, grading, policy, contract]
summary: A grade reaches a marketplace listing as text and a structured specific only — never burned into a photo, never as a QR slab image, never as a link.
---

# How a grade appears on a listing — text only

> **Re-reviewed 2026-08-17.** Drift flagged `flipdesk-ebay.ts` for the same two
> commits as the note above, both about reading eBay's response. The rule here
> is about what a grade may become on a listing — text and a structured
> specific, never burned into a photo, never a QR code — and nothing in either
> commit writes an image or an aspect.
>
> **Re-reviewed 2026-08-21.** Drift flagged `flipdesk-ebay.ts` for the US-2704 /
> US-2706 / US-2707 evidence work. This is the first change that renders grade
> facts INTO AN IMAGE and sends that image to eBay, so it deserves a straight
> answer rather than a "nothing to see here": the rule holds, because the rule
> is scoped to **listings**, and none of this reaches one.
>
> US-2706 builds a condition sheet carrying the certificate number and grade
> tier, and uploads it with the defect photographs. Every one of those calls —
> `uploadReturnFile`, `submitReturnFiles`, `uploadDisputeEvidenceFile` — goes to
> `apiHost()/post-order/v2` (see `services/edge-functions/src/lib/ebay-postorder.ts`).
> That is the returns and payment-dispute API. It is a private channel between
> the seller, the buyer and eBay's case handler, opened only once a case exists.
> No listing photo is written, no aspect is added, no link goes on a listing.
>
> **Re-reviewed 2026-08-27 (US-2935).** The evidence pack now reaches a THIRD
> eBay surface — an escalated Money Back Guarantee case, via `uploadCaseFile`
> / `submitCaseFiles` in `services/edge-functions/src/lib/ebay-cases.ts`. Same
> host, same private channel, same answer: `apiHost()/post-order/v2`, opened
> only once a case exists, no listing photo written and no aspect added. The
> rule below is unchanged; only the count of case types it does not apply to
> has gone from two to three.
>
> The distinction to keep, because the next reader will hit this and wonder: the
> ban is on grading marks appearing where a BUYER BROWSES — the hero image, the
> gallery, a QR code on the listing — which is what gets accounts suspended.
> Handing a case handler an evidence document inside a dispute they are already
> adjudicating is the opposite situation, and eBay's own API exists to receive
> it. If a future story ever proposes attaching that sheet to the listing
> itself, that is a NEW decision and this note says no.

**Decision, 2026-06-25: a grade never touches a listing photo.** No badge burned
into the hero image, no QR "digital slab" image attached to the listing.
Marketplaces can suspend an account for third-party grading marks or QR codes on
listing **photos**, and the downside is asymmetric — a suspended account loses
every listing, while text carries the same information at zero risk.

This is a policy constraint, not a design preference. Do not reintroduce an image
treatment because it would look better.

> **Reaffirmed 2026-09-02, against a story that asked for the opposite.**
> US-9206 proposed a 1000x1000 condition card appended as the last listing photo
> on Poshmark, Mercari, Vinted and Depop, on the reasoning that photo-first
> buyers never read a truncated description. The question went to Dj directly,
> with the option of allowing the card on those four channels only, and the
> answer was to keep this rule as written: the suspension risk has not changed,
> and it is the same risk whichever marketplace the photo lands on. The story is
> closed without code. If it is ever revisited, the first step is amending this
> paragraph -- not writing the renderer, which already exists
> (`lib/cert-image-render.ts`).

## The three channels a grade actually uses

1. **Description text.** The `grade` description block writes the grade line and
   the `disclosure` block writes the defect statement — both emitted by the edge
   renderer (`lib/description-blocks.ts`) on every save, from
   `listings.description_blocks`. The server still appends the cert number in
   `applyGradeListingPromotion` (`flipdesk-ebay.ts`).

   **US-2965 (2026-08-28) removed the client's second copy.** `gradeBlock` and
   `ensureGradeLine` used to write the same line into the composer's description
   string, and `{{grade}}` was in every entry of `DESCRIPTION_TEMPLATES`. That
   was correct while the description WAS one string; once the grade became its
   own block it printed the grade twice, and only the block half followed a
   later regrade. Both are gone from `src/lib/listing-templates.ts`, and
   `src/test/listing-template-coverage.test.ts` now asserts the inverse — no
   template may restate a fact a block owns.
2. **A structured item specific.** `applyGradeListingPromotion` adds
   `"Condition Grade" → "GradeThread X.X"` to the aspect map — keys and format
   from `lib/gt-grade-standard.ts`. It is added **after** aspect sanitisation, so
   it always reaches the wire; but on the PUBLISH path it never overwrites a
   value the seller already set. Only a forced resync/revise (`opts.force`)
   replaces a live value.
3. **A cert number the buyer can type.** `grade_reports.certificate_number` — a
   unique Crockford-base32 `GT-XXXXXXX` minted at grade time by
   `generateUniqueCertNumber` (`lib/cert-number.ts`) and exposed on the public
   cert view. Buyers verify at **`/verify`**, which resolves the number
   anonymously. That is what replaces a clickable link.

**All three reach a multi-variation listing too, as of US-2395 (2026-08-15).**
The group revise is handed the same link-stripped, grade-promoted description
and the same aspect map the single-offer path builds, so the grade line and the
`Condition Grade` specific ride to every variant item and to each variant's
offer. That is a consequence of the group path reusing the assembly rather than
repeating it — worth stating because the failure it avoids is silent: a
variation listing whose grade text quietly stopped being re-asserted, with
`stripCertLinks` skipped along with it, would put an off-eBay link back on a
live listing on the next revise.

The split between 1 and 2 is not arbitrary: the grade line comes out of the
render because the item row has the grade, and the **server** appends the cert
number because the unique number lives on the grade report. An AI rewrite,
especially "regenerate", writes a fresh description that carries no grade line —
which used to matter, because the draft string was the only copy and the
seller's preview would show no grade on an item publish was about to re-assert
one for. It no longer does: the `grade` block is re-emitted by the next render
whatever the rewrite said, so a rewrite that drops the line costs nothing and
nothing client-side re-adds it.

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

## The card decision, and why the code is gone (US-2382, 2026-08-02)

**A generated grade CARD in the gallery is banned too, on the same grounds.**
The card was the one open question this note used to leave to a story: an
overlay burned onto the seller's own photo is obviously out, but is a separate
generated image different? It is not. eBay's exposure is a third-party grading
mark **among the listing photos**; a card is a listing photo. The asymmetry that
decided the overlay decides the card — the three text channels above carry the
same information at zero risk, so the upside is small and the downside is every
listing on the account.

The decision was executed as **deletion, not deprecation**:

- The composer switch ("Add a grade card image to the gallery") is gone from
  `src/components/flipdesk/composer/photos-card.tsx`, with the state and the
  save-payload keys in `composer.tsx` / `composer-save.ts`.
- `src/lib/grade-badge.ts`, `services/edge-functions/src/lib/grade-badge.ts` and
  `src/lib/slab-image.ts` are deleted with their tests.
- Publish **no longer SELECTs** `badge_enabled` or `slab_image_mode`, and
  `cross-push.ts` no longer copies `badge_enabled` onto the sibling row.

The columns themselves stay: their migrations (00027, 00180) are immutable, and
so are `flipdesk_settings.auto_grade_badge` / `auto_slab_image`. What is held
instead is that nobody WRITES one —
`src/test/no-dead-column-writes.test.ts` scans every object-literal write
position across `src/`, the edge and `functions/`, and fails on a single one.

> [!important] Being fetched is not being used
> This is the lesson worth carrying out of US-2382, and it cost a shipped
> feature. After the 2026-06-25 retirement the two columns stayed in publish's
> SELECT list. US-2247 read that list, concluded "publish has always read
> `badge_enabled` and `slab_image_mode`", and shipped a seller-facing switch on
> that premise. Nothing branched on either value. A seller could flip the
> switch, save, publish, and get no card and no error — worse than an absent
> feature, because it also spends their trust. Review passed it because the
> premise *sounded* verified.
>
> Dropping the columns from the SELECT is the cheap structural fix: the
> inference cannot be made from a list they are not in. Prefer that to a comment
> saying "unused" whenever a retirement leaves a column behind. See
> [[shipped-but-unwired]] for telling a retirement apart from an oversight.

The slab page (`functions/slab/cert/[id].ts`) is still there and still served —
for social sharing and standalone use, never attached to a listing. It is
reached by `cert-share-actions.tsx` and `graded-photo-panel.tsx`, which build
its URL directly.

A historical 422 "1 photo unreachable" on graded publishes was the slab URL
failing a HEAD probe. It cannot recur, since nothing attaches a slab.

## Related

- [[ebay-description-freshness]] — the no-links policy, and why descriptions freeze
- [[grading-scale-and-weights]] — what the number in that text means
- [[shipped-but-unwired]] — telling a retirement apart from an oversight
- [[INDEX]]
