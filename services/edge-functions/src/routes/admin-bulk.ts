import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { defaultRegradeStore, regradeSubmission } from "../lib/grading-pipeline.ts";
import { requireScope } from "../lib/scope-guard.ts";

// Bulk admin operations (US-589). Every admin action used to be single-record;
// this module adds three batch primitives an operator needs when a promo or a
// prompt regression has to be applied across a selected set without one-by-one
// clicks:
//   POST /credits  — bulk grant grade credits to N users
//   POST /suspend  — bulk suspend / reinstate N users
//   POST /regrade  — bulk re-run grading for N submissions
//
// Mounted at /api/admin/bulk — inherits authMiddleware + adminAuthMiddleware
// (admin JWT + standing AAL2) from main.ts.
//
// IDEMPOTENCY (US-589 AC). Each request carries an `idempotency_key` (a UUID the
// client mints per submission). The run is CLAIMED by inserting a
// bulk_admin_operations row keyed on that UNIQUE key BEFORE any side effect:
//   - first delivery wins the insert → executes → stores the result;
//   - a duplicate delivery collides on the key → we replay the stored result
//     (or report "in progress" if the original is still running).
// This protects the one non-idempotent primitive — credit grants are additive
// (grant_grade_credits) so a double-click would otherwise double-grant. suspend
// (set a target boolean) and regrade (supersede prior reports + re-kick) are
// naturally repeatable, but go through the same claim for a uniform trail.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminBulkRoutes = new Hono<AdminEnv>();

// Cap a single batch so one request can't fan out unbounded work / lock rows for
// too long. An operator with a larger set runs it in pages.
const MAX_TARGETS = 200;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BulkAction = "grant_credits" | "suspend" | "unsuspend" | "regrade";

interface NormalizedIds {
  ids: string[];
  error?: string;
}

// Validate + dedupe a target-id array from the request body. Exported for unit
// testing (no DB needed). Rejects non-arrays, empties, non-UUID entries, and
// over-cap batches; collapses duplicates so a repeated id is acted on once.
export function normalizeTargetIds(raw: unknown): NormalizedIds {
  if (!Array.isArray(raw)) {
    return { ids: [], error: "ids must be a non-empty array" };
  }
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || !UUID_RE.test(entry.trim())) {
      return { ids: [], error: "every id must be a valid UUID" };
    }
    seen.add(entry.trim().toLowerCase());
  }
  const ids = [...seen];
  if (ids.length === 0) return { ids: [], error: "ids must be a non-empty array" };
  if (ids.length > MAX_TARGETS) {
    return { ids: [], error: `at most ${MAX_TARGETS} ids per batch` };
  }
  return { ids };
}

interface ClaimOutcome {
  /** A row id when we won the claim and should proceed to execute. */
  runId?: string;
  /** A ready Response (replayed result or "in progress") when we did not. */
  replay?: Response;
  error?: string;
}

// Claim a run by inserting the ledger row keyed on idempotency_key. The UNIQUE
// constraint makes the check-then-insert race-free: exactly one concurrent
// request wins. The loser reads the existing row and either replays its stored
// result (completed) or reports it's still running (processing).
async function claimRun(
  c: Context<AdminEnv>,
  key: string,
  action: BulkAction,
  targetCount: number,
  params: Record<string, unknown>,
): Promise<ClaimOutcome> {
  const adminId = c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("bulk_admin_operations")
    .insert({
      idempotency_key: key,
      admin_user_id: adminId,
      action,
      target_count: targetCount,
      params,
      status: "processing",
    })
    .select("id")
    .single();

  if (!error && data) {
    return { runId: (data as { id: string }).id };
  }

  // 23505 = unique_violation → a run with this key already exists. Replay it.
  if (error && (error as { code?: string }).code === "23505") {
    const { data: existing } = await supabaseAdmin
      .from("bulk_admin_operations")
      .select("status, result")
      .eq("idempotency_key", key)
      .maybeSingle();
    const row = existing as { status: string; result: unknown } | null;
    if (row?.status === "completed") {
      return {
        replay: c.json(
          { ok: true, replayed: true, ...(row.result as Record<string, unknown> ?? {}) },
          200,
        ),
      };
    }
    // Still processing (or failed mid-run): tell the client not to re-fire.
    return {
      replay: c.json(
        { error: "An operation with this idempotency key is already in progress.", code: "IN_PROGRESS" },
        409,
      ),
    };
  }

  return { error: error?.message ?? "Failed to claim operation" };
}

