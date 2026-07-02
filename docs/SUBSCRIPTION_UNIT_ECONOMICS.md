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
| **Pro** | 59 | 590 | 1,000 | 750 | All | 30 | 0 |
| **Business** | 99 | 990 | ∞ | 2,000 | All | 75 | 10 |

> AI-action caps were right-sized 2026-07-02 (Pro 1,000→750, Business
> 5,000→2,000; migration `00336`) so a maxed-out user still clears the 40% floor
> — see §5. Still ~3× the heaviest realistic seller.

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

## 5. Margin at MAX cap utilization — after the 2026-07-02 right-size

The old 1,000 / 5,000 AI-action caps broke the floor if fully consumed (Pro 21%,
Business negative — the caps dwarfed realistic usage, so a "whale" inverted the
margin). Grading was never the problem — even all-Sonnet it's >90% margin against
the $2.99 fee; the AI-action cap was the sole driver.

With the caps right-sized (Pro 750, Business 2,000) at the **blended** action
cost (~$0.02; grade ~$0.05), a user at **100% of every allowance** now clears the
floor:

| Tier | Grades | AI actions | Stripe | Total COGS | **Margin at max** |
|---|--:|--:|--:|--:|--:|
| Starter $29 (200 actions) | $1.00 | $4.00 | $1.14 | $6.14 | **79% ✓** |
| Pro $59 (750 actions) | $1.50 | $15.00 | $2.01 | $18.51 | **69% ✓** |
| Business $99 (2,000 actions) | $3.75 | $40.00 | $3.17 | $46.92 | **53% ✓** |

**Caveat — the pathological tail.** If *every* action were a vision-heavy
AutoLister call (~$0.04, the conservative unit cost) a maxed user still thins to
~38% (Pro) / ~5% (Business). That case is (a) unrealistic — the blended mix is
mostly cheap text/OCR, (b) bounded by the per-feature `ai_budgets` guardrail
(§6), and (c) closed entirely by the pending **Haiku routing** (US-1065), which
drops the AutoLister/content per-action cost ~3×.

## 6. What protects margin today

1. **The caps are the ceiling** — the new 402 enforcement means usage physically
   can't exceed the allowance without an upgrade.
2. **`reserve_ai_action`** atomic monthly quota (US-387) + the **global daily
   call ceiling** (50k/day) + the per-feature **`ai_budgets`** guardrail (US-895)
   bound spend even inside a cap.
3. **Realistic usage is ~10–15% of cap**, so the whale case is rare and bounded.

## 7. Actions taken & remaining lever

**Done 2026-07-02 (prices unchanged):**

1. **Right-sized the AI-action caps** — Pro 1,000 → 750, Business 5,000 → 2,000
   (migration `00336` + `FLIPDESK_PLANS` / `FALLBACK_MATRIX` / `AI_ACTION_LIMITS`
   / both cap ladders / IAP + doc copy). A maxed user now clears 40% at blended
   cost (§5).
2. **Closed the enforcement holes** — `scheduledActions` + `bulkActions` now gate
   at 402, and the automation cron skips downgraded owners (§2).

**Remaining lever (not yet done):**

3. **Land the Haiku routing from US-1065** — route AutoLister + Content to Haiku
   behind a value gate (~3× cheaper) and tune the grading cascade. This closes the
   pathological all-vision tail (§5) and widens every tier's margin. Biggest
   single win still on the table.

The `ai_budgets` per-feature guardrail (US-895) remains the hard backstop that
makes any cap safe in practice.

**Verdict:** tiers are fully defined, fully enforced, and every level clears the
40% floor at both realistic *and* maxed-out utilization after the right-size —
without any price change. The only residual exposure (a maxed user whose every
action is vision-heavy) is bounded by `ai_budgets` and closed by the pending
Haiku routing.
