# FlipDesk Dogfood Runbook (US-137 / PRD §11.1, §14.2)

The automated half of US-137 ships in the repo:

- **`e2e/flipdesk-lifecycle.spec.ts`** — Playwright drive of the lifecycle UI
  (intake → pipeline → sold → P&L) against the network-mock seam. Runs in the
  existing CI e2e job; no eBay sandbox / staging creds needed.
- **`src/lib/__tests__/flipdesk-lifecycle.test.ts`** — deterministic assertions
  for status transitions, fee allocation, and net-profit P&L, proving the
  frontend live P&L (`computePnl`) agrees with the edge sync's stored
  `net_profit` formula to the cent.

This runbook covers the two acceptance criteria that are **operator actions, not
code** — they require eBay sandbox credentials, a real garment, and four weeks of
daily use, so they are executed by the operator and logged here, not automated.

---

## 1. Live-infra smoke (AC#1, AC#2 — against staging + eBay sandbox + R2)

The mocked spec proves the UI wiring. This pass proves the *real* integrations.
Run once before opening the private beta (PRD §11.2 gate).

**Prerequisites**

- [ ] eBay **sandbox** app keys (App ID / Cert ID / Dev ID) + a sandbox seller
      account, set in the edge service env (`EBAY_*`, `EBAY_ENV=sandbox`).
- [ ] Staging Supabase project URL + anon/service keys.
- [ ] R2 (or R2-compatible) bucket reachable; image uploads land and return URLs.
- [ ] A test garment with visible condition + a brand tag.

**Steps (tick as you go — these mirror AC#1 verbatim):**

1. [ ] Sign up a fresh account on staging.
2. [ ] Connect the **eBay sandbox** account (OAuth round-trip completes, token stored).
3. [ ] Create a **source** (e.g. "Goodwill bins", thrift).
4. [ ] **Intake** an item (auto-SKU assigned, status → `sourced`).
5. [ ] **Upload photos** (front/back/tag/detail) — confirm they land in storage.
6. [ ] **Measure** (status → `measured`).
7. [ ] **Send to GradeThread** (status → `grading`; submission + charge created).
8. [ ] **Wait for grade** (status → `graded`; grade value + certificate appear).
9. [ ] **Comp** (Browse comps return; target price set; status → `comped`).
10. [ ] **Draft listing** (composer produces title/description; status → `drafted`).
11. [ ] **Push to sandbox eBay** (Inventory → offer → publish; listingId returned;
        status → `listed`).
12. [ ] **Simulate a sandbox sale** (eBay sandbox "buy" flow or order injection).
13. [ ] **Reconcile a payout CSV** (import the sandbox payout; fees + payout
        allocated onto the sale).
14. [ ] **Verify `net_profit`** on the item detail page equals
        `sale_price + shipping_collected − fees − shipping − grading − other − cost_basis`
        (tax excluded). Cross-check against the deterministic test's formula.

**Result**

- Date run: `__________`   Operator: `__________`
- Pass / Fail: `__________`
- eBay sandbox listing URL: `__________`
- Observed `net_profit` vs expected: `__________`

---

## 2. Operator dogfood + friction log (AC#4 — PRD §11.1)

Use FlipDesk as your daily driver for real listings. Log every point of
friction so it becomes the pre-beta polish backlog.

| Date | Stage (intake/measure/grade/comp/draft/list/sell/reconcile) | Friction observed | Severity (blocker/major/minor) | Fix idea / story |
|------|------|------|------|------|
|      |      |      |      |      |
|      |      |      |      |      |
|      |      |      |      |      |

> Promote every **blocker** and **major** row to a `prd.json` story before beta.

---

## 3. Success metric (AC#5 — PRD §14.2)

**Target:** ≥ **50% increase in items-listed-per-week** vs the spreadsheet
baseline, sustained over **4 weeks** of daily use.

**Metric definition:** count of items whose status reaches `listed` (first time)
within the ISO week, per the `items_full` / listings history. Pull weekly from
the FlipDesk analytics surface (`src/lib/flipdesk-analytics.ts`).

**Baseline (spreadsheet, pre-FlipDesk):**

- Avg items listed / week over the last 4 spreadsheet weeks: `______`
- 50%-uplift target = baseline × 1.5 = `______` items/week

**Tracking:**

| Week | Start date | Items listed | Δ vs baseline | Hit target (≥1.5×)? | Notes |
|------|-----------|--------------|---------------|----------------------|-------|
| 1    |           |              |               |                      |       |
| 2    |           |              |               |                      |       |
| 3    |           |              |               |                      |       |
| 4    |           |              |               |                      |       |

**Verdict (after week 4):** Target met? `Yes / No` — if no, capture the
bottleneck stage (from the friction log) as the next sprint's focus.

---

### Sign-off

US-137 is fully satisfied when: (a) the two automated suites are green in CI,
(b) §1 live-infra smoke passes once against the eBay sandbox, (c) §2 friction log
has been triaged, and (d) §3 shows the 4-week metric outcome (met or with a
documented remediation plan). (b)–(d) are operator actions gated on eBay sandbox
provisioning; record their completion above.
