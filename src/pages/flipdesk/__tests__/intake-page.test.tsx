// The Add item page, rendered inside a DATA router so the real navigation
// guard (useBlocker) runs. Each describe covers one behavior of the form.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useNavigate } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueIntake: vi.fn(),
  enqueuePhotosForItem: vi.fn(),
  refresh: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  uploadItemPhoto: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  lookup: vi.fn(),
  lookupPending: false,
  extract: vi.fn(),
  can: vi.fn((perm: string) => perm.length > 0),
  ownerId: "owner-1" as string | null,
  reviewFlow: { enabled: false, isLoading: false, chosen: false },
  useSources: vi.fn(() => ({ data: [] as Array<{ id: string; name: string }> })),
  aiPanelProps: null as null | Record<string, unknown>,
  today: "2026-09-24",
  setReviewFlow: vi.fn(),
  scannerProps: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/supabase", () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }));
vi.mock("@/lib/offline-queue", () => ({
  enqueueIntake: mocks.enqueueIntake,
  enqueuePhotosForItem: mocks.enqueuePhotosForItem,
}));
vi.mock("@/lib/item-photo-upload", async (orig) => ({
  ...(await orig<typeof import("@/lib/item-photo-upload")>()),
  uploadItemPhoto: mocks.uploadItemPhoto,
}));
vi.mock("@/hooks/use-offline-intake", () => ({
  useOfflineIntakeStatus: () => ({ pending: 0, photosPending: 0, online: true, refresh: mocks.refresh }),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
    info: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
  }),
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: "member-1" } }),
}));
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ workspaceOwnerId: mocks.ownerId, can: mocks.can }),
}));
vi.mock("@/hooks/use-sku-sequence", () => ({
  SKU_SEQUENCE_KEY: "sku_sequence",
  SKU_PREVIEW_KEY: "sku_preview",
  useSkuSequence: () => ({ nextSku: null, isEnabled: false }),
}));
vi.mock("@/hooks/use-sources", () => ({ useSources: () => mocks.useSources() }));
vi.mock("@/hooks/use-ai-extract", () => ({
  useAiExtract: () => ({ mutateAsync: mocks.extract, isPending: false }),
}));
vi.mock("@/hooks/use-product-lookup", () => ({
  useProductLookup: () => ({ mutateAsync: mocks.lookup, isPending: mocks.lookupPending }),
}));
vi.mock("@/hooks/use-review-flow", () => ({
  useReviewFlowEnabled: () => mocks.reviewFlow,
  useSetReviewFlow: () => ({ mutate: mocks.setReviewFlow, isPending: false }),
}));
vi.mock("@/lib/local-date", async (orig) => ({
  ...(await orig<typeof import("@/lib/local-date")>()),
  todayLocalDate: () => mocks.today,
}));
vi.mock("@/components/flipdesk/sourced-by-select", () => ({ SourcedBySelect: () => null }));
vi.mock("@/components/flipdesk/sku-auto-hint", () => ({ SkuAutoHint: () => null }));
vi.mock("@/components/flipdesk/bulk-intake", () => ({
  BulkIntake: () => {
    const navigate = useNavigate();
    return (
      <button type="button" onClick={() => navigate("/dashboard/flipdesk/items")}>
        bulk back
      </button>
    );
  },
}));
vi.mock("@/components/flipdesk/snap-catalog", () => ({ SnapCatalog: () => null }));
vi.mock("@/components/flipdesk/pwa-install-banner", () => ({ PwaInstallBanner: () => null }));
vi.mock("@/components/flipdesk/ai-fill-panel", () => ({
  AiFillPanel: (props: Record<string, unknown>) => {
    mocks.aiPanelProps = props;
    return null;
  },
}));
vi.mock("@/components/flipdesk/barcode-scanner-dialog", () => ({
  BarcodeScannerDialog: (props: Record<string, unknown>) => {
    mocks.scannerProps = props;
    return null;
  },
}));
vi.mock("@/components/flipdesk/grade-roi-hint", () => ({ GradeRoiHint: () => null }));
vi.mock("@/components/flipdesk/measurement-form", () => ({ MeasurementForm: () => null }));
vi.mock("@/components/help/page-help", () => ({ PageHelp: () => null }));
vi.mock("@/components/flipdesk/intake-photo-stager", () => ({
  IntakePhotoStager: ({
    photos,
    onChange,
  }: {
    photos: unknown[];
    onChange: (next: unknown[]) => void;
  }) => (
    <>
      <button
        type="button"
        data-staged={photos.length}
        onClick={() =>
          onChange([
            {
              id: "s1",
              file: new File(["f"], "front.jpg", { type: "image/jpeg" }),
              previewUrl: "",
              photoType: "front",
              photoRole: null,
            },
          ])
        }
      >
        stage photos
      </button>
      <button
        type="button"
        onClick={() =>
          onChange(
            (["tag", "front", "back", "detail"] as const).map((t, i) => ({
              id: `p${i}`,
              file: new File([t], `${t}.jpg`, { type: "image/jpeg" }),
              previewUrl: "",
              photoType: t,
              photoRole: null,
              photoId: `00000000-0000-4000-8000-00000000000${i}`,
            })),
          )
        }
      >
        stage four
      </button>
    </>
  ),
}));

