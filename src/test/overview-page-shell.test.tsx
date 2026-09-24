import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewViewSwitcher } from "@/components/dashboard/overview-view-switcher";
import { OVERVIEW_VIEW_DEFS } from "@/lib/overview-view";
import {
  overviewRangeKey,
  parseOverviewRange,
  resolveOverviewRange,
} from "@/lib/overview-range";

// DASH-11: an accessible view switcher, a remembered and alias-tolerant range,
// links rather than buttons, and one greeting.

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ profile: { full_name: "Jordan Q. Public", use_case: "seller" } }),
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (select: (s: { user: { id: string } }) => unknown) =>
    select({ user: { id: "u1" } }),
}));
vi.mock("@/components/flipdesk/pwa-install-banner", () => ({
  PwaInstallBanner: ({ variant }: { variant: string }) => (
    <div data-testid="pwa" data-variant={variant} />
  ),
}));
vi.mock("@/components/dashboard/customize-board", () => ({
  CustomizableWidgetBoard: (props: {
    subtitle: React.ReactNode;
    actions: React.ReactNode;
    lead: React.ReactNode;
  }) => (
    <div>
      <div data-testid="subtitle">{props.subtitle}</div>
      <div data-testid="actions">{props.actions}</div>
      {props.lead}
    </div>
  ),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "is", "order", "limit", "in"]) chain[m] = () => chain;
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: [{ id: "sub-1", title: "Denim jacket", status: "pending", created_at: "2026-09-01" }],
          error: null,
        }).then(resolve);
      return chain;
    },
  },
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("OverviewViewSwitcher", () => {
  it("moves selection with the arrow keys and keeps one tab stop", async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <OverviewViewSwitcher views={OVERVIEW_VIEW_DEFS} value="grading" onChange={onChange} />,
      )
    );
    const radios = [...container.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1]);
    await act(async () => {
      radios[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("flipdesk");
    expect(document.activeElement).toBe(radios[1]);
    await act(async () => {
      radios[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith("flipdesk");
  });
});

describe("the range", () => {
  it("accepts the documented legacy aliases", () => {
    expect(parseOverviewRange("30d")).toBe("d30");
    expect(parseOverviewRange("7d")).toBe("d7");
    expect(parseOverviewRange("90d")).toBe("d90");
    expect(parseOverviewRange("d30")).toBe("d30");
    expect(parseOverviewRange("nonsense")).toBeNull();
  });

  it("resolves URL first, then memory, then 7 days", () => {
    expect(resolveOverviewRange("30d", "ytd")).toBe("d30");
    expect(resolveOverviewRange(null, "ytd")).toBe("ytd");
    expect(resolveOverviewRange("junk", null)).toBe("d7");
  });
});

describe("DashboardPage", () => {
  async function renderPage(url: string) {
    const { DashboardPage } = await import("@/pages/dashboard");
    const router = createMemoryRouter([{ path: "/dashboard", element: <DashboardPage /> }], {
      initialEntries: [url],
    });
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    return router;
  }

  it("rewrites ?range=30d to the canonical d30 and remembers it", async () => {
    const router = await renderPage("/dashboard?view=flipdesk&range=30d");
    await vi.waitFor(() =>
      expect(new URLSearchParams(router.state.location.search).get("range")).toBe("d30")
    );
    expect(localStorage.getItem(overviewRangeKey("u1")!)).toBe("d30");
  });

  it("opens on the remembered range when the URL has none", async () => {
    localStorage.setItem(overviewRangeKey("u1")!, "ytd");
    const router = await renderPage("/dashboard?view=flipdesk");
    await vi.waitFor(() =>
      expect(new URLSearchParams(router.state.location.search).get("range")).toBe("ytd")
    );
  });

  it("drops ?range= on the grading view", async () => {
    const router = await renderPage("/dashboard?view=grading&range=d30");
    await vi.waitFor(() =>
      expect(new URLSearchParams(router.state.location.search).has("range")).toBe(false)
    );
  });

  it("greets by first name, shows the view subtitle, and New Submission is a link", async () => {
    await renderPage("/dashboard?view=grading");
    const subtitle = container.querySelector('[data-testid="subtitle"]')!.textContent;
    expect(subtitle).toContain("Welcome back, Jordan.");
    expect(subtitle).not.toContain("Public");
    expect(subtitle).toContain(OVERVIEW_VIEW_DEFS[0]!.subtitle);
    const link = [...container.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("New Submission")
    );
    expect(link?.getAttribute("href")).toBe("/dashboard/submissions/new");
  });

  it("uses the FlipDesk PWA copy on the FlipDesk view", async () => {
    await renderPage("/dashboard?view=flipdesk");
    expect(container.querySelector('[data-testid="pwa"]')!.getAttribute("data-variant"))
      .toBe("flipdesk");
  });
});

describe("recent submissions", () => {
  it("renders each row as an anchor with an href", async () => {
    const { GradingRecentSubmissionsWidget } = await import(
      "@/components/dashboard/widgets/grading-recent-submissions"
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <GradingRecentSubmissionsWidget />
          </MemoryRouter>
        </QueryClientProvider>,
      )
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Denim jacket"));
    const row = [...container.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("Denim jacket")
    );
    expect(row?.getAttribute("href")).toBe("/dashboard/submissions/sub-1");
    client.clear();
  });
});
