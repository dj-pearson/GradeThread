import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// US-3428: the second secondary read in the same effect, and the harder one.
//
// `linkedItem` has TWO consumers of opposite polarity -- the linked-item card
// renders when it is set, the "Sell this with FlipDesk" nudge renders when it
// is not -- so a failed read that simply leaves the row null does not go quiet:
// it asserts the grade is attached to nothing. And a THIRD consumer, the retake
// bridge, carries linkedItemId into a new submission, where a wrongly-null
// value silently detaches a grade from an item it is already on.
//
// This file drives all three. The shape is US-3427's.

const SUB_ID = "44444444-4444-4444-4444-444444444444";
const ITEM_ID = "77777777-7777-7777-7777-777777777777";

type Result = { data: unknown; error: unknown };
const mocks = vi.hoisted(() => ({
  read: vi.fn<(table: string) => Result>(),
  navigate: vi.fn(),
  toastError: vi.fn(),
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
    error: (...args: unknown[]) => mocks.toastError(...args),
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

const ITEM = { id: ITEM_ID, title: "Acme Jacket", brand: "Acme", user_id: "owner" };

/**
 * `inventory_items` answers from a QUEUE, so a case can say "fails on load and
 * succeeds on the retake's re-read". Every other table answers the same way
 * every time.
 */
function backend(opts: {
  status?: string;
  /** A needs_photos submission has no report yet, and that is what renders the retake. */
  report?: unknown;
  inventoryQueue: Result[];
} ) {
  const queue = [...opts.inventoryQueue];
  const ok: Record<string, unknown> = {
    submissions: submissionWith(opts.status ?? "completed"),
    grade_reports: "report" in opts ? opts.report : REPORT,
    submission_images: [],
    disputes: null,
  };
  mocks.read.mockImplementation((table) => {
    if (table === "inventory_items") {
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    }
    return { data: table in ok ? ok[table] : null, error: null };
  });
}

const FAILS: Result = { data: null, error: { code: "57014", message: "statement timeout" } };
const NONE: Result = { data: null, error: null };
const LINKED: Result = { data: ITEM, error: null };

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.read.mockReset();
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
  return container.textContent ?? "";
}

function clickRetake() {
  const button = [...container.querySelectorAll("button")].find((b) =>
    /retake|new photos|try again with/i.test(b.textContent ?? ""),
  );
  if (!button) throw new Error("no retake button rendered");
  return button;
}

describe("US-3428: a failed linked-item lookup withholds what it feeds", () => {
  it("renders the linked-item card when the lookup finds one", async () => {
    backend({ inventoryQueue: [LINKED] });
    const text = await mount();
    expect(text).toContain("Open item to use this grade");
    expect(text).not.toContain("Sell this with FlipDesk");
  });

  it("renders the FlipDesk nudge when the lookup genuinely finds none", async () => {
    // The control for the negative assertion below: an unresolved lookup must
    // look different from a resolved empty one.
    backend({ inventoryQueue: [NONE] });
    const text = await mount();
    expect(text).toContain("Sell this with FlipDesk");
  });

  it("still renders the grade when the lookup fails", async () => {
    backend({ inventoryQueue: [FAILS] });
    const text = await mount();
    expect(text).toContain("8.5");
    expect(text).not.toContain("Couldn't check the linked inventory item");
  });

  it("withholds the nudge, because it would assert the grade is on no item", async () => {
    backend({ inventoryQueue: [FAILS] });
    const text = await mount();
    expect(text).not.toContain("Sell this with FlipDesk");
  });

  it("says the linkage is unknown, and offers a retry", async () => {
    backend({ inventoryQueue: [FAILS] });
    const text = await mount();
    expect(text).toContain("Couldn't check whether this grade is already on a FlipDesk item.");
    expect(text).toContain("Try again");
  });

  it("a retake re-reads the linkage, and carries it when the re-read resolves", async () => {
    // The load failed, so the page holds no row. If the retake trusted that,
    // the new submission would start detached from an item it IS on.
    backend({ status: "needs_photos", report: null, inventoryQueue: [FAILS, LINKED] });
    await mount();
    await act(async () => { clickRetake().click(); });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    const state = mocks.navigate.mock.calls[0]?.[1] as
      | { state?: { retake?: { linkedItemId?: string | null } } }
      | undefined;
    expect(state?.state?.retake?.linkedItemId).toBe(ITEM_ID);
  });

  it("a retake stops when the re-read fails too, rather than dropping the link", async () => {
    backend({ status: "needs_photos", report: null, inventoryQueue: [FAILS] });
    await mount();
    await act(async () => { clickRetake().click(); });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("a retake would drop the link"),
    );
  });
});
