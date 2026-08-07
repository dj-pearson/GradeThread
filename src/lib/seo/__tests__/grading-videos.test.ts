import { describe, it, expect } from "vitest";
import {
  GRADING_SHORTS,
  SHORTS_BASE_TAGS,
  SHORTS_SERIES_SUFFIX,
  shortTitle,
  shortDescription,
  shortTags,
  shortTranscript,
  shortDurationIso,
  shortEmbedUrl,
  shortWatchUrl,
  shortThumbnailUrl,
  isPublished,
  publishedShort,
  publishedShorts,
  getShortByGuideSlug,
  guidesWithoutShorts,
  type GradingShort,
} from "../grading-videos";
import { getGuideBySlug, GARMENT_GUIDES } from "../garment-guides";
import { garmentGuideJsonLd } from "@/pages/marketing/marketing-jsonld";

// US-1689: the shorts registry, the derived naming that keeps the series
// consistent with the GradeThread Scale, and the publish gate that keeps
// VideoObject markup off pages whose video does not exist yet.

describe("grading shorts registry (US-1689)", () => {
  it("scripts 5–10 shorts, the range the story asks for", () => {
    expect(GRADING_SHORTS.length).toBeGreaterThanOrEqual(5);
    expect(GRADING_SHORTS.length).toBeLessThanOrEqual(10);
  });

  it("every short targets a real garment guide, exactly once", () => {
    const slugs = GRADING_SHORTS.map((s) => s.guideSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(getGuideBySlug(slug), `no guide for ${slug}`).toBeDefined();
    }
  });

  it("every script is a complete, shootable short", () => {
    for (const s of GRADING_SHORTS) {
      // Shorts are capped at 60s by YouTube; under 30s can't carry three checks.
      expect(s.durationSeconds, `${s.guideSlug} duration`).toBeGreaterThanOrEqual(30);
      expect(s.durationSeconds, `${s.guideSlug} duration`).toBeLessThanOrEqual(60);
      // hook + three checks + grade call.
      expect(s.beats.length, `${s.guideSlug} beats`).toBeGreaterThanOrEqual(5);
      for (const b of s.beats) {
        expect(b.at, `${s.guideSlug} beat timestamp`).toMatch(/^\d:\d{2}$/);
        expect(b.shot.length, `${s.guideSlug} shot`).toBeGreaterThan(10);
        expect(b.say.length, `${s.guideSlug} line`).toBeGreaterThan(20);
      }
      // Beats run forward in time.
      const seconds = s.beats.map((b) => {
        const [m, sec] = b.at.split(":");
        return Number(m) * 60 + Number(sec);
      });
      for (let i = 1; i < seconds.length; i++) {
        expect(seconds[i], `${s.guideSlug} beat ${i} order`).toBeGreaterThan(
          seconds[i - 1]!,
        );
      }
      // The last beat starts before the short ends.
      expect(seconds[seconds.length - 1]!, `${s.guideSlug} last beat`).toBeLessThan(
        s.durationSeconds,
      );
    }
  });

  it("every script names the GradeThread scale in its grade call (AC3)", () => {
    for (const s of GRADING_SHORTS) {
      expect(
        shortTranscript(s).toLowerCase(),
        `${s.guideSlug} transcript never says GradeThread`,
      ).toContain("gradethread");
    }
  });
});

