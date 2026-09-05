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
import { fetchWithTimeout } from "./circuit-breaker.ts";

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

/**
 * Revoke every session the target holds (AC2).
 *
 * supabase-js has no "sign this user out by id" — `auth.admin.signOut` wants a
 * JWT, which is the one thing we do not have here (the token lives in the
 * admin's browser). The whole point is that a COPIED refresh token must stop
 * working; ending our own row would not touch it.
 *
 * TWO MECHANISMS, in that order, because neither is available everywhere
 * (US-2662):
 *
 *   1. GoTrue's admin logout — which, as of 2026-09-05, EXISTS IN NO VERSION WE
 *      CAN FIND, and this comment used to say something weaker and wronger.
 *
 *      It said "ABSENT below some version", which implies newer builds have it.
 *      They do not. Read straight from supabase/auth's route table at both tags
 *      that matter, internal/api/api.go: neither v2.174.0 (what production runs,
 *      measured via /auth/v1/health) nor v2.195.0 registers ANY route under
 *      /admin whose path contains "logout" or "sessions". The only logout route
 *      in either is `r.With(api.requireAuthentication).Post("/logout", ...)`,
 *      which wants the user's OWN token — the one thing we do not have.
 *
 *      The source read is trustworthy because it has a control: it also says
 *      "absent" for v2.195.0, which is the version where a live 404 was measured
 *      against a running container (with GET /admin/users/{id} answering 200, so
 *      auth, routing and the id were all fine). Predicting a known measurement
 *      is what makes the same read of v2.174.0 worth believing.
 *
 *      So this call CANNOT succeed on our stack, and it is kept first anyway,
 *      deliberately: it fails fast with a 404, the fallback below is what
 *      actually revokes, and leaving it means the day upstream adds the route
 *      the supported path resumes with no code change. What it must never be is
 *      the thing anyone believes is doing the work. It is not.
 *   2. Deleting the rows ourselves. Refresh tokens hang off sessions, so
 *      removing them invalidates the tokens (measured: refresh answered 200
 *      before, 400 refresh_token_not_found after). It goes through an RPC
 *      because PostgREST only exposes the schemas in its config, and `auth` is
 *      not one of them — `supabaseAdmin.schema("auth")` type-checks, lints
 *      clean and answers 406.
 *
 * Returns false only when BOTH failed, so the caller can say so instead of
 * reporting a clean stop.
 *
 * `deps` exists ONLY so a test can assert the outcome instead of the call, and
 * production passes nothing. It is a seam rather than a preference: neither half
 * can be stubbed from outside. `supabaseAdmin` is a Proxy whose `get` trap always
 * resolves to the real client (supabase.ts:76), so assigning `.rpc` on it does
 * nothing, and the client captures `fetch` when it is constructed, so stubbing
 * `globalThis.fetch` does not reach it either. Both were tried. Asserting the
 * outcome is the entire point of US-2662: the old test asserted that GoTrue's
 * logout was CALLED, which stayed green for the whole time that route was
 * answering 404 and nothing was being revoked.
 */
export interface RevokeDeps {
  logout?: (userId: string) => Promise<{ ok: boolean; detail: string }>;
  deleteRows?: (userId: string) => Promise<{ error: { message: string } | null }>;
}

export async function revokeUserSessions(
  userId: string,
  deps: RevokeDeps = {},
): Promise<boolean> {
  const viaGoTrue = await (deps.logout ?? revokeViaGoTrue)(userId);
  if (viaGoTrue.ok) return true;

  const { error } = await (deps.deleteRows ?? revokeViaDatabase)(userId);
  if (!error) return true;

  // Only now is this an incident: the supported route was unavailable AND the
  // mechanism we own failed too, so the target's tokens are still live.
  captureException(
    new Error(
      `impersonation revoke failed both ways (GoTrue: ${viaGoTrue.detail}; ` +
        `rpc: ${error.message})`,
    ),
    { route: "impersonation.revoke", tags: { target: userId } },
  );
  return false;
}

/** The mechanism we own. Reaches `auth`, which a client call cannot. */
async function revokeViaDatabase(
  userId: string,
): Promise<{ error: { message: string } | null }> {
  const { error } = await supabaseAdmin.rpc(
    "admin_revoke_user_sessions",
    { p_user_id: userId } as never,
  );
  return { error: error ? { message: error.message } : null };
}

/**
 * The upstream route. Registered in no supabase/auth version we can read (see
 * revokeUserSessions above), so on this stack it is a fast 404 and `detail`
 * carries the status so a double failure can name why.
 */
async function revokeViaGoTrue(userId: string): Promise<{ ok: boolean; detail: string }> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return { ok: false, detail: "SUPABASE_URL/SERVICE_ROLE_KEY unset" };
  try {
    // US-2321: a deadline. This runs while an admin waits on /stop, and a hung
    // GoTrue would leave them staring at a spinner while the target's tokens
    // stay live — the exact window this revocation exists to close.
    const res = await fetchWithTimeout(
      `${url}/auth/v1/admin/users/${userId}/logout`,
      {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        // `global` revokes every refresh token the user holds, which is the
        // only scope that reaches a token already copied out of the browser.
        body: JSON.stringify({ scope: "global" }),
      },
      8_000,
    );
    return res.ok ? { ok: true, detail: String(res.status) } : { ok: false, detail: `${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
