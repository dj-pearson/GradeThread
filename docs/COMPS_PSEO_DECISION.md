# Comps pSEO decision record (US-1692)

**Proposal:** publish `/comps/{brand}-{category}/` pages built from GradeThread's
comp pulls (a StockX-style, sold-price acquisition channel) — potentially the
biggest raw-traffic idea in the SEO 2.0 plan (§5 P7).

## Decision: HOLD — do not build (as of 2026-07-06)

No comps pSEO pages ship until a legal/ToS review clears publishing
comp-derived data at scale. This is recorded here so the decision is explicit,
not ambiguous, and so no thin pages accumulate in the meantime. **Status pending
counsel** — this doc is the engineering-side decision + guardrails; the legal
review itself is an external task for Pearson Media LLC.

### Why HOLD, not build-now

GradeThread's comp data derives from marketplace data (eBay Browse/Marketplace
Insights and similar). Republishing or exposing that data at scale has
marketplace-data ToS constraints that must be resolved by counsel first.
Shipping first and asking later risks the API access the whole product depends on.

### Why HOLD, not kill-forever

If counsel clears an aggregate-stats-only design, this is a category-scale
organic channel. So we hold the option open rather than killing it — but we build
nothing speculative.

## If counsel CLEARS it — the only acceptable design

- **Aggregate stats only.** Median sold price, price range, and a sell-through
  band per {brand}-{category}. **Never** republish individual listings, titles,
  photos, or seller data.
- **Per-page data-density quality bar.** A page ships only when its bucket has
  enough recent sold comps to be statistically meaningful (same discipline as the
  Condition Index / What's-It-Worth). No thin pages.
- **Condition-aware.** Tie the stats to the GradeThread grade band so the page
  says something proprietary ("what a Grade 8 {brand} {category} sells for") that
  a raw comp scrape can't.
- Re-verify the ToS position on any material change to a marketplace's data terms.

## If counsel DECLINES it

Kill permanently and delete this option from the roadmap. Ship **no** comps pSEO
pages under any design. The Condition Index / What's-It-Worth surfaces (which use
aggregate value curves already cleared for that use) remain the sanctioned way to
expose condition-value data.

## Guardrail in force now

No `/comps/*` route exists in `src/lib/seo/public-routes.ts`, no comps pSEO page
component exists, and none should be added until this decision flips to BUILD.
