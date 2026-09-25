// /dashboard/help: the in-app Help reader.
//
// Rendered for real against a mocked edgeFetch, so what these pin is what a
// signed-in seller sees: not-found vs retry, votes that record honestly, search
// states that follow the active query, and ranking that survives the page.
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonByText, settle } from "./helpers/mount";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), track: vi.fn() }));

vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: mocks.fetch }));
vi.mock("@/lib/analytics", () => ({ track: mocks.track, identify: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { HelpReaderPage } from "@/pages/help-reader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!("ResizeObserver" in globalThis)) {
  Object.assign(globalThis, {
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
window.scrollTo = (() => {}) as typeof window.scrollTo;

type Handler = (path: string, init: { method?: string; json?: unknown }) => Promise<Response> | Response;

function res(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const CATEGORIES = [
  { key: "billing", title: "Billing", slug: "billing", summary: "", sort_order: 1, icon: null, article_count: 1 },
  { key: "listing", title: "Listing", slug: "listing", summary: "", sort_order: 2, icon: null, article_count: 1 },
];

function listItem(slug: string, category_key: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    title: `Title ${slug}`,
    summary: `Summary ${slug}`,
    category_key,
    audience: "all",
    visibility: "public",
    sort_order: 1,
    updated_at: "2026-09-01T00:00:00Z",
    reviewed_at: null,
    ...extra,
  };
}

function articleView(slug: string, extra: Record<string, unknown> = {}) {
  return {
    ...listItem(slug, "billing"),
    body_html: `<p>Body of ${slug}</p>`,
    hero_image_url: null,
    faq: [],
    related_slugs: [],
    video_url: null,
    pillar_path: null,
    published_at: "2026-09-01T00:00:00Z",
    ...extra,
  };
}

let handler: Handler;
let calls: Array<{ path: string; method: string; json?: unknown }>;
let root: Root | null = null;
let container: HTMLDivElement;
let router: ReturnType<typeof createMemoryRouter>;

function defaultIndex() {
  return res({
    categories: CATEGORIES,
    articles: [listItem("refunds", "billing"), listItem("drafts", "listing")],
    viewer: "member",
  });
}

beforeEach(() => {
  calls = [];
  handler = (path) => {
    if (path === "/api/help") return defaultIndex();
    const m = /^\/api\/help\/([a-z0-9-]+)$/.exec(path);
    if (m) return res({ article: articleView(m[1]!), category: CATEGORIES[0], viewer: "member" });
    return res({ ok: true, recorded: true });
  };
  mocks.track.mockReset();
  mocks.fetch.mockReset().mockImplementation(async (path: string, init: { method?: string; json?: unknown } = {}) => {
    calls.push({ path, method: init.method ?? "GET", json: init.json });
    return handler(path, init);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
});

function render(url: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  // Default gcTime on purpose: an article already in the cache is exactly when
  // a stale tree position shows, because the switch is synchronous.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  router = createMemoryRouter(
    [
      { path: "/dashboard/help", element: h(HelpReaderPage) },
      { path: "/dashboard/help/:slug", element: h(HelpReaderPage) },
      { path: "*", element: h("p", null, "elsewhere") },
    ],
    { initialEntries: [url] },
  );
  act(() => {
    root = createRoot(container);
    root.render(h(QueryClientProvider, { client }, h(RouterProvider, { router })));
  });
  return { client };
}

async function go(to: string | number) {
  await act(async () => {
    if (typeof to === "number") await router.navigate(to);
    else await router.navigate(to);
  });
  await settle();
}

async function click(el: Element | undefined | null) {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

const text = () => container.textContent ?? "";
const articleCalls = (slug: string) => calls.filter((c) => c.path === `/api/help/${slug}`);

describe("H4: not-found is decided by status, not by message text", () => {
  it("a 404 whose body says 'Gone' renders the not-found state and does not retry", async () => {
    handler = (path) => (path === "/api/help/missing" ? res({ error: "Gone" }, 404) : defaultIndex());
    render("/dashboard/help/missing");
    await settle(20);
    expect(text()).toContain("We couldn't find that article");
    expect(text()).not.toContain("Couldn't load this article");
    expect(articleCalls("missing")).toHaveLength(1);
  });

  it("a 500 renders the retry error, not the not-found state", async () => {
    handler = (path) => (path === "/api/help/broken" ? res({ error: "Not found" }, 500) : defaultIndex());
    render("/dashboard/help/broken");
    await settle(20);
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)); });
    await settle(20);
    expect(text()).toContain("Couldn't load this article");
    expect(text()).not.toContain("We couldn't find that article");
  });
});

describe("H5: each article gets its own reader", () => {
  it("a vote on article A does not hide the vote buttons on article B", async () => {
    render("/dashboard/help/drafts");
    await settle(20);
    await go("/dashboard/help/refunds");
    await settle(20);
    await click(buttonByText(container, "Yes"));
    expect(buttonByText(container, "Yes")).toBeUndefined();
    await go("/dashboard/help/drafts");
    await settle(20);
    expect(text()).toContain("Body of drafts");
    expect(buttonByText(container, "Yes")).toBeTruthy();
    expect(buttonByText(container, "No")).toBeTruthy();
  });

  it("focuses the new article's title when it opens", async () => {
    render("/dashboard/help/refunds");
    await settle(20);
    await go("/dashboard/help/drafts");
    await settle(20);
    expect(document.activeElement?.tagName).toBe("H1");
    expect(document.activeElement?.textContent).toContain("Title drafts");
  });
});

describe("H6: a vote is thanked only once the server has it", () => {
  const feedbackCalls = () => calls.filter((c) => c.path.endsWith("/feedback"));

  it("disables the buttons while the vote is in flight", async () => {
    let release: (r: Response) => void = () => {};
    handler = (path) => {
      if (path.endsWith("/feedback")) return new Promise<Response>((r) => { release = r; });
      if (path === "/api/help") return defaultIndex();
      return res({ article: articleView("refunds"), category: CATEGORIES[0], viewer: "member" });
    };
    render("/dashboard/help/refunds");
    await settle(20);
    await click(buttonByText(container, "Yes"));
    expect(buttonByText(container, "Yes")?.disabled).toBe(true);
    expect(buttonByText(container, "No")?.disabled).toBe(true);
    expect(text()).not.toContain("Thanks");
    await act(async () => release(res({ ok: true, recorded: true })));
    await settle();
    expect(text()).toContain("Thanks.");
  });

  it("recorded:false shows the retry message and keeps the buttons", async () => {
    handler = (path) => {
      if (path.endsWith("/feedback")) return res({ ok: true, recorded: false });
      if (path === "/api/help") return defaultIndex();
      return res({ article: articleView("refunds"), category: CATEGORIES[0], viewer: "member" });
    };
    render("/dashboard/help/refunds");
    await settle(20);
    await click(buttonByText(container, "Yes"));
    expect(text()).toContain("That didn't save. Try again.");
    expect(text()).not.toContain("Thanks");
    expect(buttonByText(container, "Yes")?.disabled).toBe(false);
    expect(mocks.track).not.toHaveBeenCalledWith("help_feedback_vote", expect.anything());
  });

  it("a failed request keeps the buttons live for a retry", async () => {
    handler = (path) => {
      if (path.endsWith("/feedback")) return res({ error: "boom" }, 500);
      if (path === "/api/help") return defaultIndex();
      return res({ article: articleView("refunds"), category: CATEGORIES[0], viewer: "member" });
    };
    render("/dashboard/help/refunds");
    await settle(20);
    await click(buttonByText(container, "Yes"));
    expect(text()).toContain("That didn't save. Try again.");
    expect(buttonByText(container, "Yes")).toBeTruthy();
  });

  it("No asks what was missing, then Send posts ONE request carrying the comment", async () => {
    render("/dashboard/help/refunds");
    await settle(20);
    await click(buttonByText(container, "No"));
    expect(feedbackCalls()).toHaveLength(0);
    await click(buttonByText(container, "Out of date"));
    await click(buttonByText(container, "Send"));
    expect(feedbackCalls()).toHaveLength(1);
    expect(feedbackCalls()[0]!.json).toEqual({ helpful: "no", comment: "Out of date" });
    expect(text()).toContain("We'll take another look");
    const link = container.querySelector('a[href="/dashboard/support?article=refunds"]');
    expect(link?.textContent).toBe("Open a ticket about this article");
  });
});
