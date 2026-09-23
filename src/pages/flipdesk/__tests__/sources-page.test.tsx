// The Sources page: item counts come from one SQL aggregate (00831,
// source_item_counts), and the delete dialog names how many items will be
// unlinked from that same count.
//
// The page used to select source_id for every inventory row and count in the
// browser. Under any row cap that under-reports, and the delete dialog is the
// place an under-count does harm: the seller is told fewer items will lose
// their source than actually will.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: "member-1" } }),
}));

// A workspace member looking at the owner's sources: the count must be asked
// for the OWNER's workspace, not the member's own.
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ workspaceOwnerId: "owner-1", can: () => true }),
}));

vi.mock("@/hooks/use-sources", () => ({
  useSources: () => ({
    data: [
      { id: "src-goodwill", name: "Goodwill SE 14th", source_type: "thrift", location: null, notes: null },
      { id: "src-estate", name: "Estate sale", source_type: "estate_sale", location: null, notes: null },
    ],
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/components/flipdesk/sourcer-roster-card", () => ({
  SourcerRosterCard: () => null,
}));

const { FlipdeskSourcesPage } = await import("@/pages/flipdesk/sources");

// React only flushes effects under act() when this is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <FlipdeskSourcesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

function rowCount(name: string): string | undefined {
  const row = Array.from(host.querySelectorAll("tr")).find((tr) =>
    tr.textContent?.includes(name),
  );
  return row?.querySelectorAll("td")[3]?.textContent ?? undefined;
}

async function clickDelete(name: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="Delete ${name}"]`);
  expect(button, `no delete button for ${name}`).not.toBeNull();
  await act(async () => {
    button!.click();
  });
  await flush();
}

beforeEach(() => {
  mocks.rpc.mockReset().mockResolvedValue({
    // bigint may arrive as a string; the page must read either.
    data: [
      { source_id: "src-goodwill", item_count: 3 },
      { source_id: "src-estate", item_count: "1" },
    ],
    error: null,
  });
  mocks.from.mockReset().mockImplementation((table: string) => {
    throw new Error(`the page read ${table} directly`);
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("Sources page item counts", () => {
  it("asks the aggregate for the workspace owner's counts, and reads no inventory rows", async () => {
    await renderPage();
    expect(mocks.rpc).toHaveBeenCalledWith("source_item_counts", { p_user_id: "owner-1" });
    expect(mocks.from).not.toHaveBeenCalledWith("inventory_items");
    expect(rowCount("Goodwill SE 14th")).toBe("3");
    expect(rowCount("Estate sale")).toBe("1");
  });

  it("the delete dialog names how many items will be unlinked", async () => {
    await renderPage();
    await clickDelete("Goodwill SE 14th");
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog, "the delete dialog did not open").not.toBeNull();
    expect(dialog!.textContent).toContain("3 items will be unlinked");
  });

  it("uses the singular for one item", async () => {
    await renderPage();
    await clickDelete("Estate sale");
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog!.textContent).toContain("1 item will be unlinked");
  });

  it("warns about nothing when no item links to the source", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    await renderPage();
    expect(rowCount("Goodwill SE 14th")).toBe("0");
    await clickDelete("Goodwill SE 14th");
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog!.textContent).toContain('"Goodwill SE 14th" will be removed.');
    expect(dialog!.textContent).not.toContain("unlinked");
  });
});
