import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LISTING_DRAFT_ENDPOINT,
  LISTING_DRAFT_MAX_PHOTOS,
  LISTING_DRAFT_PER_HOUR,
  listingTemplate,
  listingTemplates,
  TEMPLATE_PLATFORMS,
  templateNotes,
  titlePattern,
} from "../seo/listing-templates";
import { MARKETPLACE_SPECS } from "../marketplace-specs";

// US-3089 AC3. Every number and every field name on /tools/listing-generator is
// read from MARKETPLACE_SPECS rather than typed into the page.
//
// This is the assertion the whole page rests on. The incumbents on these SERPs
// are template sites whose character counts stopped being true years ago, and
// the only reason nobody noticed is that a number typed into a paragraph has
// nothing checking it. If these tests pass, ours cannot drift from the registry
// the product itself pushes against.

const ROOT = resolve(import.meta.dirname, "../../..");

describe("US-3089: every rendered limit is the registry's", () => {
  it("takes the title limit from MARKETPLACE_SPECS, including Depop's null", () => {
    for (const platform of TEMPLATE_PLATFORMS) {
      expect(listingTemplate(platform).titleLimit, platform).toBe(
        MARKETPLACE_SPECS[platform].titleMaxLength,
      );
    }
    // Depop has no separate title field. A template that printed 80 here would
    // be inventing a rule the platform does not have.
    expect(listingTemplate("depop").titleLimit).toBe(null);
    expect(titlePattern("depop")).toBe(null);
  });

  it("takes the description limit and photo cap from MARKETPLACE_SPECS", () => {
    for (const platform of TEMPLATE_PLATFORMS) {
      const t = listingTemplate(platform);
      expect(t.descriptionLimit, platform).toBe(MARKETPLACE_SPECS[platform].descriptionMaxLength);
      expect(t.maxPhotos, platform).toBe(MARKETPLACE_SPECS[platform].maxPhotos);
    }
  });

  it("prints no number in a note that the registry does not hold", () => {
    // The failure this catches is a hand-typed figure surviving a registry
    // correction. Every integer in the notes must be a value from the spec.
    for (const platform of TEMPLATE_PLATFORMS) {
      const spec = MARKETPLACE_SPECS[platform];
      const allowed = new Set(
        [
          spec.titleMaxLength,
          spec.descriptionMaxLength,
          spec.maxPhotos,
          spec.tags?.max,
          spec.priceStep,
        ].filter((n): n is number => typeof n === "number").map(String),
      );
      // The whole-dollars note quotes an example price; it is prose, not a
      // limit, and it is the one string allowed to carry its own digits.
      for (const note of templateNotes(platform)) {
        const cleaned = note.replace(/\$32\.49/g, "");
        for (const found of cleaned.matchAll(/\d[\d,]*/g)) {
          const bare = found[0].replace(/,/g, "");
          expect(
            allowed.has(bare),
            `${platform}: "${found[0]}" appears in a note but is not a MARKETPLACE_SPECS value`,
          ).toBe(true);
        }
      }
    }
  });

  it("names fields with the registry's own labels", () => {
    for (const platform of TEMPLATE_PLATFORMS) {
      const t = listingTemplate(platform);
      const labels = new Set(MARKETPLACE_SPECS[platform].fields.map((f) => f.label));
      for (const field of t.fields) {
        expect(labels.has(field.label), `${platform}: ${field.label}`).toBe(true);
      }
      // Title and description are the template itself, not entries in the
      // details list, or the seller fills them twice.
      expect(t.fields.some((f) => f.key === "title")).toBe(false);
      expect(t.fields.some((f) => f.key === "description")).toBe(false);
    }
  });

  it("puts the registry's field labels into the description template body", () => {
    // The stronger form of the check above: the RENDERED string has to carry
    // them, not just the fields array a caller might ignore.
    const poshmark = listingTemplate("poshmark");
    expect(poshmark.descriptionTemplate).toContain("Color (up to 2)");
    expect(poshmark.descriptionTemplate).toContain("Size");
    for (const platform of TEMPLATE_PLATFORMS) {
      const t = listingTemplate(platform);
      for (const field of t.fields) {
        if (field.key === "price" || field.key === "originalPrice") continue;
        expect(
          t.descriptionTemplate.includes(field.label),
          `${platform} template is missing "${field.label}"`,
        ).toBe(true);
      }
    }
  });

  it("uses each platform's OWN condition wording", () => {
    // A Poshmark listing that says "Used - Excellent" instead of "EUC" reads as
    // written by somebody who does not sell there.
    expect(listingTemplate("poshmark").descriptionTemplate).toContain("EUC");
    expect(listingTemplate("mercari").descriptionTemplate).toContain("Like new");
    expect(listingTemplate("depop").descriptionTemplate).toContain("Used - excellent");
  });

  it("warns about whole dollars exactly where the registry says priceStep is 1", () => {
    for (const platform of TEMPLATE_PLATFORMS) {
      const warned = templateNotes(platform).some((n) => /whole dollars/i.test(n));
      expect(warned, platform).toBe(MARKETPLACE_SPECS[platform].priceStep === 1);
    }
  });

  it("mentions hashtags exactly where the registry declares them", () => {
    for (const platform of TEMPLATE_PLATFORMS) {
      const mentioned = templateNotes(platform).some((n) => /hashtag/i.test(n));
      expect(mentioned, platform).toBe(Boolean(MARKETPLACE_SPECS[platform].tags));
    }
  });

  it("gives every platform a usable template", () => {
    const all = listingTemplates();
    expect(all).toHaveLength(TEMPLATE_PLATFORMS.length);
    for (const t of all) {
      expect(t.descriptionTemplate.length, t.platform).toBeGreaterThan(120);
      expect(t.notes.length, t.platform).toBeGreaterThanOrEqual(3);
      expect(t.label, t.platform).toBe(MARKETPLACE_SPECS[t.platform].label);
    }
  });
});

