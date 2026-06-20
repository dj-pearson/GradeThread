// US-932: internal behavioral event stream (drip trigger substrate).
//
// Server-side PostHog (posthog.ts) fires OUT to analytics; this records the SAME
// lifecycle actions INTO public.user_events so the drip / journey trigger engine
// (US-933, drip-trigger.ts) can ask "did first_grade happen since enrolled_at?".
//
// emitEvent is FIRE-AND-FORGET: it never throws into the caller and never blocks
// the originating action — analytics must not be able to fail a grade, a publish,
// a checkout, or a webhook. Callers `void emitEvent(...)` (or await; it always
// resolves). It is the internal counterpart to posthog.ts's captureServer and is
// added ALONGSIDE the existing captures, never replacing them.

import { supabaseAdmin } from "./supabase.ts";

// The lifecycle keys the trigger engine understands. Kept as a union so call
// sites can't typo a key the engine will silently never match.
export type UserEventKey =
  | "signup"
  | "first_grade"
  | "grade_completed"
  | "first_listing"
  | "listing_published"
  | "sale_recorded"
  | "checkout_started"
  | "subscription_created"
  | "trial_expired"
  | "login"
  | "app_open";

// Events that advance users.last_active_at (the cheap recency signal inactivity
// triggers read instead of joining grade_reports/listings/sales every tick).
const ACTIVITY_EVENTS: ReadonlySet<UserEventKey> = new Set<UserEventKey>([
  "app_open",
  "login",
  "first_grade",
  "grade_completed",
  "first_listing",
  "listing_published",
  "sale_recorded",
]);

export interface EmitEventOptions {
  /** Arbitrary event payload (e.g. { plan: "pro" }). Defaults to {}. */
  properties?: Record<string, unknown>;
  /** Stable key making the insert idempotent for first-occurrence / once-only
   *  events. Convention: `${event}:${userId}`. A duplicate is silently ignored
   *  (the dedupe_key UNIQUE constraint). Omit for repeatable events. */
  dedupeKey?: string;
  /** Occurrence time (ISO). Defaults to now() in the DB. */
  occurredAt?: string;
  /** Override whether this event bumps users.last_active_at. Defaults to the
   *  ACTIVITY_EVENTS membership of `event`. */
  touchActive?: boolean;
}

/** Convenience: the canonical dedupe key for a once-per-user event. */
export function firstOccurrenceKey(event: UserEventKey, userId: string): string {
  return `${event}:${userId}`;
}

/**
 * Record one behavioral event. Fire-and-forget: swallows every error (logs a
 * warning) so a failure here can never surface to — let alone fail — the action
 * that emitted it.
 */
export async function emitEvent(
  userId: string | null | undefined,
  event: UserEventKey,
  opts: EmitEventOptions = {},
): Promise<void> {
  try {
    if (!userId) return;

    const row: Record<string, unknown> = {
      user_id: userId,
      event_key: event,
      properties: opts.properties ?? {},
    };
    if (opts.occurredAt) row.occurred_at = opts.occurredAt;
    if (opts.dedupeKey) row.dedupe_key = opts.dedupeKey;

    const { error } = opts.dedupeKey
      ? await supabaseAdmin
          .from("user_events")
          .upsert(row, { onConflict: "dedupe_key", ignoreDuplicates: true })
      : await supabaseAdmin.from("user_events").insert(row);

    if (error) {
      console.warn(`[user-events] emit '${event}' failed: ${error.message}`);
    }

    const touch = opts.touchActive ?? ACTIVITY_EVENTS.has(event);
    if (touch) await touchLastActive(userId, opts.occurredAt);
  } catch (err) {
    console.warn(
      `[user-events] emit '${event}' threw (ignored):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Move users.last_active_at FORWARD to `at` (default now). Forward-only so an
 * out-of-order/backfilled older event can never regress the recency signal.
 */
async function touchLastActive(userId: string, atIso?: string): Promise<void> {
  const at = atIso ?? new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("users")
    .update({ last_active_at: at })
    .eq("id", userId)
    // Only advance: skip rows already at-or-past `at`.
    .or(`last_active_at.is.null,last_active_at.lt.${at}`);
  if (error) {
    console.warn(`[user-events] last_active_at touch failed: ${error.message}`);
  }
}
