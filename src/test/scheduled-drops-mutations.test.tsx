// SD-1: a drop write that matched no row must not read as success.
//
// PostgREST answers a filtered UPDATE that hits nothing with 200 and no error,
// so a drop the cron already published, or a row RLS hides from a viewer,
// used to toast "moved". These mount the real hooks against a stubbed
// supabase and read what they return.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
  // One response per update, consumed in order; the last one repeats.
  responses: [] as Array<{ data: unknown; error: unknown }>,
  updates: [] as Array<{ patch: unknown; id: unknown }>,
};

function builder() {
  let patch: unknown;
  let id: unknown;
  const b: Record<string, unknown> = {};
  b.update = (p: unknown) => {
    patch = p;
    return b;
  };
  b.eq = (col: string, v: unknown) => {
    if (col === "id") id = v;
    return b;
  };
  b.select = () => {
    state.updates.push({ patch, id });
    const r = state.responses.length > 1 ? state.responses.shift()! : state.responses[0]!;
    return Promise.resolve(r);
  };
  return b;
}

vi.mock("@/lib/supabase", () => ({
  supabase: { from: vi.fn(() => builder()) },
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: "u1" } }),
}));

const hooks = await import("@/hooks/use-scheduled-drops");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  state.responses = [];
  state.updates = [];
});

async function mount<T>(useHook: () => T) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(client, "invalidateQueries");
  const out: { current: T | null } = { current: null };
  function Probe() {
    out.current = useHook();
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  return { out, spy };
}

describe("drop writes that change nothing (SD-1)", () => {
  it("reschedule rejects with DropNotChangedError on zero rows, and still refreshes", async () => {
    state.responses = [{ data: [], error: null }];
    const { out, spy } = await mount(() => hooks.useRescheduleDrop());
    let caught: unknown;
    await act(async () => {
      try {
        await out.current!.mutateAsync({ id: "a", at: new Date(Date.now() + 3_600_000).toISOString() });
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(hooks.DropNotChangedError);
    expect(spy).toHaveBeenCalled();
  });

  it("unschedule rejects with DropNotChangedError on zero rows", async () => {
    state.responses = [{ data: [], error: null }];
    const { out, spy } = await mount(() => hooks.useCancelDrop());
    let caught: unknown;
    await act(async () => {
      try {
        await out.current!.mutateAsync({ id: "a" });
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(hooks.DropNotChangedError);
    expect(state.updates[0]).toEqual({ patch: { scheduled_publish_at: null }, id: "a" });
    expect(spy).toHaveBeenCalled();
  });

  it("unschedule resolves when a row changed", async () => {
    state.responses = [{ data: [{ id: "a" }], error: null }];
    const { out } = await mount(() => hooks.useCancelDrop());
    await act(async () => {
      await out.current!.mutateAsync({ id: "a" });
    });
    expect(state.updates).toHaveLength(1);
  });

  it("shift counts moved and unchanged rows instead of stopping", async () => {
    state.responses = [
      { data: [{ id: "a" }], error: null },
      { data: [], error: null },
    ];
    const { out } = await mount(() => hooks.useShiftDrops());
    const soon = Date.now() + 86_400_000;
    let result: unknown;
    await act(async () => {
      result = await out.current!.mutateAsync({
        drops: [
          { id: "a", scheduled_publish_at: new Date(soon).toISOString() },
          { id: "b", scheduled_publish_at: new Date(soon + 60_000).toISOString() },
        ],
        minutes: 60,
      });
    });
    expect(result).toMatchObject({ moved: 1, unchanged: 1, failed: 0, movedIds: ["a"] });
  });

  it("shift counts an errored row as failed and carries on", async () => {
    state.responses = [
      { data: null, error: { message: "boom" } },
      { data: [{ id: "b" }], error: null },
    ];
    const { out } = await mount(() => hooks.useShiftDrops());
    const soon = Date.now() + 86_400_000;
    let result: unknown;
    await act(async () => {
      result = await out.current!.mutateAsync({
        drops: [
          { id: "a", scheduled_publish_at: new Date(soon).toISOString() },
          { id: "b", scheduled_publish_at: new Date(soon).toISOString() },
        ],
        minutes: 60,
      });
    });
    expect(result).toMatchObject({ moved: 1, unchanged: 0, failed: 1 });
  });
});
