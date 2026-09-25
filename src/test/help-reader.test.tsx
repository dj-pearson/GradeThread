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
import { settle } from "./helpers/mount";

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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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
