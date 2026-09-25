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

describe("H7: search states follow the active query", () => {
  const hit = (slug: string, category_key: string) => ({
    slug, title: `Title ${slug}`, summary: `Summary ${slug}`, category_key, visibility: "public", rank: 1,
  });

  it("a pending search shows loading, never 'Nothing matched'", async () => {
    handler = (path) => {
      if (path.startsWith("/api/help/search")) return new Promise<Response>(() => {});
      return defaultIndex();
    };
    render("/dashboard/help?q=returns");
    await settle(20);
    expect(text()).not.toContain("Nothing matched");
    expect(text()).toContain("Searching help");
  });

  it("a failed search shows the error state with Retry, not zero results", async () => {
    handler = (path) => {
      if (path.startsWith("/api/help/search")) return res({ error: "boom" }, 500);
      return defaultIndex();
    };
    render("/dashboard/help?q=returns");
    await settle(20);
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)); });
    await settle(20);
    expect(text()).toContain("Search didn't answer. Try again.");
    expect(text()).not.toContain("Nothing matched");
    expect(buttonByText(container, /Retry|Try again/)).toBeTruthy();
  });

  it("an index error does not sit above working search results", async () => {
    handler = (path) => {
      if (path.startsWith("/api/help/search")) {
        return res({ query: "returns", hits: [hit("refunds", "billing")], viewer: "member" });
      }
      if (path === "/api/help") return res({ error: "down" }, 500);
      return res({});
    };
    render("/dashboard/help?q=returns");
    await settle(20);
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)); });
    await settle(20);
    expect(text()).toContain("Title refunds");
    expect(text()).not.toContain("Couldn't load help");
  });
});

describe("H9: ranked search, editor-ordered browse", () => {
  const titles = () => Array.from(container.querySelectorAll("li a")).map((a) => a.textContent);

  it("search hits render in server (rank) order, not regrouped by category", async () => {
    handler = (path) => {
      if (path.startsWith("/api/help/search")) {
        return res({
          query: "fees",
          hits: [
            { slug: "b", title: "B hit", summary: "", category_key: "zeta", visibility: "public", rank: 0.9 },
            { slug: "a", title: "A hit", summary: "", category_key: "alpha", visibility: "public", rank: 0.1 },
          ],
          viewer: "member",
        });
      }
      return defaultIndex();
    };
    render("/dashboard/help?q=fees");
    await settle(20);
    expect(titles()).toEqual(["B hit", "A hit"]);
    expect(text()).toContain('2 results for "fees"');
  });

  it("browse puts category cards in the editor's sort_order", async () => {
    handler = (path) =>
      path === "/api/help"
        ? res({
            categories: [
              { ...CATEGORIES[0], key: "z", title: "Zebra", sort_order: 1 },
              { ...CATEGORIES[1], key: "a", title: "Apple", sort_order: 2 },
            ],
            articles: [listItem("in-a", "a"), listItem("in-z", "z")],
            viewer: "member",
          })
        : res({});
    render("/dashboard/help");
    await settle(20);
    const headings = Array.from(container.querySelectorAll("h2")).map((h2) => h2.textContent);
    expect(headings.slice(0, 2)).toEqual(["Zebra", "Apple"]);
  });

  it("the article h1 is just the title; the visibility badge sits outside it", async () => {
    handler = (path) =>
      path === "/api/help"
        ? defaultIndex()
        : res({ article: articleView("ops", { visibility: "internal" }), category: CATEGORIES[0], viewer: "admin" });
    render("/dashboard/help/ops");
    await settle(20);
    expect(container.querySelector("h1")?.textContent).toBe("Title ops");
    expect(text()).toContain("Internal");
  });
});

