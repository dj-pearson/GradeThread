// US-1295: affiliate payout pure math + accrual/payout decision logic. No env/DB
// needed — affiliate-payout-math.ts is dependency-free by design.
import { assert, assertEquals } from "@std/assert";
import {
  type AffiliatePayoutConfig,
  centsToDollars,
  crossesTaxThreshold,
  DEFAULT_AFFILIATE_PAYOUT_CONFIG,
  dollarsToCents,
  isPastHold,
  isPayoutRetryable,
  MAX_PAYOUT_RETRY_AGE_MS,
  normalizeAffiliatePayoutConfig,
  planAccrual,
  planPayout,
  clampCommissionPct,
  commissionForSubscriptionInvoice,
  isWithinCommissionWindow,
  CREATOR_COMMISSION_MIN_PCT,
  CREATOR_COMMISSION_MAX_PCT,
} from "../lib/affiliate-payout-math.ts";

const active: AffiliatePayoutConfig = {
  // US-9212 added four creator-model fields; spread the default so this fixture
  // stays about the mode it is testing rather than restating the whole config.
  ...DEFAULT_AFFILIATE_PAYOUT_CONFIG,
  mode: "batched",
  commission_per_conversion: 5,
  minimum_payout: 25,
  hold_days: 30,
  tax_threshold_usd: 600,
};

// ── Money units (US-1655: integer cents) ─────────────────────────────────────

Deno.test("dollarsToCents: converts USD to integer cents, killing float drift", () => {
  assertEquals(dollarsToCents(5), 500);
  assertEquals(dollarsToCents(25), 2500);
  assertEquals(dollarsToCents(0), 0);
  assertEquals(dollarsToCents(0.1), 10);
  // 0.1 + 0.2 = 0.30000000000000004 in binary float → must land on exactly 30¢.
  assertEquals(dollarsToCents(0.1 + 0.2), 30);
  assertEquals(dollarsToCents(4.99), 499);
  // Non-finite → 0 (never NaN into a money column).
  assertEquals(dollarsToCents(Number.NaN), 0);
  assertEquals(dollarsToCents(Infinity), 0);
});

Deno.test("centsToDollars: converts integer cents back to USD dollars", () => {
  assertEquals(centsToDollars(500), 5);
  assertEquals(centsToDollars(2500), 25);
  assertEquals(centsToDollars(12345), 123.45);
  assertEquals(centsToDollars(0), 0);
  assertEquals(centsToDollars(Number.NaN), 0);
});

Deno.test("dollars↔cents round-trips exactly for representative amounts", () => {
  for (const usd of [0, 0.1, 5, 25, 123.45, 599.99, 600]) {
    assertEquals(centsToDollars(dollarsToCents(usd)), usd);
  }
});

// ── Accrual on conversion ────────────────────────────────────────────────────

Deno.test("planAccrual: an affiliate conversion accrues the configured rate (in cents)", () => {
  assertEquals(
    planAccrual({
      attributionSource: "affiliate",
      mode: active.mode,
      rate: active.commission_per_conversion,
      alreadyAccrued: false,
    }),
    { action: "accrue", amount: 500 }, // $5.00 → 500¢
  );
});

Deno.test("planAccrual: a fractional-dollar rate accrues exact cents", () => {
  assertEquals(
    planAccrual({ attributionSource: "affiliate", mode: "batched", rate: 4.99, alreadyAccrued: false }),
    { action: "accrue", amount: 499 },
  );
});

Deno.test("planAccrual: a direct (non-affiliate) conversion accrues nothing", () => {
  assertEquals(
    planAccrual({ attributionSource: "direct", mode: "batched", rate: 5, alreadyAccrued: false }),
    { action: "skip", reason: "not_affiliate" },
  );
});

Deno.test("planAccrual: the engine being off accrues nothing", () => {
  assertEquals(
    planAccrual({ attributionSource: "affiliate", mode: "off", rate: 5, alreadyAccrued: false }),
    { action: "skip", reason: "disabled" },
  );
});

Deno.test("planAccrual: a $0 rate accrues nothing", () => {
  assertEquals(
    planAccrual({ attributionSource: "affiliate", mode: "batched", rate: 0, alreadyAccrued: false }),
    { action: "skip", reason: "zero_rate" },
  );
});

Deno.test("planAccrual: an already-accrued conversion is a no-op (idempotent)", () => {
  assertEquals(
    planAccrual({ attributionSource: "affiliate", mode: "batched", rate: 5, alreadyAccrued: true }),
    { action: "skip", reason: "already_accrued" },
  );
});

// ── Idempotent payout decision ───────────────────────────────────────────────

