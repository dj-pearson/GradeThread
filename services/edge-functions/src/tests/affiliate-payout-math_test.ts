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
  normalizeAffiliateProgram,
  planSubscriptionAccrual,
  summarizeCreatorEarnings,
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
      program: "creator",
    }),
    { action: "accrue", amount: 500 }, // $5.00 → 500¢
  );
});

Deno.test("planAccrual: a fractional-dollar rate accrues exact cents", () => {
  assertEquals(
    planAccrual({
      attributionSource: "affiliate",
      mode: "batched",
      rate: 4.99,
      alreadyAccrued: false,
      program: "creator",
    }),
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
    planAccrual({
      attributionSource: "affiliate",
      mode: "off",
      rate: 5,
      alreadyAccrued: false,
      program: "creator",
    }),
    { action: "skip", reason: "disabled" },
  );
});

Deno.test("planAccrual: a $0 rate accrues nothing", () => {
  assertEquals(
    planAccrual({
      attributionSource: "affiliate",
      mode: "batched",
      rate: 0,
      alreadyAccrued: false,
      program: "creator",
    }),
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

// ── US-9212: the creator programme is separate from user referral ───────────

Deno.test("planAccrual: a user-programme affiliate earns no cash, and the default is refusal", () => {
  // The whole point of the split: a seller who shared a link keeps earning
  // grade credits in referrals.ts and never becomes a 1099 recipient here.
  assertEquals(
    planAccrual({
      attributionSource: "affiliate",
      mode: "batched",
      rate: 5,
      alreadyAccrued: false,
      program: "user",
    }),
    { action: "skip", reason: "not_creator" },
  );
  // Omitted entirely — a caller that forgets the programme accrues nothing,
  // exactly like a caller that forgets the tax gate pays nothing.
  assertEquals(
    planAccrual({ attributionSource: "affiliate", mode: "batched", rate: 5, alreadyAccrued: false }),
    { action: "skip", reason: "not_creator" },
  );
});

Deno.test("normalizeAffiliateProgram: only the exact string is a creator", () => {
  assertEquals(normalizeAffiliateProgram("creator"), "creator");
  for (const v of ["user", "CREATOR", "", null, undefined, 1, {}, ["creator"]]) {
    assertEquals(normalizeAffiliateProgram(v), "user");
  }
});

// ── US-9212: one paid invoice, end to end (pure) ────────────────────────────

type InvoiceArgs = Parameters<typeof planSubscriptionAccrual>[0];

const INVOICE: InvoiceArgs = {
  attributionSource: "affiliate",
  program: "creator",
  mode: "batched",
  model: "subscription_pct",
  pct: 25,
  capUsd: 250,
  windowMonths: 12,
  subscriptionStartedAt: "2026-01-15T00:00:00Z",
  invoicePaidAt: "2026-03-15T00:00:00Z",
  invoiceAmountCents: 5900, // Pro, monthly
  alreadyAccruedCents: 0,
};

Deno.test("planSubscriptionAccrual: a creator earns the percentage of a paid invoice", () => {
  assertEquals(planSubscriptionAccrual(INVOICE), { action: "accrue", amount: 1475 });
});

Deno.test("planSubscriptionAccrual: every refusal is named", () => {
  type SkipReason = Extract<ReturnType<typeof planSubscriptionAccrual>, { action: "skip" }>["reason"];
  const cases: Array<[Partial<InvoiceArgs>, SkipReason]> = [
    [{ attributionSource: "direct" }, "not_affiliate"],
    [{ program: "user" }, "not_creator"],
    [{ mode: "off" }, "disabled"],
    [{ model: "flat" }, "wrong_model"],
    [{ invoiceAmountCents: 0 }, "zero_amount"],
    // 14 months after the anchor, on a 12-month window.
    [{ invoicePaidAt: "2027-03-15T00:00:00Z" }, "outside_window"],
    // The $250 cap is already spent on this referred account.
    [{ alreadyAccruedCents: 25_000 }, "cap_reached"],
  ];
  for (const [patch, reason] of cases) {
    assertEquals(
      planSubscriptionAccrual({ ...INVOICE, ...patch }),
      { action: "skip", reason },
      `expected ${reason}`,
    );
  }
});

Deno.test("planSubscriptionAccrual: the cap truncates the last invoice rather than skipping it", () => {
  // $248 earned, $250 cap, a $59 invoice that would earn $14.75 → pays the $2
  // of room and no more. The creator is never overpaid and never zeroed out on
  // an invoice that still had room.
  assertEquals(
    planSubscriptionAccrual({ ...INVOICE, alreadyAccruedCents: 24_800 }),
    { action: "accrue", amount: 200 },
  );
});

Deno.test("planSubscriptionAccrual: an out-of-band percentage is clamped, not honoured", () => {
  assertEquals(
    planSubscriptionAccrual({ ...INVOICE, pct: 300 }),
    { action: "accrue", amount: 1770 }, // clamped to 30%
  );
  assertEquals(
    planSubscriptionAccrual({ ...INVOICE, pct: 0 }),
    { action: "accrue", amount: 1180 }, // clamped to 20%
  );
});

// ── US-9212: what the creator dashboard adds up ─────────────────────────────

Deno.test("summarizeCreatorEarnings: paid, payable and held are separated by hold", () => {
  const now = Date.parse("2026-09-02T00:00:00Z");
  const out = summarizeCreatorEarnings(
    [
      { amount: 1475, status: "paid", hold_until: null, created_at: "2026-03-15T00:00:00Z", referred_user_id: "acc-111111" },
      { amount: 1475, status: "accrued", hold_until: "2026-08-01T00:00:00Z", created_at: "2026-06-01T00:00:00Z", referred_user_id: "acc-111111" },
      { amount: 1000, status: "accrued", hold_until: "2026-12-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", referred_user_id: "acc-222222" },
      // Voided: counts for nothing, including against the cap.
      { amount: 9999, status: "void", hold_until: null, created_at: "2026-06-01T00:00:00Z", referred_user_id: "acc-222222" },
    ],
    { capUsd: 250, windowMonths: 12, nowMs: now },
  );
  assertEquals(out.paidCents, 1475);
  assertEquals(out.payableCents, 1475);
  assertEquals(out.heldCents, 1000);
});

Deno.test("summarizeCreatorEarnings: one row per referred account, with no identity on it", () => {
  const now = Date.parse("2026-09-02T00:00:00Z");
  const out = summarizeCreatorEarnings(
    [
      { amount: 1475, status: "paid", hold_until: null, created_at: "2026-06-15T00:00:00Z", referred_user_id: "3f1e2d-aaaaaa" },
      { amount: 1475, status: "accrued", hold_until: null, created_at: "2026-03-15T00:00:00Z", referred_user_id: "3f1e2d-aaaaaa" },
      { amount: 500, status: "accrued", hold_until: null, created_at: "2026-08-15T00:00:00Z", referred_user_id: "9c8b7a-bbbbbb" },
    ],
    { capUsd: 250, windowMonths: 12, nowMs: now },
  );
  assertEquals(out.accounts.length, 2);
  const [top, second] = out.accounts;
  // Sorted by what they earned, biggest first.
  assertEquals(top.earnedCents, 2950);
  assertEquals(second.earnedCents, 500);
  // The handle is six characters and cannot be used to look anyone up.
  assertEquals(top.ref, "aaaaaa");
  assertEquals(top.ref.length, 6);
  assert(!JSON.stringify(out).includes("3f1e2d-aaaaaa"), "the full account id must not survive the fold");
  // The window runs from the EARLIEST commissioned invoice, not the latest.
  assertEquals(top.firstEarnedAt, "2026-03-15T00:00:00Z");
  assertEquals(top.windowEndsAt, "2027-03-15T00:00:00.000Z");
  // $250 cap, $29.50 earned.
  assertEquals(top.capRemainingCents, 22_050);
});

Deno.test("summarizeCreatorEarnings: nothing earned is four zeros, not a crash", () => {
  const out = summarizeCreatorEarnings([], { capUsd: 250, windowMonths: 12, nowMs: Date.now() });
  assertEquals(out, { paidCents: 0, payableCents: 0, heldCents: 0, accounts: [] });
});
