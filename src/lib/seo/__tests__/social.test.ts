import { afterEach, describe, expect, it, vi } from "vitest";
import {
  socialProfileUrls,
  twitterSiteHandle,
  twitterCreatorHandle,
  contactEmail,
  foundingDate,
} from "../social";
import { organizationLd } from "../json-ld";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("social config (US-428)", () => {
  it("always includes the live GitHub profile and nothing fake by default", () => {
    const urls = socialProfileUrls();
    expect(urls).toContain("https://github.com/dj-pearson/GradeThread");
    // No placeholder profiles when unconfigured (only live URLs).
    expect(urls).toEqual(["https://github.com/dj-pearson/GradeThread"]);
    expect(twitterSiteHandle()).toBe("");
    expect(twitterCreatorHandle()).toBe("");
    expect(contactEmail()).toBe("");
    expect(foundingDate()).toBe("");
  });

  it("adds only configured, well-formed profile URLs to sameAs", () => {
    vi.stubEnv("VITE_SOCIAL_X", "https://x.com/gradethread");
    vi.stubEnv("VITE_SOCIAL_LINKEDIN", "https://www.linkedin.com/company/gradethread");
    vi.stubEnv("VITE_SOCIAL_INSTAGRAM", "  "); // blank → dropped
    vi.stubEnv("VITE_SOCIAL_CRUNCHBASE", "not-a-url"); // malformed → dropped
    expect(socialProfileUrls()).toEqual([
      "https://github.com/dj-pearson/GradeThread",
      "https://x.com/gradethread",
      "https://www.linkedin.com/company/gradethread",
    ]);
  });

  it("normalizes the twitter:site handle and defaults creator to it", () => {
    vi.stubEnv("VITE_TWITTER_SITE", "gradethread");
    expect(twitterSiteHandle()).toBe("@gradethread");
    expect(twitterCreatorHandle()).toBe("@gradethread");
    vi.stubEnv("VITE_TWITTER_CREATOR", "@gt_editorial");
    expect(twitterCreatorHandle()).toBe("@gt_editorial");
  });

  it("emits contactPoint + foundingDate on the Organization only when valid", () => {
    expect(organizationLd().contactPoint).toBeUndefined();
    expect(organizationLd().foundingDate).toBeUndefined();
    vi.stubEnv("VITE_CONTACT_EMAIL", "support@gradethread.com");
    vi.stubEnv("VITE_FOUNDING_DATE", "2025-01-15");
    vi.stubEnv("VITE_SOCIAL_X", "https://x.com/gradethread");
    const ld = organizationLd();
    expect(ld.foundingDate).toBe("2025-01-15");
    expect(ld.contactPoint).toMatchObject({
      "@type": "ContactPoint",
      email: "support@gradethread.com",
    });
    expect(ld.sameAs).toContain("https://x.com/gradethread");
  });

  it("rejects a malformed founding date", () => {
    vi.stubEnv("VITE_FOUNDING_DATE", "January 2025");
    expect(foundingDate()).toBe("");
  });
});
