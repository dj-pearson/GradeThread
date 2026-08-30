/**
 * US-3013: canned answers for the UI-layout harness, keyed on the FIRST segment
 * of a query key.
 *
 * WHY THE FIRST SEGMENT. Every key in this codebase starts with a hand-written
 * string and then adds `user?.id` and, often, a date. The tail is not knowable
 * from a script, and the head is the part that says what is being asked for.
 *
 * WHAT BELONGS HERE. Enough shape for the page to take its LOADED branch
 * instead of its skeleton, and nothing more. These numbers are never asserted
 * on; a fixture that is plausible costs the same as one that is not, so they
 * are plausible, but that is a courtesy to whoever reads a screenshot, not a
 * contract.
 *
 * ⚠ AN ABSENT KEY IS NOT A BUG. A screen with no fixture renders its empty
 * state, which is a real layout and worth scanning too. Add a fixture when the
 * empty state is not the layout you meant to check.
 */

export const FIXTURES: Record<string, unknown> = {
  // Money overview -------------------------------------------------------
  "tax-profile": {
    fiscal_year_start_month: 1,
    filing_status: "single",
    other_household_income_cents: 0,
    income_tax_rate_bps: null,
    last_year_total_tax_cents: null,
  },
  "money-overview-ledger": [
    { ledger_accounts: { code: "4000" }, amount_cents: 41_250 },
    { ledger_accounts: { code: "5000" }, amount_cents: -14_800 },
    { ledger_accounts: { code: "6100" }, amount_cents: -2_340 },
  ],
  "money-overview-calendar": [
    { ledger_accounts: { code: "4000" }, amount_cents: 52_900 },
    { ledger_accounts: { code: "5000" }, amount_cents: -19_100 },
  ],
  // Shape copied from src/lib/estimated-tax.test.ts's RATES_2025, which is the
  // only place the real shape is written down outside the table.
  "tax-rate-year": {
    tax_year: 2026,
    ss_wage_base_cents: 17_610_000,
    social_security_rate_bps: 1_240,
    medicare_rate_bps: 290,
    se_income_factor_bps: 9_235,
    addl_medicare_rate_bps: 90,
    addl_medicare_threshold: {
      single: 20_000_000,
      married_joint: 25_000_000,
      married_separate: 12_500_000,
      head_of_household: 20_000_000,
      qualifying_surviving_spouse: 20_000_000,
    },
    safe_harbour_high_agi_cents: 15_000_000,
    safe_harbour_low_bps: 10_000,
    safe_harbour_high_bps: 11_000,
    is_provisional: false,
    note: "harness fixture",
  },
  "estimated-tax-payments": [{ quarter: 1, paid_cents: 20_000 }],
  "books-review-count": 3,

  // Expenses -------------------------------------------------------------
  // ExpenseRow (src/types/database.ts:2593). `amount` is dollars, not cents -
  // the one field on this page that breaks the house convention, and the page
  // calls .toFixed(2) on it, so a cents fixture renders "$4180.00".
  expenses: [
    {
      id: "e1",
      user_id: "00000000-0000-4000-8000-000000000001",
      category: "sourcing_travel",
      description: "Goodwill Outlet, two bins",
      amount: 41.8,
      spent_on: "2026-08-04",
      created_at: "2026-08-04T15:00:00Z",
      updated_at: "2026-08-04T15:00:00Z",
      receipt_path: null,
      receipt_mime: null,
      receipt_uploaded_at: null,
      recurs_monthly: false,
      recurrence_source_id: null,
      account_id: null,
    },
    {
      id: "e2",
      user_id: "00000000-0000-4000-8000-000000000001",
      category: "shipping_supplies",
      description: "USPS postage",
      amount: 12.65,
      spent_on: "2026-08-11",
      created_at: "2026-08-11T15:00:00Z",
      updated_at: "2026-08-11T15:00:00Z",
      receipt_path: "u1/receipts/e2.jpg",
      receipt_mime: "image/jpeg",
      receipt_uploaded_at: "2026-08-11T15:01:00Z",
      recurs_monthly: false,
      recurrence_source_id: null,
      account_id: null,
    },
    {
      id: "e3",
      user_id: "00000000-0000-4000-8000-000000000001",
      category: "subscriptions",
      description: "Uline poly mailers",
      amount: 89.4,
      spent_on: "2026-07-19",
      created_at: "2026-07-19T15:00:00Z",
      updated_at: "2026-07-19T15:00:00Z",
      receipt_path: null,
      receipt_mime: null,
      receipt_uploaded_at: null,
      recurs_monthly: true,
      recurrence_source_id: null,
      account_id: null,
    },
  ],
  // Reconcile > eBay SKU match ------------------------------------------
  // EbayListingRow (src/types/database.ts:2638). Three rows in three match
  // states, because the tab's whole job is telling them apart.
  ebay_listings: [
    {
      id: "l1",
      user_id: "00000000-0000-4000-8000-000000000001",
      ebay_item_id: "204512300001",
      custom_label: "PAT-0142",
      title: "Patagonia Better Sweater, men's medium, oatmeal",
      current_price: 68,
      available_quantity: 1,
      listing_url: "https://www.ebay.com/itm/204512300001",
      listing_format: "FIXED_PRICE",
      start_date: "2026-08-02T00:00:00Z",
      matched_item_id: "00000000-0000-4000-8000-0000000000a1",
      match_status: "matched",
      raw: {},
      imported_at: "2026-08-28T09:00:00Z",
      created_at: "2026-08-02T00:00:00Z",
      updated_at: "2026-08-28T09:00:00Z",
    },
    {
      id: "l2",
      user_id: "00000000-0000-4000-8000-000000000001",
      ebay_item_id: "204512300002",
      custom_label: null,
      title: "Levi's 501 shrink-to-fit, W32 L34",
      current_price: 44,
      available_quantity: 1,
      listing_url: "https://www.ebay.com/itm/204512300002",
      listing_format: "FIXED_PRICE",
      start_date: "2026-08-10T00:00:00Z",
      matched_item_id: null,
      match_status: "unmatched",
      raw: {},
      imported_at: "2026-08-28T09:00:00Z",
      created_at: "2026-08-10T00:00:00Z",
      updated_at: "2026-08-28T09:00:00Z",
    },
    {
      id: "l3",
      user_id: "00000000-0000-4000-8000-000000000001",
      ebay_item_id: "204512300003",
      custom_label: "OLD-STOCK",
      title: "Assorted lot, not tracked here",
      current_price: 19.5,
      available_quantity: 4,
      listing_url: "https://www.ebay.com/itm/204512300003",
      listing_format: "FIXED_PRICE",
      start_date: "2026-05-01T00:00:00Z",
      matched_item_id: null,
      match_status: "ignored",
      raw: {},
      imported_at: "2026-08-28T09:00:00Z",
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-08-28T09:00:00Z",
    },
  ],
};
