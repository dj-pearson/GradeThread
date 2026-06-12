import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { sendWorkspaceInvitationEmail } from "../lib/email.ts";
import {
  ASSIGNABLE_ROLES,
  canAssignRole,
  canManageMember,
  MFA_THRESHOLD_ROLES,
  roleAtLeast,
  type WorkspaceRole,
} from "../lib/workspace-roles.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { writeAuditLog } from "../lib/audit-log.ts";

type WorkspaceEnv = {
  Variables: {
    user: { id: string; email?: string };
    userId: string;
    workspaceOwnerId: string;
    workspaceRole: WorkspaceRole;
  };
};

export const workspaceRoutes = new Hono<WorkspaceEnv>();

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  listing_manager: "Manager",
  member: "Staff",
  viewer: "Viewer",
};

function generateToken(): string {
  // 64 hex chars — two UUIDs combined for ~256 bits of entropy. Same shape
  // the frontend was producing client-side previously.
  return (
    crypto.randomUUID().replace(/-/g, "") +
    crypto.randomUUID().replace(/-/g, "")
  );
}

function siteUrl(): string {
  return Deno.env.get("APP_URL")?.replace(/\/$/, "") ??
    "https://gradethread.com";
}

// POST /api/workspace/invitations
//
// Creates an invitation row keyed on the active workspace and (best-effort)
// emails the invitee. The active workspace is resolved by workspaceMiddleware
// from the X-Workspace-Owner header. Only the owner or an admin of that
// workspace can create invitations.
workspaceRoutes.post("/invitations", async (c) => {
  const userId = c.get("userId");
  const ownerId = c.get("workspaceOwnerId");
  const role = c.get("workspaceRole");

  if (!roleAtLeast(role, "admin")) {
    return c.json(
      { error: "Only the workspace owner and admins can invite members" },
      403,
    );
  }

  let body: { email?: unknown; role?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const requestedRole = body.role as WorkspaceRole | undefined;

  if (!email || !email.includes("@")) {
    return c.json({ error: "A valid email is required" }, 400);
  }
  if (!requestedRole || !ASSIGNABLE_ROLES.includes(requestedRole)) {
    return c.json(
      {
        error: `role must be one of: ${ASSIGNABLE_ROLES.join(", ")}`,
      },
      400,
    );
  }

  // US-351: cap the assigned role at the actor's own role. ASSIGNABLE_ROLES
  // already excludes 'owner', but canAssignRole makes the "never assign above
  // your own level" invariant explicit + server-enforced (an admin can assign
  // up to admin, never owner) instead of relying on the role list and the
  // invite gate coincidentally aligning.
  if (!canAssignRole(role, requestedRole)) {
    return c.json(
      { error: "You cannot assign a role higher than your own" },
      403,
    );
  }

  // US-388: team seats are a paid feature, bounded per plan. Gate on the
  // workspace OWNER's plan (not the inviting admin's): subAccounts must be
  // enabled (Free/Starter/Pro get FEATURE_LOCKED) and the active-member count
  // must be under the seat cap (Business → CAP_REACHED at the limit). The
  // accept RPC re-checks the cap authoritatively to close the over-invite race.
  const featureGate = await requireFlipdesk(c, {
    userId: ownerId,
    feature: "subAccounts",
  });
  if (featureGate) return featureGate;
  const seatGate = await requireFlipdesk(c, {
    userId: ownerId,
    capacity: { kind: "teamSeats" },
  });
  if (seatGate) return seatGate;

  // Look up the workspace owner's name + the inviter's name for the email.
  const [ownerRes, inviterRes] = await Promise.all([
    supabaseAdmin
      .from("users")
      .select("email, full_name")
      .eq("id", ownerId)
      .single(),
    supabaseAdmin
      .from("users")
      .select("email, full_name")
      .eq("id", userId)
      .single(),
  ]);

  if (ownerRes.error || !ownerRes.data) {
    return c.json({ error: "Workspace owner not found" }, 500);
  }

  const ownerProfile = ownerRes.data as { email: string; full_name: string | null };
  const inviterProfile = inviterRes.data as
    | { email: string; full_name: string | null }
    | null;

  const workspaceName =
    ownerProfile.full_name?.trim() ||
    `${ownerProfile.email}'s workspace`;
  const inviterName =
    inviterProfile?.full_name?.trim() ||
    inviterProfile?.email ||
    ownerProfile.full_name ||
    ownerProfile.email;
  const inviterEmail = inviterProfile?.email ?? ownerProfile.email;

  // Insert the invitation. The unique partial index on (owner_id, lower(email))
  // for pending rows will reject duplicates.
  const token = generateToken();
  const expiresAt = new Date(
    Date.now() + 14 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("workspace_invitations")
    .insert({
      owner_id: ownerId,
      email,
      role: requestedRole,
      token,
      invited_by: userId,
      expires_at: expiresAt,
    })
    .select("id, token, expires_at, role, email")
    .single();

  if (insertErr || !inserted) {
    if (insertErr?.code === "23505") {
      return c.json(
        { error: "There's already a pending invitation for that email" },
        409,
      );
    }
    console.error("[workspace] insert invitation failed", insertErr);
    return c.json({ error: "Failed to create invitation" }, 500);
  }

  const acceptUrl = `${siteUrl()}/accept-invite?token=${token}`;

  // Fire the email best-effort. If it fails we still return the invite so
  // the inviter can copy the URL manually.
  let emailSent = false;
  try {
    emailSent = await sendWorkspaceInvitationEmail(email, {
      inviterName,
      inviterEmail,
      workspaceName,
      role: ROLE_LABEL[requestedRole],
      acceptUrl,
      expiresAt,
    });
  } catch (err) {
    console.error("[workspace] invitation email failed", err);
  }

  return c.json({
    id: (inserted as { id: string }).id,
    token,
    email,
    role: requestedRole,
    expires_at: expiresAt,
    accept_url: acceptUrl,
    email_sent: emailSent,
  });
});

// POST /api/workspace/invitations/:id/resend
//
// Re-sends the invitation email for an existing pending invitation. Useful
// when the email service was down at create time, or the invitee misplaced
// the original email. Only the workspace owner or an admin can resend.
workspaceRoutes.post("/invitations/:id/resend", async (c) => {
  const ownerId = c.get("workspaceOwnerId");
  const role = c.get("workspaceRole");
  const userId = c.get("userId");
  const invitationId = c.req.param("id");

  if (!roleAtLeast(role, "admin")) {
    return c.json(
      { error: "Only the workspace owner and admins can resend invitations" },
      403,
    );
  }

  const { data: invitation, error: invErr } = await supabaseAdmin
    .from("workspace_invitations")
    .select("id, owner_id, email, role, token, expires_at, accepted_at, revoked_at")
    .eq("id", invitationId)
    .single();

  if (invErr || !invitation) {
    return c.json({ error: "Invitation not found" }, 404);
  }

  const inv = invitation as {
    id: string;
    owner_id: string;
    email: string;
    role: WorkspaceRole;
    token: string;
    expires_at: string;
    accepted_at: string | null;
    revoked_at: string | null;
  };

  if (inv.owner_id !== ownerId) {
    return c.json({ error: "Invitation belongs to a different workspace" }, 403);
  }
  // US-351: re-apply the role cap at resend time. An invitation row could carry
  // a role above the resender's level (legacy row, or one created before the
  // cap); don't re-send an over-privileged invite.
  if (!canAssignRole(role, inv.role)) {
    return c.json(
      { error: "This invitation grants a role higher than your own and cannot be resent" },
      403,
    );
  }
  if (inv.accepted_at) {
    return c.json({ error: "Invitation already accepted" }, 400);
  }
  if (inv.revoked_at) {
    return c.json({ error: "Invitation has been revoked" }, 400);
  }
  if (new Date(inv.expires_at) < new Date()) {
    return c.json({ error: "Invitation has expired — create a new one" }, 400);
  }

  const [ownerRes, inviterRes] = await Promise.all([
    supabaseAdmin
      .from("users")
      .select("email, full_name")
      .eq("id", ownerId)
      .single(),
    supabaseAdmin
      .from("users")
      .select("email, full_name")
      .eq("id", userId)
      .single(),
  ]);

  const ownerProfile = ownerRes.data as
    | { email: string; full_name: string | null }
    | null;
  const inviterProfile = inviterRes.data as
    | { email: string; full_name: string | null }
    | null;

  if (!ownerProfile) {
    return c.json({ error: "Workspace owner not found" }, 500);
  }

  const workspaceName =
    ownerProfile.full_name?.trim() ||
    `${ownerProfile.email}'s workspace`;
  const inviterName =
    inviterProfile?.full_name?.trim() ||
    inviterProfile?.email ||
    ownerProfile.full_name ||
    ownerProfile.email;
  const inviterEmail = inviterProfile?.email ?? ownerProfile.email;
  const acceptUrl = `${siteUrl()}/accept-invite?token=${inv.token}`;

  const emailSent = await sendWorkspaceInvitationEmail(inv.email, {
    inviterName,
    inviterEmail,
    workspaceName,
    role: ROLE_LABEL[inv.role],
    acceptUrl,
    expiresAt: inv.expires_at,
  }).catch((err) => {
    console.error("[workspace] resend invitation email failed", err);
    return false;
  });

  return c.json({ email_sent: emailSent, accept_url: acceptUrl });
});

// GET /api/workspace/mfa-policy
//
// US-374: read the active workspace's MFA-enforcement threshold. Owner/admin
// only (it's a security-posture setting). Returns { required_role } where null
// means enforcement is off.
workspaceRoutes.get("/mfa-policy", async (c) => {
  const ownerId = c.get("workspaceOwnerId");
  const role = c.get("workspaceRole");
  if (!roleAtLeast(role, "admin")) {
    return c.json({ error: "Only the workspace owner and admins can view this" }, 403);
  }
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("workspace_mfa_required_role")
    .eq("id", ownerId)
    .maybeSingle();
  if (error) {
    console.error("[workspace] mfa-policy read failed", error);
    return c.json({ error: "Failed to load MFA policy" }, 500);
  }
  return c.json({
    required_role:
      (data as { workspace_mfa_required_role: WorkspaceRole | null } | null)
        ?.workspace_mfa_required_role ?? null,
  });
});

// PUT /api/workspace/mfa-policy
//
// US-374: set/clear the MFA-enforcement threshold. OWNER ONLY — this raises the
// security bar for every member at/above the threshold, so it sits with the
// owner alongside billing (not delegated to admins). Body:
// { required_role: 'viewer'|'member'|'listing_manager'|'admin'|null }.
workspaceRoutes.put("/mfa-policy", async (c) => {
  const ownerId = c.get("workspaceOwnerId");
  const userId = c.get("userId");
  const role = c.get("workspaceRole");

  if (role !== "owner") {
    return c.json(
      { error: "Only the workspace owner can change the MFA requirement" },
      403,
    );
  }

  let body: { required_role?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const raw = body.required_role;
  let requiredRole: WorkspaceRole | null;
  if (raw === null || raw === undefined || raw === "") {
    requiredRole = null;
  } else if (
    typeof raw === "string" &&
    MFA_THRESHOLD_ROLES.includes(raw as WorkspaceRole)
  ) {
    requiredRole = raw as WorkspaceRole;
  } else {
    return c.json(
      {
        error: `required_role must be null or one of: ${MFA_THRESHOLD_ROLES.join(", ")}`,
      },
      400,
    );
  }

  // Read the prior value for the audit trail.
  const { data: prior } = await supabaseAdmin
    .from("users")
    .select("workspace_mfa_required_role")
    .eq("id", ownerId)
    .maybeSingle();

  const { error } = await supabaseAdmin
    .from("users")
    .update({ workspace_mfa_required_role: requiredRole })
    .eq("id", userId); // owner updates their own row
  if (error) {
    console.error("[workspace] mfa-policy update failed", error);
    return c.json({ error: "Failed to update MFA policy" }, 500);
  }

  await writeAuditLog(c, {
    action: "workspace.mfa_policy.change",
    targetType: "workspace",
    targetId: ownerId,
    before: {
      required_role:
        (prior as { workspace_mfa_required_role: WorkspaceRole | null } | null)
          ?.workspace_mfa_required_role ?? null,
    },
    after: { required_role: requiredRole },
    details: { owner_id: ownerId },
  });

  return c.json({ required_role: requiredRole });
});

// Shared loader: the target's membership row in the ACTIVE workspace, or null.
async function loadMembership(
  ownerId: string,
  memberId: string,
): Promise<{ role: WorkspaceRole } | null> {
  const { data } = await supabaseAdmin
    .from("workspace_members")
    .select("role")
    .eq("owner_id", ownerId)
    .eq("member_id", memberId)
    .maybeSingle();
  return (data as { role: WorkspaceRole } | null) ?? null;
}

// Count members holding 'admin' in the workspace — used to block removing the
// last admin via self-action (the owner can always re-appoint, but losing your
// own admin with no peer admin is a foot-gun we refuse).
async function adminMemberCount(ownerId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("workspace_members")
    .select("member_id", { count: "exact", head: true })
    .eq("owner_id", ownerId)
    .eq("role", "admin");
  return count ?? 0;
}

// PATCH /api/workspace/members/:memberId/role
//
// US-799: change a member's role through an AUDITED, server-enforced path
// instead of a direct browser RLS write. Caller must be owner/admin of the
// active workspace; the new role is capped at the caller's own level
// (canAssignRole); the owner can't be demoted (never a member row); and an
// admin can't strip their own admin if they're the last one.
workspaceRoutes.patch("/members/:memberId/role", async (c) => {
  const ownerId = c.get("workspaceOwnerId");
  const callerRole = c.get("workspaceRole");
  const callerId = c.get("userId");
  const memberId = c.req.param("memberId");

  if (!roleAtLeast(callerRole, "admin")) {
    return c.json(
      { error: "Only the workspace owner and admins can change member roles" },
      403,
    );
  }

  let body: { role?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const newRole = body.role as WorkspaceRole | undefined;
  if (!newRole || !ASSIGNABLE_ROLES.includes(newRole)) {
    return c.json(
      { error: `role must be one of: ${ASSIGNABLE_ROLES.join(", ")}` },
      400,
    );
  }
  if (!canAssignRole(callerRole, newRole)) {
    return c.json({ error: "You cannot assign a role higher than your own" }, 403);
  }

  if (memberId === ownerId) {
    return c.json({ error: "The workspace owner's role can't be changed" }, 403);
  }

  const membership = await loadMembership(ownerId, memberId);
  if (!membership) {
    return c.json({ error: "Member not found in this workspace" }, 404);
  }
  if (!canManageMember(callerRole, membership.role)) {
    return c.json({ error: "You can't modify a member at or above your own role" }, 403);
  }

  // Block self-demotion of the last admin — appoint another admin first.
  if (
    memberId === callerId &&
    membership.role === "admin" &&
    !roleAtLeast(newRole, "admin") &&
    (await adminMemberCount(ownerId)) <= 1
  ) {
    return c.json(
      { error: "Appoint another admin before stepping down from admin." },
      409,
    );
  }

  if (membership.role === newRole) {
    return c.json({ ok: true, role: newRole }); // no-op, nothing to audit
  }

  const { error } = await supabaseAdmin
    .from("workspace_members")
    .update({ role: newRole })
    .eq("owner_id", ownerId)
    .eq("member_id", memberId);
  if (error) {
    console.error("[workspace] role change failed", error);
    return c.json({ error: "Failed to update member role" }, 500);
  }

  await writeAuditLog(c, {
    action: "workspace.member.role_change",
    targetType: "workspace_member",
    targetId: memberId,
    before: { role: membership.role },
    after: { role: newRole },
    details: { owner_id: ownerId, member_id: memberId },
  });

  return c.json({ ok: true, role: newRole });
});

// POST /api/workspace/members/:memberId/remove
//
// US-799: remove a member through an AUDITED, server-enforced path. Caller must
// be owner/admin and outrank-or-equal the target; the owner can't be removed;
// an admin can't remove themselves if they're the last admin.
workspaceRoutes.post("/members/:memberId/remove", async (c) => {
  const ownerId = c.get("workspaceOwnerId");
  const callerRole = c.get("workspaceRole");
  const callerId = c.get("userId");
  const memberId = c.req.param("memberId");

  if (!roleAtLeast(callerRole, "admin")) {
    return c.json(
      { error: "Only the workspace owner and admins can remove members" },
      403,
    );
  }
  if (memberId === ownerId) {
    return c.json({ error: "The workspace owner can't be removed" }, 403);
  }

  const membership = await loadMembership(ownerId, memberId);
  if (!membership) {
    return c.json({ error: "Member not found in this workspace" }, 404);
  }
  if (!canManageMember(callerRole, membership.role)) {
    return c.json({ error: "You can't remove a member at or above your own role" }, 403);
  }
  if (
    memberId === callerId &&
    membership.role === "admin" &&
    (await adminMemberCount(ownerId)) <= 1
  ) {
    return c.json(
      { error: "Appoint another admin before removing yourself." },
      409,
    );
  }

  const { error } = await supabaseAdmin
    .from("workspace_members")
    .delete()
    .eq("owner_id", ownerId)
    .eq("member_id", memberId);
  if (error) {
    console.error("[workspace] member removal failed", error);
    return c.json({ error: "Failed to remove member" }, 500);
  }

  await writeAuditLog(c, {
    action: "workspace.member.remove",
    targetType: "workspace_member",
    targetId: memberId,
    before: { role: membership.role },
    details: { owner_id: ownerId, member_id: memberId },
  });

  return c.json({ ok: true });
});
