import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SUB-14: a Showcase toggle flips the switch on its own answer (no realtime
// needed), and a write to an already-completed row does not toast "Grade
// Complete".

const mocks = vi.hoisted(() => ({
  handler: null as null | ((p: { new: unknown }) => void),
  mutate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    channel: () => {
      const ch = {
        on: (_e: string, _f: unknown, h: (p: { new: unknown }) => void) => {
          mocks.handler = h;
          return ch;
        },
        subscribe: () => ch,
      };
      return ch;
    },
    removeChannel: () => {},
  },
}));
vi.mock("@/hooks/use-workspace", () => ({ useWorkspace: () => ({ workspaceOwnerId: "owner" }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), mocks.toast) }));
vi.mock("@/hooks/use-showcase", () => ({
  useSetShowcaseConsent: () => ({ mutate: mocks.mutate, isPending: false }),
}));

const { useRealtimeSubmissions, statusChangeToast } = await import(
  "@/hooks/use-realtime-submission"
);
const { ShowcaseConsentPanel } = await import("@/components/showcase/showcase-consent-panel");

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient();
  mocks.handler = null;
  mocks.mutate.mockReset();
  for (const f of Object.values(mocks.toast)) f.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Realtime() {
  useRealtimeSubmissions();
  return null;
}

function mountRealtime(path = "/dashboard") {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Realtime />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
}

const fire = (row: Record<string, unknown>) => act(() => mocks.handler!({ new: row }));

describe("realtime toasts only on a real status change", () => {
  it("the rule", () => {
    expect(statusChangeToast("processing", "completed")).toBe("completed");
    expect(statusChangeToast("completed", "completed")).toBeNull();
    expect(statusChangeToast(undefined, "completed")).toBeNull();
    expect(statusChangeToast("processing", "failed")).toBe("failed");
  });

  it("a grade completing toasts once; a later Showcase write does not", () => {
    mountRealtime();
    fire({ id: "s1", status: "processing", title: "Jacket" });
    fire({ id: "s1", status: "completed", title: "Jacket" });
    fire({ id: "s1", status: "completed", title: "Jacket", showcase_opt_in: true });
    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success.mock.calls[0]![0]).toBe("Grade Complete");
  });

  it("a completed row known from the list cache does not toast", () => {
    client.setQueryData(["submissions", "owner", 0], {
      submissions: [{ id: "s2", status: "completed" }],
      totalCount: 1,
    });
    mountRealtime();
    fire({ id: "s2", status: "completed", title: "Coat", showcase_opt_in: true });
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it("no toast while already on that submission's page", () => {
    mountRealtime("/dashboard/submissions/s3");
    fire({ id: "s3", status: "processing", title: "Shirt" });
    fire({ id: "s3", status: "completed", title: "Shirt" });
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });
});

describe("Showcase switch", () => {
  function mountPanel() {
    act(() =>
      root.render(
        <MemoryRouter>
          <ShowcaseConsentPanel submissionId="s1" optIn={false} valueCents={null} />
        </MemoryRouter>,
      ),
    );
    return container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  }

  it("flips on the server's answer with realtime off", () => {
    mocks.mutate.mockImplementation((_input, opts) =>
      opts.onSuccess({ opt_in: true, opted_in_at: "x", value_cents: null }),
    );
    const sw = mountPanel();
    expect(sw.getAttribute("aria-checked")).toBe("false");
    act(() => sw.click());
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Showing in the feed");
    expect(mocks.toast.success).not.toHaveBeenCalledWith("Grade Complete", expect.anything());
  });

  it("rolls back when the save fails", () => {
    mocks.mutate.mockImplementation((_input, opts) => opts.onError(new Error("no")));
    const sw = mountPanel();
    act(() => sw.click());
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });
});
