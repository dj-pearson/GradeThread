import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { requireScope } from "../lib/scope-guard.ts";

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

// The public.flipdesk_plan enum (00037) — the tier every entitlement reads.
// US-2398: this was the legacy public.user_plan vocabulary
// (free/starter/professional/enterprise), which is a different set of words for
// a column nothing gates on.
const ASSIGNABLE_PLANS = new Set(["free", "starter", "pro", "business"]);

// Statuses that mean somebody else's system owns this account's tier: Stripe,
// the App Store or Play will write flipdesk_plan on its next event. 'comp' is
// deliberately absent — re-granting or revoking a comp is this route's job.
const EXTERNALLY_BILLED_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "paused",
]);

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

// ── User 360 activity timeline (US-902) ──────────────────────────────────────
//
// GET /:id/timeline — one chronological, cross-domain feed of everything that
// happened to a single user (signup, submissions, grades, credit ledger,
// FlipDesk subscription events, disputes, support tickets, and admin actions
// taken AGAINST them). Read-only; admin + AAL2 is already enforced by the
// /api/admin/* middleware group, so no step-up / audit write here.
//
// Strictly scoped to the one (already-verified) target id: every source query
// filters by user_id / target_id, and grades — which carry no user_id — are
// reached only through an inner join on their parent submission's user_id
// (US-268). No cross-user leakage is possible.
//
// Pagination is cursor/time-based: `cursor` is the ISO timestamp of the last
// event from the previous page; each source fetches the page-sized window of
// rows strictly OLDER than it, the windows are merged + re-sorted newest-first,
// and the slice's tail timestamp becomes the next cursor. This keeps a
// long-lived account fast — we never scan a user's entire history.

const TIMELINE_TYPES = [
  "signup",
  "submission",
  "grade",
  "credit",
  "subscription",
  "dispute",
  "ticket",
  "admin_action",
] as const;
type TimelineType = (typeof TIMELINE_TYPES)[number];

interface TimelineEvent {
  /** Stable composite id (`<type>:<rowId>`) — safe React key, no collisions. */
  id: string;
  type: TimelineType;
  /** ISO timestamp the event occurred at. */
  timestamp: string;
  summary: string;
  /** Deep link to the underlying record/surface, or null when shown inline. */
  link: string | null;
}

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  starter: "Starter",
  professional: "Professional",
  business: "Business",
  enterprise: "Enterprise",
};

