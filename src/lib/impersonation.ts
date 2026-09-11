import { supabase } from "@/lib/supabase";
import { queryClient } from "@/lib/query-client";
import { edgeFetch } from "@/lib/edge-fetch";
import { useImpersonationStore } from "@/stores/impersonation-store";
import { readStored, removeStored, writeStored } from "@/lib/safe-storage";

// Client orchestration for admin "view as" / impersonation (US-581).
//
// startImpersonation(): ask the edge service (super_admin + MFA step-up gated)
// to mint TWO one-time tokens — one for the target and one RESUME token for the
// admin — then redeem the target token to swap into the target's session. Only
// the admin's short-lived, single-use resume token_hash is stashed (never the
// admin's long-lived refresh token).
//
// stopImpersonation(): redeem the admin resume token to restore the admin
// session, then tell the edge service to write the stop audit row (now
// attributable to the admin again). If the resume token has expired, fall back
// to a clean sign-out so the admin simply logs back in.

export type StartResult =
  | { ok: true }
  | { ok: false; stepUpRequired: true }
  | { ok: false; stepUpRequired: false; error: string };

export async function startImpersonation(targetUserId: string): Promise<StartResult> {
  // Snapshot only the admin's identity (NOT their tokens) before the swap.
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return { ok: false, stepUpRequired: false, error: "You must be signed in." };
  }
  const adminUserId = session.user.id;
  const adminEmail = session.user.email ?? null;

  let res: Response;
  try {
    res = await edgeFetch(`/api/admin/impersonation/start/${targetUserId}`, {
      method: "POST",
      silentGate: true,
    });
  } catch (e) {
    return {
      ok: false,
      stepUpRequired: false,
      error: e instanceof Error ? e.message : "Request failed",
    };
  }

  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    if (body?.code === "STEP_UP_REQUIRED") {
      return { ok: false, stepUpRequired: true };
    }
    return { ok: false, stepUpRequired: false, error: body?.error ?? "Forbidden" };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return {
      ok: false,
      stepUpRequired: false,
      error: body?.error ?? `HTTP ${res.status}`,
    };
  }

  const body = (await res.json().catch(() => ({}))) as {
    token_hash?: string;
    admin_resume_token_hash?: string;
    target?: { id: string; email: string; full_name: string | null };
  };
  if (!body.token_hash || !body.admin_resume_token_hash || !body.target) {
    return { ok: false, stepUpRequired: false, error: "Malformed impersonation response." };
  }

  // Record the impersonation (incl. the admin RESUME token, not refresh token)
  // BEFORE the session swap so a reload mid-swap can still recover the admin
  // session via "Exit".
  useImpersonationStore.getState().begin({
    target: { id: body.target.id, email: body.target.email, name: body.target.full_name },
    adminUserId,
    adminEmail,
    adminResumeTokenHash: body.admin_resume_token_hash,
    startedAt: new Date().toISOString(),
  });

  // US-2089 (C4): DROP THE CACHED SERVER DATA BEFORE THE SESSION SWAP.
  //
  // Impersonation is the THIRD way the tenant scope changes, and the only one
  // that was not clearing the TanStack cache. Sign-out clears it (use-auth.ts)
  // and a workspace switch clears it (use-workspace.ts) — but verifyOtp() swaps
  // sessions by firing SIGNED_IN with a DIFFERENT user, which takes the
  // `if (newSession?.user)` branch in onAuthStateChange and never reaches the
  // SIGNED_OUT clear.
  //
  // Dozens of workspace/user-scoped query keys deliberately omit the owner id
  // (see the US-1624 comment in use-workspace.ts), so the cache clear IS the
  // isolation mechanism for them. Without it the admin's cached data is served
  // while acting as the target, and — worse on the way back out — the TARGET's
  // cached data is served to the admin for up to staleTime after exit.
  queryClient.clear();

  // Redeem the one-time token → swaps the browser into the target's session.
  const { error } = await supabase.auth.verifyOtp({
    token_hash: body.token_hash,
    type: "magiclink",
  });
  if (error) {
    // Roll back: we never entered the target session, so drop the record.
    useImpersonationStore.getState().clear();
    return { ok: false, stepUpRequired: false, error: error.message };
  }

  return { ok: true };
}

