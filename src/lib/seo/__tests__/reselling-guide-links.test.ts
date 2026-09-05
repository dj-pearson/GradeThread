// US-3090: what a reselling guide is allowed to CLAIM and allowed to LINK TO.
//
// Both properties are invisible in the rendered page. A guide that promises an
// extension flow the constants have switched off looks exactly like one that
// does not, and a guide leaking authority across hubs looks exactly like one
// that does not, right up until the SERP moves.

import { describe, expect, it } from "vitest";
import { MARKETPLACE_EXTENSION_FLOW } from "@/lib/constants";
import {
  RESELLING_GUIDES,
  guideClosetSentence,
  guideMechanismSentence,
  resellingGuidePath,
} from "../reselling-guides";
import { destinationMechanism } from "../crosslist-pairs";
import { isCrossHubLinkAllowed } from "../interlink-rules";
import { PUBLIC_ROUTES } from "../public-routes";
import { FRESHNESS_REGISTRY, verifiedLabel } from "../freshness";

const VINTED_SLUG = "how-to-sell-on-vinted";
const vinted = RESELLING_GUIDES.find((g) => g.slug === VINTED_SLUG);

describe("the guide's mechanism copy is derived, not written", () => {
  it("says what MARKETPLACE_TIER and MARKETPLACE_EXTENSION_FLOW say", () => {
    // The whole point of routing this through destinationMechanism: Mercari,
    // Grailed and Vinted all spent months being advertised as ready to list
    // while their selectors sat disabled, because the badge and the flow were
    // two hand-written facts instead of one derived one.
    // ⚠ THE ASSERTION IS THE RELATIONSHIP, NOT THE VALUE. Pinning
    // MARKETPLACE_EXTENSION_FLOW.vinted === "live" here would fail the moment
    // somebody switched the flow off, which is the one case where the guide is
    // behaving correctly - it would change its own sentence. What must hold is
    // that the guide says whatever the constants say, at any value of them.
    const derived = guideMechanismSentence("vinted", "Vinted");
    const section = vinted?.sections.find((s) => s.body.includes(derived));
    expect(
      section,
      "the Vinted guide no longer renders the derived mechanism sentence",
    ).toBeTruthy();

    // And the three branches are genuinely different sentences, so "derived"
    // is not satisfied by a helper that returns the same string for every
    // channel. eBay is api, Vinted is extension, Whatnot is neither.
    expect(destinationMechanism("ebay")).toBe("api");
    expect(destinationMechanism("whatnot")).toBe("manual");
    const said = new Set([
      guideMechanismSentence("ebay", "eBay"),
      guideMechanismSentence("vinted", "Vinted"),
      guideMechanismSentence("whatnot", "Whatnot"),
    ]);
    expect(said.size).toBe(3);
  });

  it("degrades to 'the last step is yours' when the flow is switched off", () => {
    // Facebook is the live example of the off state, so the fallback branch is
    // exercised against a real constant rather than a made-up platform.
    expect(MARKETPLACE_EXTENSION_FLOW.facebook).toBe("verifying");
    const off = guideMechanismSentence("facebook", "Marketplace");
    expect(off).toContain("no verified extension flow");
    expect(off).not.toContain("you press post");
  });

  it("does not claim a Vinted closet import", () => {
    // canReadCloset is poshmark + mercari. Claiming Vinted here would promise
    // an import the extension cannot do.
    const closet = guideClosetSentence("vinted", "Vinted");
    expect(closet).toContain("no export the extension can read");
    expect(vinted?.sections.some((s) => s.body.includes(closet))).toBe(true);
  });
});

describe("every curated link is allowed and real", () => {
  const registered = new Set(PUBLIC_ROUTES.map((r) => r.path.replace(/\/+$/, "") || "/"));

  for (const guide of RESELLING_GUIDES) {
    for (const link of guide.related ?? []) {
      it(`${guide.slug} -> ${link.to}`, () => {
        // A link to a path nothing serves is a 404 that no test of the source
        // registry alone would catch, because the string is well-formed.
        expect(registered.has(link.to), `${link.to} is not a public route`).toBe(true);
        expect(
          isCrossHubLinkAllowed(resellingGuidePath(guide.slug), link.to),
          `${link.to} is a forbidden cross-hub link`,
        ).toBe(true);
        // Generic anchors waste the link. US-1674's anchor discipline in one line.
        expect(link.label.length).toBeGreaterThan(8);
      });
    }
  }

  it("the Vinted guide links the four allowed pages of the five AC4 names", () => {
    // Four, not the five AC4 lists: /grading/platform-standards/vinted is a
    // forbidden cross-hub link, and the same criterion requires every entry to
    // pass isCrossHubLinkAllowed. See the callout on the guide.
    expect((vinted?.related ?? []).map((r) => r.to)).toEqual([
      "/compare/vinted-vs-mercari",
      "/compare/vinted-vs-poshmark",
      "/reselling/crosslist/mercari-to-vinted",
      "/reselling/crosslist/vinted-to-poshmark",
    ]);
  });
});

describe("a guide stating fees carries a real verification date", () => {
  it("the Vinted guide is stamped from the registry", () => {
    expect(vinted?.freshnessGroup).toBe("vinted");
    expect(FRESHNESS_REGISTRY.vinted.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(verifiedLabel("vinted")).toMatch(/^[A-Z][a-z]+ \d{4}$/);
  });

  it("every guide quoting a dollar figure or a deadline is stamped", () => {
    // The rule this enforces: if the copy states a number the PLATFORM controls,
    // a person has to have re-read the platform's page for it, and the page has
    // to say when. Prose without such a number needs no stamp.
    // Deliberately narrow: a bare dollar amount is usually an ILLUSTRATION
    // ("a $12 thrift find"), and stamping a guide for one would make the stamp
    // meaningless. What needs a date is a figure the PLATFORM sets.
    const VOLATILE = /\d\s?%|\d+ business days|Buyer Protection fee|no seller fee/i;
    for (const g of RESELLING_GUIDES) {
      const prose = [g.intro, ...g.sections.map((s) => s.body), ...g.faqs.map((f) => f.a)]
        .join(" ");
      if (!VOLATILE.test(prose)) continue;
      expect(
        g.freshnessGroup,
        `${g.slug} states a platform-controlled figure but carries no freshness group`,
      ).toBeTruthy();
    }
  });
});
