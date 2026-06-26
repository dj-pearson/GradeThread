// US-1295: affiliate payout pure math + accrual/payout decision logic. No env/DB
// needed — affiliate-payout-math.ts is dependency-free by design.
import { assertEquals } from "@std/assert";
import {
  type AffiliatePayoutConfig,
  crossesTaxThreshold,
  DEFAULT_AFFILIATE_PAYOUT_CONFIG,
  isPastHold,
  normalizeAffiliatePayoutConfig,
  planAccrual,
  planPayout,
} from "../lib/affiliate-payout-math.ts";

const active: AffiliatePayoutConfig = {
  mode: "batched",
  commission_per_conversion: 5,
  minimum_payout: 25,
  hold_days: 30,
  tax_threshold_usd: 600,
};

// ── Accrual on conversion ────────────────────────────────────────────────────

Deno.test("planAccrual: an affiliate conversion accrues the configured rate", () => {
  assertEquals(
    planAccrual({
      attributionSource: "affiliate",
      mode: active.mode,
      rate: active.commission_per_conversion,
      alreadyAccrued: false,
    }),
    { action: "accrue", amount: 5 },
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

Deno.test("planPayout: an onboarded balance over the minimum pays out", () => {
  assertEquals(
    planPayout({ eligibleBalance: 30, minimum: 25, onboarded: true }),
    { action: "pay", amount: 30 },
  );
});

Deno.test("planPayout: a zero eligible balance is skipped (idempotent re-run)", () => {
  // After a payout claims the commissions, a second run sees $0 → never re-pays.
  assertEquals(
    planPayout({ eligibleBalance: 0, minimum: 25, onboarded: true }),
    { action: "skip", reason: "no_balance" },
  );
});

Deno.test("planPayout: a balance below the minimum is held", () => {
  assertEquals(
    planPayout({ eligibleBalance: 10, minimum: 25, onboarded: true }),
    { action: "skip", reason: "below_minimum" },
  );
});

Deno.test("planPayout: a not-yet-onboarded affiliate is held, not paid", () => {
  assertEquals(
    planPayout({ eligibleBalance: 100, minimum: 25, onboarded: false }),
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

// ── 1099 threshold flag ──────────────────────────────────────────────────────

Deno.test("crossesTaxThreshold: flags at/over the threshold, not below", () => {
  assertEquals(crossesTaxThreshold(599.99, 600), false);
  assertEquals(crossesTaxThreshold(600, 600), true);
  assertEquals(crossesTaxThreshold(1200, 600), true);
  // A 0/negative threshold disables the flag.
  assertEquals(crossesTaxThreshold(1000, 0), false);
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
