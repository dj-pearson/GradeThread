import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { helpUrls } from "../../functions/_shared/sitemap";

// US-2578: the Help Center sitemap.
//
// The property worth testing is not "it lists articles" — it is that the list
// can only ever contain public ones, that the dates are derived rather than
// stamped with today(), and that the Function is actually reachable. All three
// fail silently in production.

const ENV = {
  SITE_URL: "https://gradethread.com",
  EDGE_API_URL: "https://functions.gradethread.com",
} as never;

const root = process.cwd();

interface MockIndex {
  categories: Array<{ key: string; slug: string; article_count?: number }>;
  articles: Array<{
    slug: string;
    category_key: string;
    updated_at: string;
    reviewed_at?: string | null;
  }>;
}

function mockIndex(payload: MockIndex, capture?: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      capture?.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => payload,
      } as never;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("helpUrls", () => {
  it("lists the hub, every non-empty category, and every article", async () => {
    mockIndex({
      categories: [
        { key: "grading", slug: "grading" },
        { key: "billing", slug: "billing" },
      ],
      articles: [
        { slug: "the-scale", category_key: "grading", updated_at: "2026-08-01T00:00:00Z" },
        { slug: "photo-tips", category_key: "grading", updated_at: "2026-08-05T00:00:00Z" },
      ],
    });
    const urls = await helpUrls(ENV);
    const locs = urls.map((u) => u.loc);
    expect(locs).toContain("https://gradethread.com/help");
    expect(locs).toContain("https://gradethread.com/help/grading");
    expect(locs).toContain("https://gradethread.com/help/grading/the-scale");
    expect(locs).toContain("https://gradethread.com/help/grading/photo-tips");
  });

  it("skips an EMPTY category", async () => {
    // A shelf with nothing on it is a thin page, and a thin page in the sitemap
    // is a page Google decides the whole section is like.
    mockIndex({
      categories: [
        { key: "grading", slug: "grading" },
        { key: "billing", slug: "billing" },
      ],
      articles: [
        { slug: "the-scale", category_key: "grading", updated_at: "2026-08-01T00:00:00Z" },
      ],
    });
    const locs = (await helpUrls(ENV)).map((u) => u.loc);
    expect(locs).not.toContain("https://gradethread.com/help/billing");
  });

  it("prefers reviewed_at over updated_at for lastmod", async () => {
    // The whole point of reviewed_at is that it moves when somebody actually
    // re-read the article. A sitemap that stamps today() on an unchanged page
    // teaches crawlers to ignore the field.
    mockIndex({
      categories: [{ key: "grading", slug: "grading" }],
      articles: [
        {
          slug: "the-scale",
          category_key: "grading",
          updated_at: "2026-08-05T00:00:00Z",
          reviewed_at: "2026-07-01T00:00:00Z",
        },
      ],
    });
    const urls = await helpUrls(ENV);
    const article = urls.find((u) => u.loc.endsWith("/the-scale"));
    expect(article?.lastmod).toBe("2026-07-01");
  });

  it("never stamps today() on anything", async () => {
    mockIndex({
      categories: [{ key: "grading", slug: "grading" }],
      articles: [
        { slug: "the-scale", category_key: "grading", updated_at: "2026-08-01T00:00:00Z" },
      ],
    });
    const today = new Date().toISOString().slice(0, 10);
    for (const u of await helpUrls(ENV)) {
      expect(u.lastmod).not.toBe(today);
    }
  });

  it("the hub inherits its newest child's date", async () => {
    mockIndex({
      categories: [{ key: "grading", slug: "grading" }],
      articles: [
        { slug: "a", category_key: "grading", updated_at: "2026-08-01T00:00:00Z" },
        { slug: "b", category_key: "grading", updated_at: "2026-08-09T00:00:00Z" },
      ],
    });
    const hub = (await helpUrls(ENV)).find((u) => u.loc === "https://gradethread.com/help");
    expect(hub?.lastmod).toBe("2026-08-09");
  });

  it("drops an article whose category is missing rather than guessing a URL", async () => {
    // Guessing from the key would put a 301 in the sitemap, which is a URL
    // crawlers then have to be told about twice.
    mockIndex({
      categories: [],
      articles: [
        { slug: "orphan", category_key: "grading", updated_at: "2026-08-01T00:00:00Z" },
      ],
    });
    const locs = (await helpUrls(ENV)).map((u) => u.loc);
    expect(locs).toEqual(["https://gradethread.com/help"]);
  });

  it("reads the ANONYMOUS endpoint, which is what makes it public-only", async () => {
    // Visibility is deliberately not re-filtered here. The endpoint cannot
    // return a members-only or internal article, and a second copy of that rule
    // in this file is a second copy that can drift.
    const seen: string[] = [];
    mockIndex({ categories: [], articles: [] }, seen);
    await helpUrls(ENV);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/api/content/public/help");
  });
});

describe("the Function is actually reachable", () => {
  it("_routes.json lists /sitemap-help.xml", () => {
    // Without this entry Cloudflare Pages serves a static 404 instead of
    // invoking the Function — the same silent prod failure the US-424 guard
    // caught on /llms-full.txt.
    const routes = JSON.parse(
      readFileSync(join(root, "public/_routes.json"), "utf8"),
    ) as { include: string[] };
    expect(routes.include).toContain("/sitemap-help.xml");
  });

  it("the sitemap index links it with a derived lastmod", () => {
    const src = readFileSync(join(root, "functions/sitemap.xml.ts"), "utf8");
    expect(src).toContain('{ name: "sitemap-help.xml", lastmod: newestLastmod(help) }');
    expect(src).toContain("helpUrls(env)");
  });

  it("the help URLs are counted toward the index/urlset threshold", () => {
    // If they were not, a corpus big enough to cross SITEMAP_MAX_URLS would
    // still be emitted as one flat urlset that silently drops the overflow.
    const src = readFileSync(join(root, "functions/sitemap.xml.ts"), "utf8");
    expect(src).toContain("help.length");
    expect(src).toContain("...help,");
  });
});
