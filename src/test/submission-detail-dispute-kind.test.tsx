import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SUB-04: grade disputes and authenticity appeals share the disputes table
// (00489). The detail page must read them apart. Harness copied from
// submission-detail-dispute-read.test.tsx, with a mock that sees the kind.
//
// (Original harness notes follow.) US-3427: the dispute lookup is a SECONDARY read. It answers one question --
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
  read: vi.fn<(table: string, kind?: string) => Result>(),
}));

vi.mock("@/lib/supabase", () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    let kind: string | undefined;
    for (const method of ["select", "is", "in", "order", "limit", "gt", "lt"]) {
      chain[method] = () => chain;
    }
    chain.eq = (col: string, val: string) => {
      if (col === "kind") kind = val;
      return chain;
    };
    const settle = () => Promise.resolve().then(() => mocks.read(table, kind));
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

const APPEAL = {
  id: "77777777-7777-7777-7777-777777777777",
  grade_report_id: REPORT.id,
  kind: "authenticity",
  status: "open",
  reason: "It is genuine, receipt available.",
  resolution_notes: null,
  created_at: CREATED_AT,
};
const GRADE_DISPUTE = {
  ...APPEAL,
  id: "88888888-8888-8888-8888-888888888888",
  kind: "grade",
  reason: "Pilling is lint, not wear.",
};

function backend(disputes: { grade?: unknown; authenticity?: unknown }) {
  const ok: Record<string, unknown> = {
    submissions: SUBMISSION,
    grade_reports: REPORT,
    inventory_items: null,
    submission_images: [],
  };
  mocks.read.mockImplementation((table, kind) => {
    if (table === "disputes") {
      // A read with no kind filter is the bug: it would see both rows, and
      // maybeSingle errors on two.
      if (!kind) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      return { data: (disputes as Record<string, unknown>)[kind] ?? null, error: null };
    }
    return { data: table in ok ? ok[table] : null, error: null };
  });
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
  await act(async () => { await Promise.resolve(); });
  return container.textContent ?? "";
}

describe("SUB-04: grade disputes and authenticity appeals are read apart", () => {
  it("an appeal alone leaves Dispute Grade available", async () => {
    backend({ authenticity: APPEAL });
    const text = await mount();
    expect(text).toContain("Dispute Grade");
    expect(text).toContain("Authenticity appeal");
    expect(text).not.toContain("Couldn't check whether you already disputed");
  });

  it("both kinds render both cards and no stuck notice", async () => {
    backend({ grade: GRADE_DISPUTE, authenticity: APPEAL });
    const text = await mount();
    expect(text).toContain("Grade dispute");
    expect(text).toContain("Pilling is lint, not wear.");
    expect(text).toContain("Authenticity appeal");
    expect(text).toContain("It is genuine, receipt available.");
    expect(text).not.toContain("Dispute Grade");
    expect(text).not.toContain("Couldn't check whether you already disputed");
  });
});
