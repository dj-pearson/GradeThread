// Push device-token prune (US-795).
//
// A token goes inactive two ways: the user signs out (DELETE /register removes
// the row), or an APNs send returns Unregistered/BadDeviceToken/410 and the send
// path flips is_active=false (apns.ts). The latter leaves a dead row lingering.
// This scheduled prune deletes long-inactive rows so the table doesn't grow
// without bound and send fan-outs stay cheap. Injectable store so the
// orchestration is unit-testable without a DB.

import { supabaseAdmin } from "./supabase.ts";
import { requireJobSecret } from "./job-auth.ts";
import { acquireJobLock } from "./job-lock.ts";
import { captureException, logEvent, recordMetric } from "./observability.ts";

function pruneThresholdMs(): number {
  const raw = Number(Deno.env.get("PUSH_TOKEN_PRUNE_DAYS"));
  return (Number.isFinite(raw) && raw > 0 ? raw : 90) * 24 * 60 * 60 * 1000;
}

export interface PushTokenPruneStore {
  // Delete is_active=false rows whose last_seen_at is older than beforeIso.
  // Returns how many were removed.
  deleteInactiveBefore: (beforeIso: string) => Promise<number>;
}

const defaultStore: PushTokenPruneStore = {
  deleteInactiveBefore: async (beforeIso) => {
    const { data, error } = await supabaseAdmin
      .from("push_device_tokens")
      .delete()
      .eq("is_active", false)
      .lt("last_seen_at", beforeIso)
      .select("id");
    if (error) {
      captureException(error, { route: "push-token-prune.delete" });
      throw new Error(`push-token prune delete failed: ${error.message}`);
    }
    return (data ?? []).length;
  },
};

export async function prunePushTokens(
  store: PushTokenPruneStore = defaultStore,
): Promise<{ pruned: number }> {
  const before = new Date(Date.now() - pruneThresholdMs()).toISOString();
  const pruned = await store.deleteInactiveBefore(before);
  if (pruned > 0) {
    recordMetric("push_tokens.pruned", pruned, {});
    logEvent("info", "push_tokens.pruned", { count: pruned });
  }
  return { pruned };
}

// Cron entry point. Mounted OUTSIDE the JWT groups; guards with the shared
// internal-job secret + an overlap lock (mirrors the other crons).
export async function handlePushTokenPruneCron(c: {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("push-token-prune", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result = await prunePushTokens();
    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "push-token-prune.cron" });
    return c.json(
      { error: "Push-token prune failed", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  } finally {
    await lock.release();
  }
}
