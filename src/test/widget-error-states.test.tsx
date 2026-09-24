import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageMeters } from "@/components/billing/usage-meter";
import { FlipdeskStatTimeSavedWidget } from "@/components/dashboard/widgets/flipdesk-stat-time-saved";
import { FlipdeskStatReviewMedianWidget } from "@/components/dashboard/widgets/flipdesk-stat-review-median";
import { FlipdeskNorthStarWidget } from "@/components/dashboard/widgets/flipdesk-north-star";
import { GradingListingSuggestionsWidget } from "@/components/dashboard/widgets/grading-listing-suggestions";
import { FlipdeskPayoutsWidget } from "@/components/dashboard/widgets/flipdesk-payouts";
import { WidgetBoard } from "@/components/dashboard/widget-board";
import type { WidgetDef } from "@/lib/dashboard-widgets";

// DASH-9: a failed read shows an error with a retry control, never a
// shimmer, a zero or "Nothing to show yet".

const failing = () => ({
  data: undefined,
  isLoading: false,
  isError: true,
  isFetching: false,
  refetch: vi.fn(),
});

const state = vi.hoisted(() => ({
  billing: null as unknown,
  payouts: null as unknown,
  connection: null as unknown,
}));

vi.mock("@/hooks/use-billing-summary", () => ({
  useBillingSummary: () => state.billing,
}));
vi.mock("@/hooks/use-time-saved", () => ({ useTimeSaved: () => failing() }));
vi.mock("@/hooks/use-review-flow", () => ({
  useReviewApproveMedian: () => failing(),
}));
vi.mock("@/hooks/use-flipdesk-overview", () => ({
  useFlipdeskOverview: () => failing(),
}));
vi.mock("@/hooks/use-ebay", () => ({
  useEbayConnection: () => state.connection,
  useEbayPayouts: () => state.payouts,
}));
vi.mock("@/components/flipdesk/ebay-payouts-card", () => ({
  EbayPayoutsCard: () => <div data-testid="payouts-card" />,
}));
vi.mock("@/components/flipdesk/north-star-card", () => ({
  NorthStarCard: () => <div>streak 0</div>,
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "not", "order", "limit", "in", "is", "eq"]) {
        chain[m] = () => chain;
      }
      chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: null, error: { message: "down" } }).then(resolve, reject);
      return chain;
    },
  },
}));
vi.mock("@/hooks/use-dashboard-layout", () => ({
  useDashboardLayout: () => ({ layout: [], registry: [] }),
}));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.billing = failing();
  state.connection = { data: { id: "c" }, isLoading: false };
  state.payouts = failing();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

async function render(node: React.ReactNode) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    )
  );
}

function retryButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) =>
    /try again|retry/i.test(b.textContent ?? "")
  ) as HTMLButtonElement | undefined;
}

describe("each widget shows a retry control on a failed read", () => {
  it("usage meters", async () => {
    await render(<UsageMeters />);
    expect(container.textContent).toContain("Could not load your usage");
    expect(retryButton()).toBeTruthy();
  });

  it("time saved", async () => {
    await render(<FlipdeskStatTimeSavedWidget />);
    expect(container.textContent).toContain("Could not load");
    expect(retryButton()).toBeTruthy();
  });

  it("review median", async () => {
    await render(<FlipdeskStatReviewMedianWidget />);
    expect(container.textContent).toContain("Could not load");
    expect(retryButton()).toBeTruthy();
  });

  it("north star, instead of a 0 streak", async () => {
    await render(<FlipdeskNorthStarWidget size="lg" surface="flipdesk" range="d7" />);
    expect(container.textContent).toContain("Could not load");
    expect(container.textContent).not.toContain("streak 0");
    expect(retryButton()).toBeTruthy();
  });

  it("listing suggestions", async () => {
    await render(<GradingListingSuggestionsWidget />);
    await vi.waitFor(() => expect(container.textContent).toContain("Could not load"));
    expect(retryButton()).toBeTruthy();
  });

  it("payouts", async () => {
    await render(<FlipdeskPayoutsWidget />);
    expect(container.textContent).toContain("Could not load");
    expect(retryButton()).toBeTruthy();
  });
});

