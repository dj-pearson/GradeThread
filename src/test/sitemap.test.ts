import { describe, it, expect, vi, afterEach } from "vitest";
import {
  urlsetXml,
  sitemapIndexXml,
  staticUrls,
  marketingUrls,
  gradingUrls,
  blogUrls,
  certUrls,
  authorUrls,
  marketingImageUrls,
  blogImageUrls,
  imageUrls,
  imageSitemapXml,
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

  // US-1679: the static registry splits into marketing vs grading pSEO segments.
  it("partitions manifest routes into marketing vs grading pSEO", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/seo-manifest.json": {
          siteUrl: "https://gradethread.com",
          generatedAt: "2026-07-06T00:00:00.000Z",
          routes: [
            { path: "/", priority: 1.0 },
            { path: "/pricing", priority: 0.9 },
            { path: "/grading/scale", priority: 0.9 },
            { path: "/grading/glossary/euc", priority: 0.5 },
            { path: "/grading/nwt", priority: 0.7 },
          ],
        },
      }),
    );
    const marketing = await marketingUrls(env);
    const grading = await gradingUrls(env);
    expect(marketing.map((u) => u.loc)).toEqual([
      "https://gradethread.com/",
      "https://gradethread.com/pricing",
    ]);
    expect(grading.map((u) => u.loc)).toEqual([
      "https://gradethread.com/grading/scale",
      "https://gradethread.com/grading/glossary/euc",
      "https://gradethread.com/grading/nwt",
    ]);
    // Together they equal the full static set (no URL dropped or duplicated).
    expect(marketing.length + grading.length).toBe(5);
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
    // Tag archives are excluded on purpose: they are served `noindex, follow`
    // (functions/blog/[[path]].ts renderTag), and listing a noindexed URL here
    // would tell Google the opposite of what the page itself says. The two must
    // stay in lockstep — if tags are ever reindexed, restore both.
    expect(locs).not.toContain("https://gradethread.com/blog/tag/resale");
    expect(locs.some((l) => l.includes("/blog/tag/"))).toBe(false);
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

  it("authorUrls includes the /authors hub + each author profile (US-874)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/api/content/public/authors.json": {
          authors: [
            { slug: "gradethread-team", updated_at: "2026-06-01T00:00:00Z" },
          ],
        },
      }),
    );
    const urls = await authorUrls(env);
    const locs = urls.map((u) => u.loc);
    expect(locs).toContain("https://gradethread.com/authors");
    expect(locs).toContain("https://gradethread.com/authors/gradethread-team");
    expect(urls.find((u) => u.loc.endsWith("/gradethread-team"))!.lastmod).toBe(
      "2026-06-01",
    );
  });

  it("authorUrls still lists the hub when the endpoint is down", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    const urls = await authorUrls(env);
    expect(urls.map((u) => u.loc)).toEqual(["https://gradethread.com/authors"]);
  });
});