describe("US-3089: the mirrored edge limits are pinned to the edge", () => {
  // LISTING_DRAFT_MAX_PHOTOS and LISTING_DRAFT_PER_HOUR are a COPY. The edge
  // and the SPA are different runtimes and cannot import each other, so the
  // only thing stopping the page from advertising a limit the endpoint no
  // longer enforces is this test. A visitor told "up to 3 photos" who is
  // refused at 3 has been lied to by the page, not by the endpoint.
  const edgeLib = readFileSync(
    resolve(ROOT, "services/edge-functions/src/lib/free-listing-draft.ts"),
    "utf8",
  );
  const edgeRoute = readFileSync(
    resolve(ROOT, "services/edge-functions/src/routes/public-grading.ts"),
    "utf8",
  );

  it("matches FREE_DRAFT_MAX_IMAGES on the edge", () => {
    const m = edgeLib.match(/FREE_DRAFT_MAX_IMAGES\s*=\s*(\d+)/);
    expect(m, "FREE_DRAFT_MAX_IMAGES not found in the edge module").toBeTruthy();
    expect(Number(m![1])).toBe(LISTING_DRAFT_MAX_PHOTOS);
  });

  it("matches the route's per-IP hourly window", () => {
    const m = edgeRoute.match(/LISTING_DRAFT_PER_IP_PER_HOUR\s*=\s*(\d+)/);
    expect(m, "LISTING_DRAFT_PER_IP_PER_HOUR not found in the edge route").toBeTruthy();
    expect(Number(m![1])).toBe(LISTING_DRAFT_PER_HOUR);
  });

  it("posts to the path the edge actually mounts", () => {
    expect(LISTING_DRAFT_ENDPOINT).toBe("/api/grading/public/listing-draft");
    expect(edgeRoute).toContain('publicGradingRoutes.post("/listing-draft"');
  });
});
