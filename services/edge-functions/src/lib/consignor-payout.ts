// US-1112: automatic consignor payout engine.
//
// When a consigned item sells, compute the consignor's share (split math, shared
// with the consignor_pnl view via consignor-payout-math.ts), record a
// consignor_payouts ledger row, and — when the consignor has completed Stripe
// Connect onboarding — fire the transfer automatically with the existing
// `consignor_payout_<id>` idempotency key. A not-yet-onboarded consignor's
// payout is QUEUED (status pending) rather than failing silently; a later sweep
// retries the transfer once onboarding completes. The manual POST /payouts route
// (flipdesk-consignment.ts) remains as an operator override.
//
// SECURITY (US-268): the service-role client bypasses RLS. Ownership flows
// through inventory_items.user_id; every payout row written here is scoped to
// that owner, and the per-sale processor re-derives the owner from the joined
// item rather than trusting any caller-supplied id.
//
// Idempotency: at most one source='auto' payout per sale (partial UNIQUE index
// uniq_consignor_payouts_auto_sale, 00301). A re-ingest / immediate+cron race
// loses on the 23505 and is treated as "already created".

import Stripe from "stripe";
import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import {
  type AutoPayoutMode,
  computeConsignorShare,
  type ExistingAutoPayout,
  parseAutoPayoutMode,
  planAutoPayout,
} from "./consignor-payout-math.ts";

export const AUTO_PAYOUT_MODE_KEY = "consignor_auto_payout_mode";

// Catch-all sweep window: only NEW consigned sales recorded in the last N days
// are candidates for creation (older ones, if missed, are still picked up while
// they have an unsettled auto payout row — see sweepConsignorPayouts). Keeps the
// scan bounded as sales history grows.
const SWEEP_LOOKBACK_DAYS = 45;
const SWEEP_LIMIT = 500;

export async function getAutoPayoutMode(): Promise<AutoPayoutMode> {
  return parseAutoPayoutMode(await getSetting<string>(AUTO_PAYOUT_MODE_KEY, "batched"));
}

function getStripe(): Stripe | null {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return null;
  return new Stripe(key, {
    apiVersion: "2024-04-10",
    timeout: 20_000,
    maxNetworkRetries: 2,
  });
}

export type ProcessOutcome =
  | "transferred" // ledger row paid via Stripe transfer
  | "queued" // ledger row created/kept pending (consignor not onboarded)
  | "skipped" // nothing to do (not consigned / not completed / $0 / already settled)
  | "failed"; // transfer attempted and errored (row marked failed)

export interface ProcessResult {
  outcome: ProcessOutcome;
  saleId: string;
  payoutId?: string;
  amount?: number;
  reason?: string;
}

interface SaleRow {
  id: string;
  status: string;
  sale_price: number | null;
  platform_fees: number | null;
  payment_processing_fees: number | null;
  inventory_item_id: string | null;
  inventory_items: {
    user_id: string;
    consignor_id: string | null;
    consignment_split_pct: number | null;
  } | null;
}

const SALE_SELECT =
  "id, status, sale_price, platform_fees, payment_processing_fees, inventory_item_id, " +
  "inventory_items!inner(user_id, consignor_id, consignment_split_pct)";

