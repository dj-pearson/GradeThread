import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// US-3433: the THIRD secondary read in the same effect, found by applying the
// rule the first two wrote down (read-failure-contract.md, "count the
// consumers").
//
// The photos feed three things: the submitted-photos card, the lightbox, and
// the retake bridge's reusablePhotos. None of them is the grade report, which
// is what the seller came for. Blocking the page on a photo list hid the grade
// to explain a missing thumbnail.
//
// The card's absence is its own defect: `images.length > 0` means a failed load
// renders nothing at all, which asserts "no photos were submitted".

const SUB_ID = "44444444-4444-4444-4444-444444444444";

type Result = { data: unknown; error: unknown };
const mocks = vi.hoisted(() => ({
  read: vi.fn<(table: string) => Result>(),
  sign: vi.fn<() => Promise<{ data: unknown; error: unknown }>>(),
  navigate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/supabase", () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "order", "limit", "gt", "lt"]) {
      chain[m] = () => chain;
    }
    const settle = () => Promise.resolve().then(() => mocks.read(table));
    chain.single = settle;
    chain.maybeSingle = settle;
    chain.then = (res: (v: Result) => unknown, rej: (e: unknown) => unknown) =>
      settle().then(res, rej);
    return chain;
  };
  return {
    supabase: {
      from: (table: string) => chainFor(table),
      storage: {
        from: () => ({
          createSignedUrls: () => mocks.sign(),
          createSignedUrl: async () => ({ data: null, error: null }),
        }),
      },
      channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
      removeChannel: () => {},
    },
  };
});

vi.mock("react-router", async (original) => ({
  ...(await original<typeof import("react-router")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "owner" }, session: null, loading: false }),
}));
vi.mock("@/hooks/use-realtime-submission", () => ({ useRealtimeSubmission: () => {} }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn(), identify: vi.fn() }));
vi.mock("@/lib/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: (...a: unknown[]) => mocks.toastError(...a),
    success: vi.fn(),
    info: vi.fn(),
  }),
}));

const { SubmissionDetailPage } = await import("@/pages/submission-detail");

const CREATED_AT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const submissionWith = (status: string) => ({
  id: SUB_ID,
  user_id: "owner",
  garment_type: "jacket",
  garment_category: "outerwear",
  brand: "Acme",
  title: "Unit Test Jacket",
  description: "",
  status,
  payment_status: "included",
  paid_at: CREATED_AT,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
  quality_feedback: null,
  style_attributes: [],
});

const REPORT = {
  id: "66666666-6666-6666-6666-666666666666",
  submission_id: SUB_ID,
  certificate_id: "55555555-5555-5555-5555-555555555555",
  created_at: CREATED_AT,
  overall_score: 8.5,
  grade_tier: "excellent",
  fabric_condition_score: 8.5,
  structural_integrity_score: 9.0,
  cosmetic_appearance_score: 8.0,
  functional_elements_score: 8.5,
  odor_cleanliness_score: 9.0,
  ai_summary: "Excellent pre-owned condition.",
  detailed_notes: {},
  model_version: "composite_v2",
  human_reviewed: false,
  defects_found: [],
  detected_style_attributes: [],
  authenticity_checked: true,
  authenticity_manipulation_suspected: false,
  authenticity_screenshot_or_watermark_detected: false,
  confidence_label: "high",
};

const PHOTO = {
  id: "photo-1",
  submission_id: SUB_ID,
  image_type: "front",
  storage_path: "owner/sub/front.jpg",
  display_order: 0,
};

const FAILS = { code: "57014", message: "statement timeout" };

function backend(opts: {
  status?: string;
  report?: unknown;
  photos?: Result;
  signing?: { data: unknown; error: unknown };
} = {}) {
  const ok: Record<string, unknown> = {
    submissions: submissionWith(opts.status ?? "completed"),
    grade_reports: "report" in opts ? opts.report : REPORT,
    inventory_items: null,
    disputes: null,
  };
  mocks.read.mockImplementation((table) => {
    if (table === "submission_images") return opts.photos ?? { data: [PHOTO], error: null };
    return { data: table in ok ? ok[table] : null, error: null };
  });
  mocks.sign.mockImplementation(async () =>
    opts.signing ?? { data: [{ path: PHOTO.storage_path, signedUrl: "https://x/y.jpg" }], error: null }
  );
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.read.mockReset();
  mocks.sign.mockReset();
  mocks.navigate.mockReset();
  mocks.toastError.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/dashboard/submissions/${SUB_ID}`]}>
          <Routes>
            <Route path="/dashboard/submissions/:id" element={<SubmissionDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  return container.textContent ?? "";
}

function clickRetake() {
  const b = [...container.querySelectorAll("button")].find((x) =>
    /retake/i.test(x.textContent ?? ""),
  );
  if (!b) throw new Error("no retake button rendered");
  return b;
}

describe("US-3433: a failed photo read withholds the photos, not the grade", () => {
  it("renders the photo card when the photos load", async () => {
    // The control. Every negative assertion below would pass on a page that
    // rendered nothing at all.
    backend();
    const text = await mount();
    expect(text).toContain("Submitted Photos");
    expect(text).not.toContain("Couldn't load the photos");
  });

  it("still renders the grade when the photo LIST read fails", async () => {
    backend({ photos: { data: null, error: FAILS } });
    const text = await mount();
    expect(text).toContain("8.5");
    expect(text).not.toContain("Couldn't load the submission photos");
  });

  it("still renders the grade when the photos cannot be SIGNED", async () => {
    // A listed-but-unsignable photo is the same thing to the seller as one we
    // could not list, and it used to blank the page just as hard.
    backend({ signing: { data: null, error: { message: "no" } } });
    const text = await mount();
    expect(text).toContain("8.5");
    expect(text).not.toContain("Couldn't open the submission photos");
  });

  it("says the photos are unavailable instead of letting the card vanish", async () => {
    // The card is gated on images.length > 0, so a failed load renders nothing
    // and asserts "no photos were submitted" — a different fact.
    backend({ photos: { data: null, error: FAILS } });
    const text = await mount();
    expect(text).toContain("Couldn't load the photos for this submission.");
    expect(text).toContain("Try again");
  });

  it("a retake stops rather than starting without the photos it would reuse", async () => {
    backend({ status: "needs_photos", report: null, photos: { data: null, error: FAILS } });
    await mount();
    await act(async () => { clickRetake().click(); });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("would start without them"),
    );
  });

  it("a retake proceeds normally when the photos loaded", async () => {
    // The other direction: the guard must not block every retake.
    backend({ status: "needs_photos", report: null });
    await mount();
    await act(async () => { clickRetake().click(); });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });
});
