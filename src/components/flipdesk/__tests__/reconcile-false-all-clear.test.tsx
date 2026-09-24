// Money M4: on the Reconcile view a failed or plan-gated read must never render
// as a clean result. Each card here used to fall through to its empty-success
// copy ("All payouts are reconciled", "FlipDesk, eBay, and Sheets agree", "No
// payouts in the last 90 days", "No syncs yet") when its query rejected, and a
// failed items read in eBay SKU match armed "Create all" over the whole catalog.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function q(over: Record<string, unknown> = {}) {
  return {
    data: undefined as unknown,
    isError: false,
    isSuccess: false,
    isLoading: false,
    isFetching: false,
    error: null as unknown,
    refetch: vi.fn(),
    ...over,
  };
}

const ws = vi.hoisted(() => ({ canManage: true }));

const state = {
  conflicts: q(),
  syncRuns: q(),
  payouts: q(),
  items: q(),
};

const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });

vi.mock("@/lib/supabase", () => {
  const rows = [
    {
      id: "l1",
      user_id: "u1",
      title: "Levi's 501",
      custom_label: "SKU-1",
      match_status: "unmatched",
      imported_at: "2026-09-01T00:00:00Z",
    },
  ];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "range", "limit", "in", "is"]) {
    builder[m] = () => builder;
  }
  builder.then = (resolve: (v: unknown) => void) =>
    resolve({ data: rows, error: null });
  return { supabase: { from: () => builder } };
});

vi.mock("@/stores/auth-store", () => {
  const s = { user: { id: "u1" } };
  const useAuthStore = (sel?: (x: typeof s) => unknown) => (sel ? sel(s) : s);
  useAuthStore.getState = () => s;
  return { useAuthStore };
});

vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({
    workspaceOwnerId: "u1",
    activeWorkspaceOwnerId: null,
    can: () => ws.canManage,
    isOwner: ws.canManage,
    isPersonal: true,
  }),
}));

vi.mock("@/hooks/use-plan-usage", () => ({
  usePlanUsage: () => ({ plan: "free" }),
}));

vi.mock("@/hooks/use-sync-conflicts", () => ({
  useSyncConflicts: () => state.conflicts,
  useResolveConflicts: mutation,
  useConflictThreshold: () => q({ data: null, isSuccess: true }),
  useSetConflictThreshold: mutation,
}));

vi.mock("@/hooks/use-payouts", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-payouts")>()),
  useReconciliationMatch: mutation,
  useReconciliationDismiss: mutation,
  useReconciliationRun: mutation,
}));

vi.mock("@/hooks/use-ebay", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-ebay")>()),
  useEbaySyncRuns: () => state.syncRuns,
  useSyncEbayListings: mutation,
  useEbayConnection: () => ({ data: { id: "c1" } }),
  useEbayPayouts: () => state.payouts,
}));

vi.mock("@/hooks/use-payout-breakdown", () => ({
  usePayoutBreakdown: () => q(),
}));

vi.mock("@/hooks/use-items-full", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-items-full")>()),
  useItemsList: () => state.items,
}));

const { CrossSourceConflicts } = await import(
  "@/components/flipdesk/cross-source-conflicts"
);
const { EbayPayoutsCard } = await import("@/components/flipdesk/ebay-payouts-card");
const { ReviewQueueCard, SyncHistoryCard } = await import(
  "@/pages/flipdesk/reconciliation"
);
const { EbaySkuMatch } = await import("@/components/flipdesk/ebay-sku-match");
const { ConfirmProvider } = await import("@/components/ui/confirm-dialog");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <QueryClientProvider client={client}>
        <ConfirmProvider>{node}</ConfirmProvider>
      </QueryClientProvider>,
    );
  });
  // Let the internal eBay listings query settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const text = () => document.body.textContent ?? "";
const gate = (status: number) =>
  Object.assign(new Error("Business plan required"), { status });

