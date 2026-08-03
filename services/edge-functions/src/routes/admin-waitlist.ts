// US-585: admin waitlist / beta-gating surface.
//
// Mounted at /api/admin/waitlist — inherits authMiddleware + adminAuthMiddleware
// (incl. the AAL2/MFA gate) from main.ts. Lets an operator review the waitlist,
// approve/reject entries, invite (email + status flip) individually or in bulk,
// add entries manually, track cohorts, and flip the master gating switch — all
// without a redeploy. Every state change is audited.

import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { capStringIds } from "../lib/validation.ts";
import { jsonError } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { clearAccessGateCache } from "../lib/access-gate.ts";
import { sendWaitlistInviteEmail } from "../lib/email.ts";
import { requireScope } from "../lib/scope-guard.ts";
import { requireStepUp } from "../lib/step-up.ts";

type AdminEnv = { Variables: { userId: string } };

export const adminWaitlistRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminWaitlistRoutes.use("*", requireScope("growth:write"));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_STATUS = new Set(["pending", "approved", "invited", "rejected"]);

interface WaitlistRow {
  id: string;
  email: string;
  full_name: string | null;
  cohort: string | null;
  status: string;
  source: string | null;
  user_id: string | null;
  notes: string | null;
  requested_at: string;
  approved_at: string | null;
  invited_at: string | null;
  created_at: string;
}

// GET / — list entries with optional status/cohort/search filters + a summary
// of counts per status and per cohort, plus the master gating state.
adminWaitlistRoutes.get("/", async (c: Context<AdminEnv>) => {
  const status = c.req.query("status");
  const cohort = c.req.query("cohort");
  const search = (c.req.query("q") ?? "").trim();

  let query = supabaseAdmin
    .from("waitlist_entries")
    .select(
      "id, email, full_name, cohort, status, source, user_id, notes, requested_at, approved_at, invited_at, created_at",
    )
    .order("requested_at", { ascending: false })
    .limit(500);

  if (status && VALID_STATUS.has(status)) query = query.eq("status", status);
  if (cohort) query = query.eq("cohort", cohort);
  if (search) query = query.ilike("email", `%${search.replace(/[%,()]/g, " ")}%`);

  const { data, error } = await query;
  if (error) return jsonError(c, 500, "Failed to load waitlist");

  const entries = (data ?? []) as WaitlistRow[];

  // Status + cohort summaries (read the full set unfiltered for the dashboard
  // counts so the chips don't shift when a filter is applied).
  const { data: allRows } = await supabaseAdmin
    .from("waitlist_entries")
    .select("status, cohort");
  const summary = { pending: 0, approved: 0, invited: 0, rejected: 0, total: 0 };
  const cohorts: Record<string, number> = {};
  for (const r of (allRows ?? []) as Array<{ status: string; cohort: string | null }>) {
    summary.total += 1;
    if (r.status in summary) summary[r.status as keyof typeof summary] += 1;
    if (r.cohort) cohorts[r.cohort] = (cohorts[r.cohort] ?? 0) + 1;
  }

  const { data: flagRow } = await supabaseAdmin
    .from("feature_flags")
    .select("enabled")
    .eq("key", "waitlist_gating")
    .maybeSingle();
  const gatingActive = (flagRow as { enabled?: boolean } | null)?.enabled === true;

  return c.json({ entries, summary, cohorts, gatingActive });
});

