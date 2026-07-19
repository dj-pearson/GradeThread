// US-2110: /passport/:slug had no sitemap generator.
//
// The pages are SSR'd with full Product JSON-LD and the SSR header states the
// intent plainly — "the marquee buyer-facing provenance surface — one
// INDEXABLE, AI-citable page per garment" — yet nothing enumerated them, so
// they were reachable only via inbound links. They also sit outside the
// static-route CI guard, which skips any path containing ":", which is why the
// omission went unnoticed rather than being caught.

import { describe, expect, it, vi, afterEach } from "vitest";
import { passportUrls } from "../../functions/_shared/sitemap";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENV = {
  SITE_URL: "https://gradethread.com",
  EDGE_API_URL: "https://functions.gradethread.com",
} as never;

function mockPages(pages: Array<{ slugs: string[]; next: string | null }>) {
  const seen: Array<string | null> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const cursor = new URL(url).searchParams.get("cursor");
      seen.push(cursor);
      const page = pages[seen.length - 1];
      if (!page) throw new Error(`requested page ${seen.length}, more than mocked`);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          passports: page.slugs.map((slug) => ({
            slug,
            updated_at: "2026-02-01T00:00:00Z",
          })),
          next_cursor: page.next,
        }),
      } as never;
    }),
  );
  return { seen };
}

afterEach(() => vi.unstubAllGlobals());

describe("US-2110: passport sitemap", () => {
  it("emits one URL per public passport", async () => {
    mockPages([{ slugs: ["abc", "def"], next: null }]);
    const urls = await passportUrls(ENV);
    expect(urls.map((u) => u.loc)).toEqual([
      "https://gradethread.com/passport/abc",
      "https://gradethread.com/passport/def",
    ]);
    expect(urls[0]!.lastmod).toBe("2026-02-01");
  });

  it("follows next_cursor across pages", async () => {
    // Built cursor-correct from the start rather than repeating the US-2096 bug
    // (certUrls shipped ignoring next_cursor and silently capped at 1,000).
    const { seen } = mockPages([
      { slugs: ["a"], next: "C1" },
      { slugs: ["b"], next: "C2" },
      { slugs: ["c"], next: null },
    ]);
    const urls = await passportUrls(ENV);
    expect(urls).toHaveLength(3);
    expect(seen).toEqual([null, "C1", "C2"]);
  });

  it("stops when the cursor fails to advance", async () => {
    mockPages(Array.from({ length: 5 }, () => ({ slugs: ["dup"], next: "STUCK" })));
    expect(await passportUrls(ENV)).toHaveLength(2);
  });

  it("is wired into the sitemap index and registered as a Pages route", () => {
    const root = process.cwd();
    const index = readFileSync(join(root, "functions/sitemap.xml.ts"), "utf8");
    expect(index).toContain("passportUrls(env)");
    expect(index, "must appear in the sitemapindex").toContain("sitemap-passports.xml");
    expect(index, "must count toward the index-vs-urlset threshold").toContain(
      "passports.length",
    );

    // Without this entry Cloudflare Pages serves a static 404 instead of
    // invoking the Function — the exact silent prod failure the US-424 guard
    // caught on /llms-full.txt.
    const routes = readFileSync(join(root, "public/_routes.json"), "utf8");
    expect(routes).toContain("/sitemap-passports.xml");
  });

  it("the upstream gates on public_passport_slug, the publish opt-in", () => {
    // A garment is public iff it has a slug — the same predicate
    // GET /api/passport/:slug resolves against. That parity is what stops the
    // sitemap advertising a URL that 404s, or leaking an unpublished garment.
    const src = readFileSync(
      join(process.cwd(), "services/edge-functions/src/routes/content-public.ts"),
      "utf8",
    );
    const block = src.match(/passports\.json[\s\S]{0,1200}?next_cursor/)?.[0] ?? "";
    expect(block).toContain('.not("public_passport_slug", "is", null)');
  });
});
