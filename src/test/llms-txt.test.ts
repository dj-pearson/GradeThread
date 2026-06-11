import { describe, it, expect } from "vitest";
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

  it("groups legal pages under a Legal heading", () => {
    const body = renderLlmsTxt();
    expect(body).toContain("## Legal");
    expect(body).toContain(`${SITE_URL}/privacy)`);
  });
});
