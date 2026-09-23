// eBay routes: payouts, ad spend and the payouts CSV import.
//
// Split out of flipdesk-ebay.ts, which mounts this router at /api/flipdesk/ebay
// alongside its siblings. The local router keeps the name flipdeskEbayRoutes so
// every handler below is byte-for-byte the text it had before the split.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { extractAdFees, reconcileMoneyLines } from "../lib/ad-spend.ts";
import {
  getPayouts,
  isAnalyticsAccessDenied,
  isEbayConfigured,
  listRecentTransactions,
} from "../lib/ebay-client.ts";
import { parseEbayPayoutsCsv } from "../lib/ebay-payouts-csv.ts";
import { ingestPayoutsForUser } from "../lib/ebay-payout-dedup.ts";
import { failSafe } from "../lib/http-errors.ts";
import { notifyPayoutImported } from "../lib/selling-activity-notify.ts";
import { type EbayEnv } from "./flipdesk-ebay-shared.ts";


export const flipdeskEbayRoutes = new Hono<EbayEnv>();

// US-1446 chunk 1: recent eBay payouts (the bank deposits) — resellers reconcile
// against the lump-sum payout, not individual transactions. Read-only; tenant-
// scoped; a no-access 403 (stale sell.finances grant) returns { access:false }.
flipdeskEbayRoutes.get("/finances/payouts", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
    const payouts = await getPayouts(ownerId, since);
    // US-1446 chunk 2: persist keyed by (user_id, payout_id) so reconciliation
    // has a stable record and can dedupe against the CSV payout_imports path.
    if (payouts.length > 0) {
      const rows = payouts.map((p) => ({
        user_id: ownerId,
        payout_id: p.payoutId,
        amount_cents: p.amount
          ? Math.round(Number(p.amount.value) * 100)
          : null,
        currency: p.amount?.currency ?? null,
        status: p.payoutStatus || null,
        payout_date: p.payoutDate,
        transaction_count: p.transactionCount,
      }));
      await supabaseAdmin
        .from("ebay_payouts")
        .upsert(rows as never, { onConflict: "user_id,payout_id" });
    }
    return c.json({ access: true, payouts });
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) return c.json({ access: false });
    console.error("[flipdesk-ebay] /finances/payouts failed:", err);
    return c.json({ error: "Could not load eBay payouts." }, 502);
  }
});

// US-1446 AC2: a payout's constituent sales (linked via sales.payout_reference =
// eBay payoutId) + the net. Tenant-scoped read; the UI expands a payout into
// this list so payout -> transactions -> net is visible.
flipdeskEbayRoutes.get("/finances/payouts/:payoutId/sales", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  const payoutId = c.req.param("payoutId");
  try {
    const { data, error } = await supabaseAdmin
      .from("sales")
      .select(
        "id, inventory_item_id, sale_price, platform_fees, payout_amount, sold_at",
      )
      .eq("user_id", ownerId)
      .eq("payout_reference", payoutId);
    if (error) throw error;
    const sales = (data ?? []) as Array<{
      id: string;
      inventory_item_id: string | null;
      sale_price: number | null;
      platform_fees: number | null;
      payout_amount: number | null;
      sold_at: string | null;
    }>;
    // Net = eBay's reported per-sale payout when present, else sale − fees.
    const net = sales.reduce(
      (sum, s) =>
        sum +
        (s.payout_amount ?? (s.sale_price ?? 0) - (s.platform_fees ?? 0)),
      0,
    );
    return c.json({ sales, net: Math.round(net * 100) / 100 });
  } catch (err) {
    console.error("[flipdesk-ebay] /finances/payouts/:id/sales failed:", err);
    return c.json({ error: "Could not load payout details." }, 502);
  }
});