describe("usage meter", () => {
  const summary = (plan: string) => ({
    data: {
      subscription: { plan },
      usage: {
        active_listings: 3,
        ai_actions_used_this_month: 1,
        ai_action_limit: null,
        marketplaces_connected: 1,
      },
      grades: { included_used_this_month: 0, credit_balance: 0 },
      action_credits: { balance: 0, low: false },
    },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  });

  it("falls back to the free plan for an unknown plan key instead of crashing", async () => {
    state.billing = summary("plan-from-the-future");
    await render(<UsageMeters />);
    expect(container.textContent).toContain("Active listings");
  });

  it("exposes each cap as a progressbar", async () => {
    state.billing = summary("free");
    await render(<UsageMeters />);
    const bar = container.querySelector('[role="progressbar"][aria-label="Active listings"]');
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute("aria-valuenow")).toBe("3");
    expect(bar!.getAttribute("aria-valuemin")).toBe("0");
  });
});

describe("payouts", () => {
  const payout = (payoutStatus: string, value: string, currency = "USD") => ({
    payoutStatus,
    amount: { value, currency },
    payoutDate: null,
  });

  it("puts a RETRYABLE_FAILED payout on its own line, not in the pending sum", async () => {
    state.payouts = {
      data: {
        payouts: [
          payout("INITIATED", "100.00"),
          payout("PROCESSING", "20.50"),
          payout("RETRYABLE_FAILED", "999.00"),
        ],
      },
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };
    await render(<FlipdeskPayoutsWidget />);
    const pending = container.querySelector('[data-testid="payouts-pending"]')!;
    const failed = container.querySelector('[data-testid="payouts-failed"]')!;
    expect(pending.textContent).toContain("2 payouts on the way");
    expect(pending.textContent).toContain("$120.50");
    expect(pending.textContent).not.toContain("999");
    expect(failed.textContent).toContain("1 payout failed");
    expect(failed.textContent).toContain("$999.00");
  });

  it("sums per currency", async () => {
    state.payouts = {
      data: {
        payouts: [payout("INITIATED", "10", "USD"), payout("INITIATED", "5", "GBP")],
      },
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };
    await render(<FlipdeskPayoutsWidget />);
    const pending = container.querySelector('[data-testid="payouts-pending"]')!;
    expect(pending.textContent).toContain("$10.00");
    expect(pending.textContent).toContain("£5.00");
  });

  it("shows a skeleton while the connection loads", async () => {
    state.connection = { data: undefined, isLoading: true };
    await render(<FlipdeskPayoutsWidget />);
    expect(container.querySelector('[data-testid="payouts-card"]')).toBeNull();
  });
});

describe("WidgetBoard Try again", () => {
  it("remounts a widget that threw", async () => {
    let throws = true;
    function Flaky() {
      if (throws) throw new Error("boom");
      return <p>recovered</p>;
    }
    const def = {
      id: "test.flaky",
      surface: "grading",
      title: "Flaky",
      blurb: "A test widget",
      category: "data",
      sizes: ["md"],
      defaultSize: "md",
      rangeAware: false,
      personas: ["seller"],
      queryKeys: [],
      load: () => Promise.resolve({ default: Flaky }),
    } as unknown as WidgetDef;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await render(
      <WidgetBoard
        surface="grading"
        layout={[{ id: "test.flaky", size: "md" }]}
        registry={[def]}
      />,
    );
    await vi.waitFor(() => expect(container.textContent).toContain("could not load"));
    throws = false;
    await act(async () => retryButton()!.click());
    await vi.waitFor(() => expect(container.textContent).toContain("recovered"));
    errSpy.mockRestore();
  });
});
