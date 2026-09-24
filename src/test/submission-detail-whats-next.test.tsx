import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SUB-14: What's next survives a dispute, and Showcase consent and passport
// handoff are the owner's. Harness from submission-detail-dispute-read.test.tsx:
//
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
  userId: "owner",
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
  useAuth: () => ({ user: { id: mocks.userId }, session: null, loading: false }),
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

function backend(
  status: string,
  garmentId: string | null = null,
  report: Record<string, unknown> = {},
) {
  const ok: Record<string, unknown> = {
    submissions: { ...SUBMISSION, status },
    grade_reports: { ...REPORT, garment_id: garmentId, ...report },
    inventory_items: null,
    submission_images: [],
    disputes: null,
    garments: garmentId ? { public_passport_slug: "abc" } : null,
  };
  mocks.read.mockImplementation((table) => ({ data: ok[table] ?? null, error: null }));
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.read.mockReset();
  mocks.userId = "owner";
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
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
  return container.textContent ?? "";
}

describe("SUB-14: What's next through a dispute", () => {
  it("a disputed grade keeps share and the Showcase switch, with the note", async () => {
    backend("disputed");
    const text = await mount();
    expect(text).toContain("What's next");
    expect(text).toContain("Share your certificate");
    expect(container.querySelector('[role="switch"]')).not.toBeNull();
    expect(text).toContain(
      "This grade is under dispute and may change. Your certificate stays live until it is decided.",
    );
  });

  it("a completed grade has no dispute note", async () => {
    backend("completed");
    const text = await mount();
    expect(text).toContain("Share your certificate");
    expect(text).not.toContain("This grade is under dispute");
  });
});

describe("SUB-14: owner-only controls", () => {
  it("a member sees no Showcase switch, only where it stands", async () => {
    mocks.userId = "member";
    backend("completed");
    const text = await mount();
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(text).toContain("Only the workspace owner can change that.");
  });

  it("a member gets no passport handoff", async () => {
    mocks.userId = "member";
    backend("completed", "99999999-9999-9999-9999-999999999999");
    const text = await mount();
    expect(text).toContain("Only the workspace owner can hand this passport to a buyer.");
  });

  it("the owner gets the switch", async () => {
    backend("completed");
    await mount();
    expect(container.querySelector('[role="switch"]')).not.toBeNull();
  });
});

describe("SUB-15: honest review ETA and the condition note", () => {
  it("a pending_review report past its due time shows the late copy", async () => {
    backend("pending_review", null, {
      review_due_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const text = await mount();
    expect(text).toContain("Running late. It is now at the front of the review queue.");
    expect(text).not.toContain("Expected to be official by");
  });

  it("before its due time it gives the expected time", async () => {
    backend("pending_review", null, {
      review_due_at: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
    });
    const text = await mount();
    expect(text).toContain("Expected to be official by");
  });

  it("a certified grade offers the condition text", async () => {
    backend("completed");
    const text = await mount();
    expect(text).toContain("Condition text for your listing");
    expect(container.querySelector("textarea")?.value).toContain(
      "/cert/55555555-5555-5555-5555-555555555555",
    );
  });
});
