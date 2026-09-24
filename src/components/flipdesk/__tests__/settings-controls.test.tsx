// MP-06: the per-user settings controls never write from a value they could
// not read, and never write inside another owner's workspace.
//
// On a failed read the channel picker used to show every box ticked (null means
// "all"), and the next click computed a write from that and overwrote the saved
// list. Inside someone else's workspace the write landed on the member's own
// row, which nothing reads, behind a success toast.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
  activeOwner: null as string | null,
  error: false,
  upserts: [] as unknown[],
};

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { id: "me" }, activeWorkspaceOwnerId: state.activeOwner }),
}));
vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = async () =>
    state.error
      ? { data: null, error: { message: "read failed", code: "XX000" } }
      : { data: { cross_post_channels: ["poshmark"], lister_locales: null }, error: null };
  chain.upsert = async (row: unknown) => {
    state.upserts.push(row);
    return { error: null };
  };
  return { supabase: { from: () => chain } };
});

const { CrossPostChannelPicker } = await import(
  "@/components/flipdesk/cross-post-channel-picker"
);
const { ListingBadgeToggle } = await import("@/components/flipdesk/listing-badge-toggle");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root = createRoot(container!);
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function checkboxes(): HTMLButtonElement[] {
  return [...document.querySelectorAll("[role=checkbox]")] as HTMLButtonElement[];
}

beforeEach(() => {
  state.activeOwner = null;
  state.error = false;
  state.upserts = [];
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
});

describe("CrossPostChannelPicker", () => {
  it("a failed read disables the boxes, shows Retry, and a click writes nothing", async () => {
    state.error = true;
    await render(<CrossPostChannelPicker />);
    expect(document.body.textContent).toContain("Couldn't load this setting.");
    const boxes = checkboxes();
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.disabled).toBe(true);
      expect(b.getAttribute("aria-checked")).toBe("false");
    }
    await act(async () => {
      boxes[0]!.click();
    });
    expect(state.upserts).toEqual([]);
  });

  it("inside another owner's workspace the boxes are disabled with the owner line", async () => {
    state.activeOwner = "owner-2";
    await render(<CrossPostChannelPicker />);
    expect(document.body.textContent).toContain("Set by the workspace owner.");
    for (const b of checkboxes()) expect(b.disabled).toBe(true);
  });

  it("in the seller's own workspace a readable value can be changed", async () => {
    await render(<CrossPostChannelPicker />);
    const enabled = checkboxes().filter((b) => !b.disabled);
    expect(enabled.length).toBeGreaterThan(0);
  });
});

describe("ListingBadgeToggle", () => {
  it("a failed read shows Retry instead of a switch", async () => {
    state.error = true;
    await render(<ListingBadgeToggle />);
    expect(document.getElementById("listing-badge")).toBeNull();
    expect(document.body.textContent).toContain("Couldn't load this setting.");
  });

  it("inside another owner's workspace the switch is disabled", async () => {
    state.activeOwner = "owner-2";
    await render(<ListingBadgeToggle />);
    const sw = document.getElementById("listing-badge") as HTMLButtonElement | null;
    expect(sw?.disabled).toBe(true);
  });
});
