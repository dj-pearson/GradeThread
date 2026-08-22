import { escape } from "./blog-render";

// US-2099: the crawlable prev/next nav for the blog hub and tag pages.
//
// ITS OWN MODULE (US-2789) so a test can call it. It was pure already, and the
// guard still asserted its BEHAVIOUR by matching source text - which cannot
// tell a working prev link from a broken one.
//
// It could not simply be exported from functions/blog/[[path]].ts: importing
// that route into a vitest suite drags `PagesFunction` and the rest of the
// Cloudflare Workers ambient types into the src tsconfig project, which does
// not declare them, and `tsc -b` fails inside functions/_shared/head-of.ts -
// a file the test never mentions. Every other functions/ unit test in this repo
// imports from _shared/ for the same reason.

/**
 * US-2099: crawlable prev/next links.
 *
 * Plain <a href> on purpose — JS-only pagination is invisible to the crawlers
 * this exists for. rel="prev"/"next" additionally tells an engine the pages are
 * one ordered series rather than near-duplicates.
 *
 * US-2789: EXPORTED so the test can call it. It was pure already and the guard
 * still asserted its BEHAVIOUR by matching source text — which cannot tell a
 * working prev link from a broken one, and cannot see the property that matters
 * most here: page 1 must link to the bare basePath and never to `/page/1`,
 * because the two would be the same content on two URLs, which is exactly the
 * near-duplicate the rel tags exist to deny.
 */
export function paginationNav(basePath: string, page: number, totalPages: number): string {
  if (totalPages <= 1) return "";
  const href = (n: number) => (n === 1 ? basePath : `${basePath}/page/${n}`);
  const parts: string[] = [];
  if (page > 1) {
    parts.push(`<a rel="prev" href="${escape(href(page - 1))}">← Newer posts</a>`);
  }
  parts.push(`<span>Page ${page} of ${totalPages}</span>`);
  if (page < totalPages) {
    parts.push(`<a rel="next" href="${escape(href(page + 1))}">Older posts →</a>`);
  }
  return `<nav class="pagination" style="display:flex;gap:16px;align-items:center;justify-content:center;margin-top:32px">${parts.join(
    "",
  )}</nav>`;
}


