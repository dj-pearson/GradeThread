---
title: AI profitability by surface
type: reference
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [ai, cost, margin]
summary: Per-surface model choice, unit cost and margin, with the keep/downgrade call for each.
---
# AI Model Evaluation & Per-Feature Profitability Report (US-1065)

> **Living deliverable.** The hard numbers below are reproduced live by the
> admin **AI Profitability** dashboard (`/admin/ai-profitability`), backed by the
> `ai_profitability(period)` RPC (migration `00240`). The RPC re-prices the real
> `ai_usage_events` ledger from `system_settings.ai_model_prices` (the same basis
> as the AI Spend page) and projects the modeled scenarios. The economics and
> scenarios are config rows (`ai_feature_economics`, `ai_usage_scenarios`) you can
> tune in the Settings Registry without a deploy — so this report stays honest as
> traffic and prices change. The prose below explains the methodology and the
> recommendations the numbers drive.

## 1. Scope & method

Every AI use case in the product is evaluated on four axes:

1. **Model choice** — which Claude tier the feature runs on today.
2. **Tokens / call** — average input + output tokens per Anthropic call
   (`avgInputTokens` / `avgOutputTokens`), from the ledger.
3. **$ / transaction vs revenue** — cost-per-action re-priced from the live rate
   table vs the revenue that action produces (a per-grade fee, a share of a
   subscription, or indirect).
4. **Profitability projection** — modeled monthly AI spend vs revenue under
   realistic internal and eBay-seller usage.

**Pricing basis.** USD per **million** tokens, from `ai_model_prices`
(deploy-free, editable):

| Model | input | output | cache write | cache read |
|---|--:|--:|--:|--:|
| `claude-opus-4-8` | 5 | 25 | 6.25 | 0.5 |
| `claude-sonnet-5` | 3 | 15 | 3.75 | 0.3 |
| `claude-sonnet-4-6` | 3 | 15 | 3.75 | 0.3 |
| `claude-haiku-4-5` | 1 | 5 | 1.25 | 0.1 |

> `claude-sonnet-5` is the current `DEFAULT_AI_MODEL` (grading, composite, and
> photo-bearing AI actions). Priced at **list** ($3/$15) — same sticker as Sonnet
> 4.6; the intro rate ($2/$10 through 2026-08-31) can be set deploy-free in
> `ai_model_prices`. The `~Cost/action` figures below are unchanged: Sonnet 5's
> per-token price matches Sonnet 4.6, and its ~30% larger token count is roughly
> offset by the intro discount through Aug 2026 (a modest cost rise thereafter).

**Cost-per-action** is `sum(re-priced token cost) / actions`, where an *action*
is a graded submission (`grading`, `authenticity`) or a single Anthropic call
(everything else). The numbers in §2 are the **modeled** baseline used to seed
projections; the dashboard overrides each with the **observed** ledger value the
moment real traffic exists for that feature.

## 2. Per-feature evaluation

| Feature | Today | Recommended | ~Cost/action | Revenue basis | Verdict |
|---|---|---|--:|---|---|
| **Grading** | sonnet-4-6 | sonnet-4-6 (+ cascade) | ~$0.02 | $2.99 / grade | **Keep.** 99%+ margin |
| **Authenticity** | sonnet-4-6 | sonnet-4-6 | ~$0.03 | $1.99 add-on | **Keep.** Liability floor |
| **AutoLister / Listings** | sonnet-4-6 | **haiku-4-5** | ~$0.01 | Pro $29/mo | **Downgrade.** ~3× cheaper |
| **Content (mktg/SEO)** | sonnet-4-6 | **haiku-4-5** | ~$0.03 | Indirect | **Downgrade.** Human-reviewed |
| **Payout reconcile** | haiku-4-5 | haiku-4-5 | ~$0.005 | Pro $29/mo | **Keep.** Mostly rules |
| **Catalog extract (OCR)** | haiku-4-5 | haiku-4-5 | ~$0.006 | Pro $29/mo | **Keep.** OCR ⇒ haiku |
| **Photo QA / roles** | haiku-4-5 | haiku-4-5 | ~$0.003 | Pro $29/mo | **Keep.** High volume |
| **Support assistant** | haiku-4-5 | haiku-4-5 | ~$0.004 | Indirect (retention) | **Keep.** KB-grounded |

### Notes by feature

- **Grading (sonnet, keep).** Vision scoring across five factors; sonnet is the
  quality floor — haiku alone under-scores cosmetic/structural defects. The
  confidence-gated **cascade (US-1066)** already runs a cheap haiku first pass and
  escalates only low-confidence / high-value items, so the *effective* per-grade
  cost trends toward haiku **without** a quality hit. At $2.99/grade, even an
  all-sonnet grade is a >99% gross-margin transaction. Do **not** cost-optimize
  the model here; optimize volume and the cascade's escalation rate.
