// US-3382: a manifest blip must not silently delete most of the sitemap.
//
// THE REPRODUCTION, measured 2026-09-11 before anything was changed, against a
// manifest built from the real 276-route registry:
//
//   manifest 200 -> staticUrls() 275 URLs
//   manifest 500 -> staticUrls()   1 URL   (status 200, SITEMAP_HEADERS, cached)
//   manifest 429 -> staticUrls()   1 URL   (same)
//
// Production the same morning: /sitemap.xml 650 URLs, /sitemap-static.xml 274,
// /sitemap-images.xml 131 (9 marketing + 122 blog), /llms.txt 311 entries. So a
// single 500 on a same-origin static asset removed 42% of the sitemap and served
// it 200 with `public, max-age=600, s-maxage=3600`, which withEdgeCache stores.
// No error, no log line, no alert: "200 with fewer URLs than yesterday" is the
// ONLY symptom this failure produces, which is why the count has to be the
// assertion.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  enforceUrlFloor,
  marketingImageUrls,
  partitionedStaticUrls,
  staticUrls,
  STATIC_URLS_LAST_KNOWN_GOOD,
  URL_FLOOR_FRACTION,
  URL_FLOOR_MIN_SAMPLE,
} from "../../functions/_shared/sitemap";
import { UpstreamUnavailable } from "../../functions/_shared/blog-render";
import { PUBLIC_ROUTES } from "../lib/seo/public-routes";

const env = {} as Record<string, string>;

type FixtureRoute = {
  path: string;
  title?: string;
  priority?: number;
  changefreq?: string;
  canonicalPath?: string;
  image?: { file: string; alt: string };
};

const REGISTRY_ROUTES: FixtureRoute[] = PUBLIC_ROUTES.map((r) => ({
  path: r.path,
  title: r.title,
  priority: r.priority,
  changefreq: r.changefreq,
}));

function manifestOf(routes: FixtureRoute[]) {
  return {
    siteUrl: "https://gradethread.com",
    generatedAt: "2026-09-11T00:00:00.000Z",
    routes,
  };
}

/**
 * Answers the manifest request however the case needs and 404s everything else,
 * which is what the conditional-index probe sees on a healthy run.
 */
