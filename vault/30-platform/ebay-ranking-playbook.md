---
title: eBay ranking playbook
type: reference
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-19
tags: [ebay, seo, growth]
summary: What actually moves Best Match placement, and what is folklore.
---
# eBay Ranking (Cassini/Best Match) Playbook — verified 2026-07-09, re-verified 2026-08-18

Source-of-truth for how eBay search actually ranks listings, verified against eBay's own docs
(help pages, Seller Center, export.ebay.com, developer.ebay.com, eBay Open 2025 search-team
statements) rather than tool-vendor SEO blogs. Drove the listing-SEO epic **US-1890..US-1900**
(all shipped). Re-verify yearly — eBay is moving fast on AI listing features.

> **On the numbers vendors publish.** Every SEO tool blog now quotes a weighting like
> "relevance 40-50%, seller performance 30-40%, listing quality 20-30%". eBay has never
> published a weighting. Treat any percentage split as invented. The ORDERING in §1-§4 below is
> defensible; the arithmetic is not, and nothing in our code should encode a vendor's numbers.

## Verified model of eBay search

1. **Retrieval matches title AND item specifics** (and category/structured data) — the popular
   claim that "only the title gets you into the candidate set" is **wrong**. Descriptions are the
   thing excluded from default search (opt-in "include description"). Item specifics are also the
   left-nav filter gate: a missing aspect silently removes the listing from every filtered result.
   *Consequence: complete Required + Recommended aspects is the single highest-confidence lever;
   the title doesn't need to burn characters on every aspect value.*
2. **Title**: 80-char hard limit (official). "Use 70-80 chars" and "first words weigh more" are
   plausible vendor lore, not eBay statements — front-loading Brand is a real **CTR** lever
   (mobile truncates around ~40-55 chars). No stemming folklore: modern eBay does query
   rewrite/expansion; don't burn chars on plural/spelling variants or duplicate tokens.
   **Policy line**: unrelated-brand comparisons ("fits like Lululemon", "style of Gucci") violate
   the search-manipulation policy for clothing — removal risk, not just wasted chars.
3. **Description**: not in default retrieval. Quality (not keywords) is a stated Best Match
   factor; eBay's app now shows AI-generated description summaries to buyers → clean factual
   text + measurements. Keyword-stuffing it is a policy violation.
4. **eBay-confirmed ranking signals** (Best Match doc id=4166 + Seller Center):
   competitive total price, free shipping ("can give your fixed price listing a boost"),
   returns accepted, 1-day handling, seller track record (Top Rated = "greater visibility"),
   item popularity (CTR/watchers/sales — "listings that get more clicks get shown more",
   eBay Sr. Director of Search, eBay Open 2025).
5. **End-and-relist is officially a myth** (same eBay Open 2025 session): it resets performance
   data/watchers/cart-adds and breaks offsite Google indexing. Recency is a minor factor.
   **Revise in place, always.** Sell Similar only for long-stale zero-engagement listings.
6. **Photos**: min 500px longest side (hard req), **1600px recommended** (zoom), up to 24, first
   photo = search thumbnail (biggest CTR lever), plain background, no text/watermarks (watermarks
   also block offsite syndication).
7. **Condition — Jan/Feb 2025 apparel change**: "Pre-owned" split into
   **Pre-owned - Excellent / Good / Fair**; "New with defects" → "New with imperfections";
   legacy listings auto-migrated to "Pre-owned - Good". Buyers filter by condition tier;
   eBay warns inaccurate tiers reduce visibility. This maps directly onto GradeThread grades —
   a differentiator no generic lister has.
8. **Clothing aspect mandates**: Brand, Color, Department, Type required on all new/revised CSA
   listings (since 2021) + Size/Size Type/Style/Material by subcategory. Recommended aspects are
   ranked by real 30-day buyer search volume per category.
