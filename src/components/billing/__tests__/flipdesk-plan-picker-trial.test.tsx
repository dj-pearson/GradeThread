// US-3457: a signup trialist must be able to buy the plan they are trialing.
//
// handle_new_user stamps every seller signup plan 'pro' / status 'trialing'
// with no Stripe subscription. The picker read that as "already on Pro" and
// rendered a disabled "Current plan" button on the one tile every trial CTA
// points at. These cases render the picker with that exact summary and press
// the button.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useBillingSummary,
  useFlipdeskSubscribe,
  useBillingPortal,
  useScheduleDowngrade,
  useUpgradePreview,
  useBuyerSubscribe,
  useBuyerUpgradePreview,
} from "@/hooks/use-billing-summary";
import { FlipdeskPlanPickerDialog } from "@/components/billing/flipdesk-plan-picker-dialog";

vi.mock("@/hooks/use-billing-summary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-billing-summary")>();
  return {
    ...actual,
    useBillingSummary: vi.fn(),
    useFlipdeskSubscribe: vi.fn(),
    useBillingPortal: vi.fn(),
    useScheduleDowngrade: vi.fn(),
    useUpgradePreview: vi.fn(),
    useBuyerSubscribe: vi.fn(),
    useBuyerUpgradePreview: vi.fn(),
  };
});
vi.mock("@/hooks/use-discounts", () => ({
  useDiscounts: () => ({ priceFor: () => null }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const mockedSummary = vi.mocked(useBillingSummary);
const mockedSubscribe = vi.mocked(useFlipdeskSubscribe);
const mockedPortal = vi.mocked(useBillingPortal);

const DAY = 86_400_000;

function summary(overrides: Record<string, unknown>) {
  return {
    data: {
      subscription: {
        plan: "pro",
        interval: null,
        status: "trialing",
        period_end: null,
        pause_until: null,
        cancel_at_period_end: false,
        trial_ends_at: new Date(Date.now() + 3 * DAY - 60_000).toISOString(),
        stripe_customer_id: null,
        billing_source: null,
        pending_plan: null,
        pending_interval: null,
        pending_effective_at: null,
        upcoming_invoice: null,
        ...overrides,
      },
    },
  } as unknown as ReturnType<typeof useBillingSummary>;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const mutate = vi.fn();

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<FlipdeskPlanPickerDialog open onOpenChange={() => {}} />),
  );
}

function buttons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button"));
}
function buttonNamed(text: string): HTMLButtonElement | undefined {
  return buttons().find((b) => (b.textContent ?? "").trim() === text);
}

beforeEach(() => {
  mutate.mockReset();
  mockedSummary.mockReset();
  mockedSubscribe.mockReturnValue({
    mutate,
    isPending: false,
    variables: undefined,
  } as unknown as ReturnType<typeof useFlipdeskSubscribe>);
  mockedPortal.mockReturnValue({ mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof useBillingPortal>);
  const idle = { mutate: vi.fn(), isPending: false, data: undefined } as never;
  vi.mocked(useScheduleDowngrade).mockReturnValue(idle);
  vi.mocked(useUpgradePreview).mockReturnValue(idle);
  vi.mocked(useBuyerSubscribe).mockReturnValue(idle);
  vi.mocked(useBuyerUpgradePreview).mockReturnValue(idle);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("FlipdeskPlanPickerDialog on the signup trial (US-3457)", () => {
  it("sells the trialed plan as a live 'keep it' button that starts Checkout", async () => {
    mockedSummary.mockReturnValue(summary({}));
    await render();

    expect(buttonNamed("Current plan")).toBeUndefined();
    const keep = buttonNamed("Keep Pro, add a card");
    expect(keep).toBeDefined();
    expect(keep!.disabled).toBe(false);

    await act(async () => keep!.click());
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ plan: "pro", interval: "monthly" });
  });

  it("badges the trialed tile 'Your trial' and states the days LEFT, not 14", async () => {
    mockedSummary.mockReturnValue(summary({}));
    await render();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Your trial");
    expect(text).toContain("3 days left free");
    expect(text).not.toContain("14-day free trial");
    expect(text).toContain("Free for 3 days");
    expect(text).not.toContain("Free for 14 days");
  });

  it("sends a Business pick straight to Checkout, not the in-place upgrade dialog", async () => {
    mockedSummary.mockReturnValue(summary({}));
    await render();
    const choose = buttonNamed("Choose Business");
    expect(choose).toBeDefined();
    await act(async () => choose!.click());
    expect(mutate).toHaveBeenCalledWith({ plan: "business", interval: "monthly" });
    expect(document.body.textContent).not.toContain("Confirm & pay");
  });

  it("offers Starter as a choice (Checkout), never as a downgrade of a subscription that does not exist", async () => {
    mockedSummary.mockReturnValue(summary({}));
    await render();
    expect(buttonNamed("Downgrade")).toBeUndefined();
    const choose = buttonNamed("Choose Starter");
    expect(choose).toBeDefined();
    await act(async () => choose!.click());
    expect(mutate).toHaveBeenCalledWith({ plan: "starter", interval: "monthly" });
  });

  it("says what the Free tile is: where the account lands after the trial", async () => {
    mockedSummary.mockReturnValue(summary({}));
    await render();
    const free = buttonNamed("Free after your trial");
    expect(free).toBeDefined();
    expect(free!.disabled).toBe(true);
  });

  it("a trialist who bought a credit pack (Stripe customer, no subscription) is still on the trial path", async () => {
    mockedSummary.mockReturnValue(summary({ stripe_customer_id: "cus_123" }));
    await render();
    expect(buttonNamed("Current plan")).toBeUndefined();
    expect(buttonNamed("Keep Pro, add a card")).toBeDefined();
    // The disclosure still states the trial Checkout will carry forward.
    expect(document.body.textContent).toContain("Free for 3 days");
  });
});

describe("FlipdeskPlanPickerDialog for a paying subscriber (unchanged)", () => {
  it("still marks a live Pro subscription as the current plan", async () => {
    mockedSummary.mockReturnValue(
      summary({
        status: "active",
        interval: "monthly",
        stripe_customer_id: "cus_123",
        billing_source: "stripe",
        trial_ends_at: null,
      }),
    );
    await render();
    const current = buttonNamed("Current plan");
    expect(current).toBeDefined();
    expect(current!.disabled).toBe(true);
    expect(buttonNamed("Keep Pro, add a card")).toBeUndefined();
    expect(document.body.textContent).toContain("Current");
    expect(document.body.textContent).not.toContain("Your trial");
  });

  it("a Stripe-managed trial (card already on file) is not the signup trial", async () => {
    mockedSummary.mockReturnValue(
      summary({
        status: "trialing",
        interval: "monthly",
        stripe_customer_id: "cus_123",
        billing_source: "stripe",
      }),
    );
    await render();
    expect(buttonNamed("Current plan")).toBeDefined();
    expect(buttonNamed("Keep Pro, add a card")).toBeUndefined();
  });
});