// Process the consignor payout for a single sale. Idempotent and safe to call
// from any ingest path (immediate hook) or the sweep. `expectedOwnerId`, when
// supplied (immediate path), asserts the caller's tenant matches the item owner.
export async function processSaleConsignorPayout(
  saleId: string,
  opts: { expectedOwnerId?: string; stripe?: Stripe | null } = {},
): Promise<ProcessResult> {
  const skip = (reason: string): ProcessResult => ({ outcome: "skipped", saleId, reason });

  const { data: saleRaw } = await supabaseAdmin
    .from("sales")
    .select(SALE_SELECT)
    .eq("id", saleId)
    .maybeSingle();
  const sale = saleRaw as unknown as SaleRow | null;
  if (!sale || !sale.inventory_items) return skip("sale_not_found");

  // Only genuine completed sales pay out; cancelled/refunded/pending never do.
  if (sale.status !== "completed") return skip("sale_not_completed");

  const item = sale.inventory_items;
  if (!item.consignor_id) return skip("not_consigned");
  const ownerId = item.user_id;
  if (opts.expectedOwnerId && opts.expectedOwnerId !== ownerId) {
    return skip("owner_mismatch");
  }

  // Load the consignor (tenant-scoped to the item owner).
  const { data: consignorRaw } = await supabaseAdmin
    .from("consignors")
    .select("id, default_split_pct, stripe_connect_account_id, payouts_enabled")
    .eq("id", item.consignor_id)
    .eq("user_id", ownerId)
    .maybeSingle();
  const consignor = consignorRaw as {
    id: string;
    default_split_pct: number | null;
    stripe_connect_account_id: string | null;
    payouts_enabled: boolean | null;
  } | null;
  if (!consignor) return skip("consignor_not_found");

  // US-1123: if this sale's marketplace payout has been reconciled, pay the
  // consignor on the REAL net deposited (sum of matched reconciled payout_imports
  // rows), not the sale_price-minus-fees estimate. Falls back to the estimate
  // when unreconciled — mirrors the consignor_pnl view. Tenant-scoped by user_id.
  const { data: reconciledRaw } = await supabaseAdmin
    .from("payout_imports")
    .select("amount")
    .eq("sale_id", saleId)
    .eq("user_id", ownerId)
    .eq("reconciled", true);
  const reconciledRows = (reconciledRaw ?? []) as Array<{ amount: number | null }>;
  const reconciledNet = reconciledRows.length
    ? reconciledRows.reduce(
        (acc, r) => acc + (typeof r.amount === "number" ? r.amount : 0),
        0,
      )
    : null;

  const splitPct = item.consignment_split_pct ?? consignor.default_split_pct;
  const { share } = computeConsignorShare({
    salePrice: sale.sale_price,
    platformFees: sale.platform_fees,
    paymentProcessingFees: sale.payment_processing_fees,
    splitPct,
    reconciledNet,
  });

  // Existing AUTO payout for this sale (idempotency unit).
  const { data: existingRaw } = await supabaseAdmin
    .from("consignor_payouts")
    .select("id, status")
    .eq("sale_id", saleId)
    .eq("source", "auto")
    .eq("user_id", ownerId)
    .maybeSingle();
  const existing = (existingRaw as ExistingAutoPayout | null) ?? null;

  const stripe = opts.stripe !== undefined ? opts.stripe : getStripe();
  const onboarded = Boolean(
    consignor.stripe_connect_account_id && consignor.payouts_enabled && stripe,
  );

  const plan = planAutoPayout({ existing, share, onboarded });

  switch (plan.action) {
    case "skip":
      return skip(plan.reason);

    case "requeue":
      // The share may have changed since the row was created (e.g. the sale was
      // reconciled after an estimate-based row). Keep the queued amount truthful.
      await supabaseAdmin
        .from("consignor_payouts")
        .update({ amount: share })
        .eq("id", plan.payoutId)
        .eq("user_id", ownerId)
        .in("status", ["pending", "failed"]);
      return { outcome: "queued", saleId, payoutId: plan.payoutId, amount: share };

    case "transfer":
      return await fireTransfer({
        payoutId: plan.payoutId,
        ownerId,
        consignorId: consignor.id,
        amount: share,
        accountId: consignor.stripe_connect_account_id!,
        stripe: stripe!,
        saleId,
      });

    case "create": {
      const queuedNote =
        plan.settle === "queue" ? "auto: awaiting consignor Stripe onboarding" : null;
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from("consignor_payouts")
        .insert({
          user_id: ownerId,
          consignor_id: consignor.id,
          sale_id: saleId,
          inventory_item_id: sale.inventory_item_id,
          amount: share,
          status: "pending",
          source: "auto",
          note: queuedNote,
        })
        .select("id")
        .single();

      if (insErr || !inserted) {
        // 23505 = the unique index fired (a concurrent create won the race).
        // Re-resolve and retry the transfer leg if we can now reach Stripe.
        if (insErr && (insErr as { code?: string }).code === "23505") {
          const { data: raceRaw } = await supabaseAdmin
            .from("consignor_payouts")
            .select("id, status")
            .eq("sale_id", saleId)
            .eq("source", "auto")
            .eq("user_id", ownerId)
            .maybeSingle();
          const race = raceRaw as ExistingAutoPayout | null;
          if (race && onboarded) {
            return await fireTransfer({
              payoutId: race.id,
              ownerId,
              consignorId: consignor.id,
              amount: share,
              accountId: consignor.stripe_connect_account_id!,
              stripe: stripe!,
              saleId,
            });
          }
          return { outcome: "queued", saleId, payoutId: race?.id, amount: share };
        }
        console.error(
          `[consignor-payout] insert failed for sale ${saleId}:`,
          insErr?.message,
        );
        return { outcome: "failed", saleId, reason: insErr?.message ?? "insert_failed" };
      }

      const payoutId = (inserted as { id: string }).id;
      if (plan.settle === "queue") {
        return { outcome: "queued", saleId, payoutId, amount: share };
      }
      return await fireTransfer({
        payoutId,
        ownerId,
        consignorId: consignor.id,
        amount: share,
        accountId: consignor.stripe_connect_account_id!,
        stripe: stripe!,
        saleId,
      });
    }
  }
}

