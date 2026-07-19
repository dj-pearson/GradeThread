import { createMiddleware } from "hono/factory";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  resolveRequestedOwner,
  resolveWorkspaceAccess,
  roleAtLeast,
  type WorkspaceRole,
} from "../lib/workspace-roles.ts";
import { type AuthAssuranceClaims, isAal2 } from "../lib/jwt-claims.ts";

// Re-export the pure role helpers so existing importers of this middleware keep
// working. The hierarchy + assignment cap live in lib/workspace-roles.ts (no DB
// import, unit-testable).
export { roleAtLeast };
export type { WorkspaceRole };

type WorkspaceEnv = {
  Variables: {
    user: { id: string; email?: string; [key: string]: unknown };
    userId: string;
    // Decoded by authMiddleware from the verified token (US-357/US-374).
    authClaims?: AuthAssuranceClaims;
    // Owner of the workspace this request is acting inside. Equals userId for
    // a solo user or when the caller is the workspace owner. For a member
    // acting in someone else's workspace, this is the OWNER's id — tenant
    // writes should use this, not userId.
    workspaceOwnerId: string;
    // The caller's role in the active workspace. 'owner' if they ARE the
    // owner; otherwise the role stored on workspace_members.
    workspaceRole: WorkspaceRole;
  };
};

// Reads X-Workspace-Owner header. If absent, defaults to the caller's own id
// (personal workspace). Validates that the caller has at least viewer access
// to that workspace; rejects with 403 if not. Must run AFTER authMiddleware.
export const workspaceMiddleware = createMiddleware<WorkspaceEnv>(
  async (c, next) => {
    const userId = c.get("userId");

    // US-2039 AC4: the resolution + access decisions are pure and live in
    // lib/workspace-roles.ts so they can be unit-tested. This middleware is now
    // just the I/O around them.
    const target = resolveRequestedOwner(userId, c.req.header("X-Workspace-Owner"));
    if (!target) {
      return c.json({ error: "Auth context missing" }, 401);
    }

    const ownerId = target.ownerId;
    if (target.self) {
      c.set("workspaceOwnerId", ownerId);
      c.set("workspaceRole", "owner");
      await next();
      return;
    }

    // Member of someone else's workspace. Look up the member's role AND the
    // owner's MFA-enforcement policy in one round-trip each.
    const [memberRes, ownerRes] = await Promise.all([
      supabaseAdmin
        .from("workspace_members")
        .select("role")
        .eq("owner_id", ownerId)
        .eq("member_id", userId)
        .maybeSingle(),
      supabaseAdmin
        .from("users")
        .select("workspace_mfa_required_role")
        .eq("id", ownerId)
        .maybeSingle(),
    ]);
    const { data, error } = memberRes;
    if (error) console.error("[workspace] lookup failed", error);

    // US-374: the owner's MFA policy is enforced inside resolveWorkspaceAccess.
    // If the owner requires MFA at or above this member's role and the member's
    // session isn't AAL2, it denies with a machine-readable code so the client
    // can route them to Settings → Two-Factor Authentication. Enrollment goes
    // client→Supabase (never through workspace routes), so this can't lock a
    // member out of enrolling.
    const decision = resolveWorkspaceAccess({
      ownerId,
      member: (data as { role: string | null } | null) ?? null,
      lookupFailed: Boolean(error),
      ownerMfaRequiredRole:
        (ownerRes.data as { workspace_mfa_required_role: WorkspaceRole | null } | null)
          ?.workspace_mfa_required_role ?? null,
      sessionAal2: isAal2(c.get("authClaims") ?? { aal: null, amr: [] }),
    });

    if (decision.action === "deny") {
      return c.json(
        decision.errorCode
          ? { error: decision.error, error_code: decision.errorCode }
          : { error: decision.error },
        decision.status,
      );
    }

    c.set("workspaceOwnerId", decision.ownerId);
    c.set("workspaceRole", decision.role);
    await next();
  },
);

// Convenience guard: require at least `min` role for the route. Use as
// `app.use("/path/*", requireWorkspaceRole("listing_manager"))`. Must run
// AFTER workspaceMiddleware.
export function requireWorkspaceRole(min: WorkspaceRole) {
  return createMiddleware<WorkspaceEnv>(async (c, next) => {
    const role = c.get("workspaceRole");
    if (!role || !roleAtLeast(role, min)) {
      return c.json(
        { error: `This action requires ${min} access or higher` },
        403,
      );
    }
    await next();
  });
}

// HTTP verbs that change state. GET/HEAD/OPTIONS are reads.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * US-1928: baseline write floor for the FlipDesk + grade surface. A `viewer` is
 * a read-only workspace member — the role's whole contract — yet most mutating
 * routes never checked the role, so a viewer could write / spend AI credits in
 * the owner's tenant. Mounted broadly (`/api/flipdesk/*`, `/api/grade/*`) AFTER
 * workspaceMiddleware, this blocks a viewer from ANY mutating verb in one place,
 * so a new mutating route can't silently authorize a viewer.
 *
 * Fail-safe by design: it acts ONLY when the resolved role is exactly "viewer".
 * Public sub-paths under the surface (provider webhooks, OAuth callbacks) and
 * job-secret crons never run workspaceMiddleware, so `workspaceRole` is undefined
 * there and the request passes through untouched — same for owner/member/
 * listing_manager/admin. Routes needing a HIGHER floor (admin disconnects,
 * listing_manager publishes) keep their own inline check on top of this baseline.
 */
export const blockViewerWrites = createMiddleware<WorkspaceEnv>(
  async (c, next) => {
    if (
      MUTATING_METHODS.has(c.req.method) &&
      c.get("workspaceRole") === "viewer"
    ) {
      return c.json(
        {
          error:
            "Your workspace role is view-only. Ask a workspace admin for edit " +
            "access to make changes.",
          error_code: "workspace_viewer_readonly",
        },
        403,
      );
    }
    await next();
  },
);
