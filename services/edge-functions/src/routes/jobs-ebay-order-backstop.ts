// Cron: eBay order-sync backstop (US-1965).
//
// Inbound sale/order ingest is otherwise webhook-driven (the eBay Notification
// API → flipdesk-webhooks → triggerEbaySyncForUser) plus the manual/scheduled
// per-user pull. If a notification is dropped, a topic was never subscribed, or
// a seller simply hasn't pulled in a while, their sales silently stop appearing.
// This scheduled task is the safety net: it sweeps active eBay connections and
// fires the SAME incremental, idempotent order pull for the ones that have
// fallen behind, so a missed webhook never becomes a permanently missing sale.
//
// It reuses triggerEbaySyncForUser (flipdesk-ebay.ts), which already:
//   • resolves the owner's active/primary connection,
//   • claims the per-tenant sync lock (claimSyncRun) so it never double-syncs a
//     tenant that is mid-pull (webhook, manual, or a prior backstop tick) —
//     returns "already_running" instead,
//   • fires doListingsPull incrementally from last_synced_at, which clamps the
//     start date under eBay's 2-year getOrders/getTransactions limit (errorId
//     30830) and upserts sales idempotently.
// So the backstop composes with webhooks + the parked-event drain and can never
// create duplicate sales.
//
// Herd control: triggerEbaySyncForUser fires the heavy pull detached, so we
// deliberately do NOT fan out to every connection each tick. We target the
// STALEST connections (never synced, or not synced within FRESH_WINDOW_MS),
// bounded to BACKSTOP_BATCH_SIZE owners per run; stalest-first ordering
// guarantees every connection is reached over successive ticks. Guarded by the
// shared job secret + an overlap lock (mirrors the other crons).

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isEbayConfigured } from "../lib/ebay-client.ts";
import { captureException } from "../lib/observability.ts";
import { triggerEbaySyncForUser } from "./flipdesk-ebay.ts";

// Owners to fire per tick. Each fired pull is a detached background sync (eBay
// API + Supabase writes), so we bound the fan-out; the rest are caught on the
// next tick (stalest-first). Small enough to be gentle, large enough to drain
// a normal backlog quickly at current scale.
export const BACKSTOP_BATCH_SIZE = 25;

// Skip connections synced within this window — a webhook-driven, manual, or
// scheduled pull already covered them, so re-pulling would be wasted work (the
// per-tenant lock + idempotent ingest make it harmless, just pointless).
export const BACKSTOP_FRESH_WINDOW_MS = 15 * 60 * 1000; // 15 min

// Over-fetch factor so the pure selector still sees enough stale rows to fill a
// batch after de-duping multi-connection owners.
const FETCH_MULTIPLIER = 4;

const JOB_LOCK_LEASE_SECONDS = 300;

export interface ConnectionCursorRow {
  user_id: string | null;
  last_synced_at: string | null;
}

/**
 * Pure owner-selection: from raw marketplace_connection rows, pick the distinct
 * owners the backstop should sync THIS tick.
 *
 *   1. Drop rows with no owner.
 *   2. De-dupe by owner, keeping that owner's STALEST connection cursor (a null
 *      last_synced_at — never synced — is the stalest possible).
 *   3. Drop owners synced within `freshWindowMs` (recently covered elsewhere).
 *   4. Sort stalest-first (never-synced first, then oldest cursor).
 *   5. Truncate to `batchSize`.
 *
 * Kept pure (no DB / clock) so the staleness + batching logic is unit-tested
 * without a live edge service.
 */
export function selectBackstopOwners(
  rows: ConnectionCursorRow[],
  opts: { nowMs: number; freshWindowMs: number; batchSize: number },
): string[] {
  const { nowMs, freshWindowMs, batchSize } = opts;
  const freshCutoff = nowMs - freshWindowMs;

  // owner → stalest cursor (ms), null = never synced (treated as -Infinity).
  const staleness = new Map<string, number>();
  for (const row of rows) {
    const owner = row.user_id;
    if (!owner) continue;
    const cursorMs = row.last_synced_at
      ? new Date(row.last_synced_at).getTime()
      : Number.NEGATIVE_INFINITY;
    // Guard against an unparseable timestamp (NaN) — treat as never-synced.
    const normalized = Number.isNaN(cursorMs) ? Number.NEGATIVE_INFINITY : cursorMs;
    const existing = staleness.get(owner);
    if (existing === undefined || normalized < existing) {
      staleness.set(owner, normalized);
    }
  }

  return [...staleness.entries()]
    .filter(([, cursorMs]) => cursorMs < freshCutoff)
    .sort((a, b) => a[1] - b[1])
    .slice(0, batchSize)
    .map(([owner]) => owner);
}

export interface BackstopSweepResult {
  candidates: number;
  started: number;
  alreadyRunning: number;
  noConnection: number;
  notConfigured: number;
}

export async function handleEbayOrderBackstopCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!isEbayConfigured()) {
    return c.json({ ok: true, skipped: true, reason: "ebay_not_configured" });
  }

  // A short lease — the loop only fires detached pulls (fast); it exists purely
  // to keep two overlapping ticks from double-selecting the same stale owners.
  const lock = await acquireJobLock("ebay-order-backstop", JOB_LOCK_LEASE_SECONDS);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    // Stalest-first so a large backlog drains deterministically across ticks.
    // Tenant isolation: the connection lives on the workspace owner, so the
    // owner id resolved here IS the tenant; triggerEbaySyncForUser scopes every
    // downstream read/write by that owner (see tenant-isolation skill, US-268).
    const { data, error } = await supabaseAdmin
      .from("marketplace_connections")
      .select("user_id, last_synced_at")
      .eq("marketplace", "ebay")
      .eq("is_active", true)
      .order("last_synced_at", { ascending: true, nullsFirst: true })
      .limit(BACKSTOP_BATCH_SIZE * FETCH_MULTIPLIER);
    if (error) {
      throw new Error(`load active eBay connections failed: ${error.message}`);
    }

    const owners = selectBackstopOwners((data ?? []) as ConnectionCursorRow[], {
      nowMs: Date.now(),
      freshWindowMs: BACKSTOP_FRESH_WINDOW_MS,
      batchSize: BACKSTOP_BATCH_SIZE,
    });

    const result: BackstopSweepResult = {
      candidates: owners.length,
      started: 0,
      alreadyRunning: 0,
      noConnection: 0,
      notConfigured: 0,
    };
    for (const ownerId of owners) {
      // US-3110: this job exists to catch a MISSED ORDER. It used to pay a
      // whole-catalog read (one GET /offer per SKU, plus GetMyeBaySelling) on
      // every tick to do it — 25,312 Inventory calls a day across two sellers.
      // "orders" skips both active-listing passes; resolveSyncScope still
      // upgrades this to a full read once the catalog goes stale, so eBay-side
      // edits are never missed for longer than CATALOG_REFRESH_MS.
      const status = await triggerEbaySyncForUser(ownerId, "orders");
      switch (status) {
        case "started":
          result.started++;
          break;
        case "already_running":
          result.alreadyRunning++;
          break;
        case "no_connection":
          result.noConnection++;
          break;
        case "not_configured":
          result.notConfigured++;
          break;
      }
    }

    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "jobs-ebay-order-backstop.cron" });
    return c.json({ error: "eBay order-sync backstop failed" }, 500);
  } finally {
    await lock.release();
  }
}
