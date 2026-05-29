import { describe, it, expect } from "vitest";
import { GRADE_TIERS, GRADE_FACTORS } from "../../constants";
import {
  GLOSSARY_ENTRIES,
  glossaryRoutes,
  glossaryTrail,
  tierSlug,
  factorSlug,
  getGlossaryEntryBySlug,
  getGlossaryEntryByPath,
} from "../glossary";
import { PUBLIC_ROUTES } from "../public-routes";

// US-303 AC: every constants tier/factor must have a corresponding generated
// glossary route AND a registry entry, with well-formed, hub-and-spoke content.

const registeredPaths = new Set(PUBLIC_ROUTES.map((r) => r.path));

describe("grading glossary hub (US-303)", () => {
  it("generates one entry per grade tier, keyed off constants", () => {
    for (const tier of GRADE_TIERS) {
      const path = `/grading/${tierSlug(tier)}`;
      const entry = getGlossaryEntryByPath(path);
      expect(entry, `missing glossary entry for tier "${tier}"`).toBeDefined();
      expect(entry!.kind).toBe("tier");
      expect(entry!.term).toBe(tier);
      // Registry entry exists → flows into manifest/sitemap/IndexNow/prerender.
      expect(registeredPaths.has(path)).toBe(true);
    }
  });

  it("generates one entry per grading factor, keyed off constants", () => {
    for (const key of Object.keys(GRADE_FACTORS)) {
      const path = `/grading/${factorSlug(key)}`;
      const entry = getGlossaryEntryByPath(path);
      expect(entry, `missing glossary entry for factor "${key}"`).toBeDefined();
      expect(entry!.kind).toBe("factor");
      expect(registeredPaths.has(path)).toBe(true);
    }
  });

  it("has exactly tiers + factors entries (no extras, no orphans)", () => {
    const expected = GRADE_TIERS.length + Object.keys(GRADE_FACTORS).length;
    expect(GLOSSARY_ENTRIES.length).toBe(expected);
    expect(glossaryRoutes().length).toBe(expected);
  });

  it("slugs and paths are unique", () => {
    const slugs = GLOSSARY_ENTRIES.map((e) => e.slug);
    const paths = GLOSSARY_ENTRIES.map((e) => e.path);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("every entry is well-formed (title/description/definition/faqs/lookFor)", () => {
    for (const e of GLOSSARY_ENTRIES) {
      expect(e.path).toBe(`/grading/${e.slug}`);
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(0);
      // Keep descriptions concise enough for SERP/meta use.
      expect(e.description.length).toBeLessThanOrEqual(200);
      expect(e.h1.length).toBeGreaterThan(0);
      expect(e.rangeLabel.length).toBeGreaterThan(0);
      expect(e.definition.length).toBeGreaterThan(40);
      expect(e.lookFor.length).toBeGreaterThan(0);
      expect(e.examples.length).toBeGreaterThan(0);
      expect(e.faqs.length).toBeGreaterThan(0);
      for (const f of e.faqs) {
        expect(f.q.length).toBeGreaterThan(0);
        expect(f.a.length).toBeGreaterThan(0);
      }
    }
  });

  it("related-term links all resolve to real glossary entries", () => {
    for (const e of GLOSSARY_ENTRIES) {
      expect(e.relatedSlugs.length).toBeGreaterThan(0);
      for (const rel of e.relatedSlugs) {
        expect(
          getGlossaryEntryBySlug(rel),
          `entry "${e.slug}" links to missing related slug "${rel}"`,
        ).toBeDefined();
      }
    }
  });

  it("breadcrumb trail is 3 levels back to the pillar", () => {
    for (const e of GLOSSARY_ENTRIES) {
      const trail = glossaryTrail(e);
      expect(trail).toHaveLength(3);
      expect(trail[0]!.path).toBe("/");
      expect(trail[1]!.path).toBe("/condition-grading");
      expect(trail[2]!.path).toBe(e.path);
      expect(trail[2]!.name).toBe(e.term);
    }
  });

  it("generated routes are registry-shaped (FAQPage, monthly, sane priority)", () => {
    for (const r of glossaryRoutes()) {
      expect(r.path.startsWith("/grading/")).toBe(true);
      expect(r.jsonLdType).toBe("FAQPage");
      expect(r.changefreq).toBe("monthly");
      expect(r.priority).toBeGreaterThan(0);
      expect(r.priority).toBeLessThanOrEqual(1);
    }
  });
});
