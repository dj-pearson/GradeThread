// MP-05: accepting an invitation switches the active workspace, so the cached
// server data from the previous tenant is dropped BEFORE the switch, the same
// order switchWorkspace uses. Without it, a cached queue or review row could be
// acted on inside the new workspace with the previous tenant's ids.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const order: string[] = [];

vi.mock("@/lib/query-client", () => ({
  queryClient: { clear: () => order.push("clear") },
}));
vi.mock("@/stores/inventory-selection", () => ({
  useInventorySelection: { getState: () => ({ clear: () => order.push("selection") }) },
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ setActiveWorkspaceOwnerId: (id: string) => order.push(`switch:${id}`) }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "member@example.com" },
    isLoading: false,
    refreshProfile: vi.fn(async () => {}),
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  chain.update = () => chain;
  chain.eq = async () => ({ error: null });
  return {
    supabase: {
      rpc: async (fn: string) =>
        fn === "peek_workspace_invitation"
          ? {
            data: [
              {
                email: "member@example.com",
                role: "member",
                owner_email: "owner@example.com",
                owner_full_name: "Owner",
                expires_at: "2099-01-01",
                status: "pending",
              },
            ],
            error: null,
          }
          : { data: "owner-9", error: null },
      from: () => chain,
      auth: { signOut: vi.fn() },
    },
  };
});

const { AcceptInvitePage } = await import("@/pages/accept-invite");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  order.length = 0;
});

describe("accept invite", () => {
  it("clears the query cache before switching to the joined workspace", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <MemoryRouter initialEntries={["/accept-invite?token=t1"]}>
          <AcceptInvitePage />
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const accept = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Accept invitation",
    );
    expect(accept).toBeTruthy();
    await act(async () => {
      accept!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(order.slice(0, 3)).toEqual(["clear", "selection", "switch:owner-9"]);
  });
});
