import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GradingAttentionWidget } from "@/components/dashboard/widgets/grading-attention";
import { orderAttentionRows } from "@/lib/dashboard-grading-queue";

// DASH-12: the longest stall first, with a count of the rest.

const rows = vi.hoisted(() => ({
  data: [] as Array<{ id: string; title: string; status: string; updated_at: string }>,
  count: 0,
  order: null as null | { col: string; ascending: boolean },
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "is", "in", "limit"]) chain[m] = () => chain;
      chain.order = (col: string, opts: { ascending: boolean }) => {
        rows.order = { col, ascending: opts.ascending };
        return chain;
      };
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows.data, error: null, count: rows.count }).then(resolve);
      return chain;
    },
  },
}));

const day = (n: number) => new Date(Date.UTC(2026, 8, n)).toISOString();

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

describe("orderAttentionRows", () => {
  it("ranks by status priority and keeps the oldest first inside a status", () => {
    const ordered = orderAttentionRows([
      { id: "r1", status: "pending_review" },
      { id: "f1", status: "failed" },
      { id: "d1", status: "disputed" },
      { id: "d2", status: "disputed" },
      { id: "n1", status: "needs_photos" },
    ]);
    expect(ordered.map((r) => r.id)).toEqual(["d1", "d2", "n1", "f1", "r1"]);
  });
});

describe("GradingAttentionWidget", () => {
  it("shows the oldest disputed row first and '+2 more' for seven rows", async () => {
    // Oldest first, as the query asks for.
    rows.data = [
      { id: "a", title: "Review A", status: "pending_review", updated_at: day(1) },
      { id: "b", title: "Failed B", status: "failed", updated_at: day(2) },
      { id: "c", title: "Disputed old", status: "disputed", updated_at: day(3) },
      { id: "d", title: "Photos D", status: "needs_photos", updated_at: day(4) },
      { id: "e", title: "Disputed new", status: "disputed", updated_at: day(5) },
      { id: "f", title: "Review F", status: "pending_review", updated_at: day(6) },
      { id: "g", title: "Review G", status: "pending_review", updated_at: day(7) },
    ];
    rows.count = 7;
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <GradingAttentionWidget />
          </MemoryRouter>
        </QueryClientProvider>,
      )
    );
    await vi.waitFor(() => expect(container.querySelectorAll("li").length).toBe(5));
    const titles = [...container.querySelectorAll("li")].map((li) => li.textContent);
    expect(titles[0]).toContain("Disputed old");
    expect(titles[1]).toContain("Disputed new");
    expect(container.textContent).toContain("+2 more");
    const more = [...container.querySelectorAll("a")].find((a) => a.textContent === "+2 more")!;
    expect(more.getAttribute("href")).toBe("/dashboard/submissions?status=pending_review");
    expect(rows.order).toEqual({ col: "updated_at", ascending: true });
  });
});
