import { describe, it, expect } from "vitest";
import {
  buildRobotsTxt,
  buildLlmsTxt,
  ALLOWED_AI_AGENTS,
  DISALLOWED_PATHS,
} from "../../functions/_shared/seo-config";

// US-295: robots.txt is the real lever for AI crawler control. These guard the
// contract that (a) the bots we want are explicitly welcomed, (b) private
// surfaces stay blocked for everyone, and (c) the sitemap is advertised.

describe("buildRobotsTxt (US-295)", () => {
  const txt = buildRobotsTxt({ siteUrl: "https://gradethread.com" });

  it("welcomes every allowed AI/search agent", () => {
    for (const ua of ALLOWED_AI_AGENTS) {
      expect(txt).toContain(`User-agent: ${ua}`);
    }
  });

  it("includes the key AI crawlers by name", () => {
    for (const ua of [
      "GPTBot",
      "OAI-SearchBot",
      "ClaudeBot",
      "PerplexityBot",
      "Google-Extended",
      "Applebot-Extended",
    ]) {
      expect(txt).toContain(ua);
    }
  });

  it("disallows every private path", () => {
    for (const p of DISALLOWED_PATHS) {
      expect(txt).toContain(`Disallow: ${p}`);
    }
  });

  it("advertises the sitemap with the deployed origin", () => {
    expect(txt).toContain("Sitemap: https://gradethread.com/sitemap.xml");
  });

  it("hard-blocks configured bad agents", () => {
    const blocked = buildRobotsTxt({
      siteUrl: "https://gradethread.com",
      blocked: ["Bytespider"],
    });
    expect(blocked).toContain("User-agent: Bytespider\nDisallow: /");
  });
});

describe("buildLlmsTxt (US-295)", () => {
  const txt = buildLlmsTxt({
    siteUrl: "https://gradethread.com",
    summary: "Test summary.",
    sections: [
      {
        heading: "Content",
        links: [
          { title: "Blog", url: "/blog", note: "Articles" },
          { title: "Ext", url: "https://example.com/x" },
        ],
      },
    ],
  });

  it("starts with an H1 and a blockquote summary", () => {
    expect(txt.startsWith("# GradeThread")).toBe(true);
    expect(txt).toContain("> Test summary.");
  });

  it("renders sections as H2 with absolute markdown links", () => {
    expect(txt).toContain("## Content");
    expect(txt).toContain("[Blog](https://gradethread.com/blog): Articles");
    expect(txt).toContain("[Ext](https://example.com/x)");
  });
});
