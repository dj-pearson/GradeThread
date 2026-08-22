// US-2100: dynamic generators stamped today() on every hub URL and every
// sitemap-index entry, every day.
//
// ROUTE_LAST_MODIFIED enforces an explicit "NEVER the build timestamp" contract
// for the 213 static routes (US-429) so an unchanged page keeps a steady date
// and crawlers stop re-fetching it. The dynamic side ignored that, which does
// more damage than wasted crawl budget: a lastmod that is always "now" is a
// signal crawlers learn to discount, devaluing the honest dates US-429 bought.

import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  newestLastmod,
  withHubLastmod,
  sitemapIndexXml,
  blogUrls,
  type SitemapUrl,
} from "../../functions/_shared/sitemap";

const ENV = {
  SITE_URL: "https://gradethread.com",
  EDGE_API_URL: "https://functions.gradethread.com",
} as never;

const TODAY = new Date().toISOString().slice(0, 10);

afterEach(() => vi.unstubAllGlobals());

describe("US-2100: lastmod is derived, not stamped", () => {
  it("newestLastmod picks the latest date and ignores missing ones", () => {
    const urls: SitemapUrl[] = [
      { loc: "a", lastmod: "2026-01-05" },
      { loc: "b" },
      { loc: "c", lastmod: "2026-03-11" },
      { loc: "d", lastmod: "2026-02-01" },
    ];
    expect(newestLastmod(urls)).toBe("2026-03-11");
    expect(newestLastmod([{ loc: "x" }])).toBeUndefined();
    expect(newestLastmod([])).toBeUndefined();
  });

  it("a hub inherits its newest CHILD's date", () => {
    const urls: SitemapUrl[] = [
      { loc: "/blog", lastmod: TODAY },
      { loc: "/blog/a", lastmod: "2026-01-01" },
      { loc: "/blog/b", lastmod: "2026-04-09" },
    ];
    expect(withHubLastmod(urls)[0]!.lastmod).toBe("2026-04-09");
  });

  it("an EMPTY hub keeps today() rather than inventing an older date", () => {
    // A hub with no children genuinely has no content date to inherit, and
    // back-dating it would be a different lie than the one being fixed.
    const urls: SitemapUrl[] = [{ loc: "/blog", lastmod: TODAY }];
    expect(withHubLastmod(urls)[0]!.lastmod).toBe(TODAY);
  });

  it("the blog hub derives from the newest post; tag URLs are not listed at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          posts: [
            { slug: "old", published_at: "2026-01-01", updated_at: "2026-01-01" },
            { slug: "new", published_at: "2026-05-20", updated_at: "2026-05-20" },
          ],
          tags: ["denim"],
        }),
      })) as never,
    );
    const urls = await blogUrls(ENV);
    const hub = urls.find((u) => u.loc.endsWith("/blog"))!;

    expect(hub.lastmod, "hub still stamped today()").toBe("2026-05-20");
    expect(hub.lastmod).not.toBe(TODAY);

    // US-2100 AC3 originally asserted tag URLs derived an honest lastmod. Tag
    // archives are no longer emitted at all — they are served `noindex, follow`
    // and a noindexed URL has no business in the sitemap. The derived-lastmod
    // guarantee this file exists to protect is now carried by the hub above.
    expect(urls.find((u) => u.loc.includes("/blog/tag/"))).toBeUndefined();
  });

  it("index entries carry their section's date, not today()", () => {
    const xml = sitemapIndexXml(ENV, [
      { name: "sitemap-blog.xml", lastmod: "2026-05-20" },
      { name: "sitemap-certs.xml", lastmod: "2026-06-02" },
    ]);
    expect(xml).toContain("<lastmod>2026-05-20</lastmod>");
    expect(xml).toContain("<lastmod>2026-06-02</lastmod>");
    expect(xml).not.toContain(`<lastmod>${TODAY}</lastmod>`);
  });

  it("AC4: no hub generator stamps today() unconditionally", () => {
    // Source-level, because the failure is structural: a NEW generator added
    // later would reintroduce it, and only a scan catches that.
    const src = readFileSync(
      join(process.cwd(), "functions/_shared/sitemap.ts"),
      "utf8",
    );
    // Every hub generator must route its return through withHubLastmod.
    const hubReturns = (src.match(/return withHubLastmod\(urls\);/g) ?? []).length;
    expect(hubReturns, "hub generators no longer derive their date").toBeGreaterThanOrEqual(6);

    // AC4's real intent is "no generator emits today() UNCONDITIONALLY", which
    // a raw count cannot express: the hub initializers still write today(), and
    // that is correct — withHubLastmod overwrites it whenever children exist and
    // keeps it only for a genuinely empty hub.
    //
    // So the precise check is: any generator that writes `lastmod: today()` must
    // also route through withHubLastmod. Comments are stripped first, because an
    // earlier version of this assertion counted 20 by matching the explanatory
    // comments ABOUT today() — a guard reading prose instead of code.
    const code = src.replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const fns = code.split(/(?=^export (?:async )?function )/m);
    const offenders: string[] = [];
    for (const fn of fns) {
      if (!/lastmod:\s*today\(\)/.test(fn)) continue;
      const name = fn.match(/^export (?:async )?function (\w+)/)?.[1] ?? "(anonymous)";
      // partitionedStaticUrls is the documented exception: its today() is the
      // no-manifest fallback for the home URL, not a hub inheriting children.
      if (name === "partitionedStaticUrls") continue;
      if (!fn.includes("withHubLastmod")) offenders.push(name);
    }
    expect(
      offenders,
      `these generators stamp today() without deriving from children: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("flat generators are NOT hub-rewritten", () => {
    // certUrls/passportUrls have no hub — element 0 is a real certificate or
    // passport, so applying withHubLastmod there would corrupt its date with
    // an unrelated sibling's.
    const src = readFileSync(
      join(process.cwd(), "functions/_shared/sitemap.ts"),
      "utf8",
    );
    for (const fn of ["certUrls", "passportUrls"]) {
      const body = src.match(
        new RegExp(`export async function ${fn}\\(env[\\s\\S]*?\\n\\}`),
      )?.[0];
      expect(body, `${fn} not found`).toBeTruthy();
      expect(
        body!.includes("withHubLastmod"),
        `${fn} is a flat list — hub rewriting would corrupt its first entry`,
      ).toBe(false);
    }
  });
});
