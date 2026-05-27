import { useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import type {
  UserRow,
  WorkspaceMemberRow,
  WorkspaceSummary,
  WorkspaceRole,
} from "@/types/database";

export function useAuth() {
  const {
    user,
    session,
    profile,
    isLoading,
    workspaces,
    activeWorkspaceOwnerId,
    setUser,
    setSession,
    setProfile,
    setIsLoading,
    setWorkspaces,
    setActiveWorkspaceOwnerId,
    reset,
  } = useAuthStore();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: currentSession } }) => {
      setSession(currentSession);
      setUser(currentSession?.user ?? null);
      if (currentSession?.user) {
        loadProfileAndWorkspaces(currentSession.user.id);
      } else {
        setIsLoading(false);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);
      if (newSession?.user) {
        loadProfileAndWorkspaces(newSession.user.id);
      } else {
        reset();
      }
    });

    return () => subscription.unsubscribe();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadProfileAndWorkspaces(userId: string) {
    try {
      const [profileRes, membershipsRes] = await Promise.all([
        supabase.from("users").select("*").eq("id", userId).single(),
        supabase
          .from("workspace_members")
          .select("owner_id, role")
          .eq("member_id", userId),
      ]);

      if (profileRes.error) throw profileRes.error;
      const userProfile = profileRes.data as UserRow;
      setProfile(userProfile);

      // Build the workspace list: personal first, then memberships.
      const memberships = (membershipsRes.data ?? []) as unknown as Pick<
        WorkspaceMemberRow,
        "owner_id" | "role"
      >[];

      const personal: WorkspaceSummary = {
        ownerId: userId,
        ownerEmail: userProfile.email,
        ownerName: userProfile.full_name,
        role: "owner",
        isPersonal: true,
      };

      let memberSummaries: WorkspaceSummary[] = [];
      if (memberships.length > 0) {
        const ownerIds = memberships.map((m) => m.owner_id);
        const { data: ownersData } = await supabase
          .from("users")
          .select("id, email, full_name")
          .in("id", ownerIds);
        const owners = (ownersData ?? []) as unknown as Array<{
          id: string;
          email: string;
          full_name: string | null;
        }>;
        const ownerMap = new Map(owners.map((o) => [o.id, o] as const));
        memberSummaries = memberships.map((m) => {
          const owner = ownerMap.get(m.owner_id);
          return {
            ownerId: m.owner_id,
            ownerEmail: owner?.email ?? "",
            ownerName: owner?.full_name ?? null,
            role: m.role as WorkspaceRole,
            isPersonal: false,
          };
        });
      }

      const allWorkspaces = [personal, ...memberSummaries];
      setWorkspaces(allWorkspaces);

      // Resolve the active workspace. Prefer the value on the profile if
      // it still corresponds to a workspace the user belongs to; fall
      // back to personal.
      const stored = userProfile.active_workspace_owner_id;
      const validStored =
        stored && allWorkspaces.some((w) => w.ownerId === stored) ? stored : null;
      setActiveWorkspaceOwnerId(validStored ?? userId);
    } catch {
      setProfile(null);
      setWorkspaces([]);
      setActiveWorkspaceOwnerId(null);
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshProfile() {
    const userId = user?.id;
    if (userId) {
      await loadProfileAndWorkspaces(userId);
    }
  }

  return {
    user,
    session,
    profile,
    isLoading,
    workspaces,
    activeWorkspaceOwnerId,
    refreshProfile,
  };
}
