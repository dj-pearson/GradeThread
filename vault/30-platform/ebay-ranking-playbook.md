---
title: eBay ranking playbook
type: reference
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [ebay, seo, growth]
summary: What actually moves Best Match placement, and what is folklore.
---
# eBay Ranking (Cassini/Best Match) Playbook — verified 2026-07-09

Source-of-truth for how eBay search actually ranks listings, verified against eBay's own docs
(help pages, Seller Center, export.ebay.com, eBay Open 2025 search-team statements) rather than
tool-vendor SEO blogs. Drives the listing-SEO epic **US-1890..US-1900**. Re-verify yearly —
eBay is moving fast on AI listing features.

## Verified model of eBay search

1. **Retrieval matches title AND item specifics** (and category/structured data) — the popular
   claim that "only the title gets you into the candidate set" is **wrong**. Descriptions are the
   thing excluded from default search (opt-in "include description"). Item specifics are also the
   left-nav filter gate: a missing aspect silently removes the listing from every filtered result.
   *Consequence: complete Required + Recommended aspects is the single highest-confidence lever;
   the title doesn't need to burn characters on every aspect value.*
2. **Title**: 80-char hard limit (official). "Use 70–80 chars" and "first words weigh more" are
   plausible vendor lore, not eBay statements — front-loading Brand is a real **CTR** lever
   (mobile truncates around ~40–55 chars). No stemming folklore: modern eBay does query
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
   **Pre-owned – Excellent / Good / Fair**; "New with defects" → "New with imperfections";
   legacy listings auto-migrated to "Pre-owned – Good". Buyers filter by condition tier;
   eBay warns inaccurate tiers reduce visibility. This maps directly onto GradeThread grades —
   a differentiator no generic lister has.
8. **Clothing aspect mandates**: Brand, Color, Department, Type required on all new/revised CSA
   listings (since 2021) + Size/Size Type/Style/Material by subcategory. Recommended aspects are
   ranked by real 30-day buyer search volume per category.
9. **Promoted Listings 2025–26**: Standard→General (CPS), Advanced→Priority (CPC); Priority now
   owns the top ad slot (US/CA); **Jan 13 2026** General moved to 30-day halo attribution
   (material cost change). No evidence promotion changes organic rank except via sales velocity.
10. **Not ranking factors** (folklore — don't build for): Best Offer as a direct signal,
    "first 35 chars", exact-token stemming tricks, listing templates/HTML, new-listing boost
    farming. Best Offer is still a good conversion lever.

## Where GradeThread already adheres (verified 2026-07-09 — don't re-audit)

- AI titles: brand-first, ≤80 enforced at generation (`title-trim.ts` word-boundary trim),
  live demand-term mining, A/B `title_variants`, eval gate (`listing-eval.ts`).
- Aspects: registry-driven column→aspect projection both directions with provenance
  (US-821..828), category-constrained second AI pass, required-aspect **publish blocker**
  (`aspect-provenance.ts` → `flipdesk-ebay.ts` preflight), SELECTION_ONLY value reconciliation.
- Category: AI query → Taxonomy `get_category_suggestions` leaf resolve, publish-time fallback,
  manual picker, post-publish category-check nudge card.
- Publish: business policies + per-listing overrides, Best Offer terms w/ comp-derived p25/p75
  thresholds (bulk-edit only), merchant location, image dedupe/cap 24, reachability preflight,
  category-aware condition remap, EPID adoption.
- Lifecycle: revise-in-place is the default (US-1490/1502/1503, bulk US-1292); relist endpoint
  is guarded, nothing auto-relists for "freshness". Compliance card (US-1422) surfaces
  ASPECTS_ADOPTION violations. Acceptance-loop learns from seller edits (US-547).

## Gaps → epic US-1890..US-1900

| Gap | Story |
|---|---|
| No 80-char/lint guard on publish+revise path (stored title sent verbatim) | US-1890 |
| **Field edits (brand/size/color…) never update the title** — the backwards-mapping ask | US-1891 |
| No title packing/quality meter (chars left unused, dup tokens, policy phrases) | US-1892 |
| No leaf-category validation guard | US-1893 |
| Condition mapping predates 2025 3-tier pre-loved apparel conditions; no conditionDescriptors | US-1894 |
| Recommended-aspect coverage not surfaced (only required blocks) | US-1895 |
| No photo dimension checks (500px hard req / 1600px zoom) or first-photo-type nudge | US-1896 |
| No unified Listing Quality Score | US-1897 |
| Best Offer absent from single-item composer | US-1898 |
| No stale-listing playbook (traffic data → revise suggestions) | US-1899 |
| Gen prompt lacks policy title rules; description guidance predates AI summaries | US-1900 |

## Related

- [[ebay-condition-and-policies]] — a rejected condition means no listing to rank
- [[cross-listing]] — reach beyond eBay
- [[INDEX]]
