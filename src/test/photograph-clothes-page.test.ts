import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED_PHOTO_PROFILES, bundledPhotoProfile } from "@/lib/photo-profiles";
import { REQUIRED_PHOTO_TYPES } from "@/lib/constants";
import { getCalculatorBySlug } from "@/lib/seo/calculators";
import { KEYWORD_TARGETS } from "@/lib/seo/keyword-targets";

// US-9023. The page renders the app's own shot list. The risk it carries is
// not a rendering bug, it is DRIFT: a marketing page that quietly grows its own
// opinion about photo order puts GradeThread on both sides of the question, and
// the public copy is the half nobody keeps current.

const PAGE = join(process.cwd(), "src", "pages", "tools", "photograph-clothes-to-sell.tsx");

describe("the shot list comes from the product, not the page", () => {
  it("imports the bundled profiles rather than declaring its own", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).toContain("BUNDLED_PHOTO_PROFILES");
    expect(src).toContain("@/lib/photo-profiles");
  });

  it("declares no shot list of its own", () => {
    // The failure this catches is somebody adding "just one more slot" to the
    // marketing page because editing the profile felt riskier.
    const src = readFileSync(PAGE, "utf8");
    expect(src).not.toMatch(/roles\s*:\s*\[/);
    expect(src).not.toMatch(/hint\s*:\s*"/);
  });

  it("offers every bundled profile, so no category is silently unserved", () => {
    expect(BUNDLED_PHOTO_PROFILES.length).toBeGreaterThanOrEqual(3);
    for (const p of BUNDLED_PHOTO_PROFILES) {
      expect(bundledPhotoProfile(p.category).category, p.category).toBe(p.category);
    }
  });

  it("keeps front at index 0 in every profile, because that is the cover image", () => {
    for (const p of BUNDLED_PHOTO_PROFILES) {
      expect(p.roles[0]?.type, p.category).toBe("front");
    }
  });

  it("agrees with REQUIRED_PHOTO_TYPES on what a clothing listing cannot go live without", () => {
    // The page prints a "required" badge. If it disagreed with the gate, a
    // seller would follow the public page and still be blocked in the app.
    const required = bundledPhotoProfile("clothing")
      .roles.filter((r) => r.required)
      .map((r) => r.type);
    expect(required).toEqual([...REQUIRED_PHOTO_TYPES]);
  });

  it("gives every rendered slot a hint, since the hint is the instruction", () => {
    for (const p of BUNDLED_PHOTO_PROFILES) {
      for (const r of p.roles) {
        expect(r.hint, `${p.category}/${r.type}`).toBeTruthy();
        expect(r.label, `${p.category}/${r.type}`).toBeTruthy();
      }
    }
  });
});

describe("the page is registered", () => {
  it("is live with content and a handoff", () => {
    const calc = getCalculatorBySlug("photograph-clothes-to-sell");
    expect(calc?.status).toBe("live");
    expect(calc?.intro).toBeTruthy();
    expect(calc?.faqs?.length).toBeGreaterThanOrEqual(4);
    expect(calc?.handoff?.surface).toBe("autolister");
  });

  it("owns the head keyword", () => {
    const target = KEYWORD_TARGETS.find(
      (t) => t.path === "/tools/photograph-clothes-to-sell",
    );
    expect(target?.primary).toBe("how to take pictures of clothes to sell");
    const calc = getCalculatorBySlug("photograph-clothes-to-sell")!;
    expect(`${calc.title} ${calc.description}`.toLowerCase()).toContain(
      "how to take pictures of clothes to sell",
    );
  });

  it("keeps the defect section, which is the part no competing page has", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).toMatch(/Photographing a flaw/);
    expect(src).toMatch(/not-as-described|postage both ways/);
  });

  it("links to the two narrower posts it is the parent of", () => {
    // Those two rank around position 8 with nothing above them. The interlink
    // is the reason this page is the cheapest structural win in the pull.
    const src = readFileSync(PAGE, "utf8");
    expect(src).toContain("/blog/best-order-ebay-clothing-listing-photos");
    expect(src).toContain("/blog/why-ebay-listing-thumbnails-lose-clicks-photo-consistency");
  });
});