describe("H10: query and category live in the URL", () => {
  const input = () => container.querySelector<HTMLInputElement>("#help-reader-q")!;
  const setInput = async (value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
  };
  const searchHandler: Handler = (path) => {
    if (path.startsWith("/api/help/search")) {
      return res({
        query: "x",
        hits: [
          { slug: "refunds", title: "Refund hit", summary: "", category_key: "billing", visibility: "public", rank: 1 },
          { slug: "drafts", title: "Draft hit", summary: "", category_key: "listing", visibility: "public", rank: 0.5 },
        ],
        viewer: "member",
      });
    }
    if (path === "/api/help") return defaultIndex();
    const m = /^\/api\/help\/([a-z0-9-]+)$/.exec(path);
    return res({ article: articleView(m?.[1] ?? "x"), category: CATEGORIES[0], viewer: "member" });
  };

  it("Back after two searches puts the earlier query back in the box", async () => {
    handler = searchHandler;
    render("/dashboard/help?q=ab");
    await settle(20);
    await go("/dashboard/help?q=cd");
    expect(input().value).toBe("cd");
    await go(-1);
    expect(input().value).toBe("ab");
  });

  it("clearing the box returns to the browse view", async () => {
    handler = searchHandler;
    render("/dashboard/help?q=refund");
    await settle(20);
    expect(text()).toContain("Refund hit");
    await setInput("");
    await settle(20);
    expect(router.state.location.search).toBe("");
    expect(text()).toContain("Title refunds");
    expect(text()).not.toContain("Refund hit");
  });

  it("typing searches after a pause, without a submit", async () => {
    handler = searchHandler;
    render("/dashboard/help");
    await settle(20);
    await setInput("refund");
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    await settle(20);
    expect(new URLSearchParams(router.state.location.search).get("q")).toBe("refund");
    expect(text()).toContain("Refund hit");
  });

  it("?category= survives opening an article and coming Back", async () => {
    handler = searchHandler;
    render("/dashboard/help?category=billing");
    await settle(20);
    expect(text()).toContain("Title refunds");
    expect(text()).not.toContain("Title drafts");
    await go("/dashboard/help/refunds");
    await go(-1);
    await settle(20);
    expect(text()).toContain("Title refunds");
    expect(text()).not.toContain("Title drafts");
  });

  it("search honours the category filter", async () => {
    handler = searchHandler;
    render("/dashboard/help?q=fees&category=billing");
    await settle(20);
    expect(text()).toContain("Refund hit");
    expect(text()).not.toContain("Draft hit");
  });

  it("an unknown ?category= is ignored rather than emptying the page", async () => {
    handler = searchHandler;
    render("/dashboard/help?category=nope");
    await settle(20);
    expect(text()).toContain("Title refunds");
    expect(text()).toContain("Title drafts");
  });

  it("one letter shows the two-letter hint instead of searching", async () => {
    handler = searchHandler;
    render("/dashboard/help");
    await settle(20);
    await setInput("r");
    expect(text()).toContain("Type at least two letters to search.");
  });

  it("'/' focuses the search box", async () => {
    handler = searchHandler;
    render("/dashboard/help");
    await settle(20);
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    });
    expect(document.activeElement).toBe(input());
  });
});

