// eBay routes: the scheduled publish-due job.
//
// Split out of flipdesk-ebay.ts, which mounts this router at /api/flipdesk/ebay
// alongside its siblings. The local router keeps the name flipdeskEbayRoutes so
// every handler below is byte-for-byte the text it had before the split.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import {
  canClaimScheduledPublish,
  MAX_SCHEDULED_PUBLISH_ATTEMPTS,
  planScheduledPublishFailure,
  PUBLISH_DUE_LEASE_SECONDS,
  publishAttemptsOf,
  publishDueDeadlineReached,
} from "../lib/publish-due-policy.ts";
import { type EbayEnv } from "./flipdesk-ebay-shared.ts";
import { publishItemForOwner } from "./flipdesk-ebay-publish.ts";

export const flipdeskEbayRoutes = new Hono<EbayEnv>();

// US-528: how long a publish claim is honored before it's considered stale and
// reclaimable. Must exceed the realistic worst-case publish wall-time (eBay
// latency + the bounded publishOffer retries) so a still-running publish is
// never reclaimed, while a crashed one is eventually retried.
const PUBLISH_CLAIM_STALE_MS = 10 * 60_000;

// US-407: a publish-due tick claims a SMALL, bounded batch — not the whole
// backlog — so the run reliably finishes inside the 240s job-lock lease (each
// publish makes several sequential eBay calls; 100 of them serially would blow
// past the lease, the lock would expire mid-run, and the next tick would
// overlap). Bounding the batch keeps each invocation idempotent and short; the
// cron (every 5 min) drains any larger backlog over successive ticks. Sized so
// the worst case (PUBLISH_BATCH_LIMIT × worst-case publish wall-time) stays
// comfortably under the lease. Overridable for ops tuning.
const PUBLISH_BATCH_DEFAULT = 15;
export function publishBatchLimit(): number {
  const n = Number(Deno.env.get("PUBLISH_DUE_BATCH_LIMIT"));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100) : PUBLISH_BATCH_DEFAULT;
}