adminUsersRoutes.get("/:id/timeline", async (c: Context<AdminEnv>) => {
  const targetId = c.req.param("id");
  if (!UUID_RE.test(targetId)) {
    return c.json({ error: "Invalid user id" }, 400);
  }

  // The target is the already-verified scope — confirm it exists and grab the
  // signup timestamp in one read.
  const { data: target, error: userErr } = await supabaseAdmin
    .from("users")
    .select("id, created_at")
    .eq("id", targetId)
    .maybeSingle();
  if (userErr) return failSafe(c, 500, "Couldn't load the user.", userErr, "admin.users.timeline.user");
  if (!target) return c.json({ error: "User not found" }, 404);
  const signupAt = (target as { created_at: string }).created_at;

  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100)
    : 25;
  // Cursor: ISO timestamp; fetch only events strictly older than it.
  const cursorRaw = (c.req.query("cursor") ?? "").trim();
  const cursor = cursorRaw && !Number.isNaN(Date.parse(cursorRaw)) ? cursorRaw : null;

  // `types` filter — comma-separated subset of TIMELINE_TYPES. Absent = all.
  const typesRaw = (c.req.query("types") ?? "").trim();
  const requested = typesRaw
    ? new Set(typesRaw.split(",").map((s) => s.trim()).filter(Boolean))
    : null;
  const wants = (t: TimelineType) => requested === null || requested.has(t);

  // Over-fetch one extra row per source so the merge has enough to fill a page
  // and to detect "there's more".
  const perSource = limit + 1;

  const events: TimelineEvent[] = [];

  // signup — a single synthetic event; include only when it falls inside the
  // current (older-than-cursor) window.
  if (wants("signup") && (!cursor || signupAt < cursor)) {
    events.push({
      id: `signup:${targetId}`,
      type: "signup",
      timestamp: signupAt,
      summary: "Account created",
      link: `/admin/users/${targetId}`,
    });
  }

  await Promise.all([
    // submissions
    (async () => {
      if (!wants("submission")) return;
      let q = supabaseAdmin
        .from("submissions")
        .select("id, title, status, created_at")
        .eq("user_id", targetId);
      if (cursor) q = q.lt("created_at", cursor);
      const { data } = await q
        .order("created_at", { ascending: false })
        .limit(perSource);
      for (const r of (data ?? []) as Array<{
        id: string;
        title: string | null;
        status: string;
        created_at: string;
      }>) {
        events.push({
          id: `submission:${r.id}`,
          type: "submission",
          timestamp: r.created_at,
          summary: `Submitted "${r.title ?? "Untitled"}" (${r.status})`,
          link: "/admin/submissions",
        });
      }
    })(),

    // grades — reached via the parent submission's user_id (grade_reports has
    // no user_id of its own); inner join keeps it tenant-scoped (US-268).
    (async () => {
      if (!wants("grade")) return;
      let q = supabaseAdmin
        .from("grade_reports")
        .select(
          "id, overall_score, grade_tier, certificate_id, created_at, submissions!inner(user_id, title)",
        )
        .eq("submissions.user_id", targetId);
      if (cursor) q = q.lt("created_at", cursor);
      const { data } = await q
        .order("created_at", { ascending: false })
        .limit(perSource);
      for (const r of (data ?? []) as Array<{
        id: string;
        overall_score: number;
        grade_tier: string;
        certificate_id: string | null;
        created_at: string;
        submissions: { title: string | null } | { title: string | null }[] | null;
      }>) {
        const sub = Array.isArray(r.submissions) ? r.submissions[0] : r.submissions;
        const title = sub?.title ?? "item";
        events.push({
          id: `grade:${r.id}`,
          type: "grade",
          timestamp: r.created_at,
          summary: `Graded "${title}" — ${Number(r.overall_score).toFixed(1)} (${r.grade_tier})`,
          link: r.certificate_id ? `/certificate/${r.certificate_id}` : null,
        });
      }
    })(),

    // grade-credit ledger
    (async () => {
      if (!wants("credit")) return;
      let q = supabaseAdmin
        .from("grade_credit_transactions")
        .select("id, delta, reason, balance_after, created_at")
        .eq("user_id", targetId);
      if (cursor) q = q.lt("created_at", cursor);
      const { data } = await q
        .order("created_at", { ascending: false })
        .limit(perSource);
      for (const r of (data ?? []) as Array<{
        id: string;
        delta: number;
        reason: string;
        balance_after: number | null;
        created_at: string;
      }>) {
        const sign = r.delta > 0 ? `+${r.delta}` : `${r.delta}`;
        events.push({
          id: `credit:${r.id}`,
          type: "credit",
          timestamp: r.created_at,
          summary:
            `Grade credits ${sign} (${r.reason.replace(/_/g, " ")})` +
            (r.balance_after !== null ? ` → balance ${r.balance_after}` : ""),
          link: null,
        });
      }
    })(),

    // FlipDesk subscription events
    (async () => {
      if (!wants("subscription")) return;
      let q = supabaseAdmin
        .from("flipdesk_subscription_events")
        .select("id, event_type, from_plan, to_plan, created_at")
        .eq("user_id", targetId);
      if (cursor) q = q.lt("created_at", cursor);
      const { data } = await q
        .order("created_at", { ascending: false })
        .limit(perSource);
      for (const r of (data ?? []) as Array<{
        id: string;
        event_type: string;
        from_plan: string | null;
        to_plan: string | null;
        created_at: string;
      }>) {
        let summary = `Subscription ${r.event_type.replace(/[_.]/g, " ")}`;
        if (r.from_plan || r.to_plan) {
          const from = r.from_plan ? (PLAN_LABELS[r.from_plan] ?? r.from_plan) : "—";
          const to = r.to_plan ? (PLAN_LABELS[r.to_plan] ?? r.to_plan) : "—";
          summary += `: ${from} → ${to}`;
        }
        events.push({
          id: `subscription:${r.id}`,
          type: "subscription",
          timestamp: r.created_at,
          summary,
          link: "/admin/revenue",
        });
      }
    })(),

    // disputes
    (async () => {
      if (!wants("dispute")) return;
      let q = supabaseAdmin
        .from("disputes")
        .select("id, reason, status, created_at")
        .eq("user_id", targetId);
      if (cursor) q = q.lt("created_at", cursor);
      const { data } = await q
        .order("created_at", { ascending: false })
        .limit(perSource);
      for (const r of (data ?? []) as Array<{
        id: string;
        reason: string;
        status: string;
        created_at: string;
      }>) {
        const reason = r.reason.length > 80 ? `${r.reason.slice(0, 80)}…` : r.reason;
        events.push({
          id: `dispute:${r.id}`,
          type: "dispute",
          timestamp: r.created_at,
          summary: `Dispute (${r.status}): ${reason}`,
          link: "/admin/disputes",
        });
      }
    })(),

    // support tickets
    (async () => {
      if (!wants("ticket")) return;
      let q = supabaseAdmin
        .from("support_tickets")
        .select("id, subject, status, created_at")
        .eq("user_id", targetId);
      if (cursor) q = q.lt("created_at", cursor);
      const { data } = await q
        .order("created_at", { ascending: false })
        .limit(perSource);
      for (const r of (data ?? []) as Array<{
        id: string;
        subject: string;
        status: string;
        created_at: string;
      }>) {
        events.push({
          id: `ticket:${r.id}`,
          type: "ticket",
          timestamp: r.created_at,
          summary: `Support ticket (${r.status}): ${r.subject}`,
          link: `/admin/support-tickets/${r.id}`,
        });
      }
    })(),

    // admin actions taken AGAINST this user
    (async () => {
      if (!wants("admin_action")) return;
      let q = supabaseAdmin
        .from("admin_audit_log")
        .select("id, action, created_at")
        .eq("target_type", "user")
        .eq("target_id", targetId);
      if (cursor) q = q.lt("created_at", cursor);
      const { data } = await q
        .order("created_at", { ascending: false })
        .limit(perSource);
      for (const r of (data ?? []) as Array<{
        id: string;
        action: string;
        created_at: string;
      }>) {
        events.push({
          id: `admin_action:${r.id}`,
          type: "admin_action",
          timestamp: r.created_at,
          summary: `Admin action: ${r.action.replace(/[._]/g, " ")}`,
          link: "/admin/audit-log",
        });
      }
    })(),
  ]);

  // Merge newest-first; break timestamp ties on the composite id for a stable
  // order across sources.
  events.sort((a, b) => {
    if (a.timestamp === b.timestamp) return a.id < b.id ? 1 : -1;
    return a.timestamp < b.timestamp ? 1 : -1;
  });

  const hasMore = events.length > limit;
  const page = events.slice(0, limit);
  const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].timestamp : null;

  return c.json({
    events: page,
    nextCursor,
    availableTypes: TIMELINE_TYPES,
  });
});

