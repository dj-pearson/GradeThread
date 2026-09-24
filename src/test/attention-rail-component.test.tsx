import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttentionRail } from "@/components/dashboard/attention-rail";

// DASH-1: the rail must never say "All clear" over a source it could not read.
// The hooks are mocked so each source's state is set directly; the grading
// count goes through a mocked supabase so its failure is a real query error.

type Q = {
  data?: unknown;
  isError?: boolean;
  error?: unknown;
  isLoading?: boolean;
};

const state = vi.hoisted(() => ({
  gradingError: false as boolean,
  gradingRows: [] as Array<{ status: string }>,
  conflicts: {} as Record<string, unknown>,
  queue: {} as Record<string, unknown>,
  drafts: {} as Record<string, unknown>,
  overview: {} as Record<string, unknown>,
  needsYou: {} as Record<string, unknown>,
  calls: {
    conflictsEnabled: [] as unknown[],
    overviewEnabled: [] as unknown[],
  },
}));

function q(o: Q) {
  return {
    data: o.data,
    isError: o.isError ?? false,
    error: o.error ?? null,
    isLoading: o.isLoading ?? false,
    isFetching: false,
    dataUpdatedAt: o.data ? Date.now() : 0,
    refetch: vi.fn(),
  };
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "order", "limit"]) {
        chain[m] = () => chain;
      }
      chain.then = (
        resolve: (v: unknown) => unknown,
        reject: (e: unknown) => unknown,
      ) =>
        Promise.resolve()
          .then(() =>
            state.gradingError
              ? { data: null, error: { message: "down" }, count: null }
              : { data: state.gradingRows, error: null, count: state.gradingRows.length }
          )
          .then(resolve, reject);
      return chain;
    },
  },
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (select: (s: { user: { id: string } }) => unknown) =>
    select({ user: { id: "u1" } }),
}));
vi.mock("@/hooks/use-needs-you", () => ({
  useNeedsYou: () => state.needsYou,
}));
vi.mock("@/hooks/use-sync-conflicts", () => ({
  useSyncConflicts: (enabled?: boolean) => {
    state.calls.conflictsEnabled.push(enabled);
    return state.conflicts;
  },
}));
vi.mock("@/hooks/use-extension-queue", () => ({
  useExtensionQueue: () => state.queue,
}));
vi.mock("@/hooks/use-autolister", () => ({
  useAutolisterDrafts: () => state.drafts,
}));
vi.mock("@/hooks/use-flipdesk-overview", () => ({
  useFlipdeskOverview: (_range: unknown, enabled?: boolean) => {
    state.calls.overviewEnabled.push(enabled);
    return state.overview;
  },
}));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

function cleanNeedsYou(over: Record<string, unknown> = {}) {
  return {
    items: [],
    queues: {},
    isLoading: false,
    isError: false,
    isPartial: false,
    isFetching: false,
    refetch: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.gradingError = false;
  state.gradingRows = [];
  state.conflicts = q({ data: { total: 0 } });
  state.queue = q({
    data: { pending: [], needsAttention: [], finishedNeedsReview: [] },
  });
  state.drafts = q({ data: { rows: [], truncated: false } });
  state.overview = q({ data: { agingCount: 0, staleCount: 0 } });
  state.needsYou = cleanNeedsYou();
  state.calls.conflictsEnabled = [];
  state.calls.overviewEnabled = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

async function render(surface: "grading" | "flipdesk") {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AttentionRail surface={surface} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("AttentionRail: a failed source is never All clear", () => {
  it("says All clear when every source answered zero", async () => {
    await render("flipdesk");
    expect(container.textContent).toContain("All clear");
    expect(container.textContent).not.toContain("Could not check");
  });

  it("shows Could not check plus Retry when the conflicts read fails", async () => {
    state.conflicts = q({ isError: true, error: Object.assign(new Error("x"), { status: 500 }) });
    await render("flipdesk");
    expect(container.textContent).toContain("Could not check 1 source");
    expect(container.textContent).toContain("Retry");
    expect(container.textContent).not.toContain("All clear");
  });

  it("treats a plan-gated conflicts read as not applicable", async () => {
    state.conflicts = q({ isError: true, error: Object.assign(new Error("x"), { status: 402 }) });
    await render("flipdesk");
    expect(container.textContent).toContain("All clear");
    expect(container.textContent).not.toContain("Could not check");
  });

  it("shows Could not check when the grading count read fails", async () => {
    state.gradingError = true;
    await render("grading");
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Could not check")
    );
    expect(container.textContent).not.toContain("All clear");
  });

  it("counts a partial eBay read as a source it could not check", async () => {
    state.needsYou = cleanNeedsYou({ isPartial: true });
    await render("flipdesk");
    expect(container.textContent).toContain("Could not check");
    expect(container.textContent).not.toContain("All clear");
  });

  it("wraps the chips in a polite live region", async () => {
    await render("flipdesk");
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
});

describe("AttentionRail: FlipDesk reads are gated off the grading view (DASH-6)", () => {
  it("disables the conflicts and overview reads on grading", async () => {
    await render("grading");
    expect(state.calls.conflictsEnabled.length).toBeGreaterThan(0);
    expect(state.calls.conflictsEnabled.every((e) => e === false)).toBe(true);
    expect(state.calls.overviewEnabled.every((e) => e === false)).toBe(true);
  });

  it("enables them on flipdesk", async () => {
    await render("flipdesk");
    expect(state.calls.conflictsEnabled.every((e) => e === true)).toBe(true);
    expect(state.calls.overviewEnabled.every((e) => e === true)).toBe(true);
  });

  it("Refresh invalidates the rail's own grading count", async () => {
    const spy = vi.spyOn(client, "invalidateQueries");
    await render("grading");
    const refresh = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Refresh")
    )!;
    await act(async () => refresh.click());
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey[0]);
    expect(keys).toContain("attention-rail-grading");
  });
});

describe("AttentionRail: grading and extension states (DASH-7)", () => {
  it("renders a truncated draft read as 500+", async () => {
    state.drafts = q({
      data: { rows: Array.from({ length: 500 }, (_, i) => ({ id: String(i) })), truncated: true },
    });
    await render("flipdesk");
    expect(container.textContent).toContain("500+");
  });

  it("tallies needs_photos from one grouped read and ranks it first", async () => {
    state.gradingRows = [
      { status: "pending_review" },
      { status: "needs_photos" },
      { status: "needs_photos" },
    ];
    await render("grading");
    await vi.waitFor(() => expect(container.textContent).toContain("need new photos"));
    const links = [...container.querySelectorAll("a")].map((a) => a.textContent);
    expect(links[0]).toContain("2");
    expect(links[0]).toContain("need new photos");
    expect(links[links.length - 1]).toContain("being finalized");
  });
});
