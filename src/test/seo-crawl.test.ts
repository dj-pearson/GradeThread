import { describe, it, expect } from "vitest";
import {
  buildRobotsTxt,
  buildLlmsTxt,
  ALLOWED_AI_AGENTS,
  CITATION_AI_AGENTS,
  TRAINING_AI_AGENTS,
  BLOCKED_AI_AGENTS,
  DISALLOWED_PATHS,
  trainingCrawlersAllowed,
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

// US-430: training crawlers are a distinct, configurable decision from citation
// crawlers; aggressive scrapers are hard-blocked by default.
describe("AI-crawler policy (US-430)", () => {
  it("classifies citation and training crawlers without overlap", () => {
    expect(CITATION_AI_AGENTS.length).toBeGreaterThan(0);
    expect(TRAINING_AI_AGENTS).toEqual(
      expect.arrayContaining(["GPTBot", "Google-Extended", "Applebot-Extended"]),
    );
    const overlap = CITATION_AI_AGENTS.filter((a) => TRAINING_AI_AGENTS.includes(a));
    expect(overlap).toEqual([]);
    // Union stays back-compatible for existing callers.
    expect(ALLOWED_AI_AGENTS).toEqual([...CITATION_AI_AGENTS, ...TRAINING_AI_AGENTS]);
  });

  it("ships a non-empty hard-block list of aggressive scrapers", () => {
    expect(BLOCKED_AI_AGENTS.length).toBeGreaterThan(0);
    for (const ua of BLOCKED_AI_AGENTS) {
      expect(buildRobotsTxt({ siteUrl: "https://gradethread.com" })).toContain(
        `User-agent: ${ua}\nDisallow: /`,
      );
    }
  });

  it("allows training crawlers by default but disallows them when opted out", () => {
    const allow = buildRobotsTxt({ siteUrl: "https://gradethread.com" });
    expect(allow).toContain("User-agent: GPTBot\nAllow: /");

    const deny = buildRobotsTxt({
      siteUrl: "https://gradethread.com",
      allowTraining: false,
    });
    for (const ua of TRAINING_AI_AGENTS) {
      expect(deny).toContain(`User-agent: ${ua}\nDisallow: /`);
    }
    // Citation bots stay allowed regardless of the training toggle.
    expect(deny).toContain("User-agent: OAI-SearchBot\nAllow: /");
  });

  it("parses the AI_TRAINING_CRAWLERS env value", () => {
    expect(trainingCrawlersAllowed(undefined)).toBe(true);
    expect(trainingCrawlersAllowed("")).toBe(true);
    expect(trainingCrawlersAllowed("allow")).toBe(true);
    for (const off of ["disallow", "block", "false", "off", "no", "0"]) {
      expect(trainingCrawlersAllowed(off)).toBe(false);
    }
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

  it("surfaces the AI-usage policy note when provided (US-430)", () => {
    const withPolicy = buildLlmsTxt({
      siteUrl: "https://gradethread.com",
      summary: "Test summary.",
      policyNote: "AI usage: cite and link back.",
      sections: [],
    });
    expect(withPolicy).toContain("_AI usage: cite and link back._");
    // Still optional — omitted when not passed.
    expect(txt).not.toContain("_AI usage");
  });
});
