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
async function loadActiveEbayOwnerIds(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select("user_id")
    .eq("marketplace", "ebay")
    .eq("is_active", true);
  if (error) {
    throw new Error(`load active eBay owners failed: ${error.message}`);
  }
  const ids = new Set<string>();
  for (const row of (data ?? []) as Array<{ user_id: string | null }>) {
    if (row.user_id) ids.add(row.user_id);
  }
  return [...ids];
}

export async function handleMarketplaceEventsCron(c: Context): Promise<Response> {
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
    const result = await sweepMarketplaceEvents(loadActiveEbayOwnerIds);
    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "jobs-marketplace-events.cron" });
    return c.json({ error: "Marketplace-event sweep failed" }, 500);
  } finally {
    await lock.release();
  }
}
