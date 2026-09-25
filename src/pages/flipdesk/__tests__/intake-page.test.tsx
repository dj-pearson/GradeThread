// The Add item page, rendered inside a DATA router so the real navigation
// guard (useBlocker) runs. Each describe covers one behavior of the form.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useNavigate } from "react-router";
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
  toastWarning: vi.fn(),
  lookup: vi.fn(),
  lookupPending: false,
  extract: vi.fn(),
  can: vi.fn((_: string) => true),
  ownerId: "owner-1" as string | null,
  reviewFlow: { enabled: false, isLoading: false, chosen: false },
  useSources: vi.fn(() => ({ data: [] as Array<{ id: string; name: string }> })),
  aiPanelProps: null as null | Record<string, unknown>,
  scannerProps: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/supabase", () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }));
vi.mock("@/lib/offline-queue", () => ({ enqueueIntake: mocks.enqueueIntake }));
vi.mock("@/lib/item-photo-upload", () => ({ uploadItemPhoto: mocks.uploadItemPhoto }));
vi.mock("@/hooks/use-offline-intake", () => ({
  useOfflineIntakeSync: () => ({ pending: 0, online: true, refresh: mocks.refresh, sync: vi.fn() }),
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
vi.mock("@/hooks/use-sku-sequence", () => ({ useSkuSequence: () => ({ nextSku: null }) }));
vi.mock("@/hooks/use-sources", () => ({ useSources: () => mocks.useSources() }));
vi.mock("@/hooks/use-ai-extract", () => ({
  useAiExtract: () => ({ mutateAsync: mocks.extract, isPending: false }),
}));
vi.mock("@/hooks/use-product-lookup", () => ({
  useProductLookup: () => ({ mutateAsync: mocks.lookup, isPending: mocks.lookupPending }),
}));
vi.mock("@/hooks/use-review-flow", () => ({
  useReviewFlowEnabled: () => mocks.reviewFlow,
  useSetReviewFlow: () => ({ mutate: vi.fn(), isPending: false }),
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
  ])
    m.mockReset();
  mocks.can.mockReset().mockReturnValue(true);
  mocks.ownerId = "owner-1";
  mocks.lookupPending = false;
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
