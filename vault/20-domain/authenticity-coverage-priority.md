---
title: Authenticity coverage — what we actually hold, and how to prioritize filling it
aliases: [tell coverage, authenticity priority, counterfeit prevalence]
type: decision
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/lib/authenticity-coverage.ts
  - services/edge-functions/src/lib/brand-authenticity.ts
reviewed: 2026-07-28
revisit_by: 2026-10-31
tags: [authenticity, brands, coverage, decision]
summary: All 179 seeded tell payloads are legacy-shaped and therefore inert; the paid add-on now discloses and caps rather than degrading silently, and the sourced prevalence ranking is deferred because it needs data we do not have.
---

# Authenticity coverage

## What we actually hold (measured 2026-07-28, US-2219)

| | |
|---|---|
| `authentication_tells` payloads across the packs | **179** |
| ...in the structured `{category, claim, check, redFlag}` shape | **0** |
| ...in the legacy `{tell, detail}` shape | **179** |
| Structured tells in `CANONICAL_TELLS` | 7, across 3 brands |
| ...marked verified | **0** — all are `seed:… (unverified — review in admin)` |

`coerceTell` maps a legacy entry to category `other` with no `redFlag`. So those
179 payloads are **prose the prompt reads and the verdict cannot use.** The
distinction the code now draws is between *having tells* and *having usable
tells*, and almost the entire corpus is on the wrong side of it.

Re-shaping them is US-2139's job. This note records the state and the
decision taken about the paid product in the meantime.

## Decision: disclose and cap, do not block the sale

The authenticity add-on is **purchased**. Before US-2219 a brand with nothing
checkable still produced a confident-looking assessment from generic reasoning,
and nothing in the output said so. That is the part a buyer would object to.

Two defensible answers existed:

1. **Refuse the sale** when coverage is thin.
2. **Sell it with a mandatory disclosure** and a confidence cap.

We took (2). A general construction-and-finishing assessment has real value to
some buyers even without brand tells; what is not defensible is charging for it
while *implying* brand-specific authentication. So `purchaseDisclosure()` returns
a non-null string the offer surface cannot render without, and confidence is
capped (0.6 with no tells, 0.75 with inert ones), composing by min with the
reference cap from [[grading-prompt-channels]].

Refusing the sale remains available and is a **product** call, not an
engineering one. Revisit if buyers report the disclosure is not enough.

## The prevalence ranking is deferred, and why

AC1 asked for a *sourced* ranking of brands by counterfeit exposure crossed with
our own submission volume. Half of that is available — volume is in our own
database, and `scripts/brand-style-coverage.mjs --db` already shows the shape of
that query. The other half is not: **counterfeit-exposure figures require
external sources we have not obtained**, and a ranking assembled from
recollection would be exactly the failure this corpus already documents in
[[brand-kb-negative-findings]] — an authoritative-looking list with nothing
behind it.

So the ranking is **not recorded here**, deliberately. What is recorded is the
method: rank by *(our submission volume) × (sourced counterfeit exposure)*, and
do not substitute pack-authoring order for either factor.

One observation that needs no external source and should inform the first pass:
the packs' own headers repeatedly note that Nike, adidas, Supreme, BAPE, Moncler,
Canada Goose, The North Face and Patagonia are heavily counterfeited, and every
one of them sits in a pack whose tells were written in the legacy shape. They are
where the corpus itself points.

## Related

- [[brand-kb-negative-findings]] — where absence is recorded as correct.
- [[grading-prompt-channels]] — the reference cap this one composes with.
