import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement as h, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

// web-growth action 1 (US-2618): an empty Help Center hub is thin content, so
// the SPA hub must pass noindex while the loaded index has zero articles, and
// must NOT while it is loading, errored, or has articles. The SSR hub applies
// the same rule through helpHubRobots (src/test/help-ssr.test.ts).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hookState: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
} = { data: undefined, isLoading: false, isError: false };

vi.mock("@/hooks/use-help-center", () => ({
  usePublicHelpIndex: () => ({ ...hookState, refetch: vi.fn() }),
}));

// Record the noindex prop instead of rendering the real layout, which pulls in
// the auth store and the full marketing chrome.
vi.mock("@/components/marketing/marketing-layout", () => ({
  MarketingLayout: ({ noindex, children }: { noindex?: boolean; children: ReactNode }) =>
    h("div", { "data-testid": "layout", "data-noindex": String(Boolean(noindex)) }, children),
}));

const { HelpHubPage } = await import("../help/hub");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderHub(): Promise<string | null> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(h(MemoryRouter, null, h(HelpHubPage)));
  });
  return container.querySelector("[data-testid=layout]")?.getAttribute("data-noindex") ?? null;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  hookState.data = undefined;
  hookState.isLoading = false;
  hookState.isError = false;
});

const category = {
  key: "grading",
  slug: "grading",
  title: "Grading",
  summary: "How the scale works.",
  sort_order: 10,
  icon: null,
};

describe("SPA help hub robots", () => {
  it("is noindex when the loaded index has zero articles", async () => {
    hookState.data = { categories: [category], articles: [] };
    expect(await renderHub()).toBe("true");
  });

  it("is indexable once an article exists", async () => {
    hookState.data = {
      categories: [category],
      articles: [
        {
          slug: "the-scale",
          title: "The scale",
          summary: "",
          category_key: "grading",
          sort_order: 10,
          updated_at: "2026-08-01T00:00:00Z",
        },
      ],
    };
    expect(await renderHub()).toBe("false");
  });

  it("does not claim empty while loading or after an error", async () => {
    hookState.isLoading = true;
    expect(await renderHub()).toBe("false");
    act(() => root?.unmount());
    container?.remove();
    hookState.isLoading = false;
    hookState.isError = true;
    expect(await renderHub()).toBe("false");
  });
});
