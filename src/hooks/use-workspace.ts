import { useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import { useAuthStore, deriveActiveRole } from "@/stores/auth-store";
import { canDo, type WorkspaceCapability } from "@/lib/workspace-permissions";
import type { WorkspaceRole, WorkspaceSummary } from "@/types/database";

// Returns the active workspace context and a `can()` helper. Pages should
// use `workspaceOwnerId` instead of `user.id` for filtering queries and
// inserting rows, so a member acting inside another user's workspace
// writes to the correct tenant.
//
// For solo accounts (no memberships), `workspaceOwnerId === user.id` and
// `role === 'owner'`, which means existing code paths Just Work.
export function useWorkspace() {
  const user = useAuthStore((s) => s.user);
  const workspaces = useAuthStore((s) => s.workspaces);
  const activeOwnerId = useAuthStore((s) => s.activeWorkspaceOwnerId);
  const setActiveOwnerId = useAuthStore((s) => s.setActiveWorkspaceOwnerId);

  const workspaceOwnerId = activeOwnerId ?? user?.id ?? null;

  const role: WorkspaceRole | null = useMemo(
    () => deriveActiveRole(user?.id ?? null, workspaceOwnerId, workspaces),
    [user?.id, workspaceOwnerId, workspaces],
  );

  const activeWorkspace: WorkspaceSummary | null = useMemo(() => {
    if (!workspaceOwnerId) return null;
    return workspaces.find((w) => w.ownerId === workspaceOwnerId) ?? null;
  }, [workspaceOwnerId, workspaces]);

  const switchWorkspace = useCallback(
    async (ownerId: string) => {
      setActiveOwnerId(ownerId);
      if (user?.id) {
        await supabase
          .from("users")
          .update({
            active_workspace_owner_id: ownerId === user.id ? null : ownerId,
          } as never)
          .eq("id", user.id);
      }
    },
    [user?.id, setActiveOwnerId],
  );

  const can = useCallback(
    (capability: WorkspaceCapability) => canDo(role, capability),
    [role],
  );

  return {
    workspaceOwnerId,
    role,
    isOwner: role === "owner",
    isPersonal: workspaceOwnerId === user?.id,
    workspaces,
    activeWorkspace,
    switchWorkspace,
    can,
  };
}