Deno.test("planPayout: an onboarded balance over the minimum pays out (cents)", () => {
  assertEquals(
    planPayout({ eligibleBalanceCents: 3000, minimum: 25, onboarded: true, taxProfileComplete: true }),
    { action: "pay", amount: 3000 }, // $30.00 balance, $25.00 minimum
  );
});

Deno.test("planPayout: a balance exactly at the minimum pays out (inclusive)", () => {
  assertEquals(
    planPayout({ eligibleBalanceCents: 2500, minimum: 25, onboarded: true, taxProfileComplete: true }),
    { action: "pay", amount: 2500 },
  );
});

Deno.test("planPayout: a zero eligible balance is skipped (idempotent re-run)", () => {
  // After a payout claims the commissions, a second run sees 0¢ → never re-pays.
  assertEquals(
    planPayout({ eligibleBalanceCents: 0, minimum: 25, onboarded: true }),
    { action: "skip", reason: "no_balance" },
  );
});

Deno.test("planPayout: a balance below the minimum is held", () => {
  assertEquals(
    planPayout({ eligibleBalanceCents: 1000, minimum: 25, onboarded: true }),
    { action: "skip", reason: "below_minimum" },
  );
});

Deno.test("planPayout: a not-yet-onboarded affiliate is held, not paid", () => {
  assertEquals(
    planPayout({ eligibleBalanceCents: 10000, minimum: 25, onboarded: false }),
    { action: "skip", reason: "not_onboarded" },
  );
});

// ── Hold window ──────────────────────────────────────────────────────────────

Deno.test("isPastHold: a future hold is not yet payable; a past hold is", () => {
  const now = 1_000_000;
  assertEquals(isPastHold(now + 1, now), false);
  assertEquals(isPastHold(now - 1, now), true);
  assertEquals(isPastHold(now, now), true);
  // A missing/garbage hold is treated as already elapsed.
  assertEquals(isPastHold(null, now), true);
  assertEquals(isPastHold(undefined, now), true);
});

// ── Retry cap (US-1653) ──────────────────────────────────────────────────────

Deno.test("isPayoutRetryable: within the cap retries; past it stops", () => {
  const now = 10 * MAX_PAYOUT_RETRY_AGE_MS; // arbitrary "now" comfortably past 0
  // Just created → retryable.
  assertEquals(isPayoutRetryable(now, now), true);
  // Exactly at the cap boundary → still retryable (inclusive).
  assertEquals(isPayoutRetryable(now - MAX_PAYOUT_RETRY_AGE_MS, now), true);
  // One ms past the cap → stale, no longer retried.
  assertEquals(isPayoutRetryable(now - MAX_PAYOUT_RETRY_AGE_MS - 1, now), false);
});

Deno.test("isPayoutRetryable: a missing/garbage created_at fails open (retryable)", () => {
  const now = 1_000_000;
  assertEquals(isPayoutRetryable(null, now), true);
  assertEquals(isPayoutRetryable(undefined, now), true);
  assertEquals(isPayoutRetryable(Number.NaN, now), true);
});

Deno.test("isPayoutRetryable: honors an explicit maxAge override", () => {
  const now = 1_000_000;
  const oneDay = 24 * 60 * 60 * 1000;
  assertEquals(isPayoutRetryable(now - oneDay, now, 2 * oneDay), true);
  assertEquals(isPayoutRetryable(now - 3 * oneDay, now, 2 * oneDay), false);
});

// ── 1099 threshold flag ──────────────────────────────────────────────────────

Deno.test("crossesTaxThreshold: flags at/over the threshold, not below (paidYtd in cents)", () => {
  // paidYtd is integer cents; threshold is USD dollars.
  assertEquals(crossesTaxThreshold(59_999, 600), false); // $599.99 < $600
  assertEquals(crossesTaxThreshold(60_000, 600), true); // $600.00 == $600
  assertEquals(crossesTaxThreshold(120_000, 600), true); // $1200 > $600
  // A 0/negative threshold disables the flag.
  assertEquals(crossesTaxThreshold(100_000, 0), false);
});

// ── Config normalization ─────────────────────────────────────────────────────

Deno.test("normalizeAffiliatePayoutConfig: coerces garbage to safe defaults", () => {
  assertEquals(
    normalizeAffiliatePayoutConfig({
      mode: "nonsense",
      commission_per_conversion: -3,
      minimum_payout: "abc",
      hold_days: 14.7,
      tax_threshold_usd: 600,
    }),
    {
      ...DEFAULT_AFFILIATE_PAYOUT_CONFIG,
      mode: "off",
      commission_per_conversion: DEFAULT_AFFILIATE_PAYOUT_CONFIG.commission_per_conversion,
      minimum_payout: DEFAULT_AFFILIATE_PAYOUT_CONFIG.minimum_payout,
      hold_days: 14,
      tax_threshold_usd: 600,
    },
  );
});

