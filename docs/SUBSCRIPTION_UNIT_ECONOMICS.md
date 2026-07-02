# FlipDesk Subscription — Hard Limits, Enforcement & Unit Economics

Subscription-tier companion to `docs/AI_PROFITABILITY_REPORT.md` (which is
per-AI-feature). This one answers: **are the tiers fully defined, are the limits
actually enforced, and does each level clear a 40% profit floor at the current
price?** Source of truth for the numbers is `FLIPDESK_PLANS` /
`pricing-config.ts` `FALLBACK_MATRIX` and the live `pricing_plans` table.

## 1. The four tiers (hard limits)

| Tier | $/mo | $/yr | Active listings | AI actions/mo | Marketplaces (API) | Incl. Standard grades/mo | Team seats |
|---|--:|--:|--:|--:|---|--:|--:|
| **Free** | 0 | 0 | 25 | 25 | 1 (eBay) | 3 | 0 |
| **Starter** | 29 | 290 | 250 | 200 | All | 10 | 0 |
| **Pro** | 59 | 590 | 1,000 | 1,000 | All | 30 | 0 |
| **Business** | 99 | 990 | ∞ | 5,000 | All | 75 | 10 |

Feature gates by tier (`gateFlags`):

| Flag | Free | Starter | Pro | Business |
|---|:--:|:--:|:--:|:--:|
| bulkActions | ✗ | ✗ | ✓ | ✓ |
| scheduledActions | ✗ | ✗ | ✓ | ✓ |
| compPulls | ✗ | ✗ | ✓ | ✓ |
| autoRelist* | ✗ | ✗ | ✓ | ✓ |
| autolister | ✗ | ✗ | ✓ | ✓ |
| subAccounts | ✗ | ✗ | ✗ | ✓ |
| apiAccess | ✗ | ✗ | ✗ | ✓ |
| reconciliation | ✗ | ✗ | ✗ | ✓ |
| prioritySupport** | ✗ | ✗ | ✗ | ✓ |

\* `autoRelist` has no distinct server code path — plan flag + UI label only; the
automation engine's `end_listing`→drafted flow is the nearest behavior, covered
by `scheduledActions`. \*\* SLA/routing attribute, no runtime gate.

## 2. Enforcement status (where the upgrade prompt fires)

Every cap/gate resolves through `requireFlipdesk()` (`plan-gate.ts`): soft
`X-Plan-Warning` header at 80%, hard **402** (`CAP_REACHED` / `FEATURE_LOCKED`)
at 100% → the frontend `UpgradeRequiredDialog`.

| Limit / gate | Enforced? | Where |
|---|---|---|
| activeListings | ✓ | eBay publish + AutoLister publish |
| aiActions | ✓ | atomic `reserve_ai_action` (fails closed) |
| marketplaces | ✓ | eBay / Shopify / Depop connect |
| includedGrades | ✓ (as debit precedence, not a block — overflow → credits → Stripe) | `runPaymentPrecedence` |
| teamSeats | ✓ | workspace invite |
| bulkActions | ✓ **(fixed 2026-07-02)** | AI bulk-extract + eBay bulk-edit + bulk-price-quantity |
| scheduledActions | ✓ **(fixed 2026-07-02)** | automation rules create/update/run **+ the hourly cron** (skips downgraded owners) |
| compPulls | ✓ | scout + forecast |
| subAccounts / apiAccess / reconciliation | ✓ | workspace / api-keys / reconciliation |

The 2026-07-02 fixes closed three holes where any tier could use a Pro+ feature
(automation rules + eBay bulk edit/reprice) — including a grandfather leak where
a downgraded user's scheduled rules kept running via cron for free.

## 3. Cost basis (per unit)

Variable cost is ~entirely Anthropic tokens (eBay API free; storage/SES
negligible). Model = **Sonnet 5** ($3/$15 per Mtok list, same sticker as Sonnet
4.6), Haiku 4.5 ($1/$5) for text/OCR. Prompt caching on. Grading is **N+1 calls**
(one vision call per photo + one composite) but the confidence cascade (US-1066)
+ caching pull the effective per-grade cost down.

