import { describe, expect, it } from "vitest";
import { paginationNav } from "../../functions/_shared/blog-pagination";

// US-2099 / US-2789: the crawlable prev/next nav, tested by CALLING it.
//
// src/test/blog-pagination.test.ts asserts this function's behaviour by matching
// its SOURCE TEXT. That holds the spelling and cannot tell a working prev link
// from a broken one — and it cannot see the property that matters most here at
// all, because that property is about a URL the function must NOT produce.
//
// WHY THIS ONE IS WORTH CALLING. Every assertion below is an SEO fact rather
// than a cosmetic one:
//
//   • Page 1 must link to the BARE basePath, never `/page/1`. Both would serve
//     the same posts, so emitting the second creates the exact near-duplicate
//     pair that rel="prev"/"next" exists to deny — while the tags themselves
//     claim the series is ordered and distinct.
//   • A single page emits NOTHING. A nav saying "Page 1 of 1" with no links is
//     markup that tells a crawler a series exists and then offers no path.
//   • The first page has no prev and the last has no next. A link to page 0 or
//     to totalPages + 1 is a crawl path to a 404, which is worse than no link:
//     it spends crawl budget and reports a broken series.
//
// The scan STAYS. It holds where the nav is CALLED from — the index and tag
// renderers — which a unit test on a pure function cannot see.

const BASE = "/blog";

describe("paginationNav (US-2099)", () => {
  it("renders nothing when there is only one page", () => {
    expect(paginationNav(BASE, 1, 1)).toBe("");
    expect(paginationNav(BASE, 1, 0)).toBe("");
  });

  it("page 1 links to the bare base path, never /page/1", () => {
    // The canonical-duplicate rule. /blog and /blog/page/1 are the same posts.
    const html = paginationNav(BASE, 2, 3);
    expect(html).toContain('href="/blog"');
    expect(html, "page 1 was linked as /blog/page/1, duplicating /blog").not.toContain(
      "/blog/page/1",
    );
  });

  it("the first page offers next and no prev", () => {
    const html = paginationNav(BASE, 1, 5);
    expect(html).toContain('rel="next"');
    expect(html, "page 1 linked to page 0").not.toContain('rel="prev"');
  });

  it("the last page offers prev and no next", () => {
    const html = paginationNav(BASE, 5, 5);
    expect(html).toContain('rel="prev"');
    expect(
      html,
      "the last page linked to a page past the end, which is a crawl path to a 404",
    ).not.toContain('rel="next"');
  });

  it("a middle page offers both, pointing one step each way", () => {
    const html = paginationNav(BASE, 3, 5);
    expect(html).toContain('href="/blog/page/2"');
    expect(html).toContain('href="/blog/page/4"');
    expect(html).toContain("Page 3 of 5");
  });

  it("uses plain anchors, because JS pagination is invisible to a crawler", () => {
    // The whole reason this renders server-side. A button or an onclick would
    // leave post 21 with no crawl path, which is the US-2099 defect returning.
    const html = paginationNav(BASE, 2, 3);
    expect(html).toMatch(/<a\s+rel="(prev|next)"\s+href=/);
    expect(html).not.toMatch(/onclick|<button/i);
  });

  it("escapes the base path rather than interpolating it raw", () => {
    // basePath reaches here from the request URL on a tag page. A raw
    // interpolation would put a visitor-supplied string inside an href on a
    // page served to everyone.
    const html = paginationNav('/blog/tag/"><script>x</script>', 2, 3);
    expect(html).not.toContain("<script>");
  });

  it("works for a tag base path, not only the hub", () => {
    const html = paginationNav("/blog/tag/denim", 2, 4);
    expect(html).toContain('href="/blog/tag/denim"');
    expect(html).toContain('href="/blog/tag/denim/page/3"');
  });
});