Deno.test("normalizeAffiliatePayoutConfig: passes a valid batched config through", () => {
  assertEquals(normalizeAffiliatePayoutConfig(active), active);
});

Deno.test("normalizeAffiliatePayoutConfig: a null/garbage blob yields defaults", () => {
  for (const raw of [null, undefined, 42, "x"]) {
    assertEquals(normalizeAffiliatePayoutConfig(raw), DEFAULT_AFFILIATE_PAYOUT_CONFIG);
  }
});

// ── US-9212: the creator commission model and the tax gate ──────────────────

Deno.test("US-9212: the default config carries the decided creator economics", () => {
  const d = DEFAULT_AFFILIATE_PAYOUT_CONFIG;
  assertEquals(d.mode, "off", "the programme still ships dark");
  assertEquals(d.commission_model, "subscription_pct");
  assertEquals(d.commission_pct, 25);
  assertEquals(d.commission_cap_usd, 250);
  assertEquals(d.commission_window_months, 12);
  assert(
    d.commission_pct >= CREATOR_COMMISSION_MIN_PCT && d.commission_pct <= CREATOR_COMMISSION_MAX_PCT,
    "the default must sit inside the 20-30 band the founder set",
  );
});

Deno.test("US-9212: a config override is clamped into the band, never honoured outside it", () => {
  assertEquals(clampCommissionPct(30, 25), 30);
  assertEquals(clampCommissionPct(300, 25), 30, "a typo must not pay 300%");
  assertEquals(clampCommissionPct(0, 25), 20, "nor must it pay nothing");
  assertEquals(clampCommissionPct("nonsense", 25), 25);
  const cfg = normalizeAffiliatePayoutConfig({ commission_pct: 99, commission_model: "flat" });
  assertEquals(cfg.commission_pct, 30);
  assertEquals(cfg.commission_model, "flat", "the legacy flat model stays reachable");
});

Deno.test("US-9212: one invoice earns its percentage, rounded down, under the cap", () => {
  // Pro at $59: 25% is $14.75.
  assertEquals(
    commissionForSubscriptionInvoice({ invoiceAmountCents: 5900, pct: 25, alreadyAccruedCents: 0, capUsd: 250 }),
    1475,
  );
  // 25% of 333 is 83.25 -> 83, never 84.
  assertEquals(
    commissionForSubscriptionInvoice({ invoiceAmountCents: 333, pct: 25, alreadyAccruedCents: 0, capUsd: 250 }),
    83,
  );
  assertEquals(
    commissionForSubscriptionInvoice({ invoiceAmountCents: -5900, pct: 25, alreadyAccruedCents: 0, capUsd: 250 }),
    0,
    "a refund earns nothing",
  );
  // The cap truncates the invoice that crosses it, and pays nothing after.
  assertEquals(
    commissionForSubscriptionInvoice({ invoiceAmountCents: 9900, pct: 25, alreadyAccruedCents: 24_900, capUsd: 250 }),
    100,
  );
  assertEquals(
    commissionForSubscriptionInvoice({ invoiceAmountCents: 9900, pct: 25, alreadyAccruedCents: 25_000, capUsd: 250 }),
    0,
  );
});

Deno.test("US-9212: only the referred account's first year counts", () => {
  const start = "2026-01-15T00:00:00Z";
  assert(isWithinCommissionWindow(start, "2026-01-15T00:00:00Z", 12));
  assert(isWithinCommissionWindow(start, "2026-12-31T23:59:59Z", 12));
  assert(!isWithinCommissionWindow(start, "2027-01-15T00:00:00Z", 12), "month 13 earns nothing");
  assert(!isWithinCommissionWindow(start, "2025-12-01T00:00:00Z", 12), "an invoice before the start is not ours");
});

Deno.test("US-9212: no cash without a certified tax profile, and the default is refusal", () => {
  const base = { eligibleBalanceCents: 10_000, minimum: 25, onboarded: true };
  assertEquals(planPayout({ ...base, taxProfileComplete: true }), { action: "pay", amount: 10_000 });
  assertEquals(planPayout({ ...base, taxProfileComplete: false }), {
    action: "skip",
    reason: "tax_profile_missing",
  });
  // A caller that forgets the gate must not pay.
  assertEquals(planPayout(base), { action: "skip", reason: "tax_profile_missing" });
  // The earlier gates still win: nothing to pay, or not onboarded, come first.
  assertEquals(planPayout({ ...base, eligibleBalanceCents: 0, taxProfileComplete: true }).action, "skip");
  assertEquals(
    planPayout({ ...base, onboarded: false, taxProfileComplete: true }),
    { action: "skip", reason: "not_onboarded" },
  );
});
