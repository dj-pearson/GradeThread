/**
 * US-3042: erase an eBay user's data when eBay tells us their account is gone.
 *
 * THE GAP THIS CLOSES. The MARKETPLACE_ACCOUNT_DELETION handler was well built
 * on every axis except the one the requirement is actually about. It verified
 * eBay's signature before writing, deduped by notification id, refused to
 * acknowledge a failed write, and logged every notification for audit — and
 * then the only thing it did was set `marketplace_connections.is_active = false`
 * and null the OAuth tokens.
 *
 * That covers exactly one case: the deleted eBay account was a SELLER who had
 * connected to us. Most deletion notifications are not that. They are buyers,
 * whose usernames we hold because they bought something from one of our
 * sellers. For those, the handler matched nothing, changed nothing, and
 * returned a clean acknowledgement.
 *
 * WHAT COUNTS AS THEIR DATA. Not just the username column. Three of the four
 * tables also carry a `raw` jsonb of eBay's last payload for the order, case or
 * offer, and that payload contains the buyer's identity. Nulling the username
 * while leaving the payload that names them is an erasure that passes a glance
 * and fails the requirement, so `raw` is redacted in the same statement.
 *
 * WHY THIS IS NOT TENANT-SCOPED, DELIBERATELY. Every other write in the edge
 * service is scoped to one workspace (US-268). This one must not be. eBay
 * addresses the notification to the APPLICATION, not to a seller, and the person
 * being erased may appear in the records of any number of our sellers. Scoping
 * it would erase them from one seller's data and leave them in the rest, which
 * is the same as not erasing them. The id being acted on is safe to fan out on
 * because the whole payload was signature-verified against eBay's public key
 * before this function is ever reached — see flipdesk-webhooks.ts. Nothing here
 * may ever be called with an id that came from a request body.
 *
 * WHAT SURVIVES. The rows themselves. A sale is the seller's financial record
 * and their books have to balance; deleting it would destroy a third party's
 * accounting to satisfy a request about someone else. We remove the person, not
 * the transaction.
 */

import { supabaseAdmin } from "./supabase.ts";

/**
 * One table that holds eBay buyer identity, and how to strip it.
 *
 * ON THE BUYER SIDE THERE IS NO STABLE ID, and that is worth stating because the
 * seller side has one and the asymmetry invites a wrong assumption. The
 * seller-side deactivation matches on `external_account_id` and keeps
 * `account_handle` only as a legacy fallback, because eBay's OAuth identity call
 * gives us a stable user id for the account that connected.
 *
 * Orders do not. eBay's Fulfillment payload carries `buyer.username` and nothing
 * durable, so every buyer column we hold is a handle. `sales.buyer_id` is
 * NAMED like an id and is written with `order.buyerUsername`
 * (flipdesk-ebay.ts:3737, orphan-sale-match.ts:120) — matching it against the
 * deletion notification's `userId` would compare a username to a user id and
 * silently never fire. So it is declared here as a `username` match, which is
 * what it actually holds.
 *
 * The fan-out is safe despite the weaker identifier because the whole payload
 * was signature-verified against eBay's public key first: the handle we match on
 * is eBay's own statement of who was deleted, not a caller's claim.
 */
export interface BuyerErasureTarget {
  table: string;
  /** Columns to match the deleted eBay user on, best first. */
  matchColumns: Array<{ column: string; source: "userId" | "username" }>;
  /** Columns set to NULL. */
  nullColumns: string[];
  /** jsonb columns replaced with a redaction marker rather than nulled. */
  redactJsonColumns: string[];
}

/**
 * THE LIST. `ebay-buyer-erasure_test.ts` reads every migration, finds every
 * table with a `buyer_username` column, and fails if one is missing here — so a
 * table added later cannot quietly fall outside the erasure. Add the table to
 * this array, not to the test's ignore list.
 */
