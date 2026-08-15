// US-2097: a sitemap must never serve 200 while silently missing a section.
//
// fetchEdgeJson returned null on ANY error, and each *Urls() generator then fell
// back to []. The result was a structurally valid sitemap missing entire URL
// classes — served 200 and cached for an hour, which tells crawlers those pages
// do not exist. Worse, a dropped section could push the total back under
// SITEMAP_MAX_URLS and flip /sitemap.xml from a sitemapindex to a truncated
// single urlset, changing the document's SHAPE because of a network blip.
//
// rss.xml.ts was hardened against exactly this in US-2044. This asserts the
// sitemap got the same treatment — and, critically, that ALL of it did: the
// failure this guards against is the kind that gets fixed in one file and left
// in ten.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FUNCTIONS = join(process.cwd(), "functions");
const read = (f: string) => readFileSync(join(FUNCTIONS, f), "utf8");

describe("US-2097: sitemap upstream failures serve 503, not a partial 200", () => {
  it("fetchEdgeJson THROWS on an unreachable upstream", () => {
    const src = read("_shared/sitemap.ts");
    expect(
      src,
      "returning null made 'unreachable' indistinguishable from 'legitimately " +
        "empty', which is the entire defect",
    ).toMatch(/throw new UpstreamUnavailable/);
  });

  // A 404 is a real answer and must stay null — otherwise a genuinely absent
  // collection would take the whole sitemap down.
  it("a 404 is still treated as a real (empty) answer", () => {
    const src = read("_shared/sitemap.ts");
    expect(src).toMatch(/res\.status === 404/);
  });

  it("the sitemap index serves 503 rather than reshaping itself", () => {
    const src = read("sitemap.xml.ts");
    expect(src).toMatch(/UpstreamUnavailable/);
    expect(src).toMatch(/upstreamUnavailableResponse\(\)/);
  });

  // The one that matters most: EVERY sub-sitemap, not just the ones that were
  // convenient to edit.
  it("every sub-sitemap route is guarded", () => {
    const routes = readdirSync(FUNCTIONS).filter((f) => /^sitemap-.*\.xml\.ts$/.test(f));
    expect(routes.length).toBeGreaterThan(5);

    const unguarded = routes.filter((f) => {
      const src = read(f);
      // Either it delegates to the shared wrapper, or it carries its own guard.
      return !src.includes("sitemapResponse(") && !src.includes("UpstreamUnavailable");
    });

    expect(
      unguarded,
      "these sub-sitemaps can still serve a silently-incomplete 200 — the whole " +
        "point of this guard is that fixing one route and missing ten is the " +
        "normal outcome",
    ).toEqual([]);
  });

  it("the image sitemap carries its own guard (different serializer)", () => {
    // It can't use the shared wrapper because it serialises imageSitemapXml
    // rather than urlsetXml — and it was the one route the bulk rewrite could
    // not match, i.e. exactly the file that would otherwise have been missed.
    const src = read("sitemap-images.xml.ts");
    expect(src).toMatch(/UpstreamUnavailable/);
    expect(src).toMatch(/upstreamUnavailableResponse\(\)/);
  });
});

// ---------------------------------------------------------------------------
// US-2614: /sitemap.xml goes through the worker cache like every other SSR
// surface, and the 503 branch above must NOT be what gets cached.
//
// MEASURED 2026-08-15: /blog and /cert/:id both answered `x-gt-cache: HIT`;
// /sitemap.xml carried no such header, so it rebuilt on every request. That is
// expensive here in a way it is not elsewhere — the builder makes eleven
// parallel upstream fetches, against an edge that caps public content at 60
// requests per minute per IP and fails closed, with every SSR page arriving
// through one Pages worker. Eight uncached fetches is 88 calls, which is
// exactly how a probe drove this endpoint to 503 four times running.
describe("US-2614: the sitemap is cached, and its failure is not", () => {
  const src = readFileSync(join(process.cwd(), "functions/sitemap.xml.ts"), "utf8");

  it("wraps the handler in withEdgeCache", () => {
    expect(src).toContain("withEdgeCache");
    expect(src).toMatch(/onRequestGet[^=]*=\s*\(context\)\s*=>\s*\n?\s*withEdgeCache\(/);
  });

  it("still serves 503 on an upstream failure rather than a partial sitemap", () => {
    // The caching change must not have swallowed the US-2097 guard. A
    // structurally valid sitemap missing whole URL classes, served 200 and
    // cached for an hour, tells crawlers those pages do not exist — and can
    // flip the document from a sitemapindex to a truncated urlset.
    expect(src).toContain("upstreamUnavailableResponse()");
    expect(src).toContain("UpstreamUnavailable");
  });

  it("EVERY section sitemap is cached, not just the index", () => {
    // The index points at fifteen sections. A crawler that reads it then
    // fetches all of them paid for fifteen uncached builds; caching only the
    // index would fix the smallest part of that.
    const files = readdirSync(join(process.cwd(), "functions"))
      .filter((f) => /^sitemap.*.xml.ts$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    const uncached = files.filter((f) =>
      !readFileSync(join(process.cwd(), "functions", f), "utf8").includes("withEdgeCache"),
    );
    expect(uncached, `these rebuild on every request: ${uncached.join(", ")}`).toEqual([]);
  });
  it("relies on withEdgeCache refusing to store a non-200", () => {
    // Guard-the-guard, and the load-bearing half: if withEdgeCache ever cached
    // error responses, a single blip would pin a Retry-After 503 on the sitemap
    // for the whole TTL — worse than the uncached behaviour this replaced.
    const cache = readFileSync(
      join(process.cwd(), "functions/_shared/blog-render.ts"),
      "utf8",
    );
    expect(cache).toMatch(/response\.status !== 200[\s\S]{0,120}return response/);
  });
});
