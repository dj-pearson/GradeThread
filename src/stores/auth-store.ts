import { create } from "zustand";
import type { Session, User } from "@supabase/supabase-js";
import type { UserRow, WorkspaceSummary, WorkspaceRole } from "@/types/database";

interface AuthState {
  user: User | null;
  session: Session | null;
  profile: UserRow | null;
  isLoading: boolean;
  // Workspaces the user can act inside. Always contains at least their
  // personal workspace (themselves as owner). Additional entries are
  // workspaces they're a member of.
  workspaces: WorkspaceSummary[];
  // The owner_id of the workspace currently being viewed. Defaults to the
  // user's own id (personal workspace).
  activeWorkspaceOwnerId: string | null;
  setUser: (user: User | null) => void;
  setSession: (session: Session | null) => void;
  setProfile: (profile: UserRow | null) => void;
  setIsLoading: (isLoading: boolean) => void;
  setWorkspaces: (workspaces: WorkspaceSummary[]) => void;
  setActiveWorkspaceOwnerId: (ownerId: string | null) => void;
  reset: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  session: null,
  profile: null,
  isLoading: true,
  workspaces: [],
  activeWorkspaceOwnerId: null,
  setUser: (user) => set({ user }),
  setSession: (session) => set({ session }),
  setProfile: (profile) => set({ profile }),
  setIsLoading: (isLoading) => set({ isLoading }),
  setWorkspaces: (workspaces) => set({ workspaces }),
  setActiveWorkspaceOwnerId: (activeWorkspaceOwnerId) => set({ activeWorkspaceOwnerId }),
  reset: () =>
    set({
      user: null,
      session: null,
      profile: null,
      isLoading: false,
      workspaces: [],
      activeWorkspaceOwnerId: null,
    }),
}));

// Resolve the effective role of the current user in the active workspace.
// Pure derivation; safe to call outside React.
export function deriveActiveRole(
  userId: string | null,
  activeOwnerId: string | null,
  workspaces: WorkspaceSummary[],
): WorkspaceRole | null {
  if (!userId || !activeOwnerId) return null;
  if (userId === activeOwnerId) return "owner";
  return workspaces.find((w) => w.ownerId === activeOwnerId)?.role ?? null;
}
