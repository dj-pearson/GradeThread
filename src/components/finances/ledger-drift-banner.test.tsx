import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LedgerDriftBanner } from "@/components/finances/ledger-drift-banner";

// money.md action 6. The RPC is mocked at the supabase client, so the real
// fetchLedgerReconciliation wrapper runs between it and the banner.

type Workspace = { ownerId: string };
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  ensure: vi.fn(async () => 1),
  workspaces: [] as Workspace[],
}));

vi.mock("@/lib/supabase", () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock("@/lib/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (select: (s: unknown) => unknown) =>
    select({ user: { id: "seller" }, workspaces: mocks.workspaces }),
}));
vi.mock("@/lib/ledger", async (original) => ({
  ...(await original<typeof import("@/lib/ledger")>()),
  ensureLedgerBuilt: mocks.ensure,
}));

const RECON = {
  dashboard_net_cents: 125000,
  ledger_sale_net_cents: 98000,
  variance_cents: -27000,
  agrees: false,
  overhead_cents: 0,
  true_net_cents: 98000,
  excluded_cents: 0,
  entry_count: 12,
};

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.workspaces = [{ ownerId: "seller" }];
  mocks.ensure.mockClear();
  mocks.rpc.mockReset().mockImplementation(async (fn: string) =>
    fn === "rebuild_my_ledger"
      ? { data: 40, error: null }
      : { data: RECON, error: null },
  );
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

async function render(periodEnd?: string) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LedgerDriftBanner periodStart="2026-01-01" periodEnd={periodEnd} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("LedgerDriftBanner", () => {
  it("tells the seller their books are out of date when the ledger disagrees", async () => {
    await render();
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Your books are out of date"),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("ledger_reconciliation", {
      p_period_start: "2026-01-01",
    });
    // It checks after the shared freshness build, not instead of it.
    expect(mocks.ensure).toHaveBeenCalled();
    expect(container.textContent).toContain("$1,250.00");
    expect(container.textContent).toContain("$980.00");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it("renders nothing when the ledger agrees", async () => {
    mocks.rpc.mockResolvedValue({ data: { ...RECON, agrees: true, variance_cents: 0 }, error: null });
    await render();
    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("renders nothing when the check fails to load", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    await render();
    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("does not run for a member of another seller's workspace", async () => {
    // finances_dashboard sees the owner's sales through RLS and the ledger
    // does not, so for a member the two never agree and a rebuild cannot help.
    mocks.workspaces = [{ ownerId: "seller" }, { ownerId: "someone-else" }];
    await render();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("rebuilds the ledger and re-checks from the button", async () => {
    await render();
    const button = await vi.waitFor(() => {
      const b = [...container.querySelectorAll("button")].find((x) =>
        x.textContent?.includes("Rebuild my books"),
      );
      expect(b).toBeTruthy();
      return b!;
    });
    mocks.rpc.mockImplementation(async (fn: string) =>
      fn === "rebuild_my_ledger"
        ? { data: 40, error: null }
        : { data: { ...RECON, agrees: true, variance_cents: 0 }, error: null },
    );
    await act(async () => button.click());
    await vi.waitFor(() => expect(container.textContent).toBe(""));
    expect(mocks.rpc).toHaveBeenCalledWith("rebuild_my_ledger");
  });
});

// ledger_reconciliation takes a start and no end: it always compares through
// today. The copy has to say so, and on a range that has already closed it has
// to say the check reaches past it. Placement (which period each page hands
// the banner) is rendered in src/pages/flipdesk/__tests__/ledger-drift-placement.test.tsx.
describe("LedgerDriftBanner copy for the period it cannot bound", () => {
  const PAST_NOTE = "covers sales after the period on screen";

  it("says the comparison runs through today", async () => {
    await render("2099-01-01");
    await vi.waitFor(() =>
      expect(container.textContent).toContain("through today"),
    );
    expect(container.textContent).not.toMatch(/^Since /m);
  });

  it("an open range gets no past-range note", async () => {
    await render("2099-01-01");
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Your books are out of date"),
    );
    expect(container.textContent).not.toContain(PAST_NOTE);
  });

  it("a range that ended in the past says the check reaches beyond it", async () => {
    await render("2025-04-01");
    await vi.waitFor(() => expect(container.textContent).toContain(PAST_NOTE));
  });

  it("a range ending today (exclusive) is already closed", async () => {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await render(today);
    await vi.waitFor(() => expect(container.textContent).toContain(PAST_NOTE));
  });
});