function stubManifest(
  answer:
    | { kind: "ok"; routes: FixtureRoute[] }
    | { kind: "status"; status: number }
    | { kind: "body"; body: string }
    | { kind: "network" },
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/seo-manifest.json")) {
        switch (answer.kind) {
          case "ok":
            return new Response(JSON.stringify(manifestOf(answer.routes)), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          case "status":
            return new Response("upstream error", { status: answer.status });
          case "body":
            return new Response(answer.body, {
              status: 200,
              headers: { "Content-Type": "text/html" },
            });
          case "network":
            throw new TypeError("fetch failed");
        }
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("US-3382: the static sitemap refuses rather than collapsing", () => {
  it("serves the whole registry when the manifest reads cleanly", async () => {
    stubManifest({ kind: "ok", routes: REGISTRY_ROUTES });
    const urls = await staticUrls(env);
    // 275 of 276 today: /state-of-durability is conditionally withheld because
    // the durability report has too few cohorts to be publishable (US-2636).
    expect(urls.length).toBeGreaterThanOrEqual(STATIC_URLS_LAST_KNOWN_GOOD);
  });

  // The reproduction, now inverted into a guard. Each of these used to return
  // exactly one URL with status 200.
  for (const status of [500, 502, 429, 403]) {
    it(`throws on a ${status} instead of serving one URL`, async () => {
      stubManifest({ kind: "status", status });
      await expect(staticUrls(env)).rejects.toBeInstanceOf(UpstreamUnavailable);
    });
  }

  it("throws on a network error or timeout", async () => {
    stubManifest({ kind: "network" });
    await expect(staticUrls(env)).rejects.toBeInstanceOf(UpstreamUnavailable);
  });

  // The case most likely to be read as "absent" and least likely to be it:
  // Cloudflare Pages answers a missing asset by serving the SPA shell, which is
  // a 200 whose body is HTML.
  it("treats a 200 carrying HTML as a failed read, not an empty registry", async () => {
    stubManifest({ kind: "body", body: "<!doctype html><html><body>app</body></html>" });
    await expect(staticUrls(env)).rejects.toBeInstanceOf(UpstreamUnavailable);
  });

  it("treats valid JSON with no routes array as a failed read", async () => {
    stubManifest({ kind: "body", body: JSON.stringify({ siteUrl: "x" }) });
    await expect(staticUrls(env)).rejects.toBeInstanceOf(UpstreamUnavailable);
  });

  // A 404 IS a different answer: the build has not landed. It degrades to the
  // home page, and then the floor decides whether that document is worth
  // serving. On this site it is not.
  it("a 404 degrades to the home page, and the floor then refuses it", async () => {
    stubManifest({ kind: "status", status: 404 });
    await expect(staticUrls(env)).rejects.toThrow(/absent/);
  });

  // The collapse does not have to arrive through the fetch. If our own filters
  // ever eat the registry, the symptom is identical.
  it("refuses when the manifest loads but the filters eat most of it", async () => {
    const routes = REGISTRY_ROUTES.map((r, i) =>
      i < REGISTRY_ROUTES.length - 5 ? { ...r, canonicalPath: "/somewhere-else" } : r,
    );
    stubManifest({ kind: "ok", routes });
    await expect(partitionedStaticUrls(env)).rejects.toBeInstanceOf(UpstreamUnavailable);
  });
});

describe("US-3382: the floor does not fire on a legitimately small site", () => {
  it("applies no ratio below URL_FLOOR_MIN_SAMPLE expected URLs", () => {
    // Three routes, one withheld to a canonical: a 33% "drop" and a perfectly
    // correct sitemap. A percentage of a small number is noise.
    expect(() => enforceUrlFloor("tiny", 2, 3)).not.toThrow();
    expect(() => enforceUrlFloor("tiny", 1, URL_FLOOR_MIN_SAMPLE - 1)).not.toThrow();
  });

  it("serves a small manifest in full", async () => {
    const routes = [
      { path: "/", priority: 1.0 },
      { path: "/pricing", priority: 0.9 },
      { path: "/faq", priority: 0.7 },
    ];
    stubManifest({ kind: "ok", routes });
    expect(await staticUrls(env)).toHaveLength(3);
  });

  it("fires once the population is big enough for a ratio to mean something", () => {
    const expected = URL_FLOOR_MIN_SAMPLE;
    const floor = Math.ceil(expected * URL_FLOOR_FRACTION);
    expect(() => enforceUrlFloor("big enough", floor, expected)).not.toThrow();
    expect(() => enforceUrlFloor("big enough", floor - 1, expected)).toThrow(
      UpstreamUnavailable,
    );
  });
});

// ---------------------------------------------------------------------------
// Where "last known good" comes from, and the half that keeps it honest.
//
// A Pages Function holds no state between requests, so yesterday's size cannot
// be read at the edge. Two sources survive a cold start and this uses both: the
// manifest's own routes.length whenever it loads (a build artifact, so it cannot
// rot and is right at any site size), and STATIC_URLS_LAST_KNOWN_GOOD for the
// case where the manifest did NOT load, which is exactly when the first source
// is unavailable. This describe block is the ratchet on the second one.
describe("US-3382: STATIC_URLS_LAST_KNOWN_GOOD stays true", () => {
  const floor = Math.ceil(STATIC_URLS_LAST_KNOWN_GOOD * URL_FLOOR_FRACTION);

  it("sits at or below the live registry, so it cannot 503 a healthy build", () => {
    expect(
      PUBLIC_ROUTES.length,
      `the registry has shrunk to ${PUBLIC_ROUTES.length} routes, below the ` +
        `floor of ${floor}. If that is deliberate, lower ` +
        `STATIC_URLS_LAST_KNOWN_GOOD in functions/_shared/sitemap.ts to ` +
        `${PUBLIC_ROUTES.length}. Until then every sitemap serves 503.`,
    ).toBeGreaterThanOrEqual(floor);
  });

  it("has not rotted so far below the registry that the floor is a no-op", () => {
    // One doubling of headroom. Past that the recorded number describes a site
    // that no longer exists and the floor stops catching a real collapse.
    expect(
      floor,
      `the registry is now ${PUBLIC_ROUTES.length} routes but the floor is ` +
        `${floor}, so the sitemap could lose most of itself and still pass. ` +
        `Re-measure: set STATIC_URLS_LAST_KNOWN_GOOD to ${PUBLIC_ROUTES.length}.`,
    ).toBeGreaterThanOrEqual(Math.floor(PUBLIC_ROUTES.length * 0.5));
  });
});

// ---------------------------------------------------------------------------
// The image sitemap is the one place where "absent" and "could not read" have
// genuinely different right answers, which is the point of splitting them.
describe("US-3382: marketingImageUrls diverges on absent vs unreadable", () => {
  it("keeps the stale-but-correct fallback set when the manifest is ABSENT", async () => {
    stubManifest({ kind: "status", status: 404 });
    const entries = await marketingImageUrls(env);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.images[0]!.loc).toContain("https://gradethread.com/");
  });

  it("refuses when the manifest could not be READ", async () => {
    stubManifest({ kind: "status", status: 500 });
    await expect(marketingImageUrls(env)).rejects.toBeInstanceOf(UpstreamUnavailable);
  });

  it("prefers the manifest's own images when it loads", async () => {
    stubManifest({
      kind: "ok",
      routes: [
        { path: "/", title: "Home", image: { file: "/og-image.png", alt: "Home card" } },
        {
          path: "/pricing",
          title: "Pricing",
          image: { file: "/social/pricing.png", alt: "Pricing card" },
        },
      ],
    });
    const entries = await marketingImageUrls(env);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.images[0]!.caption).toBe("Pricing card");
  });
});
