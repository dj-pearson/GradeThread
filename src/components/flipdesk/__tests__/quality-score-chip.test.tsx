// US-1897 (AC2): the quality-score chip + breakdown render correctly.
//
// Rendered markup is asserted via renderToStaticMarkup (the repo's convention —
// no @testing-library here), so these run headless and still catch the things
// that actually matter: a blocked listing must not look like a merely-weak one,
// an unscored listing must not look like a zero, and every fixable component
// must name its fix surface.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  QualityScoreBreakdown,
  QualityScoreChip,
  scoreBand,
  type ListingQualityScore,
} from "@/components/flipdesk/quality-score-chip";

function makeScore(over: Partial<ListingQualityScore> = {}): ListingQualityScore {
  return {
    score: 92,
    weightCounted: 100,
    blocked: false,
    blockingReasons: [],
    components: [
      { key: "aspects", label: "Item specifics", weight: 30, earned: 30, status: "ok", detail: "8/8 filled.", fixSurface: "composer.aspects" },
      { key: "photos", label: "Photos", weight: 25, earned: 20, status: "warn", detail: "Hero is a tag shot.", fixSurface: "composer.photos" },
    ],
    topFixes: [{ key: "photos", label: "Photos", pointsAvailable: 5, fixSurface: "composer.photos" }],
    ...over,
  };
}

describe("scoreBand", () => {
  it("gives a blocked listing its OWN band, not merely a low one", () => {
    // The server caps a blocked listing at 40 so it sorts with the wreckage.
    // Painting it the same amber as a weak-but-listable one would undo that on
    // screen — which is the exact confusion the cap exists to prevent.
    expect(scoreBand(40, true)).toBe("blocked");
    expect(scoreBand(95, true)).toBe("blocked");
    expect(scoreBand(40, false)).toBe("poor");
  });

  it("bands a publishable listing by score", () => {
    expect(scoreBand(85, false)).toBe("good");
    expect(scoreBand(60, false)).toBe("fair");
    expect(scoreBand(59, false)).toBe("poor");
  });
});

describe("QualityScoreChip", () => {
  it("shows the number for a healthy listing", () => {
    const html = renderToStaticMarkup(<QualityScoreChip score={makeScore()} />);
    expect(html).toContain("92");
    expect(html).toContain("Listing quality 92/100");
  });

  it("says 'Can't list' rather than a number when blocked", () => {
    // A blocked listing's score is not the actionable fact about it.
    const html = renderToStaticMarkup(
      <QualityScoreChip
        score={makeScore({ score: 40, blocked: true, blockingReasons: ["1 required specific missing: Size"] })}
      />,
    );
    expect(html).toContain("Can&#x27;t list");
    expect(html).toContain("1 required specific missing: Size");
    expect(html).not.toMatch(/>40</);
  });

  it("renders an em dash for a never-scored listing, never a zero", () => {
    // NULL and 0 are different facts. A confident 0 would sort an unscored
    // draft in with the worst listings in the account.
    const html = renderToStaticMarkup(<QualityScoreChip score={null} />);
    // Assert the rendered TEXT, not the raw markup: a naive not.toContain("0")
    // matches "py-0.5" in a class name and passes for the wrong reason.
    expect(html).toContain(">—</span>");
    expect(html).not.toContain(">0</span>");
    expect(html).toContain("Not scored yet");
  });
});

describe("QualityScoreBreakdown", () => {
  it("names each component and what it cost", () => {
    const html = renderToStaticMarkup(<QualityScoreBreakdown score={makeScore()} />);
    expect(html).toContain("Item specifics");
    expect(html).toContain("30/30");
    expect(html).toContain("Photos");
    expect(html).toContain("20/25");
    expect(html).toContain("Hero is a tag shot.");
  });

  it("surfaces the biggest available win", () => {
    const html = renderToStaticMarkup(<QualityScoreBreakdown score={makeScore()} />);
    expect(html).toContain("Biggest win");
    expect(html).toContain("+5 pts");
  });

  it("offers a Fix action for fixable components only", () => {
    // An 'ok' component has nothing to fix, and an 'unknown' one is a signal we
    // could not read — offering to 'fix' either sends the seller somewhere
    // pointless.
    const html = renderToStaticMarkup(
      <QualityScoreBreakdown score={makeScore()} onFix={vi.fn()} />,
    );
    // 2 components, exactly one of which is fixable (photos: warn).
    expect(html.match(/>Fix</g)?.length).toBe(1);
  });

  it("does not render Fix buttons when no handler is supplied", () => {
    const html = renderToStaticMarkup(<QualityScoreBreakdown score={makeScore()} />);
    expect(html).not.toContain(">Fix<");
    // ...but the component is still named, so the seller knows what is wrong.
    expect(html).toContain("Photos");
  });

  it("leads with the blocking reason when the listing can't go live", () => {
    const html = renderToStaticMarkup(
      <QualityScoreBreakdown
        score={makeScore({ blocked: true, blockingReasons: ["Not a leaf category — pick a subcategory."] })}
      />,
    );
    expect(html).toContain("can’t go live yet");
    expect(html).toContain("Not a leaf category");
  });

  it("admits when the score was computed on partial information", () => {
    // Unknown signals are excluded from the maths server-side rather than
    // penalised; the seller should be told the number was scaled, not left to
    // assume it was a full assessment.
    const html = renderToStaticMarkup(
      <QualityScoreBreakdown
        score={makeScore({
          weightCounted: 90,
          components: [
            { key: "fulfillment", label: "Shipping & returns", weight: 10, earned: 0, status: "unknown", detail: "Business policies not synced.", fixSurface: "settings.businessPolicies" },
          ],
        })}
      />,
    );
    expect(html).toContain("Scored on 90 of 100 points");
    expect(html).toContain("not checked");
    // An unknown component must never show as 0/10 — that reads as a failure.
    expect(html).not.toContain("0/10");
  });
});
