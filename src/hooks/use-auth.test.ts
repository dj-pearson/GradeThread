// US-1917: the async profile/workspace load must not repopulate the auth store
// after the signed-in user changed. On a shared browser, a slow load from user
// A's session can resolve after A signs out and B signs in; without a guard it
// would write A's profile/workspaces/activeWorkspaceOwnerId over B's session.
// These tests drive loadProfileAndWorkspaces directly with a mocked Supabase.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { User } from "@supabase/supabase-js";

// Controllable mock results, hoisted so the vi.mock factory can close over them.
const h = vi.hoisted(() => ({
  profileResult: { data: null as unknown, error: null as unknown },
  membersResult: { data: [] as unknown[], error: null as unknown },
}));

vi.mock("@/lib/supabase", () => {
  const chain = (getResult: () => unknown) => {
    const c: Record<string, unknown> = {
      select: () => c,
      eq: () => c,
      in: () => c,
      single: () => Promise.resolve(getResult()),
      // thenable so `await supabase.from(...).select(...).eq(...)` resolves.
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(getResult()).then(onF, onR),
    };
    return c;
  };
  return {
    supabase: {
      from: (table: string) =>
        table === "workspace_members"
          ? chain(() => h.membersResult)
          : chain(() => h.profileResult),
      auth: {
        getSession: () => Promise.resolve({ data: { session: null } }),
        onAuthStateChange: () => ({
          data: { subscription: { unsubscribe() {} } },
        }),
      },
    },
  };
});

import { loadProfileAndWorkspaces } from "@/hooks/use-auth";
import { useAuthStore } from "@/stores/auth-store";

const asUser = (id: string) => ({ id, email: `${id}@x.test` }) as unknown as User;

function profileFor(id: string) {
  return {
    id,
    email: `${id}@x.test`,
    full_name: `User ${id}`,
    active_workspace_owner_id: null,
  };
}

describe("loadProfileAndWorkspaces stale-resolution guard (US-1917)", () => {
  beforeEach(() => {
    useAuthStore.getState().reset();
    h.membersResult = { data: [], error: null };
  });

  it("drops the write when the load resolves for a NON-current user (A signout → B active)", async () => {
    // A's load resolves, but by then B is the signed-in user.
    h.profileResult = { data: profileFor("A"), error: null };
    useAuthStore.getState().setUser(asUser("B"));

    await loadProfileAndWorkspaces("A", { force: true });

    const s = useAuthStore.getState();
    expect(s.profile).toBeNull(); // A's profile must NOT land in B's session
    expect(s.workspaces).toEqual([]);
    expect(s.activeWorkspaceOwnerId).toBeNull();
  });

  it("writes normally when the load resolves for the CURRENT user (happy path)", async () => {
    h.profileResult = { data: profileFor("A"), error: null };
    useAuthStore.getState().setUser(asUser("A"));

    await loadProfileAndWorkspaces("A", { force: true });

    const s = useAuthStore.getState();
    expect(s.profile?.id).toBe("A");
    expect(s.workspaces.some((w) => w.ownerId === "A" && w.isPersonal)).toBe(true);
    expect(s.activeWorkspaceOwnerId).toBe("A");
  });

  it("does not flip isLoading for a superseded (non-current) load", async () => {
    h.profileResult = { data: profileFor("A"), error: null };
    useAuthStore.getState().setUser(asUser("B"));
    useAuthStore.getState().setIsLoading(true); // B's own load is still running

    await loadProfileAndWorkspaces("A", { force: true });

    expect(useAuthStore.getState().isLoading).toBe(true); // untouched by A's stale load
  });
});
