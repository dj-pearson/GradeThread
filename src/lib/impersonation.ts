import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { useImpersonationStore } from "@/stores/impersonation-store";

// Client orchestration for admin "view as" / impersonation (US-581).
//
// startImpersonation(): stash the admin's own session, ask the edge service to
// mint a one-time token for the target (super_admin + MFA step-up gated), then
// redeem it to swap into the target's session.
//
// stopImpersonation(): restore the admin's stashed session and tell the edge
// service to write the stop audit row (now attributable to the admin again).

export type StartResult =
  | { ok: true }
  | { ok: false; stepUpRequired: true }
  | { ok: false; stepUpRequired: false; error: string };

export async function startImpersonation(targetUserId: string): Promise<StartResult> {
  // Snapshot the admin's current session BEFORE anything swaps it out.
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token || !session.refresh_token) {
    return { ok: false, stepUpRequired: false, error: "You must be signed in." };
  }
  const adminUserId = session.user.id;
  const adminEmail = session.user.email ?? null;
  const adminAccessToken = session.access_token;
  const adminRefreshToken = session.refresh_token;

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
    target?: { id: string; email: string; full_name: string | null };
  };
  if (!body.token_hash || !body.target) {
    return { ok: false, stepUpRequired: false, error: "Malformed impersonation response." };
  }

  // Record the impersonation (incl. admin tokens) BEFORE the session swap so a
  // reload mid-swap can still recover the admin session.
  useImpersonationStore.getState().begin({
    target: { id: body.target.id, email: body.target.email, name: body.target.full_name },
    adminUserId,
    adminEmail,
    adminAccessToken,
    adminRefreshToken,
    startedAt: new Date().toISOString(),
  });

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

  // Restore the admin's session from the stashed tokens.
  await supabase.auth.setSession({
    access_token: record.adminAccessToken,
    refresh_token: record.adminRefreshToken,
  });

  // Now running as the admin again — write the stop audit row. Best-effort:
  // the session restore is the important part; never block the exit on it.
  try {
    await edgeFetch("/api/admin/impersonation/stop", {
      method: "POST",
      silentGate: true,
      json: { target_id: record.target.id },
    });
  } catch {
    // ignore — the start was already audited; stop is a convenience record.
  }

  useImpersonationStore.getState().clear();
}
