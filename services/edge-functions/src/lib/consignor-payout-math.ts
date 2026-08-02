// US-1112: pure consignor auto-payout math + idempotency/gating decision.
//
// Kept dependency-free (no supabase / Stripe / env imports) so it unit-tests
// without the env dance and the impure engine (lib/consignor-payout.ts) shares
// one source of truth for the arithmetic and the create/transfer/queue policy.
//
// Split economics mirror the consignor_pnl view (00171): net proceeds =
// sale_price − platform_fees − payment_processing_fees; the consignor's share =
// net × split% (the per-item consignment_split_pct override, else the
// consignor's default_split_pct). Shipping is NOT deducted (matches the view).

export type AutoPayoutMode = "off" | "batched" | "immediate";

export function parseAutoPayoutMode(raw: unknown): AutoPayoutMode {
  return raw === "off" || raw === "immediate" ? raw : "batched";
}

// Round to cents, half-up at 2dp, before the number reaches Stripe.
//
// US-2296. This used to be `Math.round((n + Number.EPSILON) * 100) / 100`, and
// the reason that was wrong is worth keeping: `Number.EPSILON` is the gap
// between 1 and the next double — 2.22e-16. The representation error it is
// meant to cancel scales WITH THE VALUE, so the correction works around 1 and
// quietly stops working as the amount grows. Measured:
//
//   1.005 → 1.01 ✓   1.255 → 1.26 ✓        (small: the nudge is enough)
//   8.165 → 8.16 ✗   10.075 → 10.07 ✗      (larger: it is not)
//
// A magnitude-dependent rounding bug is the worst kind to test for, because
// small fixtures pass.
//
// Instead, shift the DECIMAL exponent through the string form. `Number("8.165"
// + "e+2")` re-parses JavaScript's shortest round-trip decimal and yields
// exactly 816.5, where `8.165 * 100` yields 816.4999999999999. So this rounds
// the number a human would read, which is the one the consignor is owed.
//
// Sign convention is unchanged: `Math.round` is half-up toward +∞, so -8.165
// stays -8.16. Payout paths clamp at zero (`Math.max(0, netRaw)`) so this is
// not reachable for a real payout, and changing it silently would be a
// different decision than the one this fix is making.
export function roundCents(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const s = String(n);
  // Already in exponential form (|n| < 1e-6 or >= 1e21) — appending "e+2" would
  // produce "1e-7e+2" and parse as NaN. Neither end of that range is a currency
  // amount; fall back rather than pretend to be exact.
  if (s.includes("e") || s.includes("E")) return Math.round(n * 100) / 100;
  return Number(`${Math.round(Number(`${s}e+2`))}e-2`);
}

export interface ShareInput {
  salePrice: number | null | undefined;
  platformFees: number | null | undefined;
  paymentProcessingFees: number | null | undefined;
  // Per-item split override (consignment_split_pct) when set, else the
  // consignor's default_split_pct. 0–100.
  splitPct: number | null | undefined;
  // US-1123: the REAL net the marketplace deposited, from a reconciled
  // payout_imports row matched to this sale. When present (a finite number) it
  // overrides the sale_price-minus-fees estimate so the consignor is paid on
  // actuals, not a guess. Mirrors the consignor_pnl view's COALESCE(reconciled,
  // estimate). null/undefined ⇒ unreconciled ⇒ use the estimate.
  reconciledNet?: number | null | undefined;
}

export interface ShareResult {
  netProceeds: number; // rounded to cents, clamped ≥ 0
  share: number; // consignor's cut, rounded to cents, clamped ≥ 0
  // Where netProceeds came from: the reconciled payout vs the sale-price estimate.
  netSource: "reconciled" | "estimate";
}

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function computeConsignorShare(input: ShareInput): ShareResult {
  const reconciled =
    typeof input.reconciledNet === "number" && Number.isFinite(input.reconciledNet);
  // Reconciled payout (real net) wins over the sale_price-minus-fees estimate.
  const netRaw = reconciled
    ? (input.reconciledNet as number)
    : num(input.salePrice) -
      (num(input.platformFees) + num(input.paymentProcessingFees));
  // A payout is never negative — if fees exceed proceeds there's nothing to pay.
  const netProceeds = roundCents(Math.max(0, netRaw));
  const split = Math.min(100, Math.max(0, num(input.splitPct)));
  const share = roundCents(Math.max(0, (netProceeds * split) / 100));
  return { netProceeds, share, netSource: reconciled ? "reconciled" : "estimate" };
}