describe("derived naming keeps the series consistent (AC3)", () => {
  it("every title ends with the scale suffix and fits YouTube's 100-char cap", () => {
    for (const s of GRADING_SHORTS) {
      const t = shortTitle(s);
      expect(t.endsWith(SHORTS_SERIES_SUFFIX), `${s.guideSlug}: ${t}`).toBe(true);
      expect(t.startsWith("How to Grade"), `${s.guideSlug}: ${t}`).toBe(true);
      // The video title carries the guide's own title, so they cannot drift.
      expect(t).toBe(`${getGuideBySlug(s.guideSlug)!.title} | ${SHORTS_SERIES_SUFFIX}`);
      expect(t.length, `${s.guideSlug} title length`).toBeLessThanOrEqual(100);
    }
  });

  it("titles are unique across the series", () => {
    const titles = GRADING_SHORTS.map(shortTitle);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("every short carries the shared series tags plus its garment's names", () => {
    for (const s of GRADING_SHORTS) {
      const tags = shortTags(s);
      for (const base of SHORTS_BASE_TAGS) {
        expect(tags, `${s.guideSlug} missing base tag ${base}`).toContain(base);
      }
      const guide = getGuideBySlug(s.guideSlug)!;
      expect(tags).toContain(guide.garment.toLowerCase());
      for (const alt of guide.alternateNames ?? []) {
        expect(tags, `${s.guideSlug} missing alternate ${alt}`).toContain(alt);
      }
      // De-duped.
      expect(new Set(tags).size).toBe(tags.length);
    }
  });

  it("every description states the scale and links the matching guide", () => {
    for (const s of GRADING_SHORTS) {
      const d = shortDescription(s);
      expect(d, `${s.guideSlug} description`).toContain("1.0–10.0");
      expect(d).toContain(`https://gradethread.com/grading/guides/${s.guideSlug}`);
    }
  });

  it("the transcript is derived from the beats unless one was recorded", () => {
    const s = GRADING_SHORTS[0]!;
    expect(shortTranscript(s)).toBe(s.beats.map((b) => b.say).join(" "));
    const overridden: GradingShort = { ...s, transcript: "  a real transcript  " };
    expect(shortTranscript(overridden)).toBe("a real transcript");
  });

  it("duration renders as an ISO 8601 duration", () => {
    expect(shortDurationIso({ ...GRADING_SHORTS[0]!, durationSeconds: 45 })).toBe(
      "PT45S",
    );
  });

  it("embeds are cookieless and URLs point at the right video", () => {
    expect(shortEmbedUrl("abc123")).toBe(
      "https://www.youtube-nocookie.com/embed/abc123",
    );
    expect(shortWatchUrl("abc123")).toBe("https://www.youtube.com/watch?v=abc123");
    expect(shortThumbnailUrl("abc123")).toBe(
      "https://i.ytimg.com/vi/abc123/maxresdefault.jpg",
    );
  });
});

// ── The publish gate ───────────────────────────────────────────────────
//
// This is the assertion that matters most. Marking up a VideoObject for a video
// nobody has filmed is fabricated structured data, the same class of error as a
// placeholder aggregateRating. The gate must hold in BOTH directions: silent
// while unproduced, and complete the moment an id lands.

describe("publish gate: no markup for a video that does not exist", () => {
  it("a short with no youtubeId is not published", () => {
    for (const s of GRADING_SHORTS) {
      if (!s.youtubeId) {
        expect(isPublished(s), `${s.guideSlug}`).toBe(false);
        expect(publishedShort(s.guideSlug)).toBeUndefined();
      }
    }
  });

  it("an id WITHOUT an upload date still does not publish", () => {
    // uploadDate is required by VideoObject, so half-filled is not live.
    expect(isPublished({ ...GRADING_SHORTS[0]!, youtubeId: "abc123" })).toBe(false);
    expect(
      isPublished({ ...GRADING_SHORTS[0]!, uploadDate: "2026-08-01" }),
    ).toBe(false);
    expect(
      isPublished({
        ...GRADING_SHORTS[0]!,
        youtubeId: "abc123",
        uploadDate: "2026-08-01",
      }),
    ).toBe(true);
  });

  it("guide JSON-LD emits no VideoObject while nothing is published", () => {
    for (const guide of GARMENT_GUIDES) {
      const types = garmentGuideJsonLd(guide).map((n) => n["@type"]);
      if (publishedShort(guide.slug)) {
        expect(types, `${guide.slug}`).toContain("VideoObject");
      } else {
        expect(types, `${guide.slug} marks up a video that isn't live`).not.toContain(
          "VideoObject",
        );
      }
    }
  });

  it("publishedShorts() lists exactly the live ones", () => {
    expect(publishedShorts()).toEqual(GRADING_SHORTS.filter(isPublished));
  });

  it("getShortByGuideSlug finds a scripted short regardless of publish state", () => {
    const s = GRADING_SHORTS[0]!;
    expect(getShortByGuideSlug(s.guideSlug)).toBe(s);
    expect(getShortByGuideSlug("not-a-guide")).toBeUndefined();
  });

  it("guidesWithoutShorts() is the candidate pool for the next batch", () => {
    const pool = guidesWithoutShorts();
    expect(pool.length).toBe(GARMENT_GUIDES.length - GRADING_SHORTS.length);
    for (const s of GRADING_SHORTS) expect(pool).not.toContain(s.guideSlug);
  });
});
