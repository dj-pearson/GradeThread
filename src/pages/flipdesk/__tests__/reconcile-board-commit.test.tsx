// Money M12: the commit button counts photos as they save, and the commit
// spinner clears before photo-type classification finishes, which now runs
// after the commit with its own status line.

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
const ctl = vi.hoisted(() => ({
  classify: null as null | (() => Promise<unknown>),
  commitGate: null as Promise<void> | null,
}));
vi.mock("@/hooks/use-ai-extract", () => {
  const m = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    useBulkExtract: m,
    useEmbedPhotos: m,
    useClassifyPhotos: () => ({
      mutateAsync: () => (ctl.classify ? ctl.classify() : Promise.resolve()),
      isPending: false,
    }),
    useSuggestItemMatch: m,
  };
});
vi.mock("@/hooks/use-reconcile-commit", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-reconcile-commit")>()),
  commitClusters: async (
    clusters: Array<{ clusterId: string; label: string; photos: Array<{ id: string }> }>,
    _owner: string,
    _session: string | null,
    opts: { onProgress?: (p: unknown) => void } = {},
  ) => {
    const total = clusters.reduce((n, c) => n + c.photos.length, 0);
    opts.onProgress?.({ photosDone: 1, photosTotal: total, item: 1, items: clusters.length });
    if (ctl.commitGate) await ctl.commitGate;
    return clusters.map((c) => ({
      clusterId: c.clusterId,
      title: c.label,
      ok: true,
      detail: "saved",
      itemId: `item-${c.clusterId}`,
      saved: c.photos.length,
      skipped: 0,
      failed: 0,
      savedPhotoIds: c.photos.map((p) => p.id),
    }));
  },
}));
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

beforeEach(() => {
  db.restoreResult = { data: null, error: null };
  db.restoreGate = null;
  db.updates.length = 0;
  db.inserts.length = 0;
  blobN = 0;
  ctl.classify = null;
  ctl.commitGate = null;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:preview-${++blobN}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

const commitButton = () =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.includes("Commit ") || b.textContent?.includes("Saving "),
  ) as HTMLButtonElement | undefined;

describe("reconcile photo board commit", () => {
  it("shows an n-of-N count while saving", async () => {
    let release!: () => void;
    ctl.commitGate = new Promise<void>((r) => (release = r));
    await render();
    await addPhotos(2);
    await act(async () => commitButton()!.click());
    await flush();
    expect(commitButton()!.textContent).toContain("Saving 1 of 2 photos (item 1 of 1)");
    await act(async () => release());
    await flush();
  });

  it("clears the commit spinner before classification settles", async () => {
    let finishClassify!: () => void;
    ctl.classify = () => new Promise<void>((r) => (finishClassify = r));
    await render();
    await addPhotos(2);
    await act(async () => commitButton()!.click());
    await flush();
    // Everything committed, so the board is empty and the button gone; the
    // committed card carries the classification status instead.
    expect(document.body.textContent).not.toContain("Saving ");
    expect(document.body.textContent).toContain("Committed 1 item");
    expect(document.body.textContent).toContain("Sorting photo types for 1 item");
    await act(async () => finishClassify());
    await flush();
    expect(document.body.textContent).not.toContain("Sorting photo types");
  });
});
