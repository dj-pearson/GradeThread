import { createMiddleware } from "hono/factory";
import { supabaseAdmin } from "../lib/supabase.ts";
import { roleAtLeast, type WorkspaceRole } from "../lib/workspace-roles.ts";

// Re-export the pure role helpers so existing importers of this middleware keep
// working. The hierarchy + assignment cap live in lib/workspace-roles.ts (no DB
// import, unit-testable).
export { roleAtLeast };
export type { WorkspaceRole };

type WorkspaceEnv = {
  Variables: {
    user: { id: string; email?: string; [key: string]: unknown };
    userId: string;
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
    if (!userId) {
      return c.json({ error: "Auth context missing" }, 401);
    }

    const requested = c.req.header("X-Workspace-Owner")?.trim();
    const ownerId = requested && requested.length > 0 ? requested : userId;

    if (ownerId === userId) {
      c.set("workspaceOwnerId", userId);
      c.set("workspaceRole", "owner");
      await next();
      return;
    }

    // Member of someone else's workspace. Look up the role.
    const { data, error } = await supabaseAdmin
      .from("workspace_members")
      .select("role")
      .eq("owner_id", ownerId)
      .eq("member_id", userId)
      .maybeSingle();

    if (error) {
      console.error("[workspace] lookup failed", error);
      return c.json({ error: "Workspace lookup failed" }, 500);
    }
    if (!data) {
      // US-794: a machine-readable code so a client whose membership was revoked
      // mid-session (stale X-Workspace-Owner) can detect it, clear the cached
      // scope, and recover — instead of treating every workspace request as a
      // generic, unexplained 403.
      return c.json(
        {
          error: "You don't have access to this workspace",
          error_code: "workspace_access_revoked",
        },
        403,
      );
    }

    c.set("workspaceOwnerId", ownerId);
    c.set("workspaceRole", data.role as WorkspaceRole);
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
