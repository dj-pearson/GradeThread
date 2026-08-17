// US-2351: the server-side record of an impersonation in flight.
//
// The entry to impersonation was already well guarded. Everything after the
// token was minted was not: no time limit, no revocation, and — the one that
// makes the others matter — no MARKER. Nothing server-side said "this request is
// an impersonation", so an admin viewing a disputing customer's account could
// cancel their subscription and delete it, and every downstream record showed
// the customer doing it themselves.
//
// This module is that marker, and it deliberately lives in the database rather
// than in the token. A claim baked into the session would be equally invisible
// to any route that does not parse it, and — worse — could not be revoked once
// minted. A row can be read by anyone who asks and ended by anyone who must.

import { supabaseAdmin } from "./supabase.ts";
import { captureException } from "./observability.ts";

/**
 * The hard cap (AC1). Thirty minutes is long enough to reproduce a support
 * ticket and short enough that a session left open over lunch is not still live
 * after it.
 *
 * Enforced by every READER rather than by a scheduled sweep: a job that has not
 * run yet is not a security control, and the window between the cap passing and
 * the sweep firing is exactly when a forgotten session is most dangerous.
 */
export const IMPERSONATION_MAX_SECONDS = 30 * 60;

export interface ImpersonationSession {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  target_id: string | null;
  target_email: string | null;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  end_reason: string | null;
}

export interface StartInput {
  actorId: string;
  actorEmail: string;
  targetId: string;
  targetEmail: string;
  nowMs: number;
}

/**
 * Open the record. Returns null when it could not be written — and the caller
 * MUST treat that as a refusal to impersonate, not as a logging hiccup. An
 * impersonation with no row is precisely the unbounded, unmarked, unrevocable
 * one this story exists to remove.
 */
export async function startImpersonation(
  input: StartInput,
): Promise<ImpersonationSession | null> {
  const expiresAt = new Date(
    input.nowMs + IMPERSONATION_MAX_SECONDS * 1000,
  ).toISOString();
  const { data, error } = await supabaseAdmin
    .from("admin_impersonation_sessions")
    .insert({
      actor_id: input.actorId,
      actor_email: input.actorEmail,
      target_id: input.targetId,
      target_email: input.targetEmail,
      expires_at: expiresAt,
    } as never)
    .select("*")
    .maybeSingle();
  if (error || !data) {
    captureException(error ?? new Error("impersonation insert returned no row"), {
      route: "impersonation.start",
      tags: { actor: input.actorId, target: input.targetId },
    });
    return null;
  }
  return data as unknown as ImpersonationSession;
}

/**
 * The live impersonation this admin is running, if any. Used by /stop so the
 * audit row and the revocation both name the target the START recorded, rather
 * than one the client supplied (AC6).
 */
export async function activeImpersonationByActor(
  actorId: string,
  nowMs: number,
): Promise<ImpersonationSession | null> {
  const { data, error } = await supabaseAdmin
    .from("admin_impersonation_sessions")
    .select("*")
    .eq("actor_id", actorId)
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as ImpersonationSession;
  // Expiry is decided here, on read. See the note on IMPERSONATION_MAX_SECONDS.
  return Date.parse(row.expires_at) > nowMs ? row : null;
}

/**
 * Is this user being impersonated right now? The question every destructive
 * route asks before doing something irreversible on their behalf.
 *
 * FAILS CLOSED. If the lookup errors we report `true` — treat the request as an
 * impersonation and refuse it. The alternative is that a database blip silently
 * re-opens account deletion to an impersonating admin, and the cost of being
 * wrong in that direction is unrecoverable while the cost of being wrong in this
 * one is that a real user retries their own deletion in a minute.
 */
export async function isImpersonated(
  userId: string,
  nowMs: number,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("admin_impersonation_sessions")
    .select("expires_at")
    .eq("target_id", userId)
    .is("ended_at", null)
    .gt("expires_at", new Date(nowMs).toISOString())
    .limit(1);
  if (error) {
    captureException(error, { route: "impersonation.isImpersonated" });
    return true;
  }
  return (data ?? []).length > 0;
}

/** Close the record. Idempotent — a second stop is a no-op, not an error. */
export async function endImpersonation(
  sessionId: string,
  reason: "stopped" | "expired" | "revoked",
  nowMs: number,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("admin_impersonation_sessions")
    .update({ ended_at: new Date(nowMs).toISOString(), end_reason: reason } as never)
    .eq("id", sessionId)
    .is("ended_at", null);
  if (error) {
    captureException(error, { route: "impersonation.end", tags: { reason } });
  }
}

/** The outcome of a revocation, reported rather than reduced to a boolean. */
export interface SessionRevocation {
  /** True only when the delete ran. `sessions: 0` with this true means the
   *  target held none — which is revoked, not failed. */
  revoked: boolean;
  /** Session rows removed. Their refresh tokens go with them by cascade. */
  sessions: number;
  /** Present only on failure, for the operator-facing message. */
  error?: string;
}

/**
 * Revoke every session the target holds (US-2351 AC2, fixed in US-2662).
 *
 * THIS USED TO CALL A ROUTE THAT DOES NOT EXIST. supabase-js has no "sign this
 * user out by id" — `auth.admin.signOut` wants a JWT, which is the one thing we
 * do not have here — so this posted to GoTrue's `admin/users/:id/logout`
 * instead. That endpoint is absent on the GoTrue this project runs: it 404s
 * while `GET admin/users/:id` returns 200 on the same container with the same
 * key, and `auth.sessions` stayed put across the attempt. Production is v2.174.0,
 * older still. So for as long as impersonation has shipped, every stop reported
 * `sessions_revoked: false` and the target's refresh token stayed live.
 *
 * `revoke_user_sessions` (00614) is the replacement, and it is a mechanism we
 * own rather than a bet on an upstream route. Deleting the user's `auth.sessions`
 * rows cascades to their refresh tokens, which is what makes a token already
 * copied out of the browser stop working.
 *
 * NO FALLBACK TO THE OLD CALL, deliberately. It is proven dead; leaving it in
 * would add a second thing that looks handled and does nothing, which is the
 * defect this replaces rather than a hedge against it.
 *
 * ⚠ THE ACCESS TOKEN IS NOT KILLED BY THIS, and cannot be. A Supabase access
 * token is a JWT verified by signature with nothing to look up, so one already
 * issued stays valid until it expires — up to `jwt_expiry`, an hour. Revocation
 * stops the holder REFRESHING, and the 30-minute impersonation cap plus the
 * server-side marker are what bound the window in between. The old GoTrue route
 * would have had exactly the same limit.
 */
export async function revokeUserSessions(userId: string): Promise<SessionRevocation> {
  try {
    const { data, error } = await supabaseAdmin.rpc("revoke_user_sessions", {
      p_user_id: userId,
    });
    if (error) {
      captureException(
        new Error(`revoke_user_sessions failed: ${error.message}`),
        { route: "impersonation.revoke", tags: { target: userId } },
      );
      return { revoked: false, sessions: 0, error: error.message };
    }
    return { revoked: true, sessions: typeof data === "number" ? data : 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    captureException(err, { route: "impersonation.revoke", tags: { target: userId } });
    return { revoked: false, sessions: 0, error: message };
  }
}