describe("image sitemap (US-975)", () => {
  it("imageSitemapXml emits the image namespace + image:loc/title/caption", () => {
    const xml = imageSitemapXml([
      {
        loc: "https://gradethread.com/pricing",
        images: [
          {
            loc: "https://gradethread.com/social/pricing.png",
            title: "GradeThread pricing",
            caption: "Plans & tiers",
          },
        ],
      },
    ]);
    expect(xml).toContain(
      'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"',
    );
    expect(xml).toContain("<loc>https://gradethread.com/pricing</loc>");
    expect(xml).toContain(
      "<image:loc>https://gradethread.com/social/pricing.png</image:loc>",
    );
    expect(xml).toContain("<image:title>GradeThread pricing</image:title>");
    expect(xml).toContain("<image:caption>Plans &amp; tiers</image:caption>");
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });

  it("imageSitemapXml drops entries with no images", () => {
    const xml = imageSitemapXml([
      { loc: "https://gradethread.com/empty", images: [] },
    ]);
    expect(xml).not.toContain("/empty");
  });

  // US-2111: the marketing image set is DERIVED from the build-emitted
  // manifest, not from a hand-synced copy of ROUTE_OG_IMAGES.
  it("marketingImageUrls derives entries from the manifest's image field", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/seo-manifest.json": {
          siteUrl: "https://gradethread.com",
          generatedAt: "2026-07-19T00:00:00.000Z",
          routes: [
            {
              path: "/",
              title: "The Standard for Clothing Condition Grading",
              image: { file: "/og-image.png", alt: "Home card alt." },
            },
            {
              path: "/pricing",
              title: "Pricing",
              image: { file: "/social/pricing.png", alt: "Pricing card alt." },
            },
            // A route with NO share card must not enter the image sitemap.
            { path: "/privacy", title: "Privacy" },
          ],
        },
      }),
    );
    const entries = await marketingImageUrls(env);
    expect(entries).toHaveLength(2);
    const home = entries.find((e) => e.loc === "https://gradethread.com/");
    expect(home?.images[0]!.loc).toBe("https://gradethread.com/og-image.png");
    const pricing = entries.find(
      (e) => e.loc === "https://gradethread.com/pricing",
    );
    expect(pricing?.images[0]!.loc).toBe(
      "https://gradethread.com/social/pricing.png",
    );
    expect(pricing?.images[0]!.title).toBe("Pricing");
    expect(pricing?.images[0]!.caption).toBe("Pricing card alt.");
    expect(entries.some((e) => e.loc.endsWith("/privacy"))).toBe(false);
  });

  // A NEW share card must reach the sitemap with no second edit — this is the
  // whole point of the change, and the property the old hand-synced list broke.
  it("marketingImageUrls picks up a card the fallback list has never heard of", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/seo-manifest.json": {
          siteUrl: "https://gradethread.com",
          generatedAt: "2026-07-19T00:00:00.000Z",
          routes: [
            {
              path: "/brand-new-page",
              title: "Brand New Page",
              image: { file: "/social/brand-new.png", alt: "Brand new alt." },
            },
          ],
        },
      }),
    );
    const entries = await marketingImageUrls(env);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.loc).toBe("https://gradethread.com/brand-new-page");
    expect(entries[0]!.images[0]!.loc).toBe(
      "https://gradethread.com/social/brand-new.png",
    );
  });

  it("marketingImageUrls falls back to the static set when the manifest is unreachable", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    const entries = await marketingImageUrls(env);
    expect(entries.length).toBeGreaterThan(0);
    const pricing = entries.find(
      (e) => e.loc === "https://gradethread.com/pricing",
    );
    expect(pricing?.images[0]!.loc).toBe(
      "https://gradethread.com/social/pricing.png",
    );
  });

  // An OLD manifest predates the `image` field entirely. Reading its zero
  // image-bearing routes as an intentional empty set would blank the image
  // sitemap on the first deploy after a rollback.
  it("marketingImageUrls treats an image-less manifest as stale, not as empty", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/seo-manifest.json": {
          siteUrl: "https://gradethread.com",
          generatedAt: "2026-01-01T00:00:00.000Z",
          routes: [{ path: "/" }, { path: "/pricing" }],
        },
      }),
    );
    const entries = await marketingImageUrls(env);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.images.length > 0)).toBe(true);
  });

  it("blogImageUrls lists posts with a hero image and skips those without", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/api/content/public/sitemap.json": {
          posts: [
            {
              slug: "with-hero",
              published_at: "2026-01-01",
              updated_at: "2026-02-01",
              title: "With Hero",
              hero_image_url: "https://cdn/hero.jpg",
              hero_image_caption: "A nice jacket",
            },
            {
              slug: "no-hero",
              published_at: "2026-01-01",
              updated_at: "2026-02-01",
              title: "No Hero",
              hero_image_url: null,
            },
          ],
          tags: [],
        },
      }),
    );
    const entries = await blogImageUrls(env);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.loc).toBe("https://gradethread.com/blog/with-hero");
    expect(entries[0]!.images[0]!.loc).toBe("https://cdn/hero.jpg");
    expect(entries[0]!.images[0]!.caption).toBe("A nice jacket");
  });

  it("imageUrls combines marketing images with blog hero images", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/api/content/public/sitemap.json": {
          posts: [
            {
              slug: "with-hero",
              published_at: "2026-01-01",
              updated_at: "2026-02-01",
              title: "With Hero",
              hero_image_url: "https://cdn/hero.jpg",
            },
          ],
          tags: [],
        },
      }),
    );
    const entries = await imageUrls(env);
    const locs = entries.map((e) => e.loc);
    expect(locs).toContain("https://gradethread.com/");
    expect(locs).toContain("https://gradethread.com/blog/with-hero");
  });

  it("imageUrls still returns marketing images when the blog endpoint is down", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    const entries = await imageUrls(env);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.images.length > 0)).toBe(true);
  });
});

describe("SITEMAP_MAX_URLS threshold", () => {
  it("is the 5000 AC value", () => {
    expect(SITEMAP_MAX_URLS).toBe(5000);
  });
});
