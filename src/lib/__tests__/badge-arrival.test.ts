import { describe, it, expect } from "vitest";
import {
  BADGE_ARRIVAL_PLATFORMS,
  badgeArrival,
  badgeArrivalNote,
} from "../badge-arrival";

// US-3060 AC7. A certificate opened from an on-marketplace badge.
//
// Two load-bearing decisions.
//
// The platform rides in `utm_campaign`, NOT `utm_source`. attribution.js sets
// utm_source="extension" on every link the extension puts on the site, and that
// is how extension traffic is told apart from every other channel — so a case
// below pins that a badge link keeping utm_source=extension still resolves.
//
// And it is ALLOWLISTED rather than echoed. It reaches an analytics property
// and a rendered sentence, and the URL is one anyone can construct — echoing it
// would put attacker-chosen text on our own certificate page.

const q = (s: string) => new URLSearchParams(s);

describe("US-3060: recognising a badge arrival", () => {
  it("reads the platform from a real badge link", () => {
    expect(badgeArrival(q("utm_medium=badge&utm_campaign=ebay"))).toEqual({ platform: "ebay" });
    for (const p of BADGE_ARRIVAL_PLATFORMS) {
      expect(badgeArrival(q(`utm_medium=badge&utm_campaign=${p}`))?.platform, p).toBe(p);
    }
  });

  it("resolves on a real attribution.js link, which keeps utm_source=extension", () => {
    // The shape attribution.js actually produces: source is the extension,
    // medium is the badge, campaign is the marketplace. If this ever needs the
    // platform in utm_source again, the extension convention has changed and
    // certificateUrl in research/listing-badge.js has to change with it.
    const real = q("utm_source=extension&utm_medium=badge&utm_campaign=poshmark&utm_content=v1.1.0");
    expect(badgeArrival(real)).toEqual({ platform: "poshmark" });
  });

  it("is null on every ordinary visit", () => {
    // The caller's check is a single truthiness test, so the note cannot render
    // on a direct arrival, a share, or a QR scan.
    for (const s of ["", "s=qr", "s=share", "utm_medium=email&utm_campaign=ebay", "utm_campaign=ebay"]) {
      expect(badgeArrival(q(s)), s).toBe(null);
    }
  });

  it("tolerates casing and whitespace, because a link is retyped by hand", () => {
    expect(badgeArrival(q("utm_medium=BADGE&utm_campaign=eBay"))).toEqual({ platform: "ebay" });
    expect(badgeArrival(q("utm_medium=%20badge%20&utm_campaign=%20mercari"))).toEqual({
      platform: "mercari",
    });
  });

  it("NEVER echoes an unrecognised source", () => {
    // The whole reason for the allowlist. Each of these is a source somebody
    // could put in a link and send to a buyer.
    for (const source of [
      "<script>alert(1)</script>",
      "Definitely Not A Scam Marketplace",
      "grailed",
      "'; DROP TABLE",
      "ebay.evil.example",
    ]) {
      const arrival = badgeArrival(q(`utm_medium=badge&utm_campaign=${encodeURIComponent(source)}`));
      expect(arrival, source).not.toBe(null);
      expect(arrival?.platform, source).toBe(null);
      // And nothing renders, so the string cannot reach the page at all.
      expect(badgeArrivalNote(arrival), source).toBe(null);
    }
  });
});

describe("US-3060: the note", () => {
  it("names the marketplace with its own capitalisation", () => {
    expect(badgeArrivalNote({ platform: "ebay" })).toBe(
      "Seen via the GradeThread extension on eBay.",
    );
    expect(badgeArrivalNote({ platform: "poshmark" })).toContain("Poshmark");
    expect(badgeArrivalNote({ platform: "mercari" })).toContain("Mercari");
  });

  it("says nothing rather than something vague", () => {
    // A badge arrival with no recognised platform gets NO note: "seen via the
    // extension" without saying where adds nothing and still has to be read.
    expect(badgeArrivalNote({ platform: null })).toBe(null);
    expect(badgeArrivalNote(null)).toBe(null);
  });

  it("contains no URL and no listing id", () => {
    for (const p of BADGE_ARRIVAL_PLATFORMS) {
      const note = badgeArrivalNote({ platform: p }) ?? "";
      expect(note).not.toMatch(/http|\/|\d/);
    }
  });
});