// ── Idempotency + onboarding-gate decision (pure) ───────────────────────────

// Terminal payout statuses the engine must never re-pay.
const SETTLED_STATUSES = new Set(["paid", "processing", "canceled"]);

export interface ExistingAutoPayout {
  id: string;
  status: string;
}

export type AutoPayoutPlan =
  // Nothing to do.
  | { action: "skip"; reason: "zero_share" | "already_settled" | "paid_manually" }
  // No row yet → create one, then transfer (onboarded) or queue (not onboarded).
  | { action: "create"; settle: "transfer" | "queue" }
  // Row already exists (pending/failed) → fire the transfer now (consignor has
  // since onboarded) reusing the existing row.
  | { action: "transfer"; payoutId: string }
  // Row already exists and stays queued (consignor still not onboarded).
  | { action: "requeue"; payoutId: string };

/**
 * US-2290: does an operator-created payout for this sale block the engine?
 *
 * The two paths filed under different `source` values and each only looked for
 * its own, so neither could see the other. An operator who paid a consignor by
 * hand — cash, bank transfer, anything outside Stripe — had that payout
 * recorded as `source='manual'`, and the sweep, which searches only for
 * `source='auto'`, found nothing and paid them a second time.
 *
 * A `failed` manual row does NOT block: nothing moved, so the engine picking
 * the sale up is the recovery, not a duplicate. Every other status does,
 * including `pending` — a pending manual row is exactly the cash payout an
 * operator recorded so the balance would track, and it is the case this bug
 * hit hardest.
 *
 * Note what this deliberately does NOT do: forbid a second MANUAL payout for
 * one sale. 00301's own comment establishes that as an intentional override
 * (a partial payout, a top-up), and an operator adding one is a decision, not
 * an accident. What was never a decision is the engine adding one behind them.
 */
export function manualPayoutBlocksAuto(
  manualRows: ReadonlyArray<{ status: string }>,
): boolean {
  return manualRows.some((r) => r.status !== "failed");
}

// Decide what to do for one sale given any existing AUTO payout row, any
// operator-created rows, the computed share, and whether the consignor can
// receive a Stripe transfer.
export function planAutoPayout(args: {
  existing: ExistingAutoPayout | null;
  /** Operator-created payouts already on this sale (US-2290). */
  manual?: ReadonlyArray<{ status: string }>;
  share: number;
  onboarded: boolean;
}): AutoPayoutPlan {
  const { existing, share, onboarded } = args;

  // Checked BEFORE the auto row, and before the zero-share shortcut: a human
  // has already settled this sale, so nothing the engine computes is relevant.
  if (manualPayoutBlocksAuto(args.manual ?? [])) {
    return { action: "skip", reason: "paid_manually" };
  }

  if (existing) {
    if (SETTLED_STATUSES.has(existing.status)) {
      return { action: "skip", reason: "already_settled" };
    }
    // pending / failed → retry the transfer if we can now reach the consignor.
    return onboarded
      ? { action: "transfer", payoutId: existing.id }
      : { action: "requeue", payoutId: existing.id };
  }

  // No row yet. Don't create a $0 payout (e.g. fully-fee'd or zero-price sale).
  if (share <= 0) return { action: "skip", reason: "zero_share" };

  return { action: "create", settle: onboarded ? "transfer" : "queue" };
}

// ── US-2031: explicit single-currency enforcement ───────────────────
//
// fireTransfer hardcodes currency: "usd" with Math.round(amount * 100). That is
// self-consistent TODAY because the sales table had no currency at all — but it
// is the classic slow burn: the moment a seller connects a UK or EU eBay
// account, a £120 sale is transferred as $120 with no error anywhere. Wrong
// amounts, silently, in the direction of overpaying a consignor.
//
// The AC offered two routes: support multi-currency, or REJECT non-USD rather
// than treat it as dollars. This is the reject route, and it is deliberately
// NOT a partial multi-currency model — the AC warns that a half-migrated
// currency model is worse than an explicit single-currency one, and it is
// right. We now RECORD what the marketplace told us and REFUSE to pay when it
// is not USD. Nothing else in the money path learns about currencies.
//
// NULL means "the marketplace never told us" — every sale written before this
// shipped, plus any ingest path that does not report one. Those are treated as
// USD, which is what they have always been treated as; this changes nothing for
// them and avoids a fabricated backfill.

