// US-402: decide when to clear a scheduled-downgrade ("pending") state.
//
// A downgrade is staged as a Stripe Subscription Schedule: phase 1 is the
// current plan, phase 2 the cheaper target. We store pending_flipdesk_plan/
// _interval/_schedule_id/_effective_at and show a "Downgrade scheduled" banner
// until it activates.
//
// The OLD webhook cleared pending on an exact plan-STRING match
// (plan === pending_flipdesk_plan), which is wrong two ways:
//   • it can't distinguish "schedule just ATTACHED" (subscription.updated fires
//     while the plan is unchanged) from "phase 2 ACTIVATED";
//   • it misses interval-only downgrades (e.g. pro/monthly → pro/yearly) where
//     the plan string never changes, so the banner sticks forever.
//
// This keys the clear on the SCHEDULE lifecycle instead: Stripe releases the
// schedule (sub.schedule → null, or a different id) once the final phase
// activates. We clear when the schedule is gone AND the resolved plan+interval
// match the target — or, as a reconcile, when the effective date has passed and
// the schedule is gone. Pure + dependency-free for unit testing.

export interface PendingDowngradeState {
  pendingPlan: string | null;
  pendingInterval: string | null;
  pendingScheduleId: string | null;
  pendingEffectiveAt: string | null;
}

export function shouldClearPendingDowngrade(
  state: PendingDowngradeState,
  resolvedPlan: string,
  resolvedInterval: string | null,
  incomingScheduleId: string | null,
  nowMs: number = Date.now(),
): boolean {
  const hasPending = Boolean(state.pendingPlan) || Boolean(state.pendingScheduleId);
  if (!hasPending) return false;

  // The tracked schedule is no longer attached: either the stored id is gone
  // (a different/absent schedule now) or there's no schedule at all anymore.
  const scheduleGone = state.pendingScheduleId
    ? incomingScheduleId !== state.pendingScheduleId
    : incomingScheduleId === null;
  if (!scheduleGone) return false; // schedule still pending → keep the banner.

  // The plan + interval reached the scheduled target (each only enforced when
  // it was actually recorded).
  const reachedTarget =
    (!state.pendingPlan || resolvedPlan === state.pendingPlan) &&
    (!state.pendingInterval || resolvedInterval === state.pendingInterval);
  if (reachedTarget) return true;

  // Reconcile stale pending: the effective date has passed and the schedule is
  // gone, but we never saw a clean target match — clear it so the banner can't
  // stick indefinitely.
  const effectivePassed = Boolean(state.pendingEffectiveAt) &&
    new Date(state.pendingEffectiveAt as string).getTime() <= nowMs;
  return effectivePassed;
}
