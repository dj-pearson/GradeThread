// Money M8: the photo board's session lifecycle. Adding photos waits for the
// saved board to load, Clear closes the saved session so a reload does not
// bring the photos back, and unmount revokes every preview URL the board holds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const db = vi.hoisted(() => ({
  restoreResult: { data: null as unknown, error: null as unknown },
  restoreGate: null as Promise<void> | null,
  updates: [] as { table: string; payload: unknown }[],
  inserts: [] as { table: string; payload: unknown }[],
}));

vi.mock("@/lib/supabase", () => {
  function chain(result: () => Promise<unknown>) {
    const self: Record<string, unknown> = {};
    for (const k of ["select", "eq", "in", "is", "order", "limit"]) self[k] = () => self;
    self.single = result;
    self.maybeSingle = result;
    self.then = (f: (v: unknown) => unknown) => result().then(f);
    return self;
  }
  return {
    supabase: {
      from: (table: string) => ({
        select: () =>
          chain(async () => {
            if (db.restoreGate) await db.restoreGate;
            return table === "flipdesk_reconcile_sessions"
              ? db.restoreResult
              : { data: [], error: null };
          }),
        insert: (payload: unknown) => {
          db.inserts.push({ table, payload });
          return chain(async () => ({ data: { id: "sess-1" }, error: null }));
        },
        update: (payload: unknown) => {
          db.updates.push({ table, payload });
          return chain(async () => ({ data: null, error: null }));
        },
      }),
      storage: {
        from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn/${p}` } }) }),
      },
    },
  };
});

vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ workspaceOwnerId: "u1", can: () => true }),
}));
vi.mock("@/hooks/use-sync-conflicts", () => ({
  useSyncConflicts: () => ({ data: undefined, isError: false }),
}));
vi.mock("@/hooks/use-ai-extract", () => {
  const m = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    useBulkExtract: m,
    useEmbedPhotos: m,
    useClassifyPhotos: m,
    useSuggestItemMatch: m,
  };
});
vi.mock("@/lib/exif", () => ({
  readCaptureTime: async () => new Date("2026-09-01T10:00:00Z"),
}));
vi.mock("@/components/flipdesk/ebay-sku-match", () => ({ EbaySkuMatch: () => null }));
vi.mock("@/components/flipdesk/cross-source-conflicts", () => ({
  CrossSourceConflicts: () => null,
}));
vi.mock("@/pages/flipdesk/reconciliation", () => ({
  ReconciliationPayoutsTab: () => null,
}));
vi.mock("@/components/help/help-link", () => ({ HelpLink: () => null }));

const { FlipdeskReconcilePage } = await import("@/pages/flipdesk/reconcile");
const { ConfirmProvider } = await import("@/components/ui/confirm-dialog");

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let blobN = 0;

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
      <MemoryRouter initialEntries={["/?tab=photos"]}>
        <QueryClientProvider client={client}>
          <ConfirmProvider>
            <FlipdeskReconcilePage />
          </ConfirmProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
}

async function addPhotos(n: number) {
  const input = container!.querySelector<HTMLInputElement>('input[type="file"]')!;
  const files = Array.from(
    { length: n },
    (_, i) => new File([new Uint8Array([1])], `p${i}.jpg`, { type: "image/jpeg" }),
  );
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

beforeEach(() => {
  db.restoreResult = { data: null, error: null };
  db.restoreGate = null;
  db.updates.length = 0;
  db.inserts.length = 0;
  blobN = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:preview-${++blobN}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe("reconcile photo board lifecycle", () => {
  it("keeps adding photos off until the saved board has loaded", async () => {
    let release!: () => void;
    db.restoreGate = new Promise<void>((r) => (release = r));
    await render();
    const input = container!.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.disabled).toBe(true);
    expect(document.body.textContent).toContain("Loading your saved board");
    await act(async () => release());
    await flush();
    expect(input.disabled).toBe(false);
  });

  it("revokes every preview URL on unmount", async () => {
    await render();
    await addPhotos(3);
    expect(document.body.textContent).toContain("3 photos");
    act(() => root?.unmount());
    root = null;
    const revoked = vi.mocked(URL.revokeObjectURL).mock.calls.map((c) => c[0]);
    expect(revoked.sort()).toEqual(["blob:preview-1", "blob:preview-2", "blob:preview-3"]);
  });

  it("Clear asks first, then closes the saved session so a reload is empty", async () => {
    await render();
    await addPhotos(2);
    expect(db.inserts.filter((i) => i.table === "flipdesk_reconcile_sessions")).toHaveLength(1);
    await act(async () => button("Clear")!.click());
    await flush();
    expect(document.body.textContent).toContain("Clear the board?");
    const confirmBtn = [...document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')].find(
      (b) => b.textContent?.trim() === "Clear",
    ) as HTMLButtonElement;
    await act(async () => confirmBtn.click());
    await flush();
    expect(db.updates).toContainEqual({
      table: "flipdesk_reconcile_sessions",
      payload: { status: "abandoned" },
    });
    expect(document.body.textContent).not.toContain("2 photos");
  });

  it("two quick drops share one session insert", async () => {
    await render();
    await Promise.all([addPhotos(1), addPhotos(1)]);
    expect(db.inserts.filter((i) => i.table === "flipdesk_reconcile_sessions")).toHaveLength(1);
  });
});
