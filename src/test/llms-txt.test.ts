import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildLlmsSections,
  buildLlmsTxt,
  LLMS_SUMMARY,
  type LlmsRoute,
} from "../../functions/_shared/seo-config";
import { PUBLIC_ROUTES, SITE_URL } from "../lib/seo/public-routes";

// US-431: /llms.txt is generated from the route registry (PUBLIC_ROUTES via the
// build-emitted seo-manifest), NOT hand-curated. This guard fails the build if
// a registry route would be missing from the rendered llms.txt — so a new
// public page can't silently drift out of the GEO surface.

const registryRoutes: LlmsRoute[] = PUBLIC_ROUTES.map((r) => ({
  path: r.path,
  title: r.title,
  description: r.description,
  priority: r.priority,
}));

function renderLlmsTxt(): string {
  return buildLlmsTxt({
    siteUrl: SITE_URL,
    summary: LLMS_SUMMARY,
    sections: buildLlmsSections({ routes: registryRoutes }),
  });
}

describe("llms.txt registry coverage (US-431)", () => {
  it("includes every registered public route", () => {
    const body = renderLlmsTxt();
    const missing = PUBLIC_ROUTES.filter((r) => {
      const abs = r.path === "/" ? `${SITE_URL}/` : `${SITE_URL}${r.path}`;
      return !body.includes(`(${abs})`);
    }).map((r) => r.path);
    expect(missing, `llms.txt is missing registry routes: ${missing.join(", ")}`).toEqual([]);
  });

  it("surfaces the required high-value pages by AC", () => {
    const body = renderLlmsTxt();
    for (const path of [
      "/transparency",
      "/faq",
      "/pricing",
      "/how-it-works",
    ]) {
      expect(body, `llms.txt missing ${path}`).toContain(`${SITE_URL}${path})`);
    }
  });

  it("includes glossary pillar + at least one spoke", () => {
    const body = renderLlmsTxt();
    expect(body).toContain(`${SITE_URL}/condition-grading)`);
    const spokes = PUBLIC_ROUTES.filter((r) => r.path.startsWith("/grading/"));
    expect(spokes.length).toBeGreaterThan(0);
    const firstSpoke = spokes[0]!;
    expect(body).toContain(`${SITE_URL}${firstSpoke.path})`);
  });

  it("renders representative cert + verified-seller URLs when provided", () => {
    const sections = buildLlmsSections({
      routes: registryRoutes,
      certUrls: [{ title: "Verified grade certificate abc", url: "/cert/abc" }],
      sellerUrls: [{ title: "Verified seller @demo", url: "/verified/demo" }],
    });
    const body = buildLlmsTxt({ siteUrl: SITE_URL, summary: LLMS_SUMMARY, sections });
    expect(body).toContain(`${SITE_URL}/cert/abc)`);
    expect(body).toContain(`${SITE_URL}/verified/demo)`);
  });

  it("renders an Authors section when author URLs are provided (US-874)", () => {
    const sections = buildLlmsSections({
      routes: registryRoutes,
      authorUrls: [{ title: "Jane Doe", url: "/authors/jane-doe" }],
    });
    const body = buildLlmsTxt({ siteUrl: SITE_URL, summary: LLMS_SUMMARY, sections });
    expect(body).toContain("## Authors");
    expect(body).toContain(`${SITE_URL}/authors/jane-doe)`);
  });

  it("groups legal pages under a Legal heading", () => {
    const body = renderLlmsTxt();
    expect(body).toContain("## Legal");
    expect(body).toContain(`${SITE_URL}/privacy)`);
  });
});

// ---------------------------------------------------------------------------
// US-2615: the crawler-facing Functions that hit the edge are cached; the two
// that do not are deliberately left alone.
//
// Measured 2026-08-15 against production: /help.md answered x-gt-cache, and
// /robots.txt, /rss.xml, /llms.txt and /llms-full.txt answered with no such
// header — they rebuilt on every request. Whether that matters depends entirely
// on whether the builder calls the edge, because the shared cost is the
// 60-per-minute public-content bucket, not CPU.
describe("US-2615: caching follows upstream cost, not file type", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("llms.txt and rss.xml are cached — they call the edge", () => {
    // llms.txt makes FIVE upstream calls per request (certificates, sellers,
    // authors, posts, help); rss.xml makes one. Twelve uncached fetches of
    // llms.txt alone would exhaust the bucket for the whole public site.
    expect(read("functions/llms.txt.ts")).toContain("withEdgeCache");
    expect(read("functions/rss.xml.ts")).toContain("withEdgeCache");
  });

  it("robots.txt is NOT cached, on purpose", () => {
    // It makes no upstream call, so caching buys nothing against the bucket —
    // and it is a control surface. If you block a crawler you want that live,
    // not an hour from now. Asserted so the next sweep does not "finish the
    // job" and add a staleness window to the one file where it costs something.
    const src = read("functions/robots.txt.ts");
    expect(src).not.toContain("withEdgeCache");
    expect(src).not.toContain("edgeApi");
  });

  it("llms-full.txt is NOT cached, and for a different reason", () => {
    // Also no upstream call: it is built from constants injected at build time
    // by vite.config.ts's llmsFullDataPlugin, so a request costs string
    // building and nothing else. Not a control surface — just not worth a
    // cache entry.
    const src = read("functions/llms-full.txt.ts");
    expect(src).not.toContain("withEdgeCache");
    expect(src).not.toContain("edgeApi");
  });
});