export const BUYER_ERASURE_TARGETS: readonly BuyerErasureTarget[] = [
  {
    // The seller's realized sale. BOTH columns hold the eBay username: see the
    // note above on `buyer_id`, which is misnamed and not an id.
    table: "sales",
    matchColumns: [
      { column: "buyer_username", source: "username" },
      { column: "buyer_id", source: "username" },
    ],
    // buyer_notes is the seller's own note, but it is a note ABOUT this person,
    // keyed to them and readable as a profile of them. It goes.
    nullColumns: ["buyer_username", "buyer_id", "buyer_notes"],
    redactJsonColumns: [],
  },
  {
    // Orders eBay sent us that matched no inventory item.
    table: "flipdesk_ebay_orphan_sales",
    matchColumns: [{ column: "buyer_username", source: "username" }],
    nullColumns: ["buyer_username"],
    redactJsonColumns: ["raw"],
  },
  {
    // Returns, cancellations, disputes and inquiries.
    table: "marketplace_post_sale_cases",
    matchColumns: [{ column: "buyer_username", source: "username" }],
    nullColumns: ["buyer_username"],
    redactJsonColumns: ["raw"],
  },
  {
    // Best Offer traffic in both directions.
    table: "marketplace_offers",
    matchColumns: [{ column: "buyer_username", source: "username" }],
    nullColumns: ["buyer_username"],
    redactJsonColumns: ["raw"],
  },
];

/**
 * What replaces a `raw` payload. Deliberately not `{}` — an empty object is
 * indistinguishable from a row that never had a payload, and six months from
 * now nobody can tell an erasure from a sync that failed halfway. This says
 * what happened and when.
 */
export function redactionMarker(now: Date = new Date()): Record<string, unknown> {
  return {
    redacted: true,
    reason: "ebay_marketplace_account_deletion",
    redacted_at: now.toISOString(),
  };
}

export interface BuyerErasureResult {
  /** Rows changed per table. */
  rowsByTable: Record<string, number>;
  totalRows: number;
  /** Non-empty means the caller must NOT acknowledge to eBay. */
  errors: Array<{ table: string; message: string }>;
}

/**
 * Build the patch for one target. Pure, so the shape of what gets written is
 * testable without a database.
 */
export function erasurePatch(
  target: BuyerErasureTarget,
  now: Date = new Date(),
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const col of target.nullColumns) patch[col] = null;
  for (const col of target.redactJsonColumns) patch[col] = redactionMarker(now);
  return patch;
}

/**
 * Which match clauses can actually run, given what eBay told us. A notification
 * carrying only a username cannot use an id-based match, and vice versa.
 * Pure — this is the logic that decides whether an erasure is even possible.
 */
export function applicableMatches(
  target: BuyerErasureTarget,
  ids: { userId?: string | null; username?: string | null },
): Array<{ column: string; value: string }> {
  const out: Array<{ column: string; value: string }> = [];
  for (const m of target.matchColumns) {
    const value = m.source === "userId" ? ids.userId : ids.username;
    if (typeof value === "string" && value.trim() !== "") {
      out.push({ column: m.column, value: value.trim() });
    }
  }
  return out;
}

/**
 * Erase the eBay user across every target table.
 *
 * Each match clause runs as its own UPDATE rather than as one `.or()` — the
 * self-hosted production PostgREST rejects logical operators on mutations
 * (42703 on the update-CTE alias) while the newer local stack accepts them, so
 * an `.or()` here would pass CI and fail only in production, on the compliance
 * path, silently. Sequential `.eq()` updates are the house rule for this.
 *
 * Rows touched by more than one clause are counted once: the caller logs the
 * number as evidence of what the erasure did, and double-counting would make
 * that evidence wrong.
 */
export async function eraseEbayBuyer(
  ids: { userId?: string | null; username?: string | null },
  now: Date = new Date(),
): Promise<BuyerErasureResult> {
  const rowsByTable: Record<string, number> = {};
  const errors: Array<{ table: string; message: string }> = [];
  let totalRows = 0;

  for (const target of BUYER_ERASURE_TARGETS) {
    const matches = applicableMatches(target, ids);
    if (matches.length === 0) {
      rowsByTable[target.table] = 0;
      continue;
    }
    const patch = erasurePatch(target, now);
    const touched = new Set<string>();

    for (const match of matches) {
      const { data, error } = await supabaseAdmin
        .from(target.table)
        .update(patch)
        .eq(match.column, match.value)
        .select("id");
      if (error) {
        errors.push({ table: target.table, message: error.message });
        console.error(
          `[ebay-erasure] ${target.table}.${match.column} update failed:`,
          error.message,
        );
        continue;
      }
      for (const row of data ?? []) touched.add(row.id as string);
    }

    rowsByTable[target.table] = touched.size;
    totalRows += touched.size;
  }

  return { rowsByTable, totalRows, errors };
}
