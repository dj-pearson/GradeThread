import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// US-3427: the dispute lookup is a SECONDARY read. It answers one question --
// has this grade report already been disputed -- and its only consumer is the
// "Dispute Grade" action. When it failed, submission-detail.tsx replaced the
// whole page with an error, so the seller could not see the grade they paid
// for. That is what turned the critical-path E2E red on 2026-09-15.
//
// read-failure-contract.md says a failed read stops the DEPENDENT ACTION. This
// file drives both halves of that: the report still renders, and the action is
// withheld rather than offered against an unknown.

const SUB_ID = "44444444-4444-4444-4444-444444444444";

type Result = { data: unknown; error: unknown };
const mocks = vi.hoisted(() => ({
  read: vi.fn<(table: string) => Result>(),
}));

vi.mock("@/lib/supabase", () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "in", "order", "limit", "gt", "lt"]) {
      chain[method] = () => chain;
    }
    const settle = () => Promise.resolve().then(() => mocks.read(table));
    chain.single = settle;
    chain.maybeSingle = settle;
    chain.then = (resolve: (v: Result) => unknown, reject: (e: unknown) => unknown) =>
      settle().then(resolve, reject);
    return chain;
  };
  return {
    supabase: {
      from: (table: string) => chainFor(table),
      storage: {
        from: () => ({
          createSignedUrls: async () => ({ data: [], error: null }),
          createSignedUrl: async () => ({ data: null, error: null }),
        }),
      },
      channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
      removeChannel: () => {},
    },
  };
});

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "owner" }, session: null, loading: false }),
}));
vi.mock("@/hooks/use-realtime-submission", () => ({
  useRealtimeSubmission: () => {},
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn(), identify: vi.fn() }));
vi.mock("@/lib/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));

const { SubmissionDetailPage } = await import("@/pages/submission-detail");

/** Yesterday, so the dispute window is open and the action is genuinely on offer. */
const CREATED_AT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const SUBMISSION = {
  id: SUB_ID,
  user_id: "owner",
  garment_type: "jacket",
  garment_category: "outerwear",
  brand: "Acme",
  title: "Unit Test Jacket",
  description: "",
  status: "completed",
  payment_status: "included",
  paid_at: CREATED_AT,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
  quality_feedback: null,
  style_attributes: [],
};

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

/** Every read succeeds except the ones named, which come back with an error. */
function backend(failing: Record<string, unknown> = {}) {
  const ok: Record<string, unknown> = {
    submissions: SUBMISSION,
    grade_reports: REPORT,
    inventory_items: null,
    submission_images: [],
    disputes: null,
  };
  mocks.read.mockImplementation((table) =>
    table in failing
      ? { data: null, error: failing[table] }
      : { data: table in ok ? ok[table] : null, error: null },
  );
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.read.mockReset();
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
  // One more tick for the awaited chain inside the effect.
  await act(async () => { await Promise.resolve(); });
  return container.textContent ?? "";
}

describe("US-3427: a failed dispute lookup withholds the action, not the report", () => {
  it("renders the grade when the dispute lookup succeeds, and offers the dispute", async () => {
    // The control. Without it a page that renders nothing at all would satisfy
    // every assertion below about what must NOT appear.
    backend();
    const text = await mount();
    expect(text).toContain("8.5");
    expect(text).toContain("Dispute Grade");
    expect(text).not.toContain("Couldn't check whether you already disputed");
  });

  it("still renders the grade when the dispute lookup fails", async () => {
    backend({ disputes: { code: "57014", message: "canceling statement due to statement timeout" } });
    const text = await mount();
    expect(text).toContain("8.5");
    expect(text).toContain("Unit Test Jacket");
  });

  // SPLIT ON PURPOSE. Withholding the button and explaining the absence are two
  // separate pieces of the fix (the `!disputeCheckFailed` clause in canDispute,
  // and the notice beside it). Measured: as ONE case, deleting either piece
  // reddened the same case, so a passing run could not tell you both were
  // there. Each sabotage now names its own half.
  it("withholds the dispute action, so no second dispute can be filed against an unknown", async () => {
    backend({ disputes: { code: "57014", message: "canceling statement due to statement timeout" } });
    const text = await mount();
    expect(text).not.toContain("Dispute Grade");
  });

  it("says why the dispute action is gone, and offers a retry", async () => {
    backend({ disputes: { code: "57014", message: "canceling statement due to statement timeout" } });
    const text = await mount();
    expect(text).toContain("Couldn't check whether you already disputed this grade.");
    expect(text).toContain("Try again");
  });

  it("does not show the page-level load error for a dispute failure", async () => {
    // The regression, stated as itself: this copy is what stood where the grade
    // report belongs between 2026-09-15 and this fix.
    backend({ disputes: { code: "57014", message: "boom" } });
    const text = await mount();
    expect(text).not.toContain("Couldn't check the existing dispute");
  });

  it("still blocks the page when the GRADE REPORT read fails", async () => {
    // The contract is granularity, not leniency: a failed read of the thing the
    // page is FOR still stops the page.
    backend({ grade_reports: { code: "57014", message: "boom" } });
    const text = await mount();
    expect(text).toContain("Couldn't load the grade report");
    expect(text).not.toContain("8.5");
  });
});