9. **Promoted Listings 2025-26**: Standard→General (CPS), Advanced→Priority (CPC); Priority now
   owns the top ad slot (US/CA); **Jan 13 2026** General moved to 30-day halo attribution
   (material cost change). No evidence promotion changes organic rank except via sales velocity.

   > **We promote nothing unless the seller opts in.** Promotion resolves at
   > publish as `listing.promote_override ?? users.promote_listings_by_default`,
   > with a legacy `promo_opt_out = true` still force-disabling. The tri-state
   > matters: `promote_override` is nullable precisely so NULL can mean *inherit*
   > — the old boolean could not express it. Rate precedence is listing rate →
   > seller default → eBay's category suggestion (`resolvePublishAdRate` in
   > `lib/ebay-marketing.ts`; omitting the new arguments preserves the legacy
   > promote-unless-opted-out behaviour, which is what makes the change
   > backward-compatible).
   >
   > The backfill preserved explicit opt-outs (`promote_override = false WHERE
   > promo_opt_out`) and left everything else NULL to inherit the new off
   > default. **Live eBay ads were not touched** — the change takes effect on the
   > next publish or revise. Grandfathering existing promoted listings ON was
   > considered and declined by the owner.

   **2026-08-18 consequence, and it is the strategic one.** The 30-day any-click window pushes
   attributed-sale share from roughly half to most of a promoted seller's sales, so the same ad
   rate now bills against sales that would have closed organically. Ad spend got more expensive
   per incremental sale without buying more impressions. Every dollar of that increase is an
   argument for the organic levers in §1-§8, and it is why the next epic is worth running.
10. **Duplicate and near-duplicate demotion.** eBay's duplicate-listings policy (help id=4255)
    covers identical fixed-price listings from one seller; the enforcement menu runs from ending
    the listing to "hiding or demoting all listings from search results". Sellers report the same
    demotion on *near* duplicates: same photos plus near-identical titles across listings or
    linked accounts. **This is a live risk for any AI lister**, ours included: a template that
    writes "Nike Dri-FIT Tee Men's Large Black Short Sleeve" for nine thrifted tees produces nine
    listings that are near-identical to a token-overlap detector. One-of-a-kind clothing is the
    defence, but only if the generated title and the lead photo actually differ per item.
11. **Visual retrieval is a second, separate index.** eBay image search embeds the query photo as
    a vector and compares it against live listings' images (over a billion of them), with models
    trained specifically on Fashion. It reads colour distribution and garment silhouette, not
    text. So the lead photo is not only the CTR lever of §6 — it is the *retrieval key* for every
    buyer who searches by picture or taps "find similar". What that index rewards: the garment
    filling the frame, a plain high-contrast background so the silhouette segments cleanly, one
    garment per photo, no props or hands, no overlay text. That is a stricter spec than "a nice
    photo", and it is checkable.
12. **Agentic buyers read the structured fields, not the prose.** eBay shipped an AI shopping
    agent that takes conversational intent instead of keywords, and reports listing acceleration
    from its own Magical Listing tool. The consistent finding across agentic-commerce coverage is
    that an agent *skips* items with incomplete attributes rather than guessing at them, and
    prefers explicit machine-readable price, availability, condition, returns and shipping over
    the same facts buried in a paragraph. For us that is not a new lever, it is §1 and §7 with
    higher stakes: a missing aspect used to cost a filter, now it costs the shortlist.
