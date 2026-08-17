import { supabase } from "@/lib/supabase";
import { queryClient } from "@/lib/query-client";
import { edgeFetch } from "@/lib/edge-fetch";
import { useImpersonationStore } from "@/stores/impersonation-store";

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
  try {
    const res = await edgeFetch("/api/admin/impersonation/stop", {
      method: "POST",
      silentGate: true,
      json: { target_id: record.target.id },
    });
    const body = await res.json().catch(() => null);
    if (body && body.revoked === false) {
      sessionStorage.setItem(REVOKE_WARNING_KEY, record.target.email);
    }
  } catch {
    // ignore — the start was already audited; stop is a convenience record.
  }

  useImpersonationStore.getState().clear();
}

/**
 * One-shot handoff for "the stop did not revoke", set by [stopImpersonation] and
 * read once by the admin page it reloads into. sessionStorage rather than state
 * because the exit is a full page load, which is also why it must be cleared on
 * read: a warning that reappears on every later visit stops being read.
 */
export const REVOKE_WARNING_KEY = "gt.impersonation.revokeFailed";

export function takeRevokeWarning(): string | null {
  const email = sessionStorage.getItem(REVOKE_WARNING_KEY);
  if (email) sessionStorage.removeItem(REVOKE_WARNING_KEY);
  return email;
}
