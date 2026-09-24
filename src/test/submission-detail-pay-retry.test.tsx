import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SUB-09: the pay-retry loop after a mid-flow credit-pack purchase. It used to
// retry final answers eight times, promise a grade that "will start
// automatically" (nothing on the server does that), and leave its loading
// toast spinning if the seller left mid-loop. Harness from
// submission-detail-dispute-read.test.tsx:
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
  edgeFetch: vi.fn(),
  toast: {
    loading: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
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
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), mocks.toast) }));
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: mocks.edgeFetch }));
vi.mock("@/hooks/use-grade-turnaround", () => ({
  useGradeTurnaround: () => ({ live: undefined, releaseTimes: {} }),
  formatReadyBy: (s: string) => s,
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
  status: "pending",
  payment_status: "unpaid",
  paid_at: CREATED_AT,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
  quality_feedback: null,
  style_attributes: [],
};


function backend() {
  const ok: Record<string, unknown> = {
    submissions: SUBMISSION,
    grade_reports: null,
    inventory_items: null,
    submission_images: [],
    disputes: null,
  };
  mocks.read.mockImplementation((table) => ({ data: ok[table] ?? null, error: null }));
}

/** Only the pay calls; the help link fetches its own article through edgeFetch. */
function payCalls() {
  return mocks.edgeFetch.mock.calls.filter((c) => String(c[0]).startsWith("/api/grade/pay/"));
}

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.read.mockReset();
  mocks.edgeFetch.mockReset();
  for (const fn of Object.values(mocks.toast)) fn.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  backend();
});

afterEach(() => {
  try {
    act(() => root.unmount());
  } catch {
    /* already unmounted */
  }
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/dashboard/submissions/${SUB_ID}?pay_retry=1&tier=standard`]}>
          <Routes>
            <Route path="/dashboard/submissions/:id" element={<SubmissionDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

describe("SUB-09: the pay-retry loop", () => {
  it("stops on a final answer after one request and shows the server's error", async () => {
    mocks.edgeFetch.mockImplementation(async (url: string) =>
      String(url).startsWith("/api/help/") ? reply(404, {}) : reply(409, { error: "This grade was refunded. Submit the garment again to grade it." }),
    );
    await mount();
    expect(payCalls()).toHaveLength(1);
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "This grade was refunded. Submit the garment again to grade it.",
      { id: "pay-retry" },
    );
  });

  it("unmounting mid-loop dismisses the loading toast", async () => {
    vi.useFakeTimers();
    mocks.edgeFetch.mockResolvedValue(reply(200, { payment: { paid: false } }));
    await mount();
    expect(mocks.toast.loading).toHaveBeenCalledWith("Applying your new credits…", { id: "pay-retry" });
    act(() => root.unmount());
    expect(mocks.toast.dismiss).toHaveBeenCalledWith("pay-retry");
  });

  it("when retries run out it offers Start grading instead of a false promise", async () => {
    vi.useFakeTimers();
    mocks.edgeFetch.mockResolvedValue(reply(200, { payment: { paid: false } }));
    await mount();
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    }
    expect(payCalls()).toHaveLength(8);
    const said = mocks.toast.info.mock.calls.map((c) => String(c[0])).join(" ");
    expect(said).not.toMatch(/start automatically/);
    expect(container.textContent).toContain("Start grading");
  });

  it("the page no longer carries the false copy", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/pages/submission-detail.tsx", "utf8");
    expect(src).not.toContain("will start automatically in a moment");
  });
});
