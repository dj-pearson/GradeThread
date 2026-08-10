// US-893: scheduled Stripe-vs-DB reconciliation.
//
// Revenue leaks when a Stripe webhook is missed or its DB write loses a race:
// our cached users.subscription_status / flipdesk_plan then drifts from the
// latest event Stripe actually sent. This cron precomputes those divergences
// into billing_reconciliation_flags so the admin console reads a ready list
// instead of recomputing on every page load (AC3). Each run it:
//   1. pulls the latest recorded subscription event per user + the cached state
//      (reconciliation_candidates RPC — one query, no N+1),
//   2. runs the pure detector (lib/billing-reconciliation.ts) — single source of
//      truth for "what does the latest event imply",
//   3. upserts an OPEN flag per still-diverging account, and
//   4. auto-resolves previously-open flags for accounts it scanned that no longer
//      diverge (the webhook caught up, or an operator re-synced).
//
// Mounted in main.ts as POST /api/jobs/billing-reconciliation, OUTSIDE the
// /api/* JWT groups; the handler enforces X-Internal-Job-Secret itself (same
// pattern as the other Coolify crons). The /api/jobs/* middleware records the run
// in the cron-run ledger.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { detectDivergence, detectStripeDivergence } from "../lib/billing-reconciliation.ts";
import { getStripe } from "../lib/stripe-client.ts";
import { emitOpsEvent } from "../lib/ops-events.ts";
import { subscriptionIsBuyer } from "./webhooks.ts";

// Bound the per-run scan. A pre-launch SaaS has far fewer subscribers than this;
// the RPC clamps to 10k regardless.
const SCAN_LIMIT = 5000;

// US-2295: how much of Stripe to pull per run. Listing is paginated at 100, and
// the whole point is one bounded sweep rather than a per-user retrieve — 5000
// candidates would otherwise mean 5000 API calls and a rate-limited job that
// never finishes.
const STRIPE_PAGE_SIZE = 100;
const STRIPE_MAX_PAGES = 20; // 2,000 subscriptions per run

/**
 * Every subscription Stripe currently holds, keyed by customer id.
 *
 * `status: "all"` is load-bearing: the default omits canceled subscriptions,
 * and "Stripe says canceled while we say active" is the single most expensive
 * divergence — a customer being served a paid plan for free. Filtering it out
 * would hide exactly what this fetch exists to find.
 *
 * Returns null when Stripe is unreachable or unconfigured, so the caller can
 * skip the Stripe half and still run the event-based half rather than failing
 * the whole job.
 */
async function fetchStripeSubscriptions(): Promise<
  Map<string, { id: string; status: string | null }> | null
