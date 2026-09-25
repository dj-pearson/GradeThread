// Sign-out must delete the offline intake queue. On a shared tablet it holds
// one seller's cost, notes and raw photos, and before this it was replayed
// under whoever signed in next.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  onChange: null as null | ((event: string, session: unknown) => void),
  clearQueue: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        h.onChange = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  },
}));
vi.mock("@/lib/offline-queue", () => ({ clearOfflineIntakeQueue: h.clearQueue }));
vi.mock("@/stores/autolister-upload-store", () => ({
  clearAutolisterLocalState: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/idle-logout", async (orig) => ({
  ...(await orig<object>()),
  initIdleLogout: vi.fn(),
}));

const { useAuth } = await import("@/hooks/use-auth");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  useAuth();
  return null;
}

describe("SIGNED_OUT", () => {
  it("deletes the offline intake database", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<Probe />));
    expect(h.onChange).not.toBeNull();
    await act(async () => {
      h.onChange!("SIGNED_OUT", null);
      await new Promise((r) => setTimeout(r, 0));
    });
    await vi.waitFor(() => expect(h.clearQueue).toHaveBeenCalledTimes(1));
    act(() => root.unmount());
  });
});
