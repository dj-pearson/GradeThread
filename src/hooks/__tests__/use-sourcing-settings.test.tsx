// SRC-2: Scout and the settings card read the SAME query. They used to share a
// key and cache different shapes under it (a number and an object), so opening
// the deal filter after Scout loaded blanked every cost draft, and a Save then
// wrote null over the seller's real costs.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "owner-1" } as { id: string },
  owner: "owner-1",
  upsert: vi.fn(),
  toastError: vi.fn(),
  reads: 0,
}));

const ROW = {
  sourcing_target_roi_pct: 40,
  sourcing_shipping_cost_cents: 1234,
  sourcing_supplies_cost_cents: 56,
  sourcing_grading_cost_cents: 78,
};

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => {
          mocks.reads++;
          return Promise.resolve({ data: ROW, error: null });
        },
        upsert: (...a: unknown[]) => {
          mocks.upsert(...a);
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
  },
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: mocks.user }),
}));
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ workspaceOwnerId: mocks.owner, can: () => true }),
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: vi.fn() } }));
vi.mock("@/components/flipdesk/forecast-card", () => ({ ForecastCard: () => null }));
vi.mock("@/hooks/use-plan-usage", () => ({
  usePlanUsage: () => ({ data: undefined, isLoading: false }),
}));

const { SourcingTargetSetting } = await import(
  "@/components/flipdesk/sourcing-target-setting"
);
const { FlipdeskScoutPage } = await import("@/pages/flipdesk/scout");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

function inputValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement).value;
}

beforeEach(() => {
  mocks.user = { id: "owner-1" };
  mocks.owner = "owner-1";
  mocks.upsert.mockReset();
  mocks.toastError.mockReset();
  mocks.reads = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("one sourcing-settings query", () => {
  it("Scout first, then the card: the card still shows the stored costs", async () => {
    await render(<FlipdeskScoutPage />);
    await render(
      <>
        <FlipdeskScoutPage />
        <SourcingTargetSetting />
      </>,
    );
    expect(inputValue("sourcing-target")).toBe("40");
    expect(inputValue("sourcing-cost-shipping")).toBe("12.34");
    expect(host.innerHTML).not.toContain("object");
  });

  it("Scout reads the target as a number, never [object Object]", async () => {
    await render(<SourcingTargetSetting />);
    await render(
      <>
        <SourcingTargetSetting />
        <FlipdeskScoutPage />
      </>,
    );
    expect(host.innerHTML).not.toContain("[object Object]");
  });

  it("12.5 is refused as not a whole percent and nothing is written", async () => {
    await render(<SourcingTargetSetting />);
    const input = document.getElementById("sourcing-target") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "12.5");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Save");
    await act(async () => {
      save!.click();
    });
    await flush();
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("whole percent"));
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("a member sees the card read-only, with no Save button and no read", async () => {
    mocks.user = { id: "member-1" };
    await render(<SourcingTargetSetting />);
    expect(host.textContent).toContain("Your workspace owner sets the profit target");
    expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent === "Save")).toBe(false);
    expect(mocks.reads).toBe(0);
  });
});
