// H13: HelpLink decides from the cached reader index, fetches the body only
// when opened, and links into Help on this screen when there is no article.
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, settle } from "./helpers/mount";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: mocks.fetch }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn(), identify: vi.fn() }));

import { HelpLink } from "@/components/help/help-link";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let paths: string[];
let indexArticles: Array<Record<string, unknown>>;

beforeEach(() => {
  paths = [];
  indexArticles = [
    {
      slug: "using-the-measurecard",
      title: "Using the MeasureCard",
      summary: "Print it at the right size.",
      category_key: "flipdesk",
      visibility: "public",
    },
  ];
  mocks.fetch.mockReset().mockImplementation(async (path: string) => {
    paths.push(path);
    if (path === "/api/help") return res({ categories: [], articles: indexArticles, viewer: "member" });
    return res({
      article: { ...indexArticles[0], body_html: "<p>Card body</p>", faq: [], related_slugs: [] },
      category: null,
      viewer: "member",
    });
  });
});

describe("HelpLink", () => {
  it("makes no article request until the sheet is opened", async () => {
    const m = mount(<HelpLink slug="using-the-measurecard" />, "/dashboard/flipdesk/measure-card");
    await settle(20);
    const button = m.container.querySelector<HTMLButtonElement>('button[aria-label="Help: Using the MeasureCard"]');
    expect(button).toBeTruthy();
    expect(paths).toEqual(["/api/help"]);
    await act(async () => button!.click());
    await settle(20);
    expect(paths).toContain("/api/help/using-the-measurecard");
    expect(document.body.textContent).toContain("Card body");
    m.unmount();
  });

  it("with no article, links to Help opened from this screen", async () => {
    indexArticles = [];
    const m = mount(<HelpLink slug="using-the-measurecard" />, "/dashboard/flipdesk/measure-card");
    await settle(20);
    const link = m.container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/dashboard/help?from=measure-card");
    expect(paths).toEqual(["/api/help"]);
    m.unmount();
  });

  it("shows a retry, not an endless skeleton, when the article fails", async () => {
    mocks.fetch.mockImplementation(async (path: string) => {
      paths.push(path);
      if (path === "/api/help") return res({ categories: [], articles: indexArticles, viewer: "member" });
      return res({ error: "Not found" }, 404);
    });
    const m = mount(<HelpLink slug="using-the-measurecard" />, "/dashboard/flipdesk/measure-card");
    await settle(20);
    const button = m.container.querySelector<HTMLButtonElement>('button[aria-label="Help: Using the MeasureCard"]');
    await act(async () => button!.click());
    await settle(20);
    expect(document.body.textContent).toContain("This article didn't load.");
    expect(document.body.textContent).toContain("Try again");
    m.unmount();
  });

  it("closes the sheet when a link in the body navigates", async () => {
    mocks.fetch.mockImplementation(async (path: string) => {
      paths.push(path);
      if (path === "/api/help") return res({ categories: [], articles: indexArticles, viewer: "member" });
      return res({
        article: {
          ...indexArticles[0],
          body_html: '<p><a href="/help/flipdesk/other-article">other</a></p>',
          faq: [],
          related_slugs: [],
        },
        category: null,
        viewer: "member",
      });
    });
    const m = mount(<HelpLink slug="using-the-measurecard" />, "/dashboard/flipdesk/measure-card");
    await settle(20);
    const button = m.container.querySelector<HTMLButtonElement>('button[aria-label="Help: Using the MeasureCard"]');
    await act(async () => button!.click());
    await settle(20);
    const link = document.body.querySelector<HTMLAnchorElement>('a[href="/help/flipdesk/other-article"]');
    expect(link).toBeTruthy();
    await act(async () => link!.click());
    await settle(20);
    expect(document.body.querySelector('a[href="/help/flipdesk/other-article"]')).toBeNull();
    m.unmount();
  });
});
