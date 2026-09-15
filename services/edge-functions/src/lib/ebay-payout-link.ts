// US-3413: fill in the payout reference the sync cannot.
//
// WHY THIS EXISTS, measured on prod 2026-09-14 rather than reasoned about.
// 228 sales, 84 with a payout_reference, and the coverage was getting WORSE:
// September 0 of 12, August 4 of 29, July 10 of 18, June 0 of 27, May 36 of 40.
// Two of the four stored payouts linked to zero sales; the September one
// settled 68 transactions and matched nothing.
//
// The cause is a timing gap, not a bug in the enrichment. flipdesk-ebay's
// finances pass reads Finances transactions for the window since the last sync
// cursor and writes agg.payoutId onto the matching sale. eBay assigns a payout
// id when the DEPOSIT settles, which is days after the order. So at the moment
// the sync sees that transaction the id is null, it writes null, the cursor
// moves past the order, and nothing ever looks again.
//
// This module is the second look. It reads a WIDE window (not the cursor), and
// it only ever fills a reference that is currently NULL -- it never overwrites
// one the sync got right, and it never touches money. Fees, payout_amount and
// net_profit stay the enrichment's job; a second writer for those is how two
// reports start disagreeing about the same sale.
//
// TENANT ISOLATION (US-268). The service-role client bypasses RLS. Every query
// here is keyed on the ownerId passed in, which callers resolve as
// `c.get("workspaceOwnerId") ?? c.get("userId")` for a seller request or from
// the connection row for the cron. No id is ever taken from a request body.

import { supabaseAdmin } from "./supabase.ts";
import { getPayouts, listRecentTransactions } from "./ebay-client.ts";

/** Default lookback. Wide enough to cover eBay's settlement lag many times over. */
export const PAYOUT_LINK_DEFAULT_DAYS = 90;

/** Hard ceiling, so a bad `days` cannot turn one owner into a full history scan. */
export const PAYOUT_LINK_MAX_DAYS = 365;

/** Sales examined per owner per pass. */
const SALES_SCAN_LIMIT = 2000;

export interface PayoutLinkResult {
  /** Payout headers upserted into ebay_payouts. */
  payoutsUpserted: number;
  /** Distinct orders the transaction feed gave us a settled payout id for. */
  ordersWithPayout: number;
  /** Sales that had no reference and now have one. */
  salesLinked: number;
  /** Sales still missing a reference after the pass. */
  salesStillUnlinked: number;
  warnings: string[];
}

/**
 * Map orderId -> payoutId from the Finances transaction feed.
 *
 * Only entries with a non-null payoutId are kept. A transaction whose payout
 * has not settled tells us nothing we do not already know, and carrying it as
 * an explicit null invites a caller to write that null over a good value.
 */
export function payoutIdsByOrder(
  transactions: ReadonlyArray<{ orderId: string | null; payoutId: string | null }>,
): Map<string, string> {
  const byOrder = new Map<string, string>();
  for (const t of transactions) {
    const orderId = t.orderId?.trim();
    const payoutId = t.payoutId?.trim();
    if (!orderId || !payoutId) continue;
    // First settled id wins. A multi-line order settles in one payout in
    // practice; if eBay ever splits one, the first is still a true answer and
    // an arbitrary overwrite on each pass would make the report flicker.
    if (!byOrder.has(orderId)) byOrder.set(orderId, payoutId);
  }
  return byOrder;
}

/**
 * Upsert payout headers and fill missing sales.payout_reference for one owner.
 *
 * Returns counts rather than throwing on a partial failure: the payouts call
 * and the transactions call fail independently (a stale sell.finances grant
 * takes out both, a 404 means "not on Managed Payments" and is benign), and an
 * owner whose headers loaded but whose transactions did not is still better off
 * than one skipped entirely.
 */
export async function linkPayoutsForOwner(
  ownerId: string,
  days: number = PAYOUT_LINK_DEFAULT_DAYS,
): Promise<PayoutLinkResult> {
  const window = Math.min(Math.max(Math.trunc(days) || PAYOUT_LINK_DEFAULT_DAYS, 1), PAYOUT_LINK_MAX_DAYS);
  const sinceIso = new Date(Date.now() - window * 86_400_000).toISOString();
  const warnings: string[] = [];
  const result: PayoutLinkResult = {
    payoutsUpserted: 0,
    ordersWithPayout: 0,
    salesLinked: 0,
    salesStillUnlinked: 0,
    warnings,
  };

  // ── 1. Payout headers ────────────────────────────────────────────
  // The seller-facing GET /finances/payouts already upserts these, but only
  // when somebody opens the Reconciliation page, and only for the 90 days
  // before they did. That is why prod held four headers spanning June to
  // September while sales referenced five payouts going back to March.
  try {
    const payouts = await getPayouts(ownerId, sinceIso);
    if (payouts.length > 0) {
      const rows = payouts.map((p) => ({
        user_id: ownerId,
        payout_id: p.payoutId,
        amount_cents: p.amount ? Math.round(Number(p.amount.value) * 100) : null,
        currency: p.amount?.currency ?? null,
        status: p.payoutStatus || null,
        payout_date: p.payoutDate,
        transaction_count: p.transactionCount,
      }));
      const { error } = await supabaseAdmin
        .from("ebay_payouts")
        .upsert(rows as never, { onConflict: "user_id,payout_id" });
      if (error) throw error;
      result.payoutsUpserted = rows.length;
    }
  } catch (err) {
    warnings.push(`payouts: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 2. orderId -> payoutId ───────────────────────────────────────
  let byOrder = new Map<string, string>();
  try {
    const txns = await listRecentTransactions(ownerId, sinceIso, warnings);
    byOrder = payoutIdsByOrder(txns);
    result.ordersWithPayout = byOrder.size;
  } catch (err) {
    warnings.push(`transactions: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  // ── 3. Fill the gaps ─────────────────────────────────────────────
  // US-268: scoped on ownerId, and the order ids come from eBay's answer for
  // THAT owner's token, never from a request.
  const { data: salesRows, error: salesErr } = await supabaseAdmin
    .from("sales")
    .select("id, platform_order_id")
    .eq("user_id", ownerId)
    .is("payout_reference", null)
    .not("platform_order_id", "is", null)
    .gte("sale_date", sinceIso)
    .limit(SALES_SCAN_LIMIT);
  if (salesErr) {
    warnings.push(`sales read: ${salesErr.message}`);
    return result;
  }

  const unlinked = (salesRows ?? []) as unknown as Array<{
    id: string;
    platform_order_id: string | null;
  }>;

  for (const row of unlinked) {
    const payoutId = row.platform_order_id
      ? byOrder.get(row.platform_order_id.trim())
      : undefined;
    if (!payoutId) continue;
    // Both filters carried on the write, not just the id: `.eq("id")` alone
    // would be an unscoped write keyed on a value this function selected, and
    // the rule is that the scope travels with the statement. `.is(null)` keeps
    // the pass idempotent under a concurrent sync that just filled this row.
    const { error } = await supabaseAdmin
      .from("sales")
      .update({ payout_reference: payoutId } as never)
      .eq("id", row.id)
      .eq("user_id", ownerId)
      .is("payout_reference", null);
    if (error) {
      warnings.push(`sale ${row.id}: ${error.message}`);
      continue;
    }
    result.salesLinked += 1;
  }

  result.salesStillUnlinked = unlinked.length - result.salesLinked;
  return result;
}