// POST /:id/role — change a user's role. super_admin only + fresh step-up.
// US-908: also requires the users:role scope (held only by super_admin in the
// seed → no behavior change; a scoped admin could be granted it explicitly).
adminUsersRoutes.post("/:id/role", requireScope("users:role"), async (c: Context<AdminEnv>) => {
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
  if (lookupErr) return failSafe(c, 500, "Couldn't look up the user.", lookupErr, "admin.users.role.lookup");
  if (!target) return c.json({ error: "User not found" }, 404);

  const { error: updateErr } = await supabaseAdmin
    .from("users")
    .update({ role })
    .eq("id", targetId);
  if (updateErr) return failSafe(c, 500, "Couldn't update the role.", updateErr, "admin.users.role.update");

  await writeAuditLog(c, {
    action: "admin.change_role",
    targetType: "user",
    targetId,
    details: { previous_role: target.role, new_role: role },
  });

  return c.json({ ok: true, role });
});

// POST /:id/suspend — suspend or reinstate a user account (US-588). This is the
// single, canonical suspend mechanism: it flips `users.suspended`, the same
// column the moderation "Ban user" action sets, and the same flag every grading
// /referral surface checks server-side. (The old user-detail "suspend" merely
// downgraded the plan to free, which blocked nothing server-side — divergent and
// unreliable. Removed.) Suspending an account is destructive → require a fresh
// MFA step-up, and audit the change so it's attributable to the acting admin.
// US-1560: account suspension is moderation authority (was role-only).
adminUsersRoutes.post("/:id/suspend", requireScope("moderation:write"), async (c: Context<AdminEnv>) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const targetId = c.req.param("id");
  const actorId = c.get("userId");
  if (targetId === actorId) {
    return c.json({ error: "You cannot suspend your own account." }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  if (typeof body.suspended !== "boolean") {
    return c.json({ error: "`suspended` (boolean) is required" }, 400);
  }
  const suspended: boolean = body.suspended;

  const { data: target, error: lookupErr } = await supabaseAdmin
    .from("users")
    .select("id, suspended")
    .eq("id", targetId)
    .maybeSingle();
  if (lookupErr) return failSafe(c, 500, "Couldn't look up the user.", lookupErr, "admin.users.suspend.lookup");
  if (!target) return c.json({ error: "User not found" }, 404);

  const previous = (target as { suspended: boolean | null }).suspended ?? false;

  const { error: updateErr } = await supabaseAdmin
    .from("users")
    .update({ suspended })
    .eq("id", targetId);
  if (updateErr) return failSafe(c, 500, "Couldn't update the suspension.", updateErr, "admin.users.suspend.update");

  await writeAuditLog(c, {
    action: suspended ? "admin.suspend_user" : "admin.unsuspend_user",
    targetType: "user",
    targetId,
    before: { suspended: previous },
    after: { suspended },
  });

  return c.json({ ok: true, suspended });
});

// POST /:id/plan — set a user's GRADING plan (users.plan) by hand: a comp, a
// support goodwill grant, a manual downgrade (US-2376).
//
// US-2398 AC4: this route now grants the tier the platform ACTUALLY reads.
//
// It used to write `users.plan`, and the comment here claimed that column was
// "the entitlement column the monthly grade allowance and every plan gate read".
// It was not, and was not when that was written: the allowance, the plan gates,
// MRR and the AI-action caps all read `users.flipdesk_plan` (payments.ts:1168,
// flipdesk-grading.ts:230, 00215_revenue_dashboard.sql). So every comp an
// operator issued returned ok/changed:true, wrote an audit row, and moved
// nothing.
//
// WRITING flipdesk_plan ALONE WOULD NOT HAVE FIXED IT EITHER, which is the part
// worth keeping: effectivePlanFor() demotes a paid plan to Free whenever
// subscription_status is 'none' or 'canceled' — exactly what a cardless account
// carries. The grant needs a status that entitles without inventing revenue, so
// it stamps `comp` (migration 00529). MRR counts only 'active' and 'past_due',
// so a comp grants caps and bills nobody.
//
// It is NOT the same route as POST /api/admin/users/:id/change-plan
// (admin-billing), which drives a real Stripe subscription and refuses free→paid
// because we hold no card. That refusal is the gap this route fills: a comp, a
// support goodwill grant, a manual downgrade. It therefore REFUSES the inverse
// case — an account with live external billing — rather than writing a value the
// next webhook would overwrite. Same posture as before: billing:write, a fresh
// MFA step-up, an audit row.
//
// Replaces a browser-side `supabase.from("users").update({ plan })`, which had
// no scope check and no step-up — and which also never worked: there is no admin
// UPDATE policy on public.users, so RLS matched zero rows, PostgREST returned
// success, and the page toasted "Plan changed" over a change that never
// happened (writing a false audit row on the way out).
adminUsersRoutes.post("/:id/plan", requireScope("billing:write"), async (c: Context<AdminEnv>) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const targetId = c.req.param("id");

  const body = await c.req.json().catch(() => ({}));
  const plan = typeof body.plan === "string" ? body.plan : "";
  if (!ASSIGNABLE_PLANS.has(plan)) {
    return c.json({ error: "Invalid plan" }, 400);
  }
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;

  const { data: target, error: lookupErr } = await supabaseAdmin
    .from("users")
    .select(
      "id, flipdesk_plan, subscription_status, billing_source, stripe_customer_id",
    )
    .eq("id", targetId)
    .maybeSingle();
  if (lookupErr) return failSafe(c, 500, "Couldn't look up the user.", lookupErr, "admin.users.plan.lookup");
  if (!target) return c.json({ error: "User not found" }, 404);

  const current = target as {
    flipdesk_plan: string;
    subscription_status: string | null;
    billing_source: string | null;
    stripe_customer_id: string | null;
  };

  // An account with live external billing is off limits. A direct write here
  // would hold until the next webhook or app-store notification and then be
  // silently overwritten, which is worse than refusing: the operator would see
  // the grant land and the user would lose it later with nothing to point at.
  if (EXTERNALLY_BILLED_STATUSES.has(current.subscription_status ?? "")) {
    return c.json(
      {
        error:
          "This account has a live subscription. Use Change plan (Stripe) so the " +
          "billing follows the tier — a manual grant here would be overwritten by " +
          "the next billing event.",
        code: "EXTERNALLY_BILLED",
        subscription_status: current.subscription_status,
        billing_source: current.billing_source,
      },
      409,
    );
  }

  const previous = current.flipdesk_plan;
  if (previous === plan) {
    // Nothing to do — but say so rather than reporting a change that wasn't one.
    return c.json({ ok: true, plan, changed: false });
  }

  // Granting a paid tier stamps 'comp'; revoking one back to free clears it.
  // The status is only touched when this route owns it — an account sitting at
  // 'none' that goes to free is left exactly as it was.
  const nextStatus = plan === "free"
    ? (current.subscription_status === "comp" ? "none" : null)
    : "comp";

  const { error: updateErr } = await supabaseAdmin
    .from("users")
    .update({
      flipdesk_plan: plan,
      ...(nextStatus ? { subscription_status: nextStatus } : {}),
    })
    .eq("id", targetId);
  if (updateErr) return failSafe(c, 500, "Couldn't change the plan.", updateErr, "admin.users.plan.update");

  await writeAuditLog(c, {
    action: "admin.change_plan",
    targetType: "user",
    targetId,
    before: { plan: previous, subscription_status: current.subscription_status },
    after: { plan, subscription_status: nextStatus ?? current.subscription_status },
    details: {
      reason,
      // A comp on an account that has paid before is the case that later looks
      // like a billing discrepancy — record it at the moment it happens.
      had_stripe_customer: Boolean(current.stripe_customer_id),
      billing_source: current.billing_source,
      comped: plan !== "free",
      stripe_synced: false,
    },
  });

  return c.json({ ok: true, plan, changed: true });
});