describe("H12: the article leads somewhere", () => {
  it("related shows only articles this viewer can see, as in-app links", async () => {
    handler = (path) => {
      if (path === "/api/help") return defaultIndex();
      return res({
        article: articleView("start", { related_slugs: ["refunds", "internal-y"] }),
        category: CATEGORIES[0],
        viewer: "member",
      });
    };
    render("/dashboard/help/start");
    await settle(20);
    const related = Array.from(container.querySelectorAll("section")).find((s) =>
      s.querySelector("h2")?.textContent === "Related",
    );
    expect(related).toBeTruthy();
    const hrefs = Array.from(related!.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/dashboard/help/refunds"]);
  });

  it("two h2s give an 'On this page' list whose anchors match the heading ids", async () => {
    handler = (path) =>
      path === "/api/help"
        ? defaultIndex()
        : res({
            article: articleView("start", { body_html: "<h2>First step</h2><p>a</p><h2>Second step</h2>" }),
            category: CATEGORIES[0],
            viewer: "member",
          });
    render("/dashboard/help/start");
    await settle(20);
    const nav = container.querySelector('nav[aria-label="On this page"]');
    expect(nav).toBeTruthy();
    const anchors = Array.from(nav!.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(anchors).toEqual(["#first-step", "#second-step"]);
    const ids = Array.from(container.querySelectorAll(".prose h2")).map((h2) => h2.id);
    expect(ids).toEqual(["first-step", "second-step"]);
  });

  it("the crumb links to the index filtered to the article's category", async () => {
    render("/dashboard/help/refunds");
    await settle(20);
    const crumb = container.querySelector('nav[aria-label="Breadcrumb"]');
    const link = Array.from(crumb!.querySelectorAll("a")).find((a) => a.textContent === "Billing");
    expect(link?.getAttribute("href")).toBe("/dashboard/help?category=billing");
  });

  it("the hero is decorative and the date line is in UTC", async () => {
    handler = (path) =>
      path === "/api/help"
        ? defaultIndex()
        : res({
            article: articleView("start", {
              hero_image_url: "https://cdn.example/h.png",
              updated_at: "2026-09-01T00:00:00Z",
            }),
            category: CATEGORIES[0],
            viewer: "member",
          });
    render("/dashboard/help/start");
    await settle(20);
    const img = container.querySelector("article img");
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("loading")).toBe("eager");
    expect(text()).toContain("Updated September 1, 2026");
  });

  it("FAQ answers are disclosures keyed by question", async () => {
    handler = (path) =>
      path === "/api/help"
        ? defaultIndex()
        : res({
            article: articleView("start", { faq: [{ question: "Q1?", answer: "A1" }] }),
            category: CATEGORIES[0],
            viewer: "member",
          });
    render("/dashboard/help/start");
    await settle(20);
    expect(container.querySelector("details summary")?.textContent).toBe("Q1?");
  });
});

describe("H13: Help leads with the screen it was opened from", () => {
  const measureIndex = () =>
    res({
      categories: [
        { ...CATEGORIES[0], key: "flipdesk", title: "FlipDesk", sort_order: 1 },
        ...CATEGORIES,
      ],
      articles: [
        listItem("refunds", "billing"),
        listItem("the-four-inventory-views", "flipdesk"),
        listItem("using-the-measurecard", "flipdesk"),
      ],
      viewer: "member",
    });

  it("?from=measure-card pins a 'For MeasureCard' block led by its article", async () => {
    handler = (path) => (path === "/api/help" ? measureIndex() : res({}));
    render("/dashboard/help?from=measure-card");
    await settle(20);
    const card = Array.from(container.querySelectorAll("h2")).find((h2) =>
      h2.textContent === "For MeasureCard",
    )?.parentElement;
    expect(card).toBeTruthy();
    const links = Array.from(card!.querySelectorAll("li a")).map((a) => a.getAttribute("href"));
    expect(links[0]).toBe("/dashboard/help/using-the-measurecard?from=measure-card");
    expect(links).toContain("/dashboard/help/the-four-inventory-views?from=measure-card");
    expect(links).not.toContain("/dashboard/help/refunds?from=measure-card");
  });

  it("an article opened from a screen offers the way back to it", async () => {
    render("/dashboard/help/refunds?from=measure-card");
    await settle(20);
    const back = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent === "Back to MeasureCard",
    );
    expect(back?.getAttribute("href")).toBe("/dashboard/flipdesk/measure-card");
  });

  it("an unknown ?from= is ignored", async () => {
    render("/dashboard/help?from=nope");
    await settle(20);
    expect(text()).not.toContain("For ");
  });
});

describe("H14: definitions in search, and a ticket that carries the question", () => {
  const empty: Handler = (path) =>
    path.startsWith("/api/help/search")
      ? res({ query: "x", hits: [], viewer: "member" })
      : defaultIndex();

  it("searching 'comp' shows the Comp definition, linked into the glossary", async () => {
    handler = empty;
    render("/dashboard/help?q=comp");
    await settle(20);
    const link = Array.from(container.querySelectorAll("dt a")).find((a) => a.textContent === "Comp");
    expect(link?.getAttribute("href")).toBe("/dashboard/help/glossary#term-comp");
  });

  it("the zero-result ticket link carries what was typed", async () => {
    handler = empty;
    render("/dashboard/help?q=where%20is%20my%20payout");
    await settle(20);
    const ticket = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Open a support ticket"),
    );
    expect(ticket?.getAttribute("href")).toBe("/dashboard/support?subject=where%20is%20my%20payout");
  });

  it("the tracked search payload has no query text", async () => {
    handler = empty;
    render("/dashboard/help?q=order%2012345");
    await settle(20);
    const call = mocks.track.mock.calls.find(([name]) => String(name).startsWith("help_search"));
    expect(call).toBeTruthy();
    expect(call![1]).not.toHaveProperty("query");
    expect(call![1]).toMatchObject({ length: 11, hits: 0, surface: "app" });
  });
});