interface PerTargetResult {
  id: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

// Finalize the ledger row with the per-target outcomes.
async function completeRun(runId: string, results: PerTargetResult[]): Promise<void> {
  const succeeded = results.filter((r) => r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.ok && !r.skipped).length;
  await supabaseAdmin
    .from("bulk_admin_operations")
    .update({
      status: "completed",
      result: { succeeded, skipped, failed, results },
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
}

function summarize(results: PerTargetResult[]) {
  return {
    succeeded: results.filter((r) => r.ok && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => !r.ok && !r.skipped).length,
    results,
  };
}

// ── POST /credits ────────────────────────────────────────────────────────────
// Body: { user_ids: string[], credits: number, reason: string, idempotency_key }
// Grants `credits` to each user via the existing grant_grade_credits RPC. Minting
// value → fresh MFA step-up (same gate as the single comp-credits endpoint).
// ── POST /resolve ────────────────────────────────────────────────────────────
// US-1562: read-only target resolution for the bulk-operations UI. Accepts a
// pasted mix of user UUIDs and emails, returns which resolve to real accounts
// and which don't — the client surfaces unknowns BEFORE any operation fires.
// No scope guard: this mutates nothing (a lookup admins already have via
// GET /api/admin/users/lookup); the operations themselves carry the scopes.
// Pure classification of pasted entries (exported for unit tests): lowercased,
// deduped, split into UUID ids / emails / malformed leftovers.
export function classifyResolveEntries(raw: unknown[]): {
  ids: string[];
  emails: string[];
  malformed: string[];
} {
  const entries: string[] = [...new Set(
    raw.filter((e): e is string => typeof e === "string")
      .map((e) => e.trim().toLowerCase()).filter(Boolean),
  )];
  return {
    ids: entries.filter((e) => UUID_RE.test(e)),
    emails: entries.filter((e) => !UUID_RE.test(e) && e.includes("@")),
    malformed: entries.filter((e) => !UUID_RE.test(e) && !e.includes("@")),
  };
}

adminBulkRoutes.post("/resolve", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const raw = Array.isArray(body.entries) ? body.entries : null;
  if (!raw || raw.length === 0) {
    return c.json({ error: "entries must be a non-empty array" }, 400);
  }
  if (raw.length > MAX_TARGETS) {
    return c.json({ error: `at most ${MAX_TARGETS} entries per batch` }, 400);
  }
  const { ids, emails, malformed } = classifyResolveEntries(raw as unknown[]);
  const entries = [...ids, ...emails, ...malformed];

  interface UserRow {
    id: string;
    email: string;
    full_name: string | null;
    suspended: boolean | null;
  }
  const found = new Map<string, UserRow>();
  const foundByEmail = new Map<string, UserRow>();
  if (ids.length > 0) {
    const { data } = await supabaseAdmin.from("users")
      .select("id, email, full_name, suspended").in("id", ids);
    for (const row of (data ?? []) as UserRow[]) found.set(row.id.toLowerCase(), row);
  }
  if (emails.length > 0) {
    const { data } = await supabaseAdmin.from("users")
      .select("id, email, full_name, suspended").in("email", emails);
    for (const row of (data ?? []) as UserRow[]) {
      foundByEmail.set(row.email.toLowerCase(), row);
    }
  }

  const resolved: Array<{ input: string; user_id: string; email: string; full_name: string | null; suspended: boolean }> = [];
  const unknown: string[] = [...malformed];
  for (const e of entries) {
    if (malformed.includes(e)) continue;
    const row = UUID_RE.test(e) ? found.get(e) : foundByEmail.get(e);
    if (row) {
      resolved.push({
        input: e,
        user_id: row.id,
        email: row.email,
        full_name: row.full_name,
        suspended: row.suspended === true,
      });
    } else {
      unknown.push(e);
    }
  }
  // Dedupe accounts resolved via both their id and email.
  const seenUsers = new Set<string>();
  const uniqueResolved = resolved.filter((r) => {
    if (seenUsers.has(r.user_id)) return false;
    seenUsers.add(r.user_id);
    return true;
  });
  return c.json({ resolved: uniqueResolved, unknown });
});

// US-1560: each bulk op carries its owning scope (see lib/admin-scope-map.ts).
adminBulkRoutes.post("/credits", requireScope("billing:write"), async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const body = await c.req.json().catch(() => ({}));
  const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  if (key.length < 8 || key.length > 200) {
    return c.json({ error: "idempotency_key is required" }, 400);
  }

  const { ids: userIds, error: idErr } = normalizeTargetIds(body.user_ids);
  if (idErr) return c.json({ error: idErr }, 400);

  const credits = Number(body.credits);
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (!Number.isInteger(credits) || credits <= 0 || credits > 1000) {
    return c.json({ error: "credits must be an integer between 1 and 1000" }, 400);
  }
  if (!reason) return c.json({ error: "reason is required" }, 400);

  const claim = await claimRun(c, key, "grant_credits", userIds.length, { credits, reason });
  if (claim.replay) return claim.replay;
  if (!claim.runId) return c.json({ error: claim.error }, 500);

  const adminId = c.get("userId");
  const results: PerTargetResult[] = [];
  for (const userId of userIds) {
    const { error } = await supabaseAdmin.rpc("grant_grade_credits", {
      p_user_id: userId,
      p_credits: credits,
      p_reason: "admin_grant",
      p_stripe_payment_intent: null,
      p_notes: `Bulk admin comp by ${adminId} (op ${key}): ${reason}`,
    });
    // US-1445: don't return the raw DB error to the client; the per-item id
    // identifies the failure and the cause is available server-side.
    results.push(error ? { id: userId, ok: false, error: "Operation failed" } : { id: userId, ok: true });
  }

  await completeRun(claim.runId, results);
  const summary = summarize(results);
  await writeAuditLog(c, {
    action: "admin.bulk_comp_credits",
    targetType: "user",
    details: { idempotency_key: key, credits, reason, ...summary, results: undefined, target_ids: userIds },
  });

  return c.json({ ok: true, ...summary });
});

// ── POST /suspend ────────────────────────────────────────────────────────────
// Body: { user_ids: string[], suspended: boolean, idempotency_key }
// Flips users.suspended for each target — the single canonical suspend flag
// (US-588) every grading/referral surface enforces server-side. Destructive →
// fresh MFA step-up (same gate as the single suspend endpoint). The acting admin
// is skipped, never suspended, to prevent self-lockout.
adminBulkRoutes.post("/suspend", requireScope("moderation:write"), async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const body = await c.req.json().catch(() => ({}));
  const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  if (key.length < 8 || key.length > 200) {
    return c.json({ error: "idempotency_key is required" }, 400);
  }
  if (typeof body.suspended !== "boolean") {
    return c.json({ error: "`suspended` (boolean) is required" }, 400);
  }
  const suspended: boolean = body.suspended;

  const { ids: userIds, error: idErr } = normalizeTargetIds(body.user_ids);
  if (idErr) return c.json({ error: idErr }, 400);

  const claim = await claimRun(
    c,
    key,
    suspended ? "suspend" : "unsuspend",
    userIds.length,
    { suspended },
  );
  if (claim.replay) return claim.replay;
  if (!claim.runId) return c.json({ error: claim.error }, 500);

  const actorId = c.get("userId");
  const results: PerTargetResult[] = [];
  for (const userId of userIds) {
    if (userId === actorId) {
      results.push({ id: userId, ok: true, skipped: true, error: "cannot suspend your own account" });
      continue;
    }
    // .eq returns 0 rows for a nonexistent id without erroring; treat that as a
    // skip so a stale id doesn't fail the batch. Setting a target boolean is
    // idempotent — re-running lands the same state.
    const { error } = await supabaseAdmin
      .from("users")
      .update({ suspended })
      .eq("id", userId)
      .select("id")
      .maybeSingle();
    // US-1445: don't return the raw DB error to the client; the per-item id
    // identifies the failure and the cause is available server-side.
    results.push(error ? { id: userId, ok: false, error: "Operation failed" } : { id: userId, ok: true });
  }

  await completeRun(claim.runId, results);
  const summary = summarize(results);
  await writeAuditLog(c, {
    action: suspended ? "admin.bulk_suspend_user" : "admin.bulk_unsuspend_user",
    targetType: "user",
    details: { idempotency_key: key, suspended, ...summary, results: undefined, target_ids: userIds },
  });

  return c.json({ ok: true, ...summary });
});

