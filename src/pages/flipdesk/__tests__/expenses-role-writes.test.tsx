// Money M11: a write RLS filtered out is an error, not a success toast; a role
// that cannot write sees no write buttons; and an expense write refreshes the
// books views that read it, not just the expense list.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  can: ((c: string) => c.length > 0) as (c: string) => boolean,
  deleteRows: [] as unknown[],
  success: vi.fn(),
  toastError: vi.fn(),
}));

const EXPENSE = {
  id: "e1",
  user_id: "u1",
  category: "shipping_supplies",
  description: "USPS postage",
  amount: 12.65,
  spent_on: "2026-08-11",
  created_at: "2026-08-11T15:00:00Z",
  updated_at: "2026-08-11T15:00:00Z",
  receipt_path: null,
  receipt_mime: null,
  receipt_uploaded_at: null,
  recurs_monthly: false,
  recurrence_source_id: null,
  account_id: null,
};

vi.mock("@/lib/supabase", () => {
  function chain(result: () => unknown) {
    const self: Record<string, unknown> = {};
    for (const k of ["select", "eq", "in", "is", "order", "limit", "gte", "lte"]) {
      self[k] = () => self;
    }
    // fetchAllPages stops on an empty page, so only the first page has rows.
    self.range = (from: number) =>
      Promise.resolve(from === 0 ? result() : { data: [], error: null });
    self.maybeSingle = () => Promise.resolve({ data: null, error: null });
    self.single = () => Promise.resolve({ data: null, error: null });
    self.then = (f: (v: unknown) => unknown) => Promise.resolve(result()).then(f);
    return self;
  }
  return {
    supabase: {
      from: (table: string) => ({
        select: () =>
          chain(() => ({ data: table === "flipdesk_expenses" ? [EXPENSE] : [], error: null })),
        delete: () => {
          const self: Record<string, unknown> = {};
          self.eq = () => self;
          self.select = () => Promise.resolve({ data: h.deleteRows, error: null });
          return self;
        },
      }),
      rpc: () => Promise.resolve({ data: null, error: null }),
      storage: { from: () => ({}) },
    },
  };
});

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: h.success,
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));
vi.mock("@/lib/toast-error", () => ({
  toastError: h.toastError,
  toastWarning: vi.fn(),
}));

vi.mock("@/stores/auth-store", () => {
  const s = { user: { id: "u1" } };
  const useAuthStore = (sel?: (x: typeof s) => unknown) => (sel ? sel(s) : s);
  useAuthStore.getState = () => s;
  return { useAuthStore };
});
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({
    workspaceOwnerId: "u1",
    can: (c: string) => h.can(c),
    isOwner: h.can("delete_inventory"),
    isPersonal: true,
  }),
}));
vi.mock("@/components/finances/statement-import-card", () => ({
  StatementImportCard: () => null,
}));
vi.mock("@/components/finances/receipt-split-card", () => ({
  ReceiptSplitCard: () => null,
}));

const { FlipdeskExpensesPage } = await import("@/pages/flipdesk/expenses");
const { ConfirmProvider } = await import("@/components/ui/confirm-dialog");
const { invalidateBooks } = await import("@/lib/ledger");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <ConfirmProvider>
            <FlipdeskExpensesPage />
          </ConfirmProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
}

beforeEach(() => {
  h.can = () => true;
  h.deleteRows = [];
  h.success.mockClear();
  h.toastError.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("expenses role-aware writes", () => {
  it("a zero-row delete is an error, not 'Expense deleted.'", async () => {
    await render();
    const del = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="Delete "]',
    );
    expect(del).not.toBeNull();
    await act(async () => del!.click());
    await flush();
    const confirmBtn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Delete expense",
    )!;
    await act(async () => confirmBtn.click());
    await flush();
    expect(h.success).not.toHaveBeenCalledWith("Expense deleted.");
    expect(h.toastError).toHaveBeenCalled();
    const err = h.toastError.mock.calls[0]![0] as Error;
    expect(err.message).toBe("You don't have permission to change this.");
  });

  it("a viewer sees no Add, Edit or Delete", async () => {
    h.can = () => false;
    await render();
    expect(document.body.textContent).toContain("USPS postage");
    expect(document.querySelector('button[aria-label^="Delete "]')).toBeNull();
    expect(document.querySelector('button[aria-label^="Edit "]')).toBeNull();
    const add = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add expense"),
    );
    expect(add).toBeUndefined();
  });

  it("a listing manager can edit but not delete", async () => {
    h.can = (c) => c === "manage_inventory";
    await render();
    expect(document.querySelector('button[aria-label^="Edit "]')).not.toBeNull();
    expect(document.querySelector('button[aria-label^="Delete "]')).toBeNull();
  });
});

describe("invalidateBooks", () => {
  it("refreshes the overhead, review and ledger reads with the expense list", async () => {
    const keys: unknown[] = [];
    await invalidateBooks({
      invalidateQueries: (f) => {
        keys.push(f.queryKey[0]);
        return Promise.resolve();
      },
    });
    expect(keys).toEqual(
      expect.arrayContaining([
        "expenses",
        "finances-overhead",
        "books-review",
        "books-review-count",
        "ledger-entries",
      ]),
    );
  });
});
