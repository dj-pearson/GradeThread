# Garment Passport — Resale-Value & Depreciation Forecast (US-1104)

> **These outputs are ESTIMATES, not guarantees.** They are derived from a
> reseller's own historical sales and are labeled as estimates everywhere they
> surface. No personal data is used — only money/condition/time scalars.

The forecast turns the longitudinal passport/sale ledger into forward-looking
valuation intelligence for a SKU class (brand + garment type [+ category]):

| Output | Meaning |
|---|---|
| **List price** | Condition-adjusted suggested asking price (cents). |
| **Days-to-sell** | Median expected listed→sold duration. |
| **12-month resale value** | Projected resale value one year out, with a confidence interval. |
| **Annual depreciation %** | Fitted (or assumed) yearly change in value (+ = declines). |
| **Confidence** | 0–1; grows with sample size, shrinks with price dispersion. |

## Where it lives

- **Math (pure, tested):** `services/edge-functions/src/lib/passport-forecast.ts`
  (`forecastDepreciation(subject, observations)`), tests in
  `src/tests/passport-forecast_test.ts`.
- **I/O shell (tenant-scoped):** `services/edge-functions/src/routes/flipdesk-forecast.ts`
  — `POST /api/flipdesk/forecast` (ad-hoc SKU class) and
  `GET /api/flipdesk/forecast/garments/:id` (one owned garment).
- **Surface:** FlipDesk Scout (`src/pages/flipdesk/scout.tsx` via
  `src/components/flipdesk/forecast-card.tsx` + `src/hooks/use-forecast.ts`).

## Data sources (per tenant)

The cohort is built **exclusively from the caller's own ledger** (US-268 tenant
isolation — every query is scoped by `user_id` / `created_by`; no cross-tenant
rows are read):

- `sales` → `sale_price`, `sold_at` ?? `sale_date`
- `inventory_items` → `brand`, `garment_type`, `garment_category`, `grade_value`
- `listings` → earliest `listed_at` (start of the listed→sold clock)

A sale joins into the cohort when its item matches every **specified** target
facet (brand / garment_type / category), case-insensitive.

## Methodology

1. **List price** — the cohort's **median** sale price, adjusted toward the
   subject's current grade via a least-squares `price ~ grade` slope **when** the
   cohort has grade spread and the subject's grade is known. The adjusted price is
   **clamped to the observed price envelope** so the model never extrapolates a
   value no comparable item actually fetched.
2. **Days-to-sell** — median of the cohort's `listed→sold` durations.
3. **12-month value** — a `log(price) ~ time` regression across the cohort yields
   an annual multiplier `exp(slope)`; the list price is carried forward one year
   by it. A fit is attempted only with **≥ 6 sales spanning ≥ 60 days** (a tight
   date cluster can't reveal a yearly trend); otherwise a conservative **15%/yr**
   default prior is used and confidence is reduced. The fitted rate is capped at
   ±60%/yr so a noisy small cohort can't imply a wild swing.
4. **Confidence & intervals** — confidence grows with sample size and shrinks with
   price dispersion (IQR/median); a non-fitted (default-prior) forecast is further
   discounted. The list-price interval is the cohort's [p25, p75]; the 12-month
   interval carries that band forward and **widens it by `1 + (1 − confidence)/2`**,
   so a thin cohort yields an honestly wide range.

## Graceful degradation (AC2)

| Cohort size | Behavior |
|---|---|
| `< 3` valid sales | `dataQuality: "insufficient"` — **all estimates are `null`**, confidence 0, with a clear "not enough sales history" message. |
| `3–5` | `dataQuality: "sparse"` — forecast emitted using the default depreciation prior, lower confidence. |
| `≥ 6` (and ≥ 60-day span) | `dataQuality: "sufficient"` — fitted depreciation trend. |

## Gating (AC4)

- **Plan tier:** the `compPulls` FlipDesk capability (pro+), the same gate as
  Scout/comps.
- **Kill-switch:** the `passport_forecast` feature flag (fail-open / default on).
