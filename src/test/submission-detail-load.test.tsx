import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SUB-11: the detail page loads in one parallel pass, polls only a loaded
// page, backs off during human review, and signs fresh URLs for a retake.
// Harness from submission-detail-dispute-read.test.tsx:
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
  requested: [] as string[],
  holdSubmissions: null as Promise<void> | null,
  signGeneration: 0,
}));

vi.mock("@/lib/supabase", () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "in", "order", "limit", "gt", "lt"]) {
      chain[method] = () => chain;
    }
    const settle = () => {
      mocks.requested.push(table);
      const gate = table === "submissions" && mocks.holdSubmissions
        ? mocks.holdSubmissions
        : Promise.resolve();
      return gate.then(() => mocks.read(table));
    };
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
          createSignedUrls: async (paths: string[]) => {
            mocks.signGeneration++;
            return {
              data: paths.map((path) => ({
                path,
                signedUrl: `https://signed/${path}?gen=${mocks.signGeneration}`,
                error: null,
              })),
              error: null,
            };
          },
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
vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
}));
vi.mock("@/hooks/use-grade-turnaround", () => ({
  useGradeTurnaround: () => ({ live: undefined, releaseTimes: {} }),
  formatReadyBy: (s: string) => s,
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

const { detailPollDelay } = await import("@/lib/detail-poll");

function backend(over: Record<string, Result> = {}) {
  const ok: Record<string, unknown> = {
    submissions: SUBMISSION,
    grade_reports: REPORT,
    inventory_items: null,
    submission_images: [],
    disputes: null,
  };
  mocks.read.mockImplementation((table) =>
    over[table] ?? { data: table in ok ? ok[table] : null, error: null },
  );
}

function reads(table: string): number {
  return mocks.read.mock.calls.filter((c) => c[0] === table).length;
}

function RetakeProbe() {
  const loc = useLocation();
  return <pre data-testid="retake">{JSON.stringify(loc.state)}</pre>;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  mocks.read.mockReset();
  mocks.requested.length = 0;
  mocks.signGeneration = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

async function mount() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/dashboard/submissions/${SUB_ID}`]}>
          <Routes>
            <Route path="/dashboard/submissions/:id" element={<SubmissionDetailPage />} />
            <Route path="/dashboard/submissions/new" element={<RetakeProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("SUB-11: polling", () => {
  it("backs off during human review", () => {
    const delays = [0, 11, 12, 31, 32, 200].map((n) => detailPollDelay("pending_review", n));
    expect(delays).toEqual([5000, 5000, 30000, 30000, 120000, 120000]);
    expect(detailPollDelay("processing", 500)).toBe(5000);
  });

  it("does not poll a not-found page", async () => {
    backend({ submissions: { data: null, error: { code: "PGRST116", message: "no rows" } } });
    await mount();
    expect(container.textContent).toContain("Submission not found");
    await advance(60_000);
    expect(reads("submissions")).toBe(1);
  });

  it("reads once on mount, then on the interval", async () => {
    backend({
      submissions: { data: { ...SUBMISSION, status: "processing" }, error: null },
      grade_reports: { data: null, error: null },
    });
    await mount();
    expect(reads("submissions")).toBe(1);
    await advance(5_000);
    expect(reads("submissions")).toBe(2);
  });

  it("pending_review polls fast for a minute, then slows", async () => {
    backend({ submissions: { data: { ...SUBMISSION, status: "pending_review" }, error: null } });
    await mount();
    await advance(60_000);
    const firstMinute = reads("submissions") - 1;
    await advance(60_000);
    const secondMinute = reads("submissions") - 1 - firstMinute;
    expect(firstMinute).toBe(12);
    expect(secondMinute).toBeLessThanOrEqual(2);
  });
});

describe("SUB-11: parallel load", () => {
  it("the first four reads start before the submission read answers", async () => {
    // Hold the submission read open. Serially, nothing else would be asked
    // for until it answered.
    let release!: () => void;
    mocks.holdSubmissions = new Promise<void>((r) => (release = r));
    backend();
    await mount();
    for (const t of ["submissions", "grade_reports", "inventory_items", "submission_images"]) {
      expect(mocks.requested, `${t} was not requested up front`).toContain(t);
    }
    expect(reads("submissions")).toBe(0);
    release();
    mocks.holdSubmissions = null;
    await flush();
    expect(container.textContent).toContain("8.5");
  });
});

describe("SUB-11: retake signs fresh URLs", () => {
  it("a retake 16 minutes after load carries newly signed photos", async () => {
    backend({
      submissions: {
        data: { ...SUBMISSION, status: "needs_photos", quality_feedback: { issues: [] } },
        error: null,
      },
      grade_reports: { data: null, error: null },
      submission_images: {
        data: [{ id: "img-1", image_type: "front", storage_path: "u/s/front.jpg", display_order: 0 }],
        error: null,
      },
    });
    await mount();
    expect(mocks.signGeneration).toBe(1);
    await advance(16 * 60_000);
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Retake photos"),
    )!;
    await act(async () => {
      button.click();
    });
    await flush();
    const state = JSON.parse(
      container.querySelector('[data-testid="retake"]')?.textContent ?? "null",
    );
    expect(state.retake.reusablePhotos).toEqual([
      { imageType: "front", signedUrl: "https://signed/u/s/front.jpg?gen=2" },
    ]);
  });
});
