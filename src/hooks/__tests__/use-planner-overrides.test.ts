// Worth My Time, R2 05/06 (US-3182): what the override hooks actually send.
//
// This file exists because a component test could not answer it. The panel's
// suite asserts the ARGUMENTS it hands the hook, and the hook is what builds
// the request body -- so a hook that quietly added a snooze length, or wrote a
// price to the item route, would pass every test on the screen. A sabotage
// proved exactly that before this file was written.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/auth-token", () => ({
  getFreshAccessToken: () => Promise.resolve("token"),
}));
vi.mock("@/lib/edge-api", () => ({ edgeApiUrl: () => "https://edge.test" }));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => ({ activeWorkspaceOwnerId: null, user: { id: "owner-1" } }),
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

const {
  toOverrideBook,
  useResetOverride,
  useResetSuppression,
  useSaveOverride,
  useSuppress,
  useWorkOverrides,
} = await import("@/hooks/use-planner");

interface Sent { url: string; method: string; body: Record<string, unknown> }
let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    sent.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ overrides: [], suppressions: [], now: "2026-09-21T12:00:00.000Z" }),
    } as unknown as Response);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Render one hook and hand its return value back. */
function mount<T>(use: () => T): { current: T } {
  const ref = { current: undefined as unknown as T };
  function Probe() {
    ref.current = use();
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  act(() => {
    root = createRoot(container!);
    root.render(h(QueryClientProvider, { client: qc }, h(Probe)));
  });
  return ref;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("the snooze clock belongs to the server (AC3)", () => {
  it("NEVER sends an expiry, whatever the caller asks for", async () => {
    // A client choosing its own snooze length is a nine-year snooze away from
    // a dismissal nobody asked for, and no screen would show the difference.
    const hook = mount(() => useSuppress());
    await act(async () => {
      await hook.current.mutateAsync({ inventoryItemId: "item-1", kind: "snooze" });
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain("/api/flipdesk/planner/suppressions");
    expect(Object.keys(sent[0]!.body)).not.toContain("until");
    expect(JSON.stringify(sent[0]!.body)).not.toContain("until");
  });

  it("sends the session id only for a skip", async () => {
    const hook = mount(() => useSuppress());
    await act(async () => {
      await hook.current.mutateAsync({
        inventoryItemId: "item-1", kind: "skip_session", sessionId: "s1",
      });
      await hook.current.mutateAsync({
        inventoryItemId: "item-1", kind: "snooze", sessionId: null,
      });
    });
    expect(sent[0]!.body.session_id).toBe("s1");
    expect(Object.keys(sent[1]!.body)).not.toContain("session_id");
  });
});

describe("corrections go to the planner's own routes (AC1)", () => {
  it("a value correction is a PUT to /planner/overrides and nothing else", async () => {
    const hook = mount(() => useSaveOverride());
    await act(async () => {
      await hook.current.mutateAsync({
        inventoryItemId: "item-1",
        kind: "value_range",
        lowCents: 3000,
        highCents: 5000,
      });
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("PUT");
    expect(sent[0]!.url).toBe("https://edge.test/api/flipdesk/planner/overrides");
    // Not an item route, not a listing route, not a price field.
    expect(sent[0]!.url).not.toContain("inventory_items");
    expect(Object.keys(sent[0]!.body)).not.toContain("target_price");
    expect(sent[0]!.body).toMatchObject({
      inventory_item_id: "item-1",
      kind: "value_range",
      low_cents: 3000,
      high_cents: 5000,
    });
  });

  it("a recorded zero cost survives the body, rather than being dropped", async () => {
    // `...(x ? {} : {})` would drop a legitimate zero, and the seller's
    // "nothing more to spend" would silently never arrive.
    const hook = mount(() => useSaveOverride());
    await act(async () => {
      await hook.current.mutateAsync({
        inventoryItemId: "item-1", kind: "remaining_cost", amountCents: 0,
      });
    });
    expect(sent[0]!.body.amount_cents).toBe(0);
  });

  it("a reset names the scope it is clearing", async () => {
    const hook = mount(() => useResetOverride());
    await act(async () => {
      await hook.current.mutateAsync({
        inventoryItemId: "item-1", actionKey: "photograph", kind: "task_minutes",
      });
    });
    expect(sent[0]!.url).toContain("/planner/overrides/reset");
    expect(sent[0]!.body).toEqual({
      inventory_item_id: "item-1", action_key: "photograph", kind: "task_minutes",
    });
  });

  it("undoing a set-aside clears every kind when none is named", async () => {
    const hook = mount(() => useResetSuppression());
    await act(async () => {
      await hook.current.mutateAsync({ inventoryItemId: "item-1" });
    });
    expect(sent[0]!.url).toContain("/planner/suppressions/reset");
    expect(Object.keys(sent[0]!.body)).not.toContain("kind");
  });
});

describe("reading the book back (AC6)", () => {
  it("asks the planner, and carries the server's clock", async () => {
    const hook = mount(() => useWorkOverrides());
    await settle();
    expect(sent[0]!.url).toContain("/api/flipdesk/planner/overrides");
    expect(hook.current.data?.now).toBe("2026-09-21T12:00:00.000Z");
  });

  it("drops a kind it does not know rather than carrying the string through", () => {
    // An unknown suppression kind that reached isSuppressed would fall past
    // every branch and quietly NOT suppress -- which is the direction that
    // shows a seller the task they dismissed.
    const b = toOverrideBook({
      overrides: [
        { id: "1", inventory_item_id: "i", action_key: null, kind: "repaint_it",
          amount_minutes: 5, amount_cents: null, low_cents: null, high_cents: null,
          original_json: null, source: "seller", updated_at: "x" },
      ],
      suppressions: [
        { id: "2", inventory_item_id: "i", action_key: null, kind: "banish",
          session_id: null, until: null, created_at: "x" },
      ],
    });
    expect(b.overrides).toHaveLength(0);
    expect(b.suppressions).toHaveLength(0);
  });

  it("falls back to its own clock only when the server sent none", () => {
    expect(toOverrideBook({}).now).toMatch(/^\d{4}-/);
  });
});
