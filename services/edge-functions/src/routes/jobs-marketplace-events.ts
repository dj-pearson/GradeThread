// Cron: marketplace-event notifications (US-1055).
//
// Sweeps every active eBay connection and polls its owner's open offers,
// returns, and payment disputes, notifying the seller on each newly-seen one.
// Guarded by the shared job secret + an overlap lock (mirrors the other crons).

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isEbayConfigured } from "../lib/ebay-client.ts";
import { captureException } from "../lib/observability.ts";
import { sweepMarketplaceEvents } from "../lib/marketplace-event-poll.ts";

// Distinct owner ids with an active eBay connection. The connection lives on the
// workspace owner, so these are exactly the tenants to poll.
// US-2317: ceiling on the active-connection scan. A bound against growth,
// not a budget — the poll itself is already per-connection rate-limited.
const ACTIVE_CONNECTION_SCAN_CAP = 10_000;

/**
 * US-3110: how far back a sale still counts as "this seller could get a return".
 *
 * eBay's own windows are shorter than this — 30 days for most return policies,
 * 30 days after delivery for a payment dispute — so 120 days is deliberately
 * generous. The cost of being too generous is one seller polled for nothing;
 * the cost of being too tight is a missed notification.
 */
export const POST_SALE_ACTIVITY_WINDOW_DAYS = 120;

/**
 * Every connected eBay owner, unfiltered. The fallback when the activity gate
 * cannot be evaluated — see loadPollableEbayOwnerIds.
 */
async function loadActiveEbayOwnerIds(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select("user_id")
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    // US-2317: bounded. One row per active eBay connection, so this grows with
    // the seller base. Ordered so the cap keeps a STABLE set run to run — an
    // unordered cap would poll a different arbitrary subset each tick.
    .order("user_id", { ascending: true })
    .limit(ACTIVE_CONNECTION_SCAN_CAP);
  if (error) {
    throw new Error(`load active eBay owners failed: ${error.message}`);
  }
  const ids = new Set<string>();
  for (const row of (data ?? []) as Array<{ user_id: string | null }>) {
    if (row.user_id) ids.add(row.user_id);
  }
  return [...ids];
}

/**
 * US-3110: the owners this sweep actually has a reason to poll.
 *
 * Each polled owner costs six eBay calls a tick, ninety-six ticks a day, whether
 * or not anything could have happened to them — 576 calls a day per connected
 * account, paid identically by a dormant trial and a real shop. The pollable
 * set is owners with an active eBay listing, a sale inside the post-sale window,
 * or an open case.
 *
 * FAILS OPEN. If the gate cannot be evaluated we poll everyone, because the
 * failure we can afford is a wasted call and the one we cannot is a seller who
 * never hears that a payment dispute was opened against them.
 */
async function loadPollableEbayOwnerIds(): Promise<string[]> {
  const since = new Date(
    Date.now() - POST_SALE_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await supabaseAdmin
    .rpc("pollable_ebay_owner_ids", { p_since: since })
    .limit(ACTIVE_CONNECTION_SCAN_CAP);

  if (error) {
    console.warn(
      `[marketplace-events] activity gate unavailable (${error.message}); ` +
        `polling every connected owner`,
    );
    return await loadActiveEbayOwnerIds();
  }

  const ids = new Set<string>();
  for (const row of (data ?? []) as Array<{ owner_user_id: string | null }>) {
    if (row.owner_user_id) ids.add(row.owner_user_id);
  }
  return [...ids];
}

export async function handleMarketplaceEventsCron(
  c: Context,
): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!isEbayConfigured()) {
    return c.json({ ok: true, skipped: true, reason: "ebay_not_configured" });
  }
  // A 10-min lease — the sweep fans out a few eBay reads per connected seller and
  // can run long; an overlapping tick would double-poll (notifications stay
  // deduped, but the work is wasted).
  const lock = await acquireJobLock("marketplace-events", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result = await sweepMarketplaceEvents(loadPollableEbayOwnerIds);
    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "jobs-marketplace-events.cron" });
    return c.json({ error: "Marketplace-event sweep failed" }, 500);
  } finally {
    await lock.release();
  }
}
