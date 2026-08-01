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
  classifySaleCurrency,
  computeConsignorShare,
  type ExistingAutoPayout,
  parseAutoPayoutMode,
  planAutoPayout,
} from "./consignor-payout-math.ts";
import {
  CONSIGNOR_PAYOUT_CONFIG_KEY,
  holdUntilFor,
  isHeld,
  normalizeConsignorPayoutConfig,
  planReversal,
} from "./consignor-reversal-math.ts";
import { emitOpsEvent } from "./ops-events.ts";

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
  | "skipped" // nothing to do (not consigned / not completed / $0 / already settled
  //          / already paid by hand — US-2290)
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
  // US-2022: the optional return-window hold is measured from the SALE, not
  // from when the payout row happens to be created — otherwise a sale the
  // sweep picks up late would get a hold window starting weeks after the buyer
  // already received the item.
  sold_at: string | null;
  sale_date: string | null;
  /**
   * US-2031: NULL = the marketplace never reported one.
   * US-2292: which no longer means "treated as USD" on its own — see
   * classifySaleCurrency, which needs created_at to tell a legacy blank from a
   * currency a connector had the chance to record and did not.
   */
  currency: string | null;
  created_at: string | null;
  inventory_items: {
    user_id: string;
    consignor_id: string | null;
    consignment_split_pct: number | null;
  } | null;
}

