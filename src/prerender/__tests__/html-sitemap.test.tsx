import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement as h, StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { HtmlSitemapPage } from "@/pages/marketing/sitemap";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";

// US-291 (indexability): the human HTML sitemap must link EVERY registered
// public page (minus home + itself), so the long programmatic tail is reachable
// via internal links. If a future page is added to PUBLIC_ROUTES but the
// sitemap's categorizer drops it, this fails.

function ssr(): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    h(StrictMode, null,
      h(QueryClientProvider, { client: qc },
        h(MemoryRouter, { initialEntries: ["/sitemap"] }, h(HtmlSitemapPage)))),
  );
}

describe("HTML sitemap page", () => {
  const html = ssr();

  it("links every registered public route (except home and itself)", () => {
    const missing = PUBLIC_ROUTES.map((r) => r.path)
      .filter((p) => p !== "/" && p !== "/sitemap")
      .filter((p) => !html.includes(`href="${p}"`));
    expect(missing).toEqual([]);
  });

  it("surfaces the pSEO hubs and dynamic index hubs", () => {
    for (const hub of [
      "/compare",
      "/reselling",
      "/grading/glossary",
      // US-9012 moved the flaw library from /grading/flaws to /care and left a
      // 301 behind. The sitemap links where the page IS, not where it was — a
      // sitemap that lists a redirect is a sitemap that costs a crawl hop on
      // every entry under it.
      "/care",
      "/tools/grade-checker",
      "/condition-index",
      "/value",
      "/durability",
      "/blog",
    ]) {
      expect(html, `sitemap should link ${hub}`).toContain(`href="${hub}"`);
    }
  });
});
