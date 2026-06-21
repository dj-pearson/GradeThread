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

// Round to cents the same way the rest of the money layer does (half-up at 2dp),
// avoiding binary-float drift (e.g. 0.1 + 0.2) before it reaches Stripe.
export function roundCents(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface ShareInput {
  salePrice: number | null | undefined;
  platformFees: number | null | undefined;
  paymentProcessingFees: number | null | undefined;
  // Per-item split override (consignment_split_pct) when set, else the
  // consignor's default_split_pct. 0–100.
  splitPct: number | null | undefined;
}

export interface ShareResult {
  netProceeds: number; // rounded to cents, clamped ≥ 0
  share: number; // consignor's cut, rounded to cents, clamped ≥ 0
}

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function computeConsignorShare(input: ShareInput): ShareResult {
  const gross = num(input.salePrice);
  const fees = num(input.platformFees) + num(input.paymentProcessingFees);
  const netRaw = gross - fees;
  // A payout is never negative — if fees exceed proceeds there's nothing to pay.
  const netProceeds = roundCents(Math.max(0, netRaw));
  const split = Math.min(100, Math.max(0, num(input.splitPct)));
  const share = roundCents(Math.max(0, (netProceeds * split) / 100));
  return { netProceeds, share };
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
  | { action: "skip"; reason: "zero_share" | "already_settled" }
  // No row yet → create one, then transfer (onboarded) or queue (not onboarded).
  | { action: "create"; settle: "transfer" | "queue" }
  // Row already exists (pending/failed) → fire the transfer now (consignor has
  // since onboarded) reusing the existing row.
  | { action: "transfer"; payoutId: string }
  // Row already exists and stays queued (consignor still not onboarded).
  | { action: "requeue"; payoutId: string };

// Decide what to do for one sale given any existing AUTO payout row, the
// computed share, and whether the consignor can receive a Stripe transfer.
export function planAutoPayout(args: {
  existing: ExistingAutoPayout | null;
  share: number;
  onboarded: boolean;
}): AutoPayoutPlan {
  const { existing, share, onboarded } = args;

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
