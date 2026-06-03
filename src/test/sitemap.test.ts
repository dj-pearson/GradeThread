import { describe, it, expect, vi, afterEach } from "vitest";
import {
  urlsetXml,
  sitemapIndexXml,
  staticUrls,
  blogUrls,
  certUrls,
  SITEMAP_MAX_URLS,
  type SitemapUrl,
} from "../../functions/_shared/sitemap";

// US-293: the sitemap builds itself from the registry manifest + blog + certs.
// blog-render's siteUrl()/edgeApi() fall back to gradethread.com /
// functions.gradethread.com when env is empty, so we mock global fetch by URL.

const env = {} as Record<string, string>;

function mockFetch(routes: Record<string, unknown>) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sitemap XML serializers", () => {
  it("urlsetXml emits valid sitemaps.org 0.9 urlset entries", () => {
    const urls: SitemapUrl[] = [
      { loc: "https://gradethread.com/", lastmod: "2026-05-29", changefreq: "weekly", priority: 1.0 },
      { loc: "https://gradethread.com/privacy", priority: 0.3 },
    ];
    const xml = urlsetXml(urls);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    expect(xml).toContain("<loc>https://gradethread.com/</loc>");
    expect(xml).toContain("<lastmod>2026-05-29</lastmod>");
    expect(xml).toContain("<priority>1.0</priority>");
    expect(xml).toContain("<priority>0.3</priority>");
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });

  it("sitemapIndexXml lists sub-sitemaps under the site origin", () => {
    const xml = sitemapIndexXml(env, ["sitemap-static.xml", "sitemap-blog.xml"]);
    expect(xml).toContain("<sitemapindex");
    expect(xml).toContain(
      "<loc>https://gradethread.com/sitemap-static.xml</loc>",
    );
    expect(xml).toContain("<loc>https://gradethread.com/sitemap-blog.xml</loc>");
  });

  it("escapes & in loc values", () => {
    const xml = urlsetXml([{ loc: "https://gradethread.com/blog/tag/a&b" }]);
    expect(xml).toContain("a&amp;b");
    expect(xml).not.toContain("a&b<");
  });
});

describe("staticUrls (from seo-manifest.json)", () => {
  it("maps manifest routes to absolute URLs with priority/changefreq", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/seo-manifest.json": {
          siteUrl: "https://gradethread.com",
          generatedAt: "2026-05-29T00:00:00.000Z",
          routes: [
            { path: "/", changefreq: "weekly", priority: 1.0 },
            { path: "/privacy", changefreq: "yearly", priority: 0.3 },
          ],
        },
      }),
    );
    const urls = await staticUrls(env);
    expect(urls.map((u) => u.loc)).toEqual([
      "https://gradethread.com/",
      "https://gradethread.com/privacy",
    ]);
    expect(urls[0]!.priority).toBe(1.0);
    expect(urls[1]!.changefreq).toBe("yearly");
  });

  it("falls back to the home page when the manifest is missing", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    const urls = await staticUrls(env);
    expect(urls).toHaveLength(1);
    expect(urls[0]!.loc).toBe("https://gradethread.com/");
  });

  it("US-429: uses the per-route lastModified (not the build timestamp), falling back to generatedAt", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/seo-manifest.json": {
          siteUrl: "https://gradethread.com",
          generatedAt: "2026-05-29T00:00:00.000Z",
          routes: [
            { path: "/privacy", changefreq: "yearly", priority: 0.3, lastModified: "2026-04-01" },
            // No lastModified → legacy fallback to the build date.
            { path: "/legacy", changefreq: "monthly", priority: 0.5 },
          ],
        },
      }),
    );
    const urls = await staticUrls(env);
    expect(urls[0]!.lastmod).toBe("2026-04-01");
    expect(urls[1]!.lastmod).toBe("2026-05-29");
  });
});

describe("blogUrls + certUrls", () => {
  it("blogUrls includes the index, each post, and each tag", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/api/content/public/sitemap.json": {
          posts: [
            { slug: "first-post", published_at: "2026-01-01", updated_at: "2026-02-01" },
          ],
          tags: ["resale", "grading"],
        },
      }),
    );
    const urls = await blogUrls(env);
    const locs = urls.map((u) => u.loc);
    expect(locs).toContain("https://gradethread.com/blog");
    expect(locs).toContain("https://gradethread.com/blog/first-post");
    expect(locs).toContain("https://gradethread.com/blog/tag/resale");
  });

  it("certUrls maps public certificates to /cert/:id with lastmod", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/api/content/public/certificates.json": {
          certificates: [
            { id: "cert-abc", updated_at: "2026-05-01T12:00:00Z" },
          ],
          next_cursor: null,
        },
      }),
    );
    const urls = await certUrls(env);
    expect(urls).toHaveLength(1);
    expect(urls[0]!.loc).toBe("https://gradethread.com/cert/cert-abc");
    expect(urls[0]!.lastmod).toBe("2026-05-01");
  });

  it("certUrls returns empty (not throw) when the endpoint is down", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    expect(await certUrls(env)).toEqual([]);
  });
});

describe("SITEMAP_MAX_URLS threshold", () => {
  it("is the 5000 AC value", () => {
    expect(SITEMAP_MAX_URLS).toBe(5000);
  });
});
