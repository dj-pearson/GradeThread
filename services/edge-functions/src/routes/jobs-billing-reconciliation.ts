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
import { detectDivergence } from "../lib/billing-reconciliation.ts";
import { emitOpsEvent } from "../lib/ops-events.ts";

// Bound the per-run scan. A pre-launch SaaS has far fewer subscribers than this;
// the RPC clamps to 10k regardless.
const SCAN_LIMIT = 5000;

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
    const scannedIds: string[] = [];
    const divergingIds: string[] = [];
    let upserted = 0;
    // US-906: count flags that are NEWLY opened this run (not refreshes of an
    // already-open one) so the ops feed alerts on genuinely new divergences only.
    let newlyFlagged = 0;

    for (const row of candidates) {
      scannedIds.push(row.subject_user_id);
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
      const nowIso = new Date().toISOString();
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
      const { data: updated, error: updErr } = await supabaseAdmin
        .from("billing_reconciliation_flags")
        .update({ ...fields, last_seen_at: nowIso })
        .eq("subject_user_id", row.subject_user_id)
        .eq("status", "open")
        .select("id");
      if (updErr) {
        console.error(
          `[billing-reconciliation] flag update failed for ${row.subject_user_id}:`,
          updErr.message,
        );
        continue;
      }
      if (!updated || updated.length === 0) {
        const { error: insErr } = await supabaseAdmin
          .from("billing_reconciliation_flags")
          .insert({
            subject_user_id: row.subject_user_id,
            ...fields,
            status: "open",
            detected_at: nowIso,
            last_seen_at: nowIso,
          });
        if (insErr) {
          console.error(
            `[billing-reconciliation] flag insert failed for ${row.subject_user_id}:`,
            insErr.message,
          );
          continue;
        }
        newlyFlagged++;
      }
      upserted++;
    }

    // US-906: surface newly-opened reconciliation flags on the ops activity feed
    // (a billing divergence is real revenue risk → warning). Refreshes of an
    // already-open flag don't re-alert.
    if (newlyFlagged > 0) {
      void emitOpsEvent("billing.reconciliation", "warning", {
        title: `Billing reconciliation opened ${newlyFlagged} new divergence flag${newlyFlagged === 1 ? "" : "s"}`,
        source: "billing-reconciliation",
        data: { newly_flagged: newlyFlagged, diverged: divergingIds.length, scanned: scannedIds.length },
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
    });
  } finally {
    await lock.release();
  }
}
