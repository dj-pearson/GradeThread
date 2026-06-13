import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";

// Admin user-management (US-270). Role grant/revoke is a destructive
// super-admin action, so it runs server-side here (not via a client-side
// supabase update) where it can be gated by a fresh MFA step-up + audited.
// Mounted at /api/admin/users — inherits authMiddleware + adminAuthMiddleware
// (which already enforces the standing AAL2 requirement) from main.ts.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminUsersRoutes = new Hono<AdminEnv>();

const ASSIGNABLE_ROLES = new Set(["user", "admin", "super_admin"]);

// A v4 UUID — used to recognise an id paste (user / submission / cert id are all
// UUIDs) so we know which tables are worth probing.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface LookupMatch {
  user_id: string;
  email: string;
  full_name: string | null;
  /** Which identifier resolved to this user. */
  matched_on: "email" | "user_id" | "stripe_customer_id" | "submission_id" | "certificate_id";
}

// GET /lookup?q=... — global account lookup (US-581). Resolves an email,
// Stripe customer id, submission id, or certificate id to the owning user so an
// operator can jump straight to the user-detail page. Read-only; admin + AAL2 is
// already enforced by the /api/admin/* middleware group. Declared before the
// "/:id/role" route — distinct method+path, so no collision.
adminUsersRoutes.get("/lookup", async (c: Context<AdminEnv>) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 3) {
    return c.json({ error: "Search term too short" }, 400);
  }

  const matches: LookupMatch[] = [];
  const seen = new Set<string>();
  const add = (
    row: { id: string; email: string; full_name: string | null } | null,
    matchedOn: LookupMatch["matched_on"],
  ) => {
    if (!row || seen.has(row.id)) return;
    seen.add(row.id);
    matches.push({
      user_id: row.id,
      email: row.email,
      full_name: row.full_name,
      matched_on: matchedOn,
    });
  };

  const fetchUser = async (id: string) => {
    const { data } = await supabaseAdmin
      .from("users")
      .select("id, email, full_name")
      .eq("id", id)
      .maybeSingle();
    return (data as { id: string; email: string; full_name: string | null } | null) ?? null;
  };

  if (q.includes("@")) {
    // Email — exact first, then a bounded prefix/substring match.
    const { data } = await supabaseAdmin
      .from("users")
      .select("id, email, full_name")
      .ilike("email", `%${q.replace(/[%,()]/g, " ")}%`)
      .limit(10);
    for (const row of (data ?? []) as Array<{ id: string; email: string; full_name: string | null }>) {
      add(row, "email");
    }
  } else if (q.startsWith("cus_")) {
    // Stripe customer id.
    const { data } = await supabaseAdmin
      .from("users")
      .select("id, email, full_name")
      .eq("stripe_customer_id", q)
      .maybeSingle();
    add(data as { id: string; email: string; full_name: string | null } | null, "stripe_customer_id");
  } else if (UUID_RE.test(q)) {
    // Could be a user id, a submission id, or a certificate id (cert ids are
    // also UUIDs). Probe each until one resolves.
    add(await fetchUser(q), "user_id");

    if (matches.length === 0) {
      const { data: sub } = await supabaseAdmin
        .from("submissions")
        .select("user_id")
        .eq("id", q)
        .maybeSingle();
      const subUserId = (sub as { user_id?: string } | null)?.user_id;
      if (subUserId) add(await fetchUser(subUserId), "submission_id");
    }

    if (matches.length === 0) {
      const { data: report } = await supabaseAdmin
        .from("grade_reports")
        .select("submission_id")
        .eq("certificate_id", q)
        .maybeSingle();
      const subId = (report as { submission_id?: string } | null)?.submission_id;
      if (subId) {
        const { data: sub } = await supabaseAdmin
          .from("submissions")
          .select("user_id")
          .eq("id", subId)
          .maybeSingle();
        const subUserId = (sub as { user_id?: string } | null)?.user_id;
        if (subUserId) add(await fetchUser(subUserId), "certificate_id");
      }
    }
  } else {
    // Bare certificate ids are short human-readable codes in some flows —
    // try certificate_id directly as a last resort.
    const { data: report } = await supabaseAdmin
      .from("grade_reports")
      .select("submission_id")
      .eq("certificate_id", q)
      .maybeSingle();
    const subId = (report as { submission_id?: string } | null)?.submission_id;
    if (subId) {
      const { data: sub } = await supabaseAdmin
        .from("submissions")
        .select("user_id")
        .eq("id", subId)
        .maybeSingle();
      const subUserId = (sub as { user_id?: string } | null)?.user_id;
      if (subUserId) add(await fetchUser(subUserId), "certificate_id");
    }
  }

  return c.json({ matches });
});

// POST /:id/role — change a user's role. super_admin only + fresh step-up.
adminUsersRoutes.post("/:id/role", async (c: Context<AdminEnv>) => {
  // Only super-admins manage roles.
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  // Destructive privilege change — require a fresh MFA step-up.
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const targetId = c.req.param("id");
  const actorId = c.get("userId");
  if (targetId === actorId) {
    // Prevent self-lockout / self-escalation in one move.
    return c.json({ error: "You cannot change your own role." }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const role = typeof body.role === "string" ? body.role : "";
  if (!ASSIGNABLE_ROLES.has(role)) {
    return c.json({ error: "Invalid role" }, 400);
  }

  const { data: target, error: lookupErr } = await supabaseAdmin
    .from("users")
    .select("id, role")
    .eq("id", targetId)
    .maybeSingle();
  if (lookupErr) return c.json({ error: lookupErr.message }, 500);
  if (!target) return c.json({ error: "User not found" }, 404);

  const { error: updateErr } = await supabaseAdmin
    .from("users")
    .update({ role })
    .eq("id", targetId);
  if (updateErr) return c.json({ error: updateErr.message }, 500);

  await writeAuditLog(c, {
    action: "admin.change_role",
    targetType: "user",
    targetId,
    details: { previous_role: target.role, new_role: role },
  });

  return c.json({ ok: true, role });
});