export const PAYOUT_CURRENCY = "usd";

/**
 * Whether a sale in `currency` may be paid out. NULL/blank → true (legacy or
 * unreported; unchanged behaviour). Anything else must match USD exactly.
 */
export function isPayableCurrency(currency: string | null | undefined): boolean {
  const c = (currency ?? "").trim().toLowerCase();
  if (c === "") return true;
  return c === PAYOUT_CURRENCY;
}

/**
 * US-2292: normalize a marketplace-reported currency for `sales.currency`.
 *
 * Every connector writes through this so the column holds ONE shape. It matters
 * because the payout guard above compares strings: "GBP", "gbp" and " gbp "
 * must not be three different currencies, and a junk value must not become a
 * currency at all.
 *
 * Returns null — not "usd" — when the marketplace said nothing. Defaulting to
 * USD is precisely the bug: a Shopify sale in GBP arrived with no currency
 * recorded, isPayableCurrency read the blank as payable, and the consignor was
 * paid their share of 200 as if it were dollars. A null says "we do not know",
 * which is true and which a backfill can later resolve; "usd" would be a
 * fabricated fact that no later pass could tell apart from a real one.
 *
 * ISO 4217 is three letters. Anything else is a parsing accident, not a
 * currency.
 */
export function normalizeSaleCurrency(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(c)) return null;
  return c;
}

/**
 * US-2292: the date from which every connector writes `sales.currency`.
 *
 * A blank currency means two completely different things either side of this
 * line, and the payout guard has to tell them apart:
 *
 *   • BEFORE — no ingest path recorded a currency at all, so every row is
 *     blank. These have always been paid as USD and almost all of them really
 *     are USD. Refusing them would stop consignor payouts outright for every
 *     sale in the table's history, which is a worse failure than the one being
 *     fixed.
 *   • AFTER — the connector had a currency field to write and still wrote
 *     nothing, so the marketplace genuinely did not say. That is the exact
 *     shape of the bug: an unknown amount paid out as dollars.
 *
 * Override with SALE_CURRENCY_RECORDED_SINCE if the deploy lands later than
 * this date, otherwise sales ingested by the OLD code in the gap get refused
 * for a currency it was never able to record.
 */
export const CURRENCY_RECORDED_SINCE_DEFAULT = "2026-08-01T00:00:00Z";

export type SaleCurrencyVerdict =
  | { payable: true; reason: "usd" | "legacy_unrecorded" }
  | { payable: false; reason: "not_usd" | "unrecorded" };

/**
 * Whether a sale may be paid out, given what we know about its currency AND
 * whether we were in a position to know it.
 *
 * `isPayableCurrency` answers only "is this string USD", and reads a blank as
 * yes. That is right for the legacy rows and wrong for everything ingested
 * since — this is the whole decision, and it fails CLOSED on anything it cannot
 * place, including an unparseable created_at.
 */
export function classifySaleCurrency(
  currency: string | null | undefined,
  saleCreatedAt: string | null | undefined,
  recordedSinceIso: string = CURRENCY_RECORDED_SINCE_DEFAULT,
): SaleCurrencyVerdict {
  const c = (currency ?? "").trim().toLowerCase();
  if (c !== "") {
    return c === PAYOUT_CURRENCY
      ? { payable: true, reason: "usd" }
      : { payable: false, reason: "not_usd" };
  }

  // Blank. Which side of the line is it on?
  const created = Date.parse(saleCreatedAt ?? "");
  const since = Date.parse(recordedSinceIso);
  if (!Number.isFinite(created) || !Number.isFinite(since)) {
    // A sale we cannot date is a sale we cannot vouch for. Holding it costs a
    // manual review; paying it out costs whatever the exchange rate is.
    return { payable: false, reason: "unrecorded" };
  }
  return created < since
    ? { payable: true, reason: "legacy_unrecorded" }
    : { payable: false, reason: "unrecorded" };
}