// POST / — manually add an entry (operator-created). Body: { email, full_name?,
// cohort?, status? }.
adminWaitlistRoutes.post("/", async (c: Context<AdminEnv>) => {
  let body: { email?: unknown; full_name?: unknown; cohort?: unknown; status?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return jsonError(c, 400, "A valid email is required");
  const fullName = typeof body.full_name === "string" ? body.full_name.trim().slice(0, 200) : null;
  const cohort = typeof body.cohort === "string" ? body.cohort.trim().slice(0, 60) || null : null;
  const status = typeof body.status === "string" && VALID_STATUS.has(body.status) ? body.status : "pending";

  const { data, error } = await supabaseAdmin
    .from("waitlist_entries")
    .upsert(
      {
        email,
        full_name: fullName,
        cohort,
        status,
        source: "manual",
        approved_at: status === "approved" || status === "invited" ? new Date().toISOString() : null,
        approved_by: status === "approved" || status === "invited" ? c.get("userId") : null,
      },
      { onConflict: "email" },
    )
    .select("id")
    .maybeSingle();
  if (error) return jsonError(c, 500, "Failed to add entry");

  await writeAuditLog(c, {
    action: "waitlist.add",
    targetType: "waitlist_entry",
    targetId: (data as { id?: string } | null)?.id ?? null,
    after: { email, cohort, status },
  });
  return c.json({ ok: true, id: (data as { id?: string } | null)?.id });
});

// PATCH /:id — update status / cohort / notes on a single entry.
adminWaitlistRoutes.patch("/:id", async (c: Context<AdminEnv>) => {
  const id = c.req.param("id");
  let body: { status?: unknown; cohort?: unknown; notes?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const patch: Record<string, unknown> = {};
  if (typeof body.status === "string") {
    if (!VALID_STATUS.has(body.status)) return jsonError(c, 400, "Invalid status");
    patch.status = body.status;
    if (body.status === "approved") {
      patch.approved_at = new Date().toISOString();
      patch.approved_by = c.get("userId");
    }
  }
  if (typeof body.cohort === "string") patch.cohort = body.cohort.trim().slice(0, 60) || null;
  if (typeof body.notes === "string") patch.notes = body.notes.slice(0, 2000);
  if (Object.keys(patch).length === 0) return jsonError(c, 400, "Nothing to update");

  const { error } = await supabaseAdmin.from("waitlist_entries").update(patch).eq("id", id);
  if (error) return jsonError(c, 500, "Failed to update entry");

  await writeAuditLog(c, {
    action: "waitlist.update",
    targetType: "waitlist_entry",
    targetId: id,
    after: patch,
  });
  return c.json({ ok: true });
});

// POST /invite — bulk invite. Body: { ids?: string[], cohort?: string }.
// Resolves the target set (explicit ids OR everyone in a cohort who isn't
// already invited/rejected), emails each, and flips status → invited. Returns
// per-id outcomes so the UI can report partial failures.
adminWaitlistRoutes.post("/invite", async (c: Context<AdminEnv>) => {
  // US-2356 AC2: up to 500 invitations to real inboxes, from the platform
  // address, in one call. admin-growth.ts already gates the same class of
  // action; this did not, so the bar depended on which router the send lived in.
  {
    const stepUp = requireStepUp(c);
    if (stepUp) return stepUp;
  }
  let body: { ids?: unknown; cohort?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  // Cap the id filter so an oversized body can't force an unbounded IN(...)
  // query; 500 matches the `.limit(500)` on the resolve query below (US-1944).
  const ids = capStringIds(body.ids, 500);
  const cohort = typeof body.cohort === "string" ? body.cohort.trim() : "";

  let targetQuery = supabaseAdmin
    .from("waitlist_entries")
    .select("id, email, full_name, cohort, status")
    .in("status", ["pending", "approved"]); // never re-invite invited/rejected
  if (ids.length > 0) {
    targetQuery = supabaseAdmin
      .from("waitlist_entries")
      .select("id, email, full_name, cohort, status")
      .in("id", ids);
  } else if (cohort) {
    targetQuery = targetQuery.eq("cohort", cohort);
  } else {
    return jsonError(c, 400, "Provide ids[] or a cohort to invite");
  }

  const { data, error } = await targetQuery.limit(500);
  if (error) return jsonError(c, 500, "Failed to resolve invite targets");
  const targets = (data ?? []) as Array<{
    id: string;
    email: string;
    full_name: string | null;
    cohort: string | null;
    status: string;
  }>;

  const results: Array<{ id: string; email: string; emailed: boolean }> = [];
  const nowIso = new Date().toISOString();
  for (const t of targets) {
    if (t.status === "rejected") continue;
    const emailed = await sendWaitlistInviteEmail(t.email, {
      fullName: t.full_name,
      cohort: t.cohort,
    }).catch(() => false);
    // Flip to invited regardless of email outcome — the entry IS approved for
    // access; a bounced email is a re-send, not a re-approval.
    await supabaseAdmin
      .from("waitlist_entries")
      .update({ status: "invited", invited_at: nowIso, approved_at: nowIso, approved_by: c.get("userId") })
      .eq("id", t.id);
    results.push({ id: t.id, email: t.email, emailed });
  }

  await writeAuditLog(c, {
    action: "waitlist.bulk_invite",
    targetType: "waitlist_cohort",
    targetId: cohort || null,
    after: { invited: results.length, emailedOk: results.filter((r) => r.emailed).length },
  });
  return c.json({ ok: true, invited: results.length, results });
});

// PUT /gating — flip the master gating switch. Body: { enabled: boolean }.
adminWaitlistRoutes.put("/gating", async (c: Context<AdminEnv>) => {
  let body: { enabled?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  if (typeof body.enabled !== "boolean") return jsonError(c, 400, "enabled must be a boolean");

  const { error } = await supabaseAdmin
    .from("feature_flags")
    .update({ enabled: body.enabled, updated_by: c.get("userId") })
    .eq("key", "waitlist_gating");
  if (error) return jsonError(c, 500, "Failed to update gating");

  clearAccessGateCache(); // instant on this replica; others within the cache TTL

  await writeAuditLog(c, {
    action: "waitlist.gating_toggle",
    targetType: "feature_flag",
    targetId: "waitlist_gating",
    after: { enabled: body.enabled },
  });
  return c.json({ ok: true, enabled: body.enabled });
});