- **Authenticity (sonnet, keep).** Vision-heavy and liability-sensitive — a wrong
  "authentic" becomes a guarantee claim that dwarfs any token saving. Stay on
  sonnet.
- **AutoLister (sonnet → haiku, downgrade).** Title / item-specifics / category
  drafting is structured extraction the seller edits anyway. Haiku is adequate at
  ~3× lower cost; reserve sonnet for ambiguous or high-value items behind a value
  gate. This is the single best routing win — autolister is the highest-call-count
  paid feature.
- **Content (sonnet → haiku, downgrade).** Blog/SEO copy is always human-reviewed
  before publish, so a haiku draft + human edit is the cost-optimal loop. Revenue
  is indirect (organic acquisition); watch absolute monthly spend, not per-action
  margin.
- **Reconcile / catalog extract / photo QA (haiku, keep).** Matching, OCR and
  is-this-the-back classification are textbook haiku tasks; sonnet adds cost with
  no measurable accuracy gain. Photo QA is the highest-call-volume feature, so
  keeping it on haiku matters most in aggregate.
- **Support assistant (haiku, keep).** KB-grounded deflection. Escalate hard
  tickets to a **human**, never to opus — a confidently-wrong support answer costs
  more than the tokens saved.

## 3. Profitability projection (modeled scenarios)

Monthly AI spend = `Σ (modeled volume × per-action cost)`; revenue is the modeled
subscription + per-action revenue. Computed live by `ai_profitability`; the
dashboard substitutes observed per-action cost wherever the ledger has data.

| Scenario | Modeled revenue | Modeled AI spend | Margin |
|---|--:|--:|--:|
| **Solo seller** (Pro $29/mo, ~40 items) | $29 | ~$2–3 | **~90%** |
| **Power seller** (Business $99/mo, ~200 items) | $99 | ~$8–12 | **~90%** |
| **Internal QA / smoke** | $0 (cost center) | ~$5–10 | n/a |
| **Platform blended** (1k sellers) | ~$42,000 | ~$1,500–2,500 | **~95%** |

The recommended haiku routing for autolister/content keeps even the heaviest
seller's AI cost a single-digit fraction of their subscription. **No feature has
cost approaching revenue** under modeled usage — the dashboard's "at risk" flag
trips only if observed cost-per-action climbs past 50% of per-action revenue.

## 4. Break-even volumes

For subscription-bundled features, break-even = how many actions/month it takes
for AI cost to consume the **whole** plan fee (the dashboard shows this per
feature). At the recommended tiers and a $29 Pro plan:

- AutoLister @ ~$0.01/call → **~2,900 listings/mo** to break even.
- Catalog extract @ ~$0.006 → **~4,800/mo**. Photo QA @ ~$0.003 → **~9,600/mo**.
- Reconcile @ ~$0.005 → **~5,800/mo**.

These ceilings are 1–2 orders of magnitude above realistic per-seller volume, so
AI cost is structurally a rounding error against subscription revenue.

## 5. Recommendations (priority order)

1. **Route AutoLister and Content to haiku** behind a quality gate. **Built for
   AutoLister** as a Haiku→Sonnet *quality-gated cascade* (`ai-action-cascade.ts`
   + `generateListingFields`): Haiku first, re-run on Sonnet only when the result
   is low-confidence / missing a category / has no item-specifics / errors.
   Shipped OFF — enable deploy-free by setting `ai_action_model_cascade.enabled =
   true` (system_settings, migration `00337`) after spot-checking Haiku output.
   Content is the remaining flow to route. Biggest absolute saving.
2. **Keep grading & authenticity on sonnet**; instead tune the **grading cascade**
   (US-1066) escalation threshold to push more of the confident majority onto the
   haiku first pass. This cuts grading cost with zero pricing/quality risk.
3. **Leave all haiku features as-is** — they are already at the right tier.
4. **The bottleneck is volume & churn, not model.** Every transaction clears
   >90% gross margin at any reasonable model mix; profitability is gated by how
   many sellers grade/list, not by which Claude tier runs. Direct optimization
   effort at activation and retention, and keep the per-feature **budgets**
   (`ai_budgets`, US-895) as the backstop against a runaway prompt.

## 6. Reproduce / keep current

- **Dashboard:** `/admin/ai-profitability` (admin + AAL2).
- **RPC:** `select public.ai_profitability('30d');`
- **Tune economics:** edit `ai_feature_economics` / `ai_usage_scenarios` in the
  Settings Registry — projections update with no deploy.
- **Re-price:** edit `ai_model_prices`; both AI Spend and AI Profitability
  re-price historical tokens from the current table.

## Related

- [[pricing]] — the fees these margins are measured against
- [[subscription-unit-economics]] — the tier-level view (its per-grade cost disagrees with this note's)
- [[INDEX]]
