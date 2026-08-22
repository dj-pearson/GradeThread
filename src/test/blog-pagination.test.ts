// US-2099: /blog was hard-capped at 20 posts with no pagination.
//
// The hub fetched ?limit=20 and rendered them wholesale, so post 21 and older
// had NO crawl path from the hub — reachable only from a tag page or the
// sitemap. Tag pages were unpaginated too. That capped the blog's crawlable
// surface permanently, regardless of how much the content engine produces,
// which is why it was worth fixing BEFORE switching that engine on (US-2104).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const blog = read("functions/blog/[[path]].ts");
// Comments in the source DOCUMENT the old values they replaced ("was
// logo_icon_512.png", "was `${tag} — GradeThread Blog`"), so any assertion that
// something is ABSENT has to read code, not prose. This has bitten repeatedly:
// a guard that greps its own explanation is measuring documentation.
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const blogCode = stripComments(blog);
const nav = read("functions/_shared/blog-pagination.ts");
const sitemap = read("functions/_shared/sitemap.ts");
const edge = read("services/edge-functions/src/routes/content-public.ts");

describe("US-2099: crawlable blog pagination", () => {
  it("AC1: /blog/page/N is routed and offset-driven", () => {
    expect(blog).toMatch(/segments\[0\] === "page"/);
    expect(blog, "must page by offset, not re-fetch the first 20").toMatch(
      /offset=\$\{offset\}/,
    );
  });

  it("AC1: pagination links are real anchors, not JS", () => {
    // JS-only pagination is invisible to the crawlers this exists for.
    //
    // US-2789: the nav MOVED to functions/_shared/blog-pagination.ts so a test
    // could call it (src/test/blog-pagination-nav.test.ts, which holds what the
    // links actually resolve to). This assertion follows it and keeps the
    // property the call cannot see — that the markup is an anchor at all.
    expect(nav).toMatch(/<a rel="prev"/);
    expect(nav).toMatch(/<a rel="next"/);
    // And that the route still USES it. A perfect nav nothing renders is the
    // same missing crawl path.
    expect(blog, "the blog route no longer renders the pagination nav").toMatch(
      /paginationNav\(/,
    );
  });

  it("AC2: tag pages paginate on the same scheme", () => {
    expect(blog).toMatch(/segments\[2\] === "page"/);
    expect(blog).toMatch(/allPosts\.slice\(/);
  });

  it("AC3: paginated pages self-canonical", () => {
    // Canonicalising page N to /blog would tell engines pages 2+ are duplicates
    // of page 1 — dropping the exact posts this pagination exists to expose.
    expect(blog).toMatch(/page === 1 \? `\$\{siteUrl\(env\)\}\/blog` : `\$\{siteUrl\(env\)\}\/blog\/page\/\$\{page\}`/);
    expect(blog).toMatch(/page === 1 \? tagBase : `\$\{tagBase\}\/page\/\$\{page\}`/);
  });

  it("page 1 redirects rather than existing at two URLs", () => {
    // /blog and /blog/page/1 would otherwise be duplicate content.
    expect(blog).toMatch(/if \(n === 1\) return Response\.redirect/);
  });

  it("a page past the end 404s instead of indexing an empty listing", () => {
    expect(blog).toMatch(/page > totalPages && page > 1/);
  });

  it("AC4: paginated hub URLs reach the sitemap", () => {
    expect(sitemap).toMatch(/\/blog\/page\/\$\{n\}/);
  });

  it("AC5: tag title uses the site-wide separator, not an em dash", () => {
    expect(blog, "every other page uses ' | GradeThread'").toMatch(
      /\| GradeThread Blog`/,
    );
    expect(blogCode).not.toMatch(/\$\{tag\} — GradeThread Blog/);
  });

  it("AC5: tag OG image is the wide card asset, not the square logo", () => {
    // logo_icon_512.png is square and crops badly on summary_large_image.
    // Scoped to ogImage deliberately: logo_icon_512.png is still CORRECT as
    // Organization.logo in the JSON-LD, where a square mark is what schema.org
    // wants. A blanket "this file must not mention the square logo" assertion
    // would have pushed me to break valid markup.
    const ogImageLines = blogCode
      .split("\n")
      .filter((l) => /ogImage|hero_image_width[\s\S]*/.test(l) || /\?\?\s*`\$\{siteUrl\(env\)\}\//.test(l));
    expect(ogImageLines.join("\n")).not.toMatch(/logo_icon_512\.png/);
    expect(blogCode).toMatch(/ogImage: `\$\{siteUrl\(env\)\}\/og-image\.png`/);
  });
});

describe("US-2099: the offset endpoint", () => {
  it("supports offset and reports a total", () => {
    expect(edge).toMatch(/const useOffset = !cursor && offset > 0/);
    expect(edge).toMatch(/q\.range\(offset, offset \+ limit - 1\)/);
    expect(edge).toMatch(/next_cursor: nextCursor, total/);
  });

  it("cursor still WINS over offset, so existing callers are unchanged", () => {
    // The cursor is the more precise mechanism and API consumers already use
    // it; offset exists only so a page number can be a stable URL.
    expect(edge).toMatch(/!cursor && offset > 0/);
  });

  it("a negative or non-numeric offset degrades to 0 rather than throwing", () => {
    expect(edge).toMatch(/Number\.isFinite\(rawOffset\) && rawOffset > 0/);
  });
});
