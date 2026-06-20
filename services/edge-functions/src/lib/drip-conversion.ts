// US-937: Conversion attribution & goal tracking.
//
// When a trialist converts (customer.subscription.created → webhooks.ts), credit
// the conversion to the trial-conversion drip step/email that drove it:
//   1. resolve the user's active drip enrollment,
//   2. compute first/last-touch attribution from the (enrollment, step) send
//      ledger (the PURE evaluator in drip-graph.ts), tolerating an organic
//      converter who never opened/clicked a drip email (AC4),
//   3. record the attribution row (campaign → step → send) with the plan MRR +
//      Stripe linkage so the US-946 rollup's ROI/reconciliation figures are real,
//   4. exit the enrollment as 'converted' — which pauses all remaining win-back /
//      nurture for that user (an active enrollment IS the pause; exit ends it).
//
// Idempotent: the attribution row is unique per enrollment (00253), so a
// duplicate subscription webhook never double-counts a conversion (AC6). The
// 'Welcome to Pro' confirmation email is sent by the webhook's existing
// subscription-started path; this module only owns the attribution + exit.

import { supabaseAdmin } from "./supabase.ts";
import {
  computeConversionAttribution,
  type DripSendRecord,
} from "./drip-graph.ts";

export interface DripConversionResult {
  /** True when a new attribution row was written this call. */
  attributed: boolean;
  /** Why nothing was attributed (no_enrollment | already_attributed), if so. */
  reason?: "no_enrollment" | "already_attributed";
  enrollmentId?: string;
  model?: string;
  step?: number | null;
  mrrCents?: number;
}

interface EnrollmentRow {
  id: string;
  enrolled_at: string;
  trial_started_at: string | null;
  variant: string | null;
  incentive_enabled: boolean;
  exited_at: string | null;
}

interface SendRow {
  step: number;
  phase: string;
  variant: string | null;
  sent_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
}

const parseMs = (iso: string | null): number | null =>
  iso ? Date.parse(iso) : null;

export async function recordDripConversion(args: {
  userId: string;
  campaign?: string;
  stripeSubscriptionId: string | null;
  /** Monthly recurring value of the converted plan, in cents (US-946 ROI). */
  mrrCents: number;
  /** Epoch ms the conversion was observed. */
  convertedAtMs: number;
}): Promise<DripConversionResult> {
  const campaign = (args.campaign ?? "trial_conversion").trim() || "trial_conversion";
  const convertedAtIso = new Date(args.convertedAtMs).toISOString();

  // Resolve the user's most-recent enrollment for this campaign. Tenant-scoped
  // by user_id (service-role bypasses RLS, US-268).
  const { data: enr } = await supabaseAdmin
    .from("drip_enrollments")
    .select("id, enrolled_at, trial_started_at, variant, incentive_enabled, exited_at")
    .eq("user_id", args.userId)
    .eq("campaign", campaign)
    .order("enrolled_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const enrollment = enr as EnrollmentRow | null;
  if (!enrollment) {
    // Converted, but was never in the drip (e.g. signed up with a card) — nothing
    // to attribute. Not an error.
    return { attributed: false, reason: "no_enrollment" };
  }

  // Load the (enrollment, step) send ledger to compute first/last touch.
  const { data: sendsRaw } = await supabaseAdmin
    .from("drip_sends")
    .select("step, phase, variant, sent_at, opened_at, clicked_at")
    .eq("enrollment_id", enrollment.id);
  const sends: DripSendRecord[] = ((sendsRaw ?? []) as SendRow[]).map((s) => ({
    ordinal: s.step,
    phase: s.phase === "win_back" ? "win_back" : "in_trial",
    variant: s.variant,
    sentAtMs: parseMs(s.sent_at),
    openedAtMs: parseMs(s.opened_at),
    clickedAtMs: parseMs(s.clicked_at),
  }));

  const clockStartMs =
    parseMs(enrollment.trial_started_at) ?? parseMs(enrollment.enrolled_at) ??
      args.convertedAtMs;
  const attribution = computeConversionAttribution(
    sends,
    clockStartMs,
    args.convertedAtMs,
  );

  // Record the attribution row. Idempotent: unique(enrollment_id) (00253) +
  // ignoreDuplicates → a duplicate webhook inserts nothing (AC6). The mrr +
  // Stripe linkage come straight off the live subscription, so the row is
  // already reconciled against Stripe.
  const { data: inserted, error } = await supabaseAdmin
    .from("drip_attributions")
    .upsert(
      {
        enrollment_id: enrollment.id,
        user_id: args.userId,
        campaign,
        step: attribution.step,
        phase: attribution.phase,
        variant: attribution.variant ?? enrollment.variant,
        incentive_enabled: enrollment.incentive_enabled,
        mrr_cents: Math.max(0, Math.round(args.mrrCents)),
        stripe_subscription_id: args.stripeSubscriptionId,
        stripe_reconciled: true,
        converted_at: convertedAtIso,
        attribution_model: attribution.model,
        first_touch_step: attribution.firstTouchStep,
        last_touch_step: attribution.lastTouchStep,
        last_touch_at: attribution.lastTouchAtMs
          ? new Date(attribution.lastTouchAtMs).toISOString()
          : null,
        days_to_convert: attribution.daysToConvert,
      },
      { onConflict: "enrollment_id", ignoreDuplicates: true },
    )
    .select("id");
  if (error) {
    console.warn("[drip-conversion] attribution upsert failed:", error.message);
  }
  const wasNew = !error && Array.isArray(inserted) && inserted.length > 0;

  // Exit the enrollment as converted — stops every remaining win-back/nurture
  // send (AC3). Guarded on exited_at so a duplicate webhook (or the engine
  // having already exited it) is a clean no-op.
  await supabaseAdmin
    .from("drip_enrollments")
    .update({
      converted_at: convertedAtIso,
      exited_at: convertedAtIso,
      exit_reason: "converted",
      next_evaluation_at: null,
    })
    .eq("id", enrollment.id)
    .is("exited_at", null);

  return {
    attributed: wasNew,
    reason: wasNew ? undefined : "already_attributed",
    enrollmentId: enrollment.id,
    model: attribution.model,
    step: attribution.step,
    mrrCents: Math.max(0, Math.round(args.mrrCents)),
  };
}
