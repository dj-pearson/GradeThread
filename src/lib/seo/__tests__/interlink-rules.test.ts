import { describe, it, expect } from "vitest";
import {
  APPROVED_ANCHORS,
  CANONICAL_SCALE_PATH,
  CERTIFICATE_UPLINK_PATH,
  HUB_PILLARS,
  SPINE_PATH,
  UPLINK_MAX_WORD_OFFSET,
  approvedAnchorsFor,
  hubForPath,
  isCrossHubLinkAllowed,
  isGenericAnchor,
  pickAnchor,
} from "../interlink-rules";
import { PUBLIC_ROUTES } from "../public-routes";
import { linkGlossaryTerms } from "../../../../functions/_shared/blog-render";

// US-1674: verify the interlinker rule-set on a sample corpus.

const registered = new Set(PUBLIC_ROUTES.map((r) => r.path));

describe("interlinker rule-set (US-1674)", () => {
  describe("approved-anchor discipline", () => {
    it("every governed target has 3–4 unique, non-generic approved anchors", () => {
      for (const [url, anchors] of Object.entries(APPROVED_ANCHORS)) {
        expect(anchors.length, `${url} anchor count`).toBeGreaterThanOrEqual(3);
        expect(anchors.length, `${url} anchor count`).toBeLessThanOrEqual(4);
        // unique
        expect(new Set(anchors).size, `${url} anchors unique`).toBe(anchors.length);
        // none generic
        for (const a of anchors) {
          expect(isGenericAnchor(a), `${url} anchor "${a}" is generic`).toBe(false);
        }
      }
    });

    it("every governed target URL is a registered indexable route", () => {
      for (const url of Object.keys(APPROVED_ANCHORS)) {
        expect(registered.has(url), `${url} not in PUBLIC_ROUTES`).toBe(true);
      }
    });

    it("flags generic anchors and accepts descriptive ones", () => {
      for (const bad of [
        "click here",
        "here",
        "read more",
        "learn more",
        "this page",
        "link",
        "CLICK HERE",
        "Read More »",
      ]) {
        expect(isGenericAnchor(bad), `"${bad}" should be generic`).toBe(true);
      }
      for (const good of [
        "the 1.0–10.0 grading scale",
        "reduce eBay returns",
        "condition grading",
        "NWT",
      ]) {
        expect(isGenericAnchor(good), `"${good}" should be allowed`).toBe(false);
      }
    });

    it("pickAnchor rotates deterministically within the approved set", () => {
      const url = "/grading/scale";
      const approved = approvedAnchorsFor(url);
      // Full rotation over the set, wrapping around, stable per seed.
      for (let seed = 0; seed < approved.length * 2; seed++) {
        const a = pickAnchor(url, seed);
        expect(a).toBe(approved[seed % approved.length]);
        expect(pickAnchor(url, seed)).toBe(a); // deterministic
      }
      // Negative seeds don't throw and stay in-set.
      expect(approved).toContain(pickAnchor(url, -1));
      // Ungoverned target → null.
      expect(pickAnchor("/about", 0)).toBeNull();
    });
  });

  describe("hub topology", () => {
    it("classifies representative paths into the right hub", () => {
      expect(hubForPath("/grading/scale")).toBe("grading");
      expect(hubForPath("/condition-grading")).toBe("grading");
      expect(hubForPath("/verify")).toBe("grading");
      expect(hubForPath("/reselling")).toBe("reselling");
      expect(hubForPath("/reselling/reduce-ebay-returns")).toBe("reselling");
      expect(hubForPath("/compare/mercari-vs-ebay")).toBe("reselling");
      expect(hubForPath("/flipdesk")).toBe("flipdesk");
      expect(hubForPath("/")).toBeNull();
      expect(hubForPath("/privacy")).toBeNull();
    });

    it("every hub pillar is a registered route", () => {
      for (const pillar of Object.values(HUB_PILLARS)) {
        expect(registered.has(pillar), `pillar ${pillar} not registered`).toBe(true);
      }
    });

    it("the spine and the certificate-uplink target are registered", () => {
      expect(registered.has(SPINE_PATH)).toBe(true);
      expect(registered.has(CERTIFICATE_UPLINK_PATH)).toBe(true);
      // Certificate pages ladder up to the canonical scale page.
      expect(CERTIFICATE_UPLINK_PATH).toBe(CANONICAL_SCALE_PATH);
      expect(HUB_PILLARS.grading).toBe(CANONICAL_SCALE_PATH);
    });
  });

  describe("cross-hub policy", () => {
    it("allows same-hub links freely", () => {
      expect(isCrossHubLinkAllowed("/reselling", "/compare/mercari-vs-ebay")).toBe(true);
      expect(isCrossHubLinkAllowed("/grading/scale", "/condition-grading")).toBe(true);
    });

    it("allows cross-hub links ONLY through the spine or a hub pillar", () => {
      // reselling → grading: only the scale pillar (or spine) is allowed.
      expect(isCrossHubLinkAllowed("/compare/mercari-vs-ebay", "/grading/scale")).toBe(true);
      expect(isCrossHubLinkAllowed("/reselling/ebay-item-specifics", SPINE_PATH)).toBe(true);
      // reselling → an arbitrary grading spoke is NOT allowed.
      expect(isCrossHubLinkAllowed("/compare/mercari-vs-ebay", "/grading/nwt")).toBe(false);
      // grading → reselling: only /reselling pillar (or spine) is allowed.
      expect(isCrossHubLinkAllowed("/grading/scale", "/reselling")).toBe(true);
      expect(isCrossHubLinkAllowed("/grading/scale", "/compare/mercari-vs-ebay")).toBe(false);
    });

    it("leaves non-hub paths unconstrained", () => {
      expect(isCrossHubLinkAllowed("/", "/grading/nwt")).toBe(true);
      expect(isCrossHubLinkAllowed("/grading/nwt", "/about")).toBe(true);
    });
  });

  describe("sample corpus compliance", () => {
    // A representative set of the internal links the site emits. Every one must
    // pass the cross-hub policy AND use a non-generic anchor; cross-hub links
    // must use the target's approved anchor set.
    const corpus: Array<{ from: string; to: string; anchor: string }> = [
      // Up-links (cluster → pillar) with approved anchors.
      { from: "/compare/mercari-vs-ebay", to: "/grading/scale", anchor: "the 1.0–10.0 grading scale" },
      { from: "/reselling/ebay-item-specifics", to: "/flipdesk", anchor: "FlipDesk" },
      // Universe-B → spine (the designated crossover).
      { from: "/reselling", to: SPINE_PATH, anchor: "cut not-as-described returns" },
      { from: "/compare/mercari-vs-ebay", to: SPINE_PATH, anchor: "reduce eBay returns" },
      // Same-hub sideways link (descriptive, not governed by approved set).
      { from: "/reselling/ebay-item-specifics", to: "/reselling", anchor: "the reselling workflow" },
    ];

    it("every corpus link satisfies cross-hub policy and anchor discipline", () => {
      for (const link of corpus) {
        expect(
          isCrossHubLinkAllowed(link.from, link.to),
          `${link.from} → ${link.to} violates cross-hub policy`,
        ).toBe(true);
        expect(
          isGenericAnchor(link.anchor),
          `anchor "${link.anchor}" is generic`,
        ).toBe(false);
        // If the target is governed, the anchor must be from its approved set.
        const approved = approvedAnchorsFor(link.to);
        if (approved.length > 0) {
          expect(approved, `${link.to} anchor "${link.anchor}" not approved`).toContain(
            link.anchor,
          );
        }
      }
    });

    it("rejects a non-compliant cross-hub link and a generic anchor", () => {
      // A reselling page deep-linking a grading spoke (not a pillar/spine).
      expect(isCrossHubLinkAllowed("/reselling", "/grading/nwt")).toBe(false);
      expect(isGenericAnchor("click here")).toBe(true);
    });
  });

  describe("the real interlinker obeys the anchor rules on a sample corpus", () => {
    // linkGlossaryTerms is the live sideways-linking pass. Its emitted anchors
    // are the matched glossary terms themselves — assert none are generic and
    // every injected link points at a /grading/ spoke (the scale-ward moat).
    const sample =
      "<p>Every listing should state condition. An item in Excellent condition " +
      "or Very Good condition beats a vague NWT claim. Check the Fabric Condition " +
      "and Structural Integrity before you grade.</p>";

    it("emits only non-generic anchors that point into the grading moat", () => {
      const { html, terms } = linkGlossaryTerms(sample);
      expect(terms.length).toBeGreaterThan(0);
      const anchorTexts = [...html.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)];
      expect(anchorTexts.length).toBe(terms.length);
      for (const [, href, text] of anchorTexts) {
        expect(isGenericAnchor(text ?? ""), `glossary anchor "${text}" generic`).toBe(false);
        expect(href?.startsWith("/grading/"), `href ${href} not a grading spoke`).toBe(true);
      }
    });

    it("is idempotent — a second pass adds no new anchors", () => {
      const first = linkGlossaryTerms(sample).html;
      const firstCount = (first.match(/<a /g) ?? []).length;
      const second = linkGlossaryTerms(first).html;
      const secondCount = (second.match(/<a /g) ?? []).length;
      expect(firstCount).toBeGreaterThan(0);
      expect(secondCount).toBe(firstCount);
    });
  });

  it("exposes the up-link word-offset budget", () => {
    expect(UPLINK_MAX_WORD_OFFSET).toBe(100);
  });
});