beforeEach(() => {
  ws.canManage = true;
  state.conflicts = q();
  state.syncRuns = q();
  state.payouts = q();
  state.items = q({ data: [], isSuccess: true });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function queueProps(error: unknown) {
  return {
    queue: [],
    loading: false,
    error,
    onRetry: vi.fn(),
    retrying: false,
    total: 0,
    hasMore: false,
    limit: 50,
  };
}

describe("ReviewQueueCard", () => {
  it("a rejected queue read is an error, not 'All payouts are reconciled'", async () => {
    const props = queueProps(Object.assign(new Error("boom"), { status: 500 }));
    await render(<ReviewQueueCard {...props} />);
    expect(text()).not.toContain("All payouts are reconciled");
    expect(text()).toContain("not a clean bill of health");
  });

  it("a 402 shows the upgrade prompt", async () => {
    await render(<ReviewQueueCard {...queueProps(gate(402))} />);
    expect(text()).not.toContain("All payouts are reconciled");
    expect(text()).toContain("Business plan");
    expect(text()).toContain("See plans");
  });

  it("an empty successful read still says all clear", async () => {
    await render(<ReviewQueueCard {...queueProps(null)} />);
    expect(text()).toContain("All payouts are reconciled");
  });
});

describe("CrossSourceConflicts", () => {
  it("a rejected read does not say the sources agree", async () => {
    state.conflicts = q({ isError: true, error: new Error("boom") });
    await render(<CrossSourceConflicts />);
    expect(text()).not.toContain("No open conflicts");
    expect(text()).toContain("Couldn't load conflicts");
  });

  it("a 403 shows the upgrade prompt", async () => {
    state.conflicts = q({ isError: true, error: gate(403) });
    await render(<CrossSourceConflicts />);
    expect(text()).not.toContain("No open conflicts");
    expect(text()).toContain("See plans");
  });

  it("an empty successful read says they agree", async () => {
    state.conflicts = q({
      data: { conflicts: [], total: 0, showing: 0, has_more: false },
      isSuccess: true,
    });
    await render(<CrossSourceConflicts />);
    expect(text()).toContain("No open conflicts");
  });
});

describe("EbayPayoutsCard", () => {
  it("a rejected read does not say no payouts arrived", async () => {
    state.payouts = q({ isError: true, error: new Error("boom") });
    await render(<EbayPayoutsCard />);
    expect(text()).not.toContain("No payouts in the last 90 days");
    expect(text()).toContain("Couldn't load your eBay payouts");
  });
});

describe("SyncHistoryCard", () => {
  it("a rejected read does not say no syncs have run", async () => {
    state.syncRuns = q({ isError: true, error: new Error("boom") });
    await render(<SyncHistoryCard />);
    expect(text()).not.toContain("No syncs yet");
    expect(text()).toContain("Couldn't load sync history");
  });
});

describe("EbaySkuMatch", () => {
  const createAll = () =>
    [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Create all"),
    );

  it("a failed items read shows an error and no Create all", async () => {
    state.items = q({ isError: true, error: new Error("boom") });
    await render(<EbaySkuMatch />);
    expect(text()).toContain("Couldn't load the SKU check");
    expect(createAll()).toBeUndefined();
  });

  it("a good items read with an orphan offers Create all", async () => {
    await render(<EbaySkuMatch />);
    const btn = createAll();
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(false);
  });

  it("Create all is disabled while the items read is refetching", async () => {
    state.items = q({ data: [], isSuccess: true, isFetching: true });
    await render(<EbaySkuMatch />);
    expect(createAll()?.disabled).toBe(true);
  });

  it("a viewer (Money M11) sees the check but no write buttons", async () => {
    ws.canManage = false;
    await render(<EbaySkuMatch />);
    expect(text()).toContain("Levi's 501");
    for (const label of ["Create all", "Create", "Link", "Ignore", "Upload eBay CSV", "Clear imported data"]) {
      const found = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim().startsWith(label),
      );
      expect(found, label).toBeUndefined();
    }
  });
});