const SALE_SELECT =
  "id, status, sale_price, platform_fees, payment_processing_fees, inventory_item_id, sold_at, sale_date, currency, created_at, " +
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

  // US-2031: GradeThread is explicitly single-currency. fireTransfer hardcodes
  // "usd", so paying out a GBP or EUR sale would transfer the NUMBER as dollars
  // — silently wrong, and wrong in the direction of overpaying the consignor.
  // Refuse rather than guess. Loud, because a seller with a non-US marketplace
  // account would otherwise just never see their consignor paid and would have
  // no way to find out why. Checked after ownership so the ops event can name
  // the tenant it belongs to.
  //
  // US-2292: a MISSING currency is refused too, once the connectors were able
  // to record one. Reading a blank as USD is how a 200 GBP Shopify sale paid
  // its consignor 120 dollars: nothing was wrong with the arithmetic, the unit
  // was just assumed. Legacy rows written before any connector recorded a
  // currency stay payable — see classifySaleCurrency for why that line exists.
  const verdict = classifySaleCurrency(
    sale.currency,
    sale.created_at,
    Deno.env.get("SALE_CURRENCY_RECORDED_SINCE") || undefined,
  );
  if (!verdict.payable) {
    const shown = sale.currency ?? "unrecorded";
    console.error(
      `[consignor-payout] REFUSING payout for sale ${saleId}: currency ${shown} is not USD (${verdict.reason})`,
    );
    await emitOpsEvent("consignor.payout_currency_refused", "critical", {
      title: verdict.reason === "unrecorded"
        ? `Consignor payout refused — sale has no recorded currency`
        : `Consignor payout refused — sale is in ${shown}, not USD`,
      source: "consignor-payout.currency",
      actorUserId: ownerId,
      data: { sale_id: saleId, currency: sale.currency, reason: verdict.reason },
    }).catch(() => { /* never let the ops feed break the guard */ });
    return skip(
      verdict.reason === "unrecorded" ? "currency_unrecorded" : "currency_not_supported",
    );
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

  // Existing payouts for this sale. US-2290: BOTH sources, not just 'auto'.
  //
  // This read used to filter .eq("source","auto"), so the engine was blind to
  // anything an operator had already paid. A consignor settled by hand — cash,
  // bank transfer, anything outside Stripe — was recorded as source='manual',
  // the sweep saw no auto row, and paid them again. One query now returns both
  // and the plan decides, so the two paths can no longer be blind to each other.
  const { data: payoutRows } = await supabaseAdmin
    .from("consignor_payouts")
    .select("id, status, source")
    .eq("sale_id", saleId)
    .eq("user_id", ownerId);
  const allPayouts = (payoutRows ?? []) as Array<
    { id: string; status: string; source: string | null }
  >;
  const existing =
    (allPayouts.find((r) => r.source === "auto") as ExistingAutoPayout | undefined) ?? null;
  const manualPayouts = allPayouts.filter((r) => r.source !== "auto");

  const stripe = opts.stripe !== undefined ? opts.stripe : getStripe();
  const onboarded = Boolean(
    consignor.stripe_connect_account_id && consignor.payouts_enabled && stripe,
  );

  const plan = planAutoPayout({ existing, manual: manualPayouts, share, onboarded });

  // US-2022 AC3: the return-window hold. No transfer means nothing to claw
  // back, so holding until the return window closes removes most of this
  // exposure at its source rather than recovering from it after the fact.
  //
  // OFF BY DEFAULT (hold_days: 0 = today's behaviour). Turning it on delays
  // when real people get paid and may contradict terms a seller already agreed
  // with their consignors, so it is the seller's policy call, not a default.
  const holdConfig = normalizeConsignorPayoutConfig(
    await getSetting<unknown>(CONSIGNOR_PAYOUT_CONFIG_KEY, null),
  );
  const saleAtMs = Date.parse(sale.sold_at ?? sale.sale_date ?? "");
  const holdBaseMs = Number.isFinite(saleAtMs) ? saleAtMs : Date.now();
  const holdUntil = holdUntilFor(holdConfig, holdBaseMs);
  const heldNow = isHeld(holdUntil, Date.now());

  // A held payout still gets its ledger row (the consignor can see what they
  // are owed and when) — it just does not transfer yet. The existing sweep
  // retries it, and once the hold lapses the normal transfer path fires.
  if (heldNow && (plan.action === "transfer" || plan.action === "create")) {
    if (plan.action === "transfer") {
      await supabaseAdmin
        .from("consignor_payouts")
        .update({ amount: share, hold_until: holdUntil })
        .eq("id", plan.payoutId)
        .eq("user_id", ownerId)
        .in("status", ["pending", "failed"]);
      return { outcome: "queued", saleId, payoutId: plan.payoutId, amount: share };
    }
    const { data: heldRow } = await supabaseAdmin
      .from("consignor_payouts")
      .insert({
        user_id: ownerId,
        consignor_id: consignor.id,
        sale_id: saleId,
        inventory_item_id: sale.inventory_item_id,
        amount: share,
        status: "pending",
        source: "auto",
        hold_until: holdUntil,
        note: `auto: held until ${holdUntil} (return window)`,
      })
      .select("id")
      .maybeSingle();
    return {
      outcome: "queued",
      saleId,
      payoutId: (heldRow as { id: string } | null)?.id,
      amount: share,
    };
  }

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

  // US-1916: Stripe idempotency keys only dedupe for ~24h, so a transfer that
  // settled on Stripe but whose DB write-back failed (crash/network blip) would
  // be retried by sweepConsignorPayouts after the key TTL and create a SECOND
  // transfer — a real double-pay. Before firing (every sweep retry routes here),
  // ask Stripe whether a transfer for THIS payout already exists (matched on
  // metadata.payout_id, time-bounded to the row's created_at); if so, reconcile
  // the row from it instead of transferring again. A lookup error is treated as
  // unsafe-to-retry-now (skip, leaving the row retryable) rather than re-firing.
  // Mirrors the affiliate engine's US-1653 hardening.
  const { data: rowRaw } = await supabaseAdmin
    .from("consignor_payouts")
    .select("created_at")
    .eq("id", payoutId)
    .eq("user_id", ownerId)
    .maybeSingle();
  const createdAt = (rowRaw as { created_at?: string } | null)?.created_at;
  const createdAtMs = createdAt ? Date.parse(createdAt) : NaN;
  const lookup = await findExistingTransfer(stripe, accountId, payoutId, createdAtMs);
  if (lookup.error) {
    return {
      outcome: "skipped",
      saleId,
      payoutId,
      reason: `transfer_lookup_failed: ${lookup.error}`,
    };
  }
  if (lookup.transfer) {
    await supabaseAdmin
      .from("consignor_payouts")
      .update({
        amount,
        status: "paid",
        stripe_transfer_id: lookup.transfer.id,
        paid_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", payoutId)
      .eq("user_id", ownerId);
    return { outcome: "transferred", saleId, payoutId, amount };
  }

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

// US-1916: look up whether a Stripe transfer already exists for this payout,
// matched on metadata.payout_id (set by fireTransfer at create). Bounds the scan
// to transfers to the consignor's destination created at/after the payout row
// (minus a clock-skew cushion) — the transfer can't predate the row. Returns the
// transfer if found, or an `error` string on any Stripe failure so the caller
// declines to re-fire rather than risk a double-pay on an unreadable state.
// Explicit bounded page-walk (not the SDK async iterator) so a destination with
// a long transfer history can't spin the sweep. Exported for the guard test.
// Mirrors affiliate-payout.ts findExistingTransfer (US-1653).
export async function findExistingTransfer(
  stripe: Stripe,
  accountId: string,
  payoutId: string,
  createdAtMs: number,
): Promise<{ transfer: Stripe.Transfer | null; error?: string }> {
  const createdGte = Number.isFinite(createdAtMs)
    ? Math.floor((createdAtMs - 5 * 60 * 1000) / 1000)
    : undefined;
  const MAX_PAGES = 5;
  let startingAfter: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await stripe.transfers.list({
        destination: accountId,
        ...(createdGte !== undefined ? { created: { gte: createdGte } } : {}),
        ...(startingAfter ? { starting_after: startingAfter } : {}),
        limit: 100,
      });
      for (const transfer of res.data) {
        if (transfer.metadata?.payout_id === payoutId) {
          return { transfer };
        }
      }
      if (!res.has_more || res.data.length === 0) break;
      startingAfter = res.data[res.data.length - 1].id;
    }
    return { transfer: null };
  } catch (err) {
    return {
      transfer: null,
      error: err instanceof Error ? err.message : "list_failed",
    };
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

// ── US-2022: reversal when a sale comes apart ────────────────────────
//
// processSaleConsignorPayout only ever pays FORWARD: it gates new payouts on
// sale.status === 'completed' and SETTLED_STATUSES makes every later evaluation
// of a paid row skip('already_settled'). So once money moved, a subsequent
// return or refund left the payout row reading 'paid' forever with no recovery
// and no signal. This is the missing edge.
//
// Call this from EVERY writer that transitions a sale to returned/refunded/
// cancelled. It is idempotent: a second call sees status reversed/canceled and
// skips, so wiring it into overlapping paths (a webhook AND the order sweep)
// cannot double-reverse.

export interface ReversalSummary {
  scanned: number;
  canceled: number;
  reversed: number;
  reversedAmount: number;
  flagged: number;
  errors: string[];
}

/**
 * Reverse or cancel every consignor payout attached to the given sales.
 *
 * Tenant-scoped by ownerId (US-268: the service-role client bypasses RLS and
 * these sale ids arrive from sync payloads and request bodies).
 */
export async function reverseConsignorPayoutsForSales(
  saleIds: string[],
  ownerId: string,
  opts: { stripe?: Stripe | null; reason?: string } = {},
): Promise<ReversalSummary> {
  const summary: ReversalSummary = {
    scanned: 0,
    canceled: 0,
    reversed: 0,
    reversedAmount: 0,
    flagged: 0,
    errors: [],
  };
  const ids = [...new Set(saleIds.filter((s): s is string => !!s))];
  if (ids.length === 0 || !ownerId) return summary;

  const { data: rows, error } = await supabaseAdmin
    .from("consignor_payouts")
    .select("id, status, amount, stripe_transfer_id, sale_id, consignor_id")
    .in("sale_id", ids)
    .eq("user_id", ownerId);
  if (error) {
    summary.errors.push(`payout lookup failed: ${error.message}`);
    return summary;
  }

  const payouts = (rows ?? []) as Array<{
    id: string;
    status: string;
    amount: number;
    stripe_transfer_id: string | null;
    sale_id: string | null;
    consignor_id: string;
  }>;
  summary.scanned = payouts.length;
  if (payouts.length === 0) return summary;

  const stripe = opts.stripe !== undefined ? opts.stripe : getStripe();
  const note = opts.reason ? `sale reversed: ${opts.reason}` : "sale reversed";

  for (const row of payouts) {
    const plan = planReversal(row);

    if (plan.action === "skip") continue;

    if (plan.action === "cancel") {
      const { error: cancelErr } = await supabaseAdmin
        .from("consignor_payouts")
        .update({ status: "canceled", note })
        .eq("id", plan.payoutId)
        .eq("user_id", ownerId);
      if (cancelErr) summary.errors.push(`cancel ${plan.payoutId}: ${cancelErr.message}`);
      else summary.canceled += 1;
      continue;
    }

    if (plan.action === "flag") {
      await flagClawback(plan.payoutId, ownerId, row.consignor_id, Number(row.amount), note,
        "paid with no stripe_transfer_id — cannot reverse automatically");
      summary.flagged += 1;
      continue;
    }

    // plan.action === "reverse"
    if (!stripe) {
      await flagClawback(plan.payoutId, ownerId, row.consignor_id, plan.amount, note,
        "Stripe is not configured on this deploy — reversal could not be attempted");
      summary.flagged += 1;
      continue;
    }

    try {
      const reversal = await stripe.transfers.createReversal(
        plan.transferId,
        { amount: Math.round(plan.amount * 100) },
        // Matches the existing consignor_payout_<id> convention. Keyed on the
        // payout, so a retry of the same reversal is a no-op at Stripe rather
        // than a second clawback.
        { idempotencyKey: `consignor_reversal_${plan.payoutId}` },
      );
      const { error: updErr } = await supabaseAdmin
        .from("consignor_payouts")
        .update({
          status: "reversed",
          stripe_reversal_id: reversal.id,
          reversed_at: new Date().toISOString(),
          reversal_error: null,
          note,
        })
        .eq("id", plan.payoutId)
        .eq("user_id", ownerId);
      if (updErr) {
        // The money IS back but the ledger did not record it. That is worse
        // than a failed reversal, because a later sweep would try again — so
        // it is surfaced rather than swallowed.
        summary.errors.push(`reversal recorded at Stripe but DB update failed for ${plan.payoutId}: ${updErr.message}`);
      } else {
        summary.reversed += 1;
        summary.reversedAmount = Math.round((summary.reversedAmount + plan.amount) * 100) / 100;
      }
    } catch (err) {
      // The common real failure: the connected account already paid the funds
      // out to its bank, so there is no balance to reverse. The money is gone
      // and only a human can recover it — say so instead of leaving 'paid'.
      const message = err instanceof Error ? err.message : String(err);
      await flagClawback(plan.payoutId, ownerId, row.consignor_id, plan.amount, note, message);
      summary.flagged += 1;
    }
  }

  if (summary.reversed > 0 || summary.flagged > 0) {
    await emitOpsEvent(
      "consignor.payout_reversal",
      summary.flagged > 0 ? "critical" : "info",
      {
        title: summary.flagged > 0
          ? `${summary.flagged} consignor payout(s) could NOT be clawed back after a sale reversed`
          : `Reversed ${summary.reversed} consignor payout(s) after a sale reversed`,
        source: "consignor-payout.reverse",
        actorUserId: ownerId,
        data: {
          sale_ids: ids,
          scanned: summary.scanned,
          canceled: summary.canceled,
          reversed: summary.reversed,
          reversed_amount: summary.reversedAmount,
          flagged: summary.flagged,
          reason: opts.reason ?? null,
        },
      },
    ).catch(() => { /* the ops feed must never break the reversal */ });
  }

  return summary;
}

/**
 * Mark a payout as needing human recovery. The row deliberately does NOT stay
 * 'paid': 'paid' means the consignor was correctly paid for a sale that stood,
 * and leaving it there is exactly the silent loss this story exists to end.
 */
async function flagClawback(
  payoutId: string,
  ownerId: string,
  consignorId: string,
  amount: number,
  note: string,
  reason: string,
): Promise<void> {
  await supabaseAdmin
    .from("consignor_payouts")
    .update({ status: "clawback_pending", reversal_error: reason, note })
    .eq("id", payoutId)
    .eq("user_id", ownerId);
  console.error(
    `[consignor-payout] CLAWBACK PENDING payout=${payoutId} consignor=${consignorId} amount=${amount}: ${reason}`,
  );
}