// GET /finances/ad-spend — US-2952. What advertising actually cost.
//
// Promoted-listing fees never reached the money view, so the profit figure a
// seller read was profit BEFORE advertising — higher than what they banked,
// every month they ran ads.
//
// The ad fee is billed as its own eBay transaction carrying the order id, and
// that link is kept: "this jacket cost $4.20 to sell" is the question a seller
// asks, and a single advertising total answers a different one.
//
// The response also carries the reconciled LINES and their total, computed
// together so the page cannot show a figure that disagrees with the rows above
// it.
flipdeskEbayRoutes.get("/finances/ad-spend", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const days = Math.min(Math.max(Number(c.req.query("days")) || 90, 1), 365);
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

  try {
    const warnings: string[] = [];
    const transactions = await listRecentTransactions(ownerId, sinceIso, warnings);
    const adFees = extractAdFees(
      transactions.map((t) => ({
        transactionId: t.transactionId,
        transactionType: t.transactionType,
        transactionDate: t.transactionDate,
        orderId: t.orderId,
        amount: t.amount,
        // The Finances transaction shape carries the fee type under several
        // names across versions; the reader keeps whichever it finds, and the
        // matcher is loose on purpose — a type eBay adds tomorrow should land
        // in advertising rather than disappearing from the seller's costs.
        feeType: (t as unknown as { feeType?: string | null }).feeType ?? t.transactionType,
        bookingEntry: t.bookingEntry,
      })),
    );

    // The sales side of the same window, so the lines reconcile against
    // something rather than floating on their own.
    const { data: salesRows } = await supabaseAdmin
      .from("sales")
      .select("sale_price, platform_fees, platform_order_id, inventory_item_id")
      .eq("user_id", ownerId)
      .gte("sale_date", sinceIso)
      .limit(5000);
    const sales = ((salesRows ?? []) as unknown as Array<{
      sale_price: number | null;
      platform_fees: number | null;
      platform_order_id: string | null;
      inventory_item_id: string | null;
    }>);
    const revenueCents = sales.reduce(
      (sum, r) => sum + (r.sale_price != null ? Math.round(Number(r.sale_price) * 100) : 0),
      0,
    );
    const platformFeesCents = sales.reduce(
      (sum, r) => sum + (r.platform_fees != null ? Math.round(Number(r.platform_fees) * 100) : 0),
      0,
    );

    // Cost of goods, through the owner-verified parent.
    const itemIds = [...new Set(sales.map((r) => r.inventory_item_id).filter(Boolean))] as string[];
    let costOfGoodsCents = 0;
    if (itemIds.length > 0) {
      const { data: items } = await supabaseAdmin
        .from("inventory_items")
        .select("id, acquired_price")
        .eq("user_id", ownerId)
        .in("id", itemIds);
      const costById = new Map(
        ((items ?? []) as unknown as Array<{ id: string; acquired_price: number | null }>)
          .map((i) => [i.id, i.acquired_price]),
      );
      for (const r of sales) {
        const cost = r.inventory_item_id ? costById.get(r.inventory_item_id) : null;
        if (typeof cost === "number") costOfGoodsCents += Math.round(cost * 100);
      }
    }

    const adFeesCents = adFees.reduce((sum, f) => sum + f.cents, 0);
    // Attributed per order, so a seller can ask what one sale cost to advertise.
    const byOrder: Record<string, number> = {};
    for (const f of adFees) {
      if (!f.orderId) continue;
      byOrder[f.orderId] = (byOrder[f.orderId] ?? 0) + f.cents;
    }

    return c.json({
      days,
      ad_fees_cents: adFeesCents,
      ad_fees_by_order: byOrder,
      unattributed_ad_fees_cents: adFees
        .filter((f) => !f.orderId)
        .reduce((sum, f) => sum + f.cents, 0),
      // Promotion discounts are NOT in the transaction feed as a line — eBay
      // bills the reduced price, not the discount. Reported as zero and said so
      // in the UI rather than inferred from a difference nobody can check.
      ...reconcileMoneyLines({
        revenueCents,
        platformFeesCents,
        shippingCents: 0,
        costOfGoodsCents,
        adFeesCents,
        promotionDiscountCents: 0,
      }),
      warnings,
    });
  } catch (err) {
    return failSafe(c, 502, "Couldn't read your eBay ad spend.", err, "ebay.finances.ad_spend");
  }
});

// Imports an eBay Seller Hub "Payouts" CSV into payout_imports. Server-side
// parse so we can validate, dedupe, and reuse the parser for future webhook
// ingestion. Idempotent — repeated uploads of the same export skip rows that
// already match (payout_id + amount + date) for this user.
//
// Body: { csv: string }  Response: { imported, skipped, duplicates }
flipdeskEbayRoutes.post("/payouts/import-csv", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { csv?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.csv !== "string" || body.csv.trim().length === 0) {
    return c.json({ error: "csv (string) is required" }, 400);
  }
  // Soft cap — eBay payouts exports rarely exceed a few hundred KB.
  if (body.csv.length > 5 * 1024 * 1024) {
    return c.json({ error: "CSV exceeds 5MB limit" }, 413);
  }

  const { headerFound, payouts, skipped } = parseEbayPayoutsCsv(body.csv);
  if (!headerFound) {
    return c.json(
      {
        error:
          "Could not find a payouts table in this CSV. Export the report from Seller Hub → Payments → Payouts → Download.",
      },
      400,
    );
  }
  if (payouts.length === 0) {
    return c.json({ imported: 0, skipped, duplicates: 0 });
  }

  try {
    const { inserted, duplicates } = await ingestPayoutsForUser(
      userId,
      payouts,
      "csv_upload",
    );
    // US-1054: a manual CSV import is still a payout-arrival event — notify the
    // user (in-app + push, preference-gated) so it reconciles like the webhook
    // path. Dedup in ingest means this only fires for genuinely new rows.
    if (inserted > 0) {
      void notifyPayoutImported(userId, { count: inserted });
    }
    return c.json({ imported: inserted, skipped, duplicates });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] payouts import failed:", msg);
    return c.json({ error: "Failed to write payouts.", detail: msg }, 502);
  }
});
