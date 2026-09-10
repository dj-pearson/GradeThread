// Every static partition reaches the sitemap, and each segment carries its own
// date.
//
// US-3093 added the `buying` partition to partitionedStaticUrls() and did not
// add it to staticUrls(), which is what /sitemap-static.xml serves and what the
// single-urlset branch of /sitemap.xml lists. So the /buying pages were served
// by sitemap-buying.xml and by nothing else, and they were missing from the
// total that decides which shape /sitemap.xml takes.
//
// The guard is written against the PARTITION OBJECT rather than a hand-listed
// set of clusters, so the next cluster is covered on the day it is added.

import { describe, expect, it, vi, afterEach } from "vitest";
import {
  partitionedStaticUrls,
  staticUrls,
  newestLastmod,
} from "../../functions/_shared/sitemap";

const ENV = {
  SITE_URL: "https://gradethread.com",
  EDGE_API_URL: "https://functions.gradethread.com",
} as never;

const MANIFEST = {
  generatedAt: "2026-01-01T00:00:00.000Z",
  routes: [
    { path: "/", lastModified: "2026-02-01" },
    { path: "/pricing", lastModified: "2026-02-02" },
    { path: "/grading/denim", lastModified: "2026-03-03" },
    { path: "/care/remove-a-red-wine-stain", lastModified: "2026-04-04" },
    { path: "/buying/is-vinted-legit", lastModified: "2026-05-05" },
  ],
};

function stubManifest() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/seo-manifest.json")) {
        return { ok: true, status: 200, json: async () => MANIFEST };
      }
      // /state-of-durability's indexability probe. Not part of the fixture.
      return { ok: false, status: 404, json: async () => ({}) };
    }) as never,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("staticUrls() carries every partition", () => {
  it("lists exactly the union of the partitions, with nothing dropped", async () => {
    stubManifest();
    const partitions = await partitionedStaticUrls(ENV);
    const all = await staticUrls(ENV);

    const expected = Object.values(partitions)
      .flat()
      .map((u) => u.loc)
      .sort();
    expect(all.map((u) => u.loc).sort()).toEqual(expected);
    expect(all.length).toBe(MANIFEST.routes.length);
  });

  it("advertises the buying cluster, not just its own segment", async () => {
    stubManifest();
    const all = await staticUrls(ENV);
    expect(all.map((u) => u.loc)).toContain(
      "https://gradethread.com/buying/is-vinted-legit",
    );
  });

  it("keeps every partition non-empty in the fixture, so the union means something", async () => {
    stubManifest();
    const partitions = await partitionedStaticUrls(ENV);
    for (const [name, urls] of Object.entries(partitions)) {
      expect(urls.length, `${name} partition is empty`).toBeGreaterThan(0);
    }
  });
});

describe("each static segment's lastmod is its own", () => {
  it("gives four different dates to the four static segments", async () => {
    stubManifest();
    const { marketing, grading, care, buying } = await partitionedStaticUrls(ENV);

    // The flattened set's newest date is 2026-05-05. Reading it for all four,
    // which is what the index used to do, would make every one of these equal.
    expect(newestLastmod(marketing)).toBe("2026-02-02");
    expect(newestLastmod(grading)).toBe("2026-03-03");
    expect(newestLastmod(care)).toBe("2026-04-04");
    expect(newestLastmod(buying)).toBe("2026-05-05");
  });
});

// The image sitemap carries a <loc> for the PAGE, so it makes the same claim
// the URL sitemap makes. Both now read one advertisability predicate; before
// that, marketingImageUrls() applied neither the US-2098 conditional-index rule
// nor the US-9008 canonical rule, so an image-bearing route that either rule
// excluded would have been advertised in sitemap-images.xml and withheld from
// sitemap-marketing.xml. No route is both image-bearing and excluded today,
// which is exactly why this needs a guard rather than a code reading.

const OVERRIDDEN = {
  generatedAt: "2026-01-01T00:00:00.000Z",
  routes: [
    { path: "/pricing", lastModified: "2026-02-02", image: { file: "/og/pricing.png", alt: "Pricing" } },
    {
      path: "/compare/depop-vs-poshmark",
      lastModified: "2026-02-03",
      canonicalPath: "/blog/depop-vs-poshmark-which-should-you-use",
      image: { file: "/og/compare.png", alt: "Depop vs Poshmark" },
    },
  ],
};

describe("the image sitemap withholds what the URL sitemap withholds", () => {
  it("drops a canonicalised route from the image entries, not just from the URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/seo-manifest.json")
          ? { ok: true, status: 200, json: async () => OVERRIDDEN }
          : { ok: false, status: 404, json: async () => ({}) },
      ) as never,
    );

    const { marketingImageUrls } = await import("../../functions/_shared/sitemap");
    const images = await marketingImageUrls(ENV);
    const urls = await staticUrls(ENV);

    // Both surfaces agree, and both agree by excluding the same page.
    expect(images.map((e) => e.loc)).toEqual(["https://gradethread.com/pricing"]);
    expect(urls.map((u) => u.loc)).toEqual(["https://gradethread.com/pricing"]);
  });
});