// ── POST /regrade ────────────────────────────────────────────────────────────
// Body: { submission_ids: string[], idempotency_key }
// Re-runs the grading pipeline for each submission (supersede prior report,
// reset, re-kick) via regradeSubmission. Same gate as the single regrade
// endpoint — admin JWT + AAL2, no extra step-up.
adminBulkRoutes.post("/regrade", requireScope("grading:review"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  if (key.length < 8 || key.length > 200) {
    return c.json({ error: "idempotency_key is required" }, 400);
  }

  const { ids: submissionIds, error: idErr } = normalizeTargetIds(body.submission_ids);
  if (idErr) return c.json({ error: idErr }, 400);

  const claim = await claimRun(c, key, "regrade", submissionIds.length, {});
  if (claim.replay) return claim.replay;
  if (!claim.runId) return c.json({ error: claim.error }, 500);

  const results: PerTargetResult[] = [];
  for (const id of submissionIds) {
    const r = await regradeSubmission(id, defaultRegradeStore);
    results.push(r.ok ? { id, ok: true } : { id, ok: false, error: r.error });
  }

  await completeRun(claim.runId, results);
  const summary = summarize(results);
  await writeAuditLog(c, {
    action: "admin.bulk_regrade",
    targetType: "submission",
    details: { idempotency_key: key, ...summary, results: undefined, target_ids: submissionIds },
  });

  return c.json({ ok: true, ...summary });
});