> {
  const stripe = getStripe();
  if (!stripe) return null;
  const byCustomer = new Map<string, { id: string; status: string | null }>();
  try {
    let startingAfter: string | undefined;
    for (let page = 0; page < STRIPE_MAX_PAGES; page++) {
      const res = await stripe.subscriptions.list({
        limit: STRIPE_PAGE_SIZE,
        status: "all",
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const sub of res.data) {
        // US-2457: the BUYER subscription rides the same Stripe customer as the
        // seller one, and this map is compared against the SELLER cached
        // columns. Including it means a buyer's status can be read as the
        // seller's — an account holding an active Guard plan and a canceled
        // FlipDesk one produces a `stripe_divergence` flag saying Stripe thinks
        // they are active. The remedy for that flag is the resync, whose
        // product filter is the fix in the same story: a false flag here is a
        // loaded button, not a stray line.
        if (subscriptionIsBuyer(sub)) continue;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
        if (!customerId) continue;
        // One SELLER subscription per customer is the model here. If Stripe
        // holds several, prefer a non-canceled one — a live sub is the state
        // that governs access, and comparing against a stale canceled sibling
        // would manufacture a divergence that is not real.
        const existing = byCustomer.get(customerId);
        if (!existing || (existing.status === "canceled" && sub.status !== "canceled")) {
          byCustomer.set(customerId, { id: sub.id, status: sub.status ?? null });
        }
      }
      if (!res.has_more || res.data.length === 0) break;
      startingAfter = res.data[res.data.length - 1]?.id;
      if (!startingAfter) break;
    }
    return byCustomer;
  } catch (err) {
    console.error(
      "[billing-reconciliation] Stripe subscription fetch failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

interface CandidateRow {
  subject_user_id: string;
  email: string | null;
  db_status: string | null;
  db_plan: string | null;
  past_due_since: string | null;
  stripe_customer_id: string | null;
  subscription_id: string | null;
  latest_event_id: string | null;
  latest_event_type: string | null;
  event_to_plan: string | null;
  event_raw_status: string | null;
  event_at: string | null;
}

/**
 * Open or refresh the single OPEN flag for an account.
 *
 * US-2295 extracted this from the event-divergence branch so the new
 * Stripe-divergence branch writes through the exact same path. Two copies of an
 * update-then-insert against a partial unique index is how one of them ends up
 * inserting a second open flag.
 *
 * PostgREST cannot target a partial index for upsert, hence update-then-insert
 * rather than a real upsert.
 */
async function upsertFlag(
  subjectUserId: string,
  fields: Record<string, unknown>,
): Promise<{ ok: boolean; newlyOpened: boolean }> {
  const nowIso = new Date().toISOString();
  const { data: updated, error: updErr } = await supabaseAdmin
    .from("billing_reconciliation_flags")
    .update({ ...fields, last_seen_at: nowIso })
    .eq("subject_user_id", subjectUserId)
    .eq("status", "open")
    .select("id");
  if (updErr) {
    console.error(
      `[billing-reconciliation] flag update failed for ${subjectUserId}:`,
      updErr.message,
    );
    return { ok: false, newlyOpened: false };
  }
  if (updated && updated.length > 0) return { ok: true, newlyOpened: false };

  const { error: insErr } = await supabaseAdmin
    .from("billing_reconciliation_flags")
    .insert({
      subject_user_id: subjectUserId,
      ...fields,
      status: "open",
      detected_at: nowIso,
      last_seen_at: nowIso,
    });
  if (insErr) {
    console.error(
      `[billing-reconciliation] flag insert failed for ${subjectUserId}:`,
      insErr.message,
    );
    return { ok: false, newlyOpened: false };
  }
  return { ok: true, newlyOpened: true };
}

export async function handleBillingReconciliationCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("billing-reconciliation", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const { data, error } = await supabaseAdmin.rpc("reconciliation_candidates", {
      p_limit: SCAN_LIMIT,
    });
    if (error) {
      console.error("[billing-reconciliation] candidate scan failed:", error.message);
      return c.json({ error: "Reconciliation scan failed." }, 500);
    }

    const candidates = (data ?? []) as CandidateRow[];
    // US-2295: Stripe's own view, fetched ONCE for the whole run.
    const stripeSubs = await fetchStripeSubscriptions();
    let stripeDiverged = 0;
    const scannedIds: string[] = [];
    const divergingIds: string[] = [];
    let upserted = 0;
    // US-906: count flags that are NEWLY opened this run (not refreshes of an
    // already-open one) so the ops feed alerts on genuinely new divergences only.
    let newlyFlagged = 0;

    for (const row of candidates) {
      scannedIds.push(row.subject_user_id);

      // US-2295: check Stripe FIRST, and outside the latest_event_type guard.
      //
      // That guard is what made a missed webhook invisible: no event row means
      // no latest_event_type, so the account was skipped before anything looked
      // at it — and a missed webhook is precisely the drift this job exists to
      // catch. Stripe's live status needs no event to have been recorded.
      const live = stripeSubs && row.stripe_customer_id
        ? stripeSubs.get(row.stripe_customer_id)
        : undefined;
      if (live) {
        const sd = detectStripeDivergence(
          { status: row.db_status, plan: row.db_plan },
          live,
        );
        if (sd.diverged) {
          stripeDiverged++;
          divergingIds.push(row.subject_user_id);
          const wrote = await upsertFlag(row.subject_user_id, {
            kind: "stripe_divergence",
            db_status: row.db_status,
            expected_status: sd.expectedStatus,
            db_plan: row.db_plan,
            // Plan is not compared against Stripe (see the lib comment), so it
            // is echoed rather than asserted — claiming an expected plan we did
            // not derive would be worse than leaving it as-is.
            expected_plan: row.db_plan,
            latest_event_id: row.latest_event_id,
            latest_event_type: row.latest_event_type,
            detail: {
              email: row.email,
              reasons: sd.reasons,
              subscription_id: live.id,
              stripe_status: live.status,
              source: "stripe",
            },
          });
          if (wrote.ok) {
            if (wrote.newlyOpened) newlyFlagged++;
            upserted++;
          }
          continue;
        }
      }

      if (!row.latest_event_type) continue;

      const result = detectDivergence(
        { status: row.db_status, plan: row.db_plan },
        {
          eventType: row.latest_event_type,
          toPlan: row.event_to_plan,
          rawStatus: row.event_raw_status,
        },
      );
      if (!result.diverged) continue;

      divergingIds.push(row.subject_user_id);

      const kind = result.statusDiverged ? "status_divergence" : "plan_divergence";
      // At most one OPEN flag per account (partial unique index). PostgREST can't
      // target a partial index for upsert, so update-then-insert: refresh the
      // existing open flag, or insert one if none is open.
      const fields = {
        kind,
        db_status: row.db_status,
        expected_status: result.expected.status,
        db_plan: row.db_plan,
        expected_plan: result.expected.plan,
        latest_event_id: row.latest_event_id,
        latest_event_type: row.latest_event_type,
        detail: {
          email: row.email,
          reasons: result.reasons,
          subscription_id: row.subscription_id,
          event_at: row.event_at,
        },
      };
      const wrote = await upsertFlag(row.subject_user_id, fields);
      if (!wrote.ok) continue;
      if (wrote.newlyOpened) newlyFlagged++;
      upserted++;
    }

    // US-906: surface newly-opened reconciliation flags on the ops activity feed
    // (a billing divergence is real revenue risk → warning). Refreshes of an
    // already-open flag don't re-alert.
    if (newlyFlagged > 0) {
      void emitOpsEvent("billing.reconciliation", "warning", {
        title: `Billing reconciliation opened ${newlyFlagged} new divergence flag${newlyFlagged === 1 ? "" : "s"}`,
        source: "billing-reconciliation",
        data: {
          newly_flagged: newlyFlagged,
          diverged: divergingIds.length,
          scanned: scannedIds.length,
          // US-2295: how many came from Stripe itself rather than from our own
          // event log — the number that says whether webhooks are being missed.
          stripe_diverged: stripeDiverged,
          stripe_checked: stripeSubs !== null,
        },
      });
    }

    // Auto-resolve open flags for accounts we scanned that no longer diverge —
    // the webhook caught up or an operator already re-synced. Only touch accounts
    // present in this scan so a flag for an out-of-window account isn't cleared.
    let autoResolved = 0;
    const staleIds = scannedIds.filter((id) => !divergingIds.includes(id));
    if (staleIds.length > 0) {
      // Chunk the IN-list to keep the filter expression bounded.
      for (let i = 0; i < staleIds.length; i += 200) {
        const chunk = staleIds.slice(i, i + 200);
        const { data: cleared, error: resErr } = await supabaseAdmin
          .from("billing_reconciliation_flags")
          .update({
            status: "resolved",
            resolution: "auto",
            resolved_at: new Date().toISOString(),
          })
          .eq("status", "open")
          .in("subject_user_id", chunk)
          .select("id");
        if (resErr) {
          console.error("[billing-reconciliation] auto-resolve failed:", resErr.message);
        } else {
          autoResolved += cleared?.length ?? 0;
        }
      }
    }

    return c.json({
      ok: true,
      scanned: scannedIds.length,
      diverged: divergingIds.length,
      flagged: upserted,
      autoResolved,
      // US-2295: `stripeChecked: false` means the Stripe half did not run
      // (unconfigured or unreachable) — the run is NOT a clean bill of health,
      // and saying so is the difference between this job being useful and it
      // returning green regardless, which is what the story was filed about.
      stripeChecked: stripeSubs !== null,
      stripeDiverged,
    });
  } finally {
    await lock.release();
  }
}