13. **Not ranking factors** (folklore — don't build for): Best Offer as a direct signal,
    "first 35 chars", exact-token stemming tricks, listing templates/HTML, new-listing boost
    farming. Also added 2026-08-18, all vendor claims with no eBay statement behind them: a
    "2-4 hour elevated placement window" on publish, a "48-72 hour test period", and any specific
    percentage weighting of the ranking factors. Best Offer is still a good conversion lever, and
    watchers are real *popularity* input (§4) — just not a freshness clock you can farm.

## Where GradeThread already adheres (verified 2026-07-09, re-checked 2026-08-18 — don't re-audit)

- AI titles: brand-first, <=80 enforced at generation (`title-trim.ts` word-boundary trim),
  live demand-term mining, A/B `title_variants`, eval gate (`listing-eval.ts`).
- Aspects: registry-driven column→aspect projection both directions with provenance
  (US-821..828), category-constrained second AI pass, required-aspect **publish blocker**
  (`aspect-provenance.ts` → `flipdesk-ebay.ts` preflight), SELECTION_ONLY value reconciliation.
- Category: AI query → Taxonomy `get_category_suggestions` leaf resolve, publish-time fallback,
  manual picker, post-publish category-check nudge card.
- Publish: business policies + per-listing overrides, Best Offer terms w/ comp-derived p25/p75
  thresholds, merchant location, image dedupe/cap 24, reachability preflight, category-aware
  condition remap, EPID adoption.
- Lifecycle: revise-in-place is the default (US-1490/1502/1503, bulk US-1292); relist endpoint
  is guarded, nothing auto-relists for "freshness". Compliance card (US-1422) surfaces
  ASPECTS_ADOPTION violations. Acceptance-loop learns from seller edits (US-547).
- The whole US-1890..US-1900 epic shipped: publish/revise title lint, field-edits-update-title,
  title meter, leaf-category guard, 2025 condition tiers + conditionDescriptors, recommended-
  aspect coverage, photo dimension preflight, Listing Quality Score, composer Best Offer,
  stale-listing traffic playbook, and the `listing_gen_v2` policy-era prompt.
- Post-publish traffic: `getTrafficReport` syncs impressions/views/CTR per active listing and
  `performance-signals.ts` turns it into NO_TRAFFIC / FEW_PHOTOS / LOW_CTR / WATCHED_NO_SALE.

## Gaps found in the 2026-08-18 re-verification

Ordered by expected effect on placement, not by build cost. All ten are filed.

**Four closed on 2026-08-19** — US-2675, US-2676, US-2677 and US-2678. Their rows
are kept rather than deleted, marked SHIPPED with what actually landed, because
the gap is the reason the code looks the way it does and a reader arriving at
`demand-terms.ts` needs it. The six unmarked rows are still open.

| Story | Gap | Why it matters | Where it lands |
|---|---|---|---|
| US-2675 ✅ SHIPPED 2026-08-19 | **Demand terms are mined from ACTIVE listings only.** `getEbaySearchDemandTerms` reads `searchBrowseComps` (Browse = live inventory), so the "high-demand search terms" fed to the prompt are what other SELLERS wrote, not what buyers bought. | Supply-side language, amplified. A term everyone writes and nobody buys scores identically to a term that converts. `sold-comps.ts` already fetches realized comps — a sold-vs-active frequency LIFT is nearly free and is demand-validated. **Shipped as `mineDemandTermsWithLift`:** Jaccard-free pooled document frequency in sold titles over the same in active ones, smoothed so a term absent from active listings cannot divide by zero and win outright. Falls back to the old active-only ranking below `MIN_SOLD_COMPS`, and every term carries `source: sold \| active` so nothing downstream mistakes the fallback for sold-backed data. | `lib/demand-terms.ts`, `lib/sold-comps.ts` |
| US-2683 | **eBay's own buyer queries are never ingested.** `ads-search-terms.ts` is Google Ads. `ebay-marketing.ts` has campaigns but no `ad_report_task`. | Promoted Listings Priority (CPC) reports are the ONLY place eBay hands a seller real buyer search terms for their own items. That is ground truth for §2, and it also feeds the composer chips and the negative-term side (queries that impress but never convert). Gated on the seller running Priority. | `lib/ebay-marketing.ts` |
| US-2676 ✅ SHIPPED 2026-08-19 | **Title A/B is scored on sell-through, which barely converges.** `summarizeTitleVariantSellThrough` counts listings sold per variant. A one-of-a-kind garment sells once, so a variant needs dozens of items to reach significance and the answer arrives after the inventory is gone. | CTR at matched impressions moves in days, and §4 says CTR is itself the popularity signal. The traffic sync already stores impressions and CTR per listing; nothing joins them to the variant label or the prompt version. **Shipped as `lib/title-variant-ctr.ts`:** CTR pooled per label (total views over total impressions, never an average of per-listing rates), reading only the LATEST metrics row per listing because the sync stores eBay rolling-window totals and summing consecutive snapshots counts one impression up to seven times. Both labels must clear `MIN_VARIANT_IMPRESSIONS` independently. Sell-through is kept as a veto, not replaced: a challenger with materially worse CTR ends its trial even when the keep-rate score cleared the margin. | `lib/title-variant-ctr.ts`, `lib/listing-acceptance.ts` |
| US-2677 ✅ SHIPPED 2026-08-19 | **No near-duplicate guard across the seller's own active listings.** Nothing compares a new title or lead photo against the seller's other live items. | §10. An AI lister is a near-duplicate factory by construction, and the penalty lands on *all* the seller's listings, not just the offender. A token-overlap check at publish (same seller, same leaf category) with a "differentiate this" nudge is cheap insurance. **Shipped as `lib/title-similarity.ts`:** Jaccard over distinguishing tokens, threshold 0.5 measured from four real shapes rather than picked. The batch half matters as much as the per-listing one — nine drafts generated together are all non-live, so each compares against an empty set and passes, and they only become duplicates after publish. | `lib/title-similarity.ts`, composer |
| US-2678 ✅ SHIPPED 2026-08-19 | **Price competitiveness is missing from the Listing Quality Score.** Components WERE aspects 30 / photos 25 / title 15 / category 12 / fulfillment 10 / condition 8; they are now 27 / 23 / 13 / 11 / **price 10** / 9 / 7. Competitive total price is an eBay-CONFIRMED signal (§4) and realized comps are already computed. | The score claims to rank the fixes by value and then omits a confirmed lever the seller can act on in one field. **Shipped:** scored against the realized band from `getRealizedComps`, never against active asking prices, which are by definition the ones nobody bought. The other six weights were each cut by a tenth so the nominal total stays 100 — the score reads as a percentage, and a 110-point total would quietly make every listing look worse. No sold comps is the ORDINARY state (Marketplace Insights is a gated scope) and reports `unknown`, dropping the component from both numerator and denominator. A price UNDER the band keeps full points on purpose: this score measures ranking, and docking there would smuggle a margin opinion into a search-visibility number. | `lib/listing-quality-score.ts` |
| US-2681 | **Photo preflight checks dimensions and count, not visual-retrieval fitness.** No check that the lead photo is a single garment, filling the frame, on a plain high-contrast ground. | §11. We already run `ai-photo-qa.ts` and `ai-photo-roles.ts`, so the classifier exists; it just isn't asked this question, and the cover photo isn't chosen for it. | `lib/ai-photo-qa.ts`, `lib/listing-photo-budget.ts` |
| US-2679 | **The Listing Quality Score is not shown in the composer.** It renders in the listings table, the item page and the pipeline (`quality-score-chip.tsx`); the composer has a title meter and nothing above it. | The composer is where the fixes happen. A score plus its top-3 fixes belongs at the top of the surface that can act on them, ahead of the title card. | `src/pages/flipdesk/composer.tsx` |
| US-2680 | **The title meter's green band is a length target.** `title-quality.ts` scores 70-80 chars green. §2 flags "70-80 chars" as vendor lore, and `listing-quality-score.ts` explicitly refuses to score length for that reason. | The two surfaces disagree, and the composer is teaching the wrong lesson: pad to 70. The defensible meter counts DISTINCT searchable terms not already carried by a filled aspect. | `src/lib/title-quality.ts` |
| US-2682 | **The description carries no stable machine-readable facts block.** Measurements survive verbatim (v2 prompt) but there is no fixed-shape block an AI summariser or agent can lift cleanly. | §12. GradeThread's numeric grade and factor breakdown are structured data no other lister has; they are currently prose. | `lib/ai-listing.ts` description rules, `lib/listing-template.ts` |
| US-2674 | **`listing_gen_v2` is registered but not active.** It carries the §2 policy rules and the §3 AI-summary description guidance; v1, which has neither, is still the champion. | Whatever else ships, the prompt with the verified policy rules should be the one running. Needs the eval gate + canary, not a hot-swap. | `lib/ai-listing.ts`, `lib/listing-eval.ts` |

## Related

- [[ebay-condition-and-policies]] — a rejected condition means no listing to rank
- [[cross-listing]] — reach beyond eBay
- [[INDEX]]