export async function stopImpersonation(): Promise<void> {
  const record = useImpersonationStore.getState().record;
  if (!record) return;

  // US-2089 (C4): clear on the way OUT too, and this direction matters more.
  // Anything cached while acting as the target would otherwise be served to the
  // ADMIN's own session after the swap back — a support admin would see a
  // customer's data attributed to their own session for up to staleTime.
  queryClient.clear();

  // Restore the admin's session by redeeming the one-time resume token. This
  // swaps the browser out of the target's session and back into the admin's
  // without ever having stored the admin's refresh token.
  const { error } = await supabase.auth.verifyOtp({
    token_hash: record.adminResumeTokenHash,
    type: "magiclink",
  });

  if (error) {
    // The resume token was already used or has expired (it's single-use +
    // short-lived). We can't silently restore the admin session, so fail safe:
    // sign out completely and clear the record. The admin simply logs back in —
    // strictly safer than leaving the browser in the target's session.
    await supabase.auth.signOut().catch(() => {});
    useImpersonationStore.getState().clear();
    return;
  }

  // Now running as the admin again — write the stop audit row. Best-effort:
  // the session restore is the important part; never block the exit on it.
  //
  // US-2662 AC4: the response carries `revoked`, and it used to be discarded
  // here. A false means the target's own sessions are STILL LIVE — the admin's
  // copy of their refresh token outlives the stop — which the person who just
  // clicked Exit is the only one placed to act on. Stashed rather than toasted
  // because the caller hard-reloads immediately; the admin page picks it up.
  //
  // US-3378: THERE ARE THREE ANSWERS HERE, NOT TWO. This block used to act only
  // on an explicit `revoked === false`. edgeFetch does not throw on a non-2xx
  // (see its header comment: callers still inspect res.ok), so a 500, a 403 or
  // an HTML error page from a proxy yields a body with no `revoked` key, takes
  // the same branch a clean success takes, and the warning disappears without a
  // trace. The failure direction is the unsafe one: nobody checked, and the
  // sessions may well still be live. "We could not tell" now says so.
  let warning: { status: RevokeWarningStatus; detail: string } | null = null;
  try {
    const res = await edgeFetch("/api/admin/impersonation/stop", {
      method: "POST",
      silentGate: true,
      json: { target_id: record.target.id },
    });
    if (!res.ok) {
      warning = { status: "unknown", detail: `the server answered HTTP ${res.status}` };
    } else {
      const body = (await res.json().catch(() => null)) as { revoked?: unknown } | null;
      if (!body || typeof body !== "object") {
        warning = { status: "unknown", detail: "the response could not be read" };
      } else if (body.revoked === false) {
        warning = { status: "not-revoked", detail: "" };
      } else if (body.revoked !== true) {
        // A 200 that forgot to say. Same unknown: an older or proxied build
        // answering `{ ok: true }` must not read as a confirmed revoke.
        warning = { status: "unknown", detail: "the response did not say" };
      }
    }
  } catch {
    // The start was already audited, so the exit still proceeds, but a request
    // that never completed is exactly the case the old `catch {}` hid.
    warning = { status: "unknown", detail: "the request did not complete" };
  }
  if (warning) {
    writeStored(
      REVOKE_WARNING_KEY,
      JSON.stringify({ email: record.target.email, ...warning }),
      "session",
    );
  }

  useImpersonationStore.getState().clear();
}

/**
 * `not-revoked`: the server checked and said the target's sessions are STILL LIVE.
 * `unknown`: the check could not run, so nobody knows either way. Treated as
 *                 a warning rather than as silence, because the only safe reading
 *                 of an unanswered revoke is that it did not happen.
 */
export type RevokeWarningStatus = "not-revoked" | "unknown";

export interface RevokeWarning {
  email: string;
  status: RevokeWarningStatus;
  /** One clause, admin-facing, saying why `unknown`. Empty for `not-revoked`. */
  detail: string;
}

/**
 * One-shot handoff for "the stop did not revoke, or we could not tell", set by
 * [stopImpersonation] and read once by the admin page it reloads into.
 * sessionStorage rather than state because the exit is a full page load, which
 * is also why it must be cleared on read: a warning that reappears on every
 * later visit stops being read.
 */
export const REVOKE_WARNING_KEY = "gt.impersonation.revokeFailed";

export function takeRevokeWarning(): RevokeWarning | null {
  const raw = readStored(REVOKE_WARNING_KEY, "session");
  if (!raw) return null;
  removeStored(REVOKE_WARNING_KEY, "session");

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Pre-US-3378 writers stashed the bare email. A tab that exits during a
    // deploy can still be holding one, and the old value only ever meant the
    // server said not-revoked.
    return { email: raw, status: "not-revoked", detail: "" };
  }

  const value = parsed as Partial<RevokeWarning> | null;
  if (!value || typeof value.email !== "string" || !value.email) return null;
  return {
    email: value.email,
    status: value.status === "unknown" ? "unknown" : "not-revoked",
    detail: typeof value.detail === "string" ? value.detail : "",
  };
}

/**
 * The words the admin actually reads, kept beside the state machine that decides
 * between them rather than in the page, so a test can drive the non-2xx path all
 * the way to the sentence instead of asserting that a status code is inspected.
 *
 * The two titles must stay different: "we did not sign them out" and "we could
 * not tell whether we signed them out" call for the same urgency but not the
 * same next step, and collapsing them is the bug US-3378 fixed.
 */
export function revokeWarningToast(warning: RevokeWarning): {
  title: string;
  description: string;
} {
  if (warning.status === "unknown") {
    return {
      title: "We could not confirm they were signed out",
      description:
        `The sign-out check for ${warning.email} did not run (${warning.detail}), ` +
        `so treat their sessions as still live. Ask them to sign out everywhere, ` +
        `or suspend the account if this was a security exit.`,
    };
  }
  return {
    title: "Their sessions were not signed out",
    description:
      `${warning.email} is still signed in on any device that was already logged in, ` +
      `and any copy of their session stays valid until it expires on its own. ` +
      `Ask them to sign out everywhere, or suspend the account if this was a ` +
      `security exit.`,
  };
}
