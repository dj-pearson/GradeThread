// The intake form's offline branch, rendered. With no signal, Save has to put
// the item AND its staged photos in the IndexedDB queue and touch nothing on
// the network: an insert attempted offline throws, and the old path then
// cleared the staged photos while telling the seller the item was saved.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueIntake: vi.fn(),
  refresh: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  uploadItemPhoto: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }));
vi.mock("@/lib/offline-queue", () => ({ enqueueIntake: mocks.enqueueIntake }));
vi.mock("@/lib/item-photo-upload", async (orig) => ({
  ...(await orig<typeof import("@/lib/item-photo-upload")>()),
  uploadItemPhoto: mocks.uploadItemPhoto,
}));
vi.mock("@/hooks/use-offline-intake", () => ({
  useOfflineIntakeStatus: () => ({ pending: 0, photosPending: 0, online: false, refresh: mocks.refresh }),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
  }),
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: "member-1" } }),
}));
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ workspaceOwnerId: "owner-1", can: () => true }),
}));
vi.mock("@/hooks/use-sku-sequence", () => ({ useSkuSequence: () => ({ nextSku: null }) }));
vi.mock("@/hooks/use-sources", () => ({ useSources: () => ({ data: [] }) }));
vi.mock("@/hooks/use-ai-extract", () => ({
  useAiExtract: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-product-lookup", () => ({
  useProductLookup: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-review-flow", () => ({
  useReviewFlowEnabled: () => ({ enabled: false, isLoading: false }),
  useSetReviewFlow: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/flipdesk/sourced-by-select", () => ({ SourcedBySelect: () => null }));
vi.mock("@/components/flipdesk/sku-auto-hint", () => ({ SkuAutoHint: () => null }));
vi.mock("@/components/flipdesk/bulk-intake", () => ({ BulkIntake: () => null }));
vi.mock("@/components/flipdesk/snap-catalog", () => ({ SnapCatalog: () => null }));
vi.mock("@/components/flipdesk/pwa-install-banner", () => ({ PwaInstallBanner: () => null }));
vi.mock("@/components/flipdesk/ai-fill-panel", () => ({ AiFillPanel: () => null }));
vi.mock("@/components/flipdesk/barcode-scanner-dialog", () => ({
  BarcodeScannerDialog: () => null,
}));
vi.mock("@/components/flipdesk/grade-roi-hint", () => ({ GradeRoiHint: () => null }));
vi.mock("@/components/flipdesk/measurement-form", () => ({ MeasurementForm: () => null }));
vi.mock("@/components/help/page-help", () => ({ PageHelp: () => null }));
// useBlocker needs a data router; the leave-guard is not what this tests.
vi.mock("@/hooks/use-navigation-guard", () => ({
  useNavigationGuard: () => ({ blocked: false, cancelLeave: vi.fn(), confirmLeave: vi.fn() }),
}));
// The stager's own picker is a file input; a button that stages two photos
// stands in for it.
vi.mock("@/components/flipdesk/intake-photo-stager", () => ({
  IntakePhotoStager: ({
    photos,
    onChange,
  }: {
    photos: unknown[];
    onChange: (next: unknown[]) => void;
  }) => (
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
          {
            id: "s2",
            file: new File(["b"], "back.jpg", { type: "image/jpeg" }),
            previewUrl: "",
            photoType: "back",
          },
        ])
      }
    >
      stage photos
    </button>
  ),
}));

const { FlipdeskIntakePage } = await import("@/pages/flipdesk/intake");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let onLine: ReturnType<typeof vi.spyOn>;

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
          <FlipdeskIntakePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

function titleInput(): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(
    'input[placeholder="e.g. Lululemon Align Pant"]',
  );
  expect(input, "no title input").not.toBeNull();
  return input!;
}

async function typeTitle(value: string) {
  const input = titleInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(text: string) {
  const button = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  expect(button, `no button "${text}"`).toBeTruthy();
  await act(async () => {
    button!.click();
  });
  await flush();
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.enqueueIntake.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined);
  mocks.from.mockImplementation((table: string) => {
    throw new Error(`offline save touched ${table}`);
  });
  onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  onLine.mockRestore();
});

describe("intake offline save", () => {
  it("queues the item with its staged photos and makes no network call", async () => {
    await renderPage();
    expect(host.textContent).toContain("You're offline.");
    await typeTitle("Wool coat");
    await click("stage photos");
    await click("Save & Add another");

    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.enqueueIntake).toHaveBeenCalledTimes(1);
    const [insert, extras] = mocks.enqueueIntake.mock.calls[0]! as [
      { user_id: string; title: string },
      { newSourceName: string | null; photos: Array<Record<string, unknown>> },
    ];
    // The WORKSPACE owner's row, as the online insert would write.
    expect(insert).toMatchObject({ user_id: "owner-1", title: "Wool coat" });
    expect(extras.newSourceName).toBeNull();
    expect(
      extras.photos.map((p) => [(p.blob as File).name, p.photoType, p.photoRole, p.sortOrder]),
    ).toEqual([
      ["front.jpg", "front", null, 0],
      ["back.jpg", "back", null, 100],
    ]);

    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.uploadItemPhoto).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Saved "Wool coat", with 2 photos, offline. It will sync when you reconnect.',
    );
    // Reset for the next garment only after the queue write succeeded.
    expect(titleInput().value).toBe("");
    expect(host.querySelector("[data-staged]")?.getAttribute("data-staged")).toBe("0");
  });

  it("keeps the form and the photos when the queue write fails", async () => {
    mocks.enqueueIntake.mockRejectedValue(new Error("QuotaExceededError"));
    await renderPage();
    await typeTitle("Wool coat");
    await click("stage photos");
    await click("Save & Add another");

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(titleInput().value).toBe("Wool coat");
    expect(host.querySelector("[data-staged]")?.getAttribute("data-staged")).toBe("2");
  });
});
