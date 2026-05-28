import { useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import type {
  UserRow,
  WorkspaceMemberRow,
  WorkspaceSummary,
  WorkspaceRole,
} from "@/types/database";

// ── Module-level auth bootstrap ─────────────────────────────────────
//
// useAuth() is consumed by ~26 components. Previously each instance ran its
// own getSession() + onAuthStateChange subscription + profile/workspace
// fetch, so a single page load fired the same queries dozens of times (and
// every one of those hammered workspace_members). We now bootstrap ONCE at
// module scope: a single subscription, a single initial load, and a deduped
// loader. Components just read the shared Zustand store reactively.

let authInitialized = false;
let inFlightLoad: Promise<void> | null = null;
let lastLoadedUserId: string | null = null;
let lastLoadedAt = 0;
// Collapse the initial mount-storm: repeated loads for the same user within
// this window are skipped. refreshProfile() passes force to bypass it.
const LOAD_DEDUP_MS = 3000;

async function loadProfileAndWorkspaces(
  userId: string,
  opts?: { force?: boolean },
): Promise<void> {
  const force = opts?.force ?? false;
  if (!force) {
    // Concurrent callers share the in-flight promise.
    if (inFlightLoad && lastLoadedUserId === userId) return inFlightLoad;
    // Recently-completed loads for the same user are a no-op.
    if (lastLoadedUserId === userId && Date.now() - lastLoadedAt < LOAD_DEDUP_MS) {
      return;
    }
  }

  const promise = (async () => {
    const store = useAuthStore.getState();
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
      store.setProfile(userProfile);

      // The workspace_members table is part of the team feature (migration
      // 00042). If it isn't deployed yet PostgREST 404s here; we treat that
      // as "no memberships" so solo accounts work unchanged.
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
      store.setWorkspaces(allWorkspaces);

      const stored = userProfile.active_workspace_owner_id;
      const validStored =
        stored && allWorkspaces.some((w) => w.ownerId === stored)
          ? stored
          : null;
      store.setActiveWorkspaceOwnerId(validStored ?? userId);
    } catch {
      store.setProfile(null);
      store.setWorkspaces([]);
      store.setActiveWorkspaceOwnerId(null);
    } finally {
      store.setIsLoading(false);
      lastLoadedUserId = userId;
      lastLoadedAt = Date.now();
    }
  })();

  inFlightLoad = promise;
  try {
    await promise;
  } finally {
    if (inFlightLoad === promise) inFlightLoad = null;
  }
}

// Runs exactly once for the app lifetime. The subscription is intentionally
// never torn down — auth state should track the whole session, and the
// previous per-component subscribe/unsubscribe churn was the bug.
function initAuth() {
  if (authInitialized) return;
  authInitialized = true;

  const store = useAuthStore.getState();
  supabase.auth.getSession().then(({ data: { session } }) => {
    store.setSession(session);
    store.setUser(session?.user ?? null);
    if (session?.user) {
      void loadProfileAndWorkspaces(session.user.id);
    } else {
      store.setIsLoading(false);
    }
  });

  supabase.auth.onAuthStateChange((_event, newSession) => {
    const s = useAuthStore.getState();
    s.setSession(newSession);
    s.setUser(newSession?.user ?? null);
    if (newSession?.user) {
      void loadProfileAndWorkspaces(newSession.user.id);
    } else {
      s.reset();
    }
  });
}

export function useAuth() {
  const user = useAuthStore((s) => s.user);
  const session = useAuthStore((s) => s.session);
  const profile = useAuthStore((s) => s.profile);
  const isLoading = useAuthStore((s) => s.isLoading);
  const workspaces = useAuthStore((s) => s.workspaces);
  const activeWorkspaceOwnerId = useAuthStore((s) => s.activeWorkspaceOwnerId);

  useEffect(() => {
    initAuth();
  }, []);

  async function refreshProfile() {
    const userId = useAuthStore.getState().user?.id;
    if (userId) {
      await loadProfileAndWorkspaces(userId, { force: true });
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