const { FlipdeskIntakePage } = await import("@/pages/flipdesk/intake");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function renderPage(entry = "/dashboard/flipdesk/intake") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  router = createMemoryRouter(
    [
      { path: "/dashboard/flipdesk/intake", element: <FlipdeskIntakePage /> },
      { path: "/dashboard/flipdesk/items", element: <p>ITEMS PAGE</p> },
      { path: "*", element: <p>ELSEWHERE</p> },
    ],
    { initialEntries: [entry] },
  );
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  await flush();
}

async function go(to: string) {
  await act(async () => {
    await router.navigate(to);
  });
  await flush();
}

/** supabase.from("inventory_items").insert().select().abortSignal().single() */
function insertChain(result: () => Promise<unknown>) {
  const insert = vi.fn();
  mocks.from.mockImplementation(() => ({
    insert: (row: unknown) => {
      insert(row);
      const chain = {
        select: () => chain,
        abortSignal: () => chain,
        single: result,
      };
      return chain;
    },
  }));
  return insert;
}

function titleInput(): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(
    'input[placeholder="e.g. Lululemon Align Pant"]',
  );
  expect(input, "no title input").not.toBeNull();
  return input!;
}

async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const typeTitle = (v: string) => typeInto(titleInput(), v);

function button(text: string): HTMLButtonElement {
  const b = Array.from(host.querySelectorAll("button")).find(
    (x) => x.textContent?.trim() === text,
  );
  expect(b, `no button "${text}"`).toBeTruthy();
  return b!;
}

async function openScanner() {
  const b = host.querySelector<HTMLButtonElement>('button[aria-label="Scan barcode or UPC"]')!;
  await act(async () => b.click());
  await flush();
  expect(mocks.scannerProps, "scanner did not load").not.toBeNull();
}

async function click(text: string) {
  const b = button(text);
  await act(async () => {
    b.click();
  });
  await flush();
}