// Scheduled publishing worker (US-322). Job-secret gated (no user token) like
// /oauth/refresh — a cron hits this periodically. Publishes every draft whose
// scheduled_publish_at is due and that isn't already live, AS the listing's
// owner. Not under authMiddleware (path is /jobs/*, not /listings/*).
// US-528: each due draft is atomically CLAIMED before publishing so an
// overlapping cron tick (e.g. when a publish runs longer than the cron
// interval) can't double-publish it.
flipdeskEbayRoutes.post("/jobs/publish-due", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // US-503: coarse overlap guard so a slow 5-min tick can't race the next one.
  // (Per-row publish_claimed_at claim-lock below — US-528 — is the resource-
  // level idempotency; this just stops a wasteful overlapping scan.) 4-min lease
  // < the 5-min cadence so a crashed run frees the lock before the next tick.
  const lock = await acquireJobLock("publish-due", PUBLISH_DUE_LEASE_SECONDS);
  if (!lock.acquired) {
    return c.json({ skipped: true, reason: lock.reason, scanned: 0, published: 0 });
  }
  try {
  const tickStartedMs = Date.now();
  const now = new Date(tickStartedMs).toISOString();
  // US-528: a claim older than this is "stale" and reclaimable — covers a
  // publish whose container crashed/redeployed mid-run so the draft isn't
  // stranded. Must comfortably exceed the worst-case publish wall-time.
  const staleBefore = new Date(Date.now() - PUBLISH_CLAIM_STALE_MS).toISOString();
  // US-407: bound the scan to a small batch so the tick finishes within the
  // lock lease; the cron drains any larger backlog over successive ticks. We
  // fetch one extra row to cheaply detect whether more work remains.
  const batchLimit = publishBatchLimit();
  // Due = scheduled at/before now, not yet synced live, still a draft, and not
  // currently claimed by an in-flight tick. The lte filter already excludes
  // NULL scheduled_publish_at rows.
  const { data: dueRows, error } = await supabaseAdmin
    .from("listings")
    .select("id, inventory_item_id, publish_attempts")
    .lte("scheduled_publish_at", now)
    .is("synced_to_ebay_at", null)
    .eq("listing_status", "draft")
    .lt("publish_attempts", MAX_SCHEDULED_PUBLISH_ATTEMPTS)
    .or(`publish_claimed_at.is.null,publish_claimed_at.lt.${staleBefore}`)
    .order("scheduled_publish_at", { ascending: true })
    .limit(batchLimit + 1);
  if (error) {
    console.error("[flipdesk-ebay] publish-due scan failed:", error);
    return c.json({ error: "Scan failed" }, 500);
  }

  const allDue = (dueRows ?? []) as {
    id: string;
    inventory_item_id: string;
    publish_attempts: number | null;
  }[];
  // US-407: we asked for batchLimit+1; a full extra row means the backlog
  // exceeds one tick. Process only batchLimit this invocation; the next cron
  // tick picks up the rest. `more` lets ops/monitoring see the backlog draining.
  const more = allDue.length > batchLimit;
  const due = allDue.slice(0, batchLimit);
  if (due.length === 0) {
    return c.json({ scanned: 0, published: 0, failed: 0, skipped: 0, more: false });
  }

  // Resolve each item's owner (the publish must run as them).
  const itemIds = Array.from(new Set(due.map((d) => d.inventory_item_id)));
  const { data: itemRows } = await supabaseAdmin
    .from("inventory_items")
    .select("id, user_id")
    .in("id", itemIds);
  const ownerByItem = new Map(
    ((itemRows ?? []) as { id: string; user_id: string }[]).map((r) => [r.id, r.user_id]),
  );

  let published = 0;
  let failed = 0;
  let skipped = 0;
  let deferred = 0;
  let exhausted = 0;
  for (const row of due) {
    // Stop claiming once the tick nears the job-lock lease, so a publish taken
    // now is not still running when the lock expires and the next tick starts.
    // Unreached rows stay due; the next tick picks them up.
    if (publishDueDeadlineReached(tickStartedMs, Date.now())) {
      deferred = due.length - (published + failed + skipped);
      break;
    }
    const owner = ownerByItem.get(row.inventory_item_id);
    if (!owner) {
      failed += 1;
      continue;
    }
    const attempts = publishAttemptsOf(row.publish_attempts);
    if (!canClaimScheduledPublish(attempts)) {
      skipped += 1;
      continue;
    }

    // US-528: atomically claim the draft before publishing so a concurrent (or
    // next-tick) cron run can't publish the same row while this publish is
    // still in flight. Only the tick that wins this conditional update — which
    // re-checks the same eligibility predicate under a row lock — proceeds; the
    // claim flips publish_claimed_at to a FRESH timestamp (not the scan-time
    // `now`, which can be many minutes old on a long batch), so the claim is
    // honored for the full stale window from the moment it is taken.
    const claimedAt = new Date().toISOString();
    // US-1552: two sequential conditional updates, NOT `.or()` — the prod
    // PostgREST rejects logical operators on mutations (42703 from the
    // update-CTE alias), which silently skipped every claim.
    // Each claim counts one attempt. PostgREST cannot write
    // publish_attempts + 1, so the claim writes the scanned value + 1 and
    // matches on the scanned value: a tick holding a stale count claims
    // nothing, and the cap is re-checked in the same statement.
    const attemptsAfterClaim = attempts + 1;
    const claimPatch = { publish_claimed_at: claimedAt, publish_attempts: attemptsAfterClaim };
    let { data: claimed, error: claimErr } = await supabaseAdmin
      .from("listings")
      .update(claimPatch)
      .eq("id", row.id)
      .eq("listing_status", "draft")
      .is("synced_to_ebay_at", null)
      .is("publish_claimed_at", null)
      .eq("publish_attempts", attempts)
      .lt("publish_attempts", MAX_SCHEDULED_PUBLISH_ATTEMPTS)
      .select("id")
      .maybeSingle();
    if (!claimErr && !claimed) {
      ({ data: claimed, error: claimErr } = await supabaseAdmin
        .from("listings")
        .update(claimPatch)
        .eq("id", row.id)
        .eq("listing_status", "draft")
        .is("synced_to_ebay_at", null)
        .lt("publish_claimed_at", staleBefore)
        .eq("publish_attempts", attempts)
        .lt("publish_attempts", MAX_SCHEDULED_PUBLISH_ATTEMPTS)
        .select("id")
        .maybeSingle());
    }
    if (claimErr) {
      console.error(
        `[flipdesk-ebay] scheduled-publish claim failed for listing ${row.id}: ${claimErr.message}`,
      );
      skipped += 1;
      continue;
    }
    if (!claimed) {
      skipped += 1;
      continue;
    }

    let failureMsg: string | null = null;
    try {
      const result = await publishItemForOwner(owner, row.inventory_item_id);
      if (result.ok) {
        published += 1;
      } else {
        const b = result.body;
        failureMsg = (b.detail ?? b.error ??
          (Array.isArray(b.blockers) ? (b.blockers as string[]).join("; ") : "Publish failed")) as string;
      }
    } catch (err) {
      failureMsg = err instanceof Error ? err.message : String(err);
    }
    if (failureMsg !== null) {
      failed += 1;
      // Stamp the moment THIS publish failed, not the scan-time `now`. On the
      // last attempt the plan also clears scheduled_publish_at so the draft
      // stops being due; publish_error stays for the seller to read. There is
      // no publish-failure notification helper yet, so the seller learns of it
      // from the draft's publish_error banner and the pipeline-issue view.
      const plan = planScheduledPublishFailure(attemptsAfterClaim, failureMsg, new Date());
      if (plan.terminal) exhausted += 1;
      const { error: failErr } = await supabaseAdmin
        .from("listings")
        .update(plan.patch)
        .eq("id", row.id)
        .eq("inventory_item_id", row.inventory_item_id);
      if (failErr) {
        console.error(
          `[flipdesk-ebay] scheduled-publish failure write failed for listing ${row.id}: ${failErr.message}`,
        );
      }
    }
  }

  return c.json({ scanned: due.length, published, failed, skipped, exhausted, deferred, more });
  } finally {
    await lock.release();
  }
});
