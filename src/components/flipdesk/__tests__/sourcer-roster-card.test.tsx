// SRC-15: the roster card escapes LIKE wildcards, shows a failed load as a
// failure, and never shows "0 items" for a count it does not know.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escapeLikePattern } from "@/lib/utils";

const mocks = vi.hoisted(() => ({
  sourcers: {
    rows: [] as unknown[],
    sourcers: [] as unknown[],
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  },
  usage: { data: [] as unknown[] | null, error: null as unknown },
}));

vi.mock("@/hooks/use-sourcers", () => ({
  useSourcers: () => mocks.sourcers,
  useAddSourcer: () => vi.fn(),
}));
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ workspaceOwnerId: "owner-1", can: () => true }),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => Promise.resolve(mocks.usage),
      };
      return chain;
    },
  },
}));

const { SourcerRosterCard } = await import("@/components/flipdesk/sourcer-roster-card");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SourcerRosterCard />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const TIFF = { id: "s1", name: "Tiff", isYou: false, memberUserId: null };

beforeEach(() => {
  mocks.sourcers = {
    rows: [{ id: "s1", archived_at: null }],
    sourcers: [TIFF],
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  };
  mocks.usage = { data: [{ sourced_by: "Tiff" }, { sourced_by: "tiff " }], error: null };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("escapeLikePattern", () => {
  it("escapes the two wildcards and the escape character", () => {
    expect(escapeLikePattern("A_J%")).toBe("A\\_J\\%");
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
    expect(escapeLikePattern("Tiff")).toBe("Tiff");
  });
});

describe("SourcerRosterCard", () => {
  it("shows the counts when they load", async () => {
    await render();
    expect(host.textContent).toContain("2 items");
  });

  it("a failed roster load is a retry state, not the empty copy", async () => {
    mocks.sourcers = { ...mocks.sourcers, rows: [], sourcers: [], isError: true };
    await render();
    expect(host.textContent).toContain("Couldn't load the roster");
    expect(host.textContent).not.toContain("Nobody on the roster yet");
  });

  it("a failed usage count shows no row as 0 items and disables Archive", async () => {
    mocks.usage = { data: null, error: { message: "boom" } };
    await render();
    expect(host.textContent).not.toContain("0 items");
    const archive = host.querySelector<HTMLButtonElement>('button[aria-label="Archive Tiff"]');
    expect(archive?.disabled).toBe(true);
  });
});