// Fire (or retry) the Stripe transfer for an existing pending payout row. The
// idempotency key matches the manual POST /payouts path so a manual + auto
// attempt on the same row never double-pays.
async function fireTransfer(args: {
  payoutId: string;
  ownerId: string;
  consignorId: string;
  amount: number;
  accountId: string;
  stripe: Stripe;
  saleId: string;
}): Promise<ProcessResult> {
  const { payoutId, ownerId, consignorId, amount, accountId, stripe, saleId } = args;
  try {
    const transfer = await stripe.transfers.create(
      {
        amount: Math.round(amount * 100),
        currency: "usd",
        destination: accountId,
        metadata: {
          consignor_id: consignorId,
          user_id: ownerId,
          payout_id: payoutId,
          source: "auto",
        },
      },
      { idempotencyKey: `consignor_payout_${payoutId}` },
    );
    await supabaseAdmin
      .from("consignor_payouts")
      .update({
        // Pin the ledger amount to what we actually transferred (the share may
        // have been recomputed from a reconciled payout after row creation).
        amount,
        status: "paid",
        stripe_transfer_id: transfer.id,
        paid_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", payoutId)
      .eq("user_id", ownerId);
    return { outcome: "transferred", saleId, payoutId, amount };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transfer failed";
    await supabaseAdmin
      .from("consignor_payouts")
      .update({ status: "failed", error: message })
      .eq("id", payoutId)
      .eq("user_id", ownerId);
    return { outcome: "failed", saleId, payoutId, reason: message };
  }
}

export interface SweepSummary {
  scanned: number;
  transferred: number;
  queued: number;
  skipped: number;
  failed: number;
}

// Batched sweep (the consignor-payouts cron). Processes:
//   (a) NEW consigned completed sales recorded within the lookback window; and
//   (b) any sale still carrying an UNSETTLED (pending/failed) auto payout —
//       so a consignor who onboards after the sale gets retried regardless of
//       how old the sale is.
// Idempotent: each sale routes through processSaleConsignorPayout.
export async function sweepConsignorPayouts(): Promise<SweepSummary> {
  const stripe = getStripe();
  const sinceIso = new Date(
    Date.now() - SWEEP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const saleIds = new Set<string>();

  // (a) Recent consigned completed sales.
  const { data: recentRaw } = await supabaseAdmin
    .from("sales")
    .select("id, inventory_items!inner(consignor_id)")
    .eq("status", "completed")
    .not("inventory_items.consignor_id", "is", null)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(SWEEP_LIMIT);
  for (const r of (recentRaw ?? []) as Array<{ id: string }>) saleIds.add(r.id);

  // (b) Older sales whose auto payout is still pending/failed (e.g. consignor
  //     just finished onboarding) — retry those too.
  const { data: openRaw } = await supabaseAdmin
    .from("consignor_payouts")
    .select("sale_id")
    .eq("source", "auto")
    .in("status", ["pending", "failed"])
    .not("sale_id", "is", null)
    .limit(SWEEP_LIMIT);
  for (const r of (openRaw ?? []) as Array<{ sale_id: string | null }>) {
    if (r.sale_id) saleIds.add(r.sale_id);
  }

  const summary: SweepSummary = {
    scanned: 0,
    transferred: 0,
    queued: 0,
    skipped: 0,
    failed: 0,
  };

  for (const saleId of saleIds) {
    summary.scanned += 1;
    const res = await processSaleConsignorPayout(saleId, { stripe });
    if (res.outcome === "transferred") summary.transferred += 1;
    else if (res.outcome === "queued") summary.queued += 1;
    else if (res.outcome === "failed") summary.failed += 1;
    else summary.skipped += 1;
  }

  return summary;
}

// Immediate hook for a sale-ingest path (e.g. eBay order sync). No-op unless the
// config flag is 'immediate'. Best-effort: never throws (the caller's ingest
// must not fail because a payout couldn't be computed/sent). The batched cron is
// the catch-all, so a miss here is recovered on the next sweep.
export async function maybeFireImmediateConsignorPayout(
  saleId: string,
  ownerId: string,
): Promise<void> {
  try {
    const mode = await getAutoPayoutMode();
    if (mode !== "immediate") return;
    await processSaleConsignorPayout(saleId, { expectedOwnerId: ownerId });
  } catch (err) {
    console.error(
      `[consignor-payout] immediate hook failed for sale ${saleId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
