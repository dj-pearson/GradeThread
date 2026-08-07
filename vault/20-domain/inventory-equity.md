---
title: Inventory Equity — the Phase 1 scope fence
type: contract
status: current
source_of_truth: vault
code_refs:
  - src/lib/inventory-equity-disclosure.ts
  - src/test/inventory-equity-scope-fence.test.ts
  - src/components/flipdesk/inventory-equity-card.tsx
  - ios/GradeThread/Money/InventoryEquityCard.swift
  - services/edge-functions/src/lib/inventory-equity.ts
  - services/edge-functions/src/routes/flipdesk-equity.ts
  - services/edge-functions/src/routes/jobs-equity-snapshot.ts
  - supabase/migrations/00442_inventory_equity_snapshots.sql
reviewed: 2026-08-07
tags: [flipdesk, finance, valuation, scope-fence]
summary: Inventory Equity values graded stock for DISPLAY only; lending against it is deferred by founder decision, and the fence is enforced by a discovery-based guard rather than by anyone remembering it.
---

# Inventory Equity — the Phase 1 scope fence

Inventory Equity ("GradeThread Capital", Phase 1) shows a reseller the estimated
liquidation value of their **graded** inventory: the capital sitting on their
racks, and how much of the rack is unvalued because it is ungraded. Epic
US-1868; shipped by US-1869 (model + endpoint), US-1870 (web dashboard +
equity-over-time trend) and US-1871 (iOS Money tab).

The number is built entirely from data already held — stored grades, cached
comps, [[grading-scale-and-weights|condition]] curves, and the seller's own
sell-through. That is also why it is the strongest organic grading incentive in
the product: grading more of the rack values more of the rack.

## The fence

**Phase 1 is DISPLAY-ONLY valuation.** Phase 2 — working-capital advances or
lending against inventory — is deferred on legal and financial-responsibility
grounds (founder decision, 2026-07-09). Do not build lending, credit offers,
advances, underwriting, or "get funded" flows, **UI hints included**, without a
new explicit founder green-light. No Phase 2 child stories exist by design; do
not create them. Revisit only post-launch, with counsel.

Three rules follow, and each is enforced somewhere a build can see it:

1. **Every equity display carries the same disclosure, verbatim.** It is
   `EQUITY_ESTIMATE_DISCLOSURE` in `src/lib/inventory-equity-disclosure.ts` —
   one sentence saying the figure is an estimate, what it is made of, and that
   it is *not an appraisal, an offer, or borrowing capacity*. iOS and Android
   cannot import the module; they carry the identical literal, and the guard
   compares them to it. A per-platform paraphrase is how one surface ends up
   promising what the others do not.
2. **No Phase-2 vocabulary in equity product copy.** `PHASE_2_REFUSED_TERMS`
   lists it. Bare "credit" is deliberately absent — grading credits are an
   unrelated concept, and a guard that fires on the product's own vocabulary
   gets deleted rather than obeyed.
3. **No new AI or comp spend.** The endpoint composes `inventory_items.comp_set`
   that some earlier action already paid for; the nightly snapshot job runs the
   same path for every seller, so a live fetch here would multiply by the whole
   user base. Existing comp-refresh quotas (US-1749) are the only budget.

## Why a guard and not a paragraph

A scope fence written only in acceptance criteria has no compiler. The story
that crosses it is, by definition, the one whose author never read the story
that drew it — so the fence has to be checkable from inside the build.

`src/test/inventory-equity-scope-fence.test.ts` finds equity surfaces by
**discovery** (any source file under `src/`, `services/edge-functions/src/`,
`functions/`, `ios/` or `android/` whose path matches `equity`) rather than from
a list, for the same reason [[buyer-legal-and-privacy|the buyer PII export]]
iterates a register: a hand-written list of surfaces omits the surface that
breaks the rule. It was written while US-1871 was still unbuilt and covered it
on the day it landed.

That has one consequence worth knowing before you add a surface. Discovery is by
PATH, and every `.swift`/`.tsx`/`.kt` file it finds must RENDER the disclosure —
so the iOS card keeps its read models, transport, store and views in one
`InventoryEquityCard.swift`. Splitting them across four equity-named files would
mean four copies of the sentence or four exemptions, and an exemption is how a
fence stops fencing.

Two things it deliberately does not do. It strips comments before scanning, so
the header comments that *declare* the fence do not trip it. And it says nothing
about whether the valuation is any good — `inventory-equity_test.ts` owns that.
This guard only polices what the estimate is allowed to claim to be.

## What the estimate is

Conservatism is the product: a number the seller trusts beats a number that
flatters. So every haircut only ever discounts, and an item that cannot be
priced honestly is **excluded and counted**, never guessed.

- Ungraded item → excluded, reason `no_grade`. Fewer than three cached comps →
  excluded, reason `no_comps`. Excluded items move the unvalued count, never the
  total.
- Market anchor is the median of the item's cached comps, then multiplied by two
  factors ≤ 1: the seller's own median days-to-sell (unknown velocity takes a
  real haircut, not a free pass) and how long this item has sat listed.
- The band widens as comp confidence falls, clamped to ±10–50%.
- Sold, shipped, completed and archived items are realized, not equity.

Distinct from [[buyer-platform|the buyer-side]] Wardrobe Portfolio (US-1824),
which values a closet. This is the seller/FlipDesk inventory side.

## Related

- [[thrift-radar]] — the other Phase-1 intelligence surface built only from data already held
- [[buyer-legal-and-privacy]] — the register-not-a-list pattern this guard borrows
- [[grading-scale-and-weights]] — the grades the valuation keys on
- [[moc-domain]]
