import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { sendWorkspaceInvitationEmail } from "../lib/email.ts";
import {
  ASSIGNABLE_ROLES,
  canAssignRole,
  roleAtLeast,
  type WorkspaceRole,
} from "../lib/workspace-roles.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";

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
