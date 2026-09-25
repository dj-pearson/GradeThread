// SNAP-13: a snap arrives at intake as navigation state. The form is prefilled,
// the snap photo is staged as the Front, the state is removed from history so a
// reload does not re-seed, and the save goes through the ordinary owner-scoped
// path. Rendered offline so the insert lands in the (mocked) queue, where it
// can be read without a database.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
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
vi.mock("@/hooks/use-sku-sequence", () => ({
  SKU_SEQUENCE_KEY: "sku_sequence",
  SKU_PREVIEW_KEY: "sku_preview",
  useSkuSequence: () => ({ nextSku: null, isEnabled: false }),
}));
vi.mock("@/hooks/use-open-photo-sessions", () => ({
  useOpenPhotoSessions: () => ({ data: 0 }),
}));
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
const { buildIntakeBridge } = await import("@/lib/snap-bridge");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let onLine: ReturnType<typeof vi.spyOn>;
let seenState: unknown = "unset";

function StateProbe() {
  seenState = useLocation().state;
  return null;
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

// 1x1 JPEG-shaped bytes are enough: nothing decodes them here.
const PHOTO = "data:image/jpeg;base64," + btoa("jpegbytes");

const SNAP = buildIntakeBridge(
  {
    grade: { overall_score: 7.4, grade_tier: "very_good", confidence: 0.62, factor_scores: {} },
    value: { lowCents: 1800, medianCents: 3200, highCents: 6400, sampleSize: 12, confidence: 0.5, sufficient: true, currency: "USD" },
    garment: { type: "outerwear", category: "jacket" },
    estimate: true,
    disclaimer: "",
  },
  { kind: "live", dataUri: PHOTO, brand: "Patagonia", keyword: "Nano Puff" },
  800,
);

async function renderPage(state: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[{ pathname: "/dashboard/flipdesk/intake", state }]}>
          <FlipdeskIntakePage />
          <StateProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

function inputByPlaceholder(p: string): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(`input[placeholder="${p}"]`);
  expect(input, `no input "${p}"`).not.toBeNull();
  return input!;
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
  seenState = "unset";
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  onLine.mockRestore();
});

describe("snap to intake (SNAP-13)", () => {
  it("prefills the form, stages the photo and clears history state", async () => {
    await renderPage({ snap: SNAP });
    expect(inputByPlaceholder("e.g. Lululemon Align Pant").value).toBe("Nano Puff");
    expect(host.querySelector("[data-staged]")?.getAttribute("data-staged")).toBe("1");
    expect(host.textContent).toContain("Filled in from your snap, with a target price of $32.00");
    const notes = host.querySelector<HTMLTextAreaElement>("#intake-condition-notes");
    expect(notes?.value).toBe("Snap estimate 7.4 (Very Good), 62% confidence");
    // Removed from history after the latch, so Back or a reload cannot re-seed.
    expect(seenState).toBeNull();
  });

  it("saves under the workspace owner with the photo, price, cost and garment", async () => {
    await renderPage({ snap: SNAP });
    await click("Save & Add another");
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.enqueueIntake).toHaveBeenCalledTimes(1);
    const [insert, extras] = mocks.enqueueIntake.mock.calls[0]! as [
      Record<string, unknown>,
      { photos: Array<Record<string, unknown>> },
    ];
    expect(insert).toMatchObject({
      user_id: "owner-1",
      title: "Nano Puff",
      brand: "Patagonia",
      status: "sourced",
      target_price: 32,
      acquired_price: 8,
      garment_type: "outerwear",
      garment_category: "jacket",
      condition_notes: "Snap estimate 7.4 (Very Good), 62% confidence",
    });
    expect((insert.ai_field_sources as Record<string, { source: string }>).condition_notes!.source).toBe("snap");
    expect(extras.photos.map((p) => [(p.blob as File).name, p.photoType])).toEqual([["snap-front.jpg", "front"]]);
    // The next garment in the batch does not inherit the snap.
    expect(host.textContent).not.toContain("Filled in from your snap");
  });

  it("a plain visit is untouched", async () => {
    await renderPage(null);
    expect(inputByPlaceholder("e.g. Lululemon Align Pant").value).toBe("");
    expect(host.querySelector("[data-staged]")?.getAttribute("data-staged")).toBe("0");
    expect(host.textContent).not.toContain("Filled in from your snap");
  });
});