beforeEach(() => {
  for (const m of [
    mocks.enqueueIntake,
    mocks.refresh,
    mocks.from,
    mocks.rpc,
    mocks.uploadItemPhoto,
    mocks.toastSuccess,
    mocks.toastError,
    mocks.toastWarning,
    mocks.lookup,
    mocks.extract,
    mocks.enqueuePhotosForItem,
  ])
    m.mockReset();
  mocks.can.mockReset().mockReturnValue(true);
  mocks.ownerId = "owner-1";
  mocks.lookupPending = false;
  mocks.today = "2026-09-24";
  mocks.setReviewFlow.mockReset();
  mocks.aiPanelProps = null;
  mocks.scannerProps = null;
  mocks.reviewFlow = { enabled: false, isLoading: false, chosen: false };
  mocks.useSources.mockReset().mockReturnValue({ data: [] });
  mocks.enqueueIntake.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("the leave guard and the mode tabs", () => {
  it("does not block a mode switch, keeps the draft, and lets Bulk's back arrow leave", async () => {
    await renderPage();
    await typeTitle("Wool coat");
    await click("stage photos");
    expect(host.textContent).toContain("Your draft stays here while you switch.");

    await go("/dashboard/flipdesk/intake?mode=bulk");
    expect(host.textContent).toContain("bulk back");
    expect(host.textContent).not.toContain("Leave without saving?");

    await go("/dashboard/flipdesk/intake");
    expect(titleInput().value).toBe("Wool coat");

    await go("/dashboard/flipdesk/intake?mode=bulk");
    await click("bulk back");
    expect(host.textContent).toContain("ITEMS PAGE");
  });

  it("still asks before a dirty single form leaves the page", async () => {
    await renderPage();
    await typeTitle("Wool coat");
    await go("/dashboard/flipdesk/items");
    expect(document.body.textContent).toContain("Leave without saving?");
    expect(host.textContent).not.toContain("ITEMS PAGE");
  });
});

describe("a save on weak signal", () => {
  it("queues the item under its draft id when the insert fails to fetch", async () => {
    const insert = insertChain(() => Promise.reject(new TypeError("Failed to fetch")));
    await renderPage();
    await typeTitle("Wool coat");
    await click("stage photos");
    await click("Save & Add another");

    expect(insert).toHaveBeenCalledTimes(1);
    const draftId = (insert.mock.calls[0]![0] as { id: string }).id;
    expect(draftId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.enqueueIntake).toHaveBeenCalledTimes(1);
    const [row, extras] = mocks.enqueueIntake.mock.calls[0]! as [
      { id: string },
      { id: string; queuedBy: string; photos: unknown[] },
    ];
    expect(extras.id).toBe(draftId);
    expect(row.id).toBe(draftId);
    expect(extras.queuedBy).toBe("member-1");
    expect(extras.photos).toHaveLength(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Weak signal. Saved to your queue. It will sync on its own.",
    );
    expect(titleInput().value).toBe("");
  });

  it("treats a primary-key 23505 as saved", async () => {
    insertChain(() =>
      Promise.resolve({
        data: null,
        error: {
          code: "23505",
          message: 'duplicate key value violates unique constraint "inventory_items_pkey"',
        },
      }),
    );
    await renderPage();
    await typeTitle("Wool coat");
    await click("Save & Add another");
    expect(mocks.enqueueIntake).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Added "Wool coat".');
  });

  it("gives the next item a new draft id", async () => {
    const insert = insertChain(() => Promise.resolve({ data: { id: "x" }, error: null }));
    await renderPage();
    await typeTitle("One");
    await click("Save & Add another");
    await typeTitle("Two");
    await click("Save & Add another");
    const ids = insert.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("save errors in plain words", () => {
  const raw = [
    { code: "23505", message: 'duplicate key value violates unique constraint "idx_inventory_items_user_sku"' },
    { code: "23514", message: 'new row violates check constraint "inventory_items_acquired_price_nonneg"' },
  ];
  for (const error of raw) {
    it(`never shows the raw text for ${error.code}`, async () => {
      insertChain(() => Promise.resolve({ data: null, error }));
      await renderPage();
      await typeTitle("Wool coat");
      await typeInto(host.querySelector<HTMLInputElement>("#sku-input")!, "A1");
      await click("Save & Add another");
      const shown = JSON.stringify(mocks.toastError.mock.calls) + host.textContent;
      expect(shown).not.toContain(error.message);
      expect(shown).not.toContain("constraint");
    });
  }

  it("says a SKU clash next to the SKU box and focuses it", async () => {
    insertChain(() => Promise.resolve({ data: null, error: raw[0] }));
    await renderPage();
    await typeTitle("Wool coat");
    const sku = host.querySelector<HTMLInputElement>("#sku-input")!;
    await typeInto(sku, "A1");
    await click("Save & Add another");
    expect(host.textContent).toContain(
      "You already have an item with SKU A1. Change it or leave it blank.",
    );
    expect(document.activeElement).toBe(sku);
  });

  it("refuses a bad price inline, focuses it, and does not save", async () => {
    const insert = insertChain(() => Promise.resolve({ data: { id: "x" }, error: null }));
    await renderPage();
    await typeTitle("Wool coat");
    const price = host.querySelector<HTMLInputElement>('input[placeholder="0.00"]')!;
    await typeInto(price, "-5");
    await click("Save & Add another");
    expect(insert).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Price can't be negative.");
    expect(price.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(price);
  });

  it("puts a missing title next to the Title box and focuses it", async () => {
    await renderPage();
    await click("Save & Add another");
    expect(host.textContent).toContain("Add a title to save this item.");
    expect(document.activeElement).toBe(titleInput());
  });
});

describe("barcode lookup", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }
  const found = {
    found: true,
    sku: "",
    brand: "Patagonia",
    style: "Better Sweater",
    productTitle: "Patagonia Better Sweater",
  };

  it("does not land on the next item after Save & add another", async () => {
    insertChain(() => Promise.resolve({ data: { id: "x" }, error: null }));
    const pending = deferred<typeof found>();
    mocks.lookup.mockReturnValue(pending.promise);
    await renderPage();
    await typeTitle("First coat");
    await openScanner();
    await act(async () => {
      void (mocks.scannerProps!.onDetected as (c: string) => Promise<void>)("ABC-123");
    });
    await click("Save & Add another");
    expect(titleInput().value).toBe("");

    await act(async () => pending.resolve(found));
    await flush();
    expect(titleInput().value).toBe("");
    expect(host.querySelector<HTMLInputElement>("#sku-input")!.value).toBe("");
  });

  it("keeps a typed SKU", async () => {
    mocks.lookup.mockResolvedValue({ ...found, sku: "UPC-1" });
    await renderPage();
    const sku = host.querySelector<HTMLInputElement>("#sku-input")!;
    await typeInto(sku, "MY-SKU");
    await openScanner();
    await act(async () => {
      await (mocks.scannerProps!.onDetected as (c: string) => Promise<void>)("012345678905");
    });
    await flush();
    expect(sku.value).toBe("MY-SKU");
    expect(titleInput().value).toBe("Patagonia Better Sweater");
  });

  it("fills a blank SKU with the code", async () => {
    mocks.lookup.mockResolvedValue({ ...found, found: false, brand: "", style: "", productTitle: "" });
    await renderPage();
    await openScanner();
    await act(async () => {
      await (mocks.scannerProps!.onDetected as (c: string) => Promise<void>)("ABC-123");
    });
    await flush();
    expect(host.querySelector<HTMLInputElement>("#sku-input")!.value).toBe("ABC-123");
  });
});

describe("AI review panel on intake", () => {
  it("writes an accepted description and does not save a garment_type left off", async () => {
    const insert = insertChain(() => Promise.resolve({ data: { id: "x" }, error: null }));
    mocks.extract.mockResolvedValue({
      suggestions: {
        description: { value: "Soft wool coat.", confidence: 0.9, source: "text" },
        garment_type: { value: "dress", confidence: 0.9, source: "text" },
      },
      conflicts: [],
    });
    await renderPage();
    await typeTitle("Wool coat");
    await click("AI Fill");
    const props = mocks.aiPanelProps!;
    expect(props.applicableFields).toContain("description");
    expect(props.applicableFields).toContain("garment_type");
    await act(async () => {
      (props.onApply as (a: unknown[]) => void)([
        { field: "description", value: "Soft wool coat.", source: "text", confidence: 0.9 },
      ]);
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Applied 1 AI suggestion.");
    const desc = host.querySelector<HTMLTextAreaElement>("#i-description-public-for-listing")!;
    expect(desc.value).toBe("Soft wool coat.");

    await click("Save & Add another");
    const row = insert.mock.calls[0]![0] as { description: string; garment_type: string | null };
    expect(row.description).toBe("Soft wool coat.");
    expect(row.garment_type).not.toBe("dress");
  });
});

describe("photo uploads after an online save", () => {
  it("runs at most three at once, keeps canonical order, and queues a photo that fails twice", async () => {
    const insert = insertChain(() => Promise.resolve({ data: { id: "x" }, error: null }));
    mocks.enqueuePhotosForItem.mockResolvedValue(undefined);
    let active = 0;
    let peak = 0;
    const calls: Array<{ photoType: string; sortOrder: number }> = [];
    mocks.uploadItemPhoto.mockImplementation(async (input: { photoType: string; sortOrder: number }) => {
      calls.push(input);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (input.photoType === "front") throw new Error("503 from storage");
      return { macro: { ok: true } };
    });
    await renderPage();
    await typeTitle("Wool coat");
    await click("stage four");
    await click("Save & Add another");
    for (let i = 0; i < 5; i++) await flush();

    expect(peak).toBeLessThanOrEqual(3);
    const order = Object.fromEntries(calls.map((c) => [c.photoType, c.sortOrder]));
    expect(order.front).toBe(0);
    expect(order.front).toBeLessThan(order.back!);
    expect(order.back).toBeLessThan(order.tag!);
    // front failed, was retried once, then queued.
    expect(calls.filter((c) => c.photoType === "front")).toHaveLength(2);
    const draftId = (insert.mock.calls[0]![0] as { id: string }).id;
    expect(mocks.enqueuePhotosForItem).toHaveBeenCalledTimes(1);
    const arg = mocks.enqueuePhotosForItem.mock.calls[0]![0] as {
      itemId: string;
      photos: Array<{ photoType: string; sortOrder: number; id: string }>;
    };
    expect(arg.itemId).toBe(draftId);
    expect(arg.photos).toEqual([
      expect.objectContaining({ photoType: "front", sortOrder: 0, id: "00000000-0000-4000-8000-000000000001" }),
    ]);
    expect(mocks.toastWarning).not.toHaveBeenCalled();
  });
});

describe("small state bugs", () => {
  const dateInput = () => host.querySelector<HTMLInputElement>('input[type="date"]')!;

  it("a reset after midnight shows the new day", async () => {
    insertChain(() => Promise.resolve({ data: { id: "x" }, error: null }));
    await renderPage();
    expect(dateInput().value).toBe("2026-09-24");
    mocks.today = "2026-09-25";
    await typeTitle("One");
    await click("Save & Add another");
    expect(dateInput().value).toBe("2026-09-25");
  });

  it("keeps a date the seller changed", async () => {
    insertChain(() => Promise.resolve({ data: { id: "x" }, error: null }));
    await renderPage();
    await typeInto(dateInput(), "2026-09-01");
    mocks.today = "2026-09-25";
    await typeTitle("One");
    await click("Save & Add another");
    expect(dateInput().value).toBe("2026-09-01");
  });

  it("an untouched form after a reset is not a draft", async () => {
    insertChain(() => Promise.resolve({ data: { id: "x" }, error: null }));
    await renderPage();
    await typeTitle("One");
    await click("Save & Add another");
    expect(host.textContent).not.toContain("Your draft stays here while you switch.");
  });

  it("hides the review-flow banner once the seller has chosen, and Not now stores false", async () => {
    mocks.reviewFlow = { enabled: false, isLoading: false, chosen: true };
    await renderPage();
    expect(host.textContent).not.toContain("Try the new flow");
    act(() => root.unmount());
    root = createRoot(host);
    mocks.reviewFlow = { enabled: false, isLoading: false, chosen: false };
    await renderPage();
    expect(host.textContent).toContain("Try the new flow");
    await click("Not now");
    expect(mocks.setReviewFlow).toHaveBeenCalledWith(false, expect.anything());
  });
});

describe("the mode router", () => {
  it("opened straight into Bulk, never runs the single form's hooks", async () => {
    await renderPage("/dashboard/flipdesk/intake?mode=bulk");
    expect(host.textContent).toContain("bulk back");
    expect(mocks.useSources).not.toHaveBeenCalled();
    expect(host.querySelector('input[placeholder="e.g. Lululemon Align Pant"]')).toBeNull();
  });

  it("drops a clean single form when switching modes", async () => {
    await renderPage();
    expect(mocks.useSources).toHaveBeenCalled();
    await go("/dashboard/flipdesk/intake?mode=bulk");
    expect(host.querySelector('input[placeholder="e.g. Lululemon Align Pant"]')).toBeNull();
  });
});

describe("keyboard-first form", () => {
  async function pressEnter(el: HTMLElement, mods: KeyboardEventInit = {}) {
    await act(async () => {
      el.focus();
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...mods }));
    });
    await flush();
  }

  it("Enter in Title saves and returns focus to an empty Title", async () => {
    const insert = insertChain(() => Promise.resolve({ data: { id: "x" }, error: null }));
    await renderPage();
    await typeTitle("Wool coat");
    await pressEnter(titleInput());
    expect(insert).toHaveBeenCalledTimes(1);
    expect(titleInput().value).toBe("");
    expect(document.activeElement).toBe(titleInput());
  });

  it("Enter in a textarea is a newline, not a save", async () => {
    const insert = insertChain(() => Promise.resolve({ data: { id: "x" }, error: null }));
    await renderPage();
    await typeTitle("Wool coat");
    await pressEnter(host.querySelector<HTMLTextAreaElement>("#intake-condition-notes")!);
    expect(insert).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter runs the primary save", async () => {
    const insert = insertChain(() => Promise.resolve({ data: { id: "x" }, error: null }));
    await renderPage();
    await typeTitle("Wool coat");
    await pressEnter(host.querySelector<HTMLTextAreaElement>("#intake-condition-notes")!, { ctrlKey: true });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("ITEMS PAGE");
  });

  it("the Category label points at its trigger", async () => {
    await renderPage();
    const label = Array.from(host.querySelectorAll("label")).find((l) => l.textContent?.startsWith("Category"))!;
    const target = document.getElementById(label.htmlFor);
    expect(target?.getAttribute("role")).toBe("combobox");
  });

  it("names the primary button after where it goes", async () => {
    mocks.reviewFlow = { enabled: true, isLoading: false, chosen: true };
    await renderPage();
    expect(button("Save & review")).toBeTruthy();
  });

  it("a viewer sees Save disabled and a one-line notice", async () => {
    mocks.can.mockImplementation((perm: string) => perm !== "manage_inventory");
    await renderPage();
    expect(button("Save & Add another").disabled).toBe(true);
    expect(button("Save & view items").disabled).toBe(true);
    expect(host.textContent).toContain("You can view this workspace but not add items to it.");
  });

  it("shows a spinner, not a sign-in error, while the workspace resolves", async () => {
    mocks.ownerId = null;
    await renderPage();
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(host.textContent).not.toContain("You must be signed in");
  });

  it("keeps a source created by this save selected for the next item", async () => {
    insertChain(() => Promise.resolve({ data: { id: "x" }, error: null }));
    mocks.rpc.mockResolvedValue({ data: "src-new", error: null });
    mocks.useSources.mockReturnValue({ data: [{ id: "src-new", name: "Bins" }] });
    await renderPage();
    const sourceLabel = Array.from(host.querySelectorAll("label")).find((l) => l.textContent === "Source")!;
    const trigger = document.getElementById(sourceLabel.htmlFor)!;
    const native = trigger.parentElement!.querySelector("select");
    expect(native, "Radix renders a native select inside a form").not.toBeNull();
    await act(async () => {
      native!.value = "__new";
      native!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await typeInto(host.querySelector<HTMLInputElement>('input[aria-label="New source name"]')!, "Bins");
    await typeTitle("One");
    await click("Save & Add another");
    expect(mocks.rpc).toHaveBeenCalledWith("get_or_create_source", expect.objectContaining({ p_name: "Bins" }));
    expect(native!.value).toBe("src-new");
  });
});