| Unit | Realistic cost | Conservative (no cascade / vision-heavy) |
|---|--:|--:|
| Standard grade | ~$0.03 | ~$0.15 |
| AI action (blended) | ~$0.02 | ~$0.04 |

Stripe: **2.9% + $0.30** per monthly charge.

## 4. Margin at realistic utilization — all tiers ≫ 40%

Realistic per-seller volume (from the US-1065 model: Pro ≈ 40 items, Business ≈
200 items/mo; AI actions ≈ items × ~3 ops; a handful of grades):

| Tier | Rev | Modeled AI + Stripe cost | **Margin** |
|---|--:|--:|--:|
| Starter (solo, ~20 items) | $29 | ~$2–3 | **~90%** |
| Pro (~40 items, ~120 actions, ~10 grades) | $59 | ~$4.7 | **~92%** |
| Business (~200 items, ~600 actions, ~30 grades) | $99 | ~$16 | **~84%** |

**At realistic usage every tier clears 40% with enormous headroom** (84–92%).
This matches the live AI-Profitability dashboard.

## 5. Margin at MAX cap utilization — Pro & Business fail the floor

If a user consumes **100% of every included allowance** (conservative unit costs
— grade $0.15, action $0.04):

| Tier | Grades | AI actions | Stripe | Total COGS | **Margin at max** |
|---|--:|--:|--:|--:|--:|
| Starter $29 | $1.50 | $8.00 | $1.14 | $10.64 | **63% ✓** |
| Pro $59 | $4.50 | $40.00 | $2.01 | $46.51 | **21% ✗** |
| Business $99 | $11.25 | $200.00 | $3.17 | $214.42 | **negative ✗✗** |

The driver is the **AI-action cap**: 1,000 (Pro) and especially **5,000
(Business)** are far larger than any realistic usage, so a maxed-out "whale"
inverts the margin. Grading is never the problem — even all-Sonnet it's >90%
margin against the $2.99 fee.

**Caps that would guarantee ≥40% even at full utilization** (current unit costs,
keeping price): Starter ~370 (current 200 is already safe), Pro ~720, Business
~1,125. Business's 5,000 cap can't hold 40% at full tilt under *any* realistic
per-action cost (it would need ≤ ~$0.009/action).

## 6. What protects margin today

1. **The caps are the ceiling** — the new 402 enforcement means usage physically
   can't exceed the allowance without an upgrade.
2. **`reserve_ai_action`** atomic monthly quota (US-387) + the **global daily
   call ceiling** (50k/day) + the per-feature **`ai_budgets`** guardrail (US-895)
   bound spend even inside a cap.
3. **Realistic usage is ~10–15% of cap**, so the whale case is rare and bounded.

## 7. Recommendation

Keep the current **prices and marketed caps** — they anchor against List
Perfectly / Vendoo and the generous ceilings are a competitive asset. To make the
40% floor a *guarantee* rather than an average, in priority order:

1. **Land the Haiku routing already recommended in US-1065** — route AutoLister +
   Content to Haiku behind a value gate (~3× cheaper) and tune the grading
   cascade. This is the single biggest lever and pushes blended per-action cost
   toward ~$0.01.
2. **Optionally right-size the Business AI-action cap** from 5,000 → ~2,000. Still
   3× the heaviest realistic seller, but bounds the worst case far closer to the
   40% floor. (Pro 1,000 → ~750 is the analogous move; lower marketing value.)
3. **Keep the `ai_budgets` per-feature guardrail as the whale backstop** — it's
   the hard stop that makes an unbounded cap safe in practice.

**Verdict:** tiers are fully defined and (as of 2026-07-02) fully enforced. At
realistic usage every level clears 40% by a wide margin. The only exposure is a
theoretical maxed-out Pro/Business user; the caps + backstops bound it, and the
Haiku routing closes it without touching price.
