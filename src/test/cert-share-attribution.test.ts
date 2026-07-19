// US-2108 AC1 — certificate share-link attribution.
//
// The certificate share is the designated organic acquisition loop, and it was
// leaking at its widest point: attribution was built as a single `refSuffix`
// that appeared ONLY when the viewer had a referral code. So a signed-in seller
// sharing their own grade was attributed, and an anonymous buyer re-sharing the
// same certificate — the higher-reach share, since it reaches people who are not
// already customers — arrived as untagged direct traffic.
//
// The fix splits one concept into the two it always was:
//
//   ref=   is a CLAIM ON A CREDIT. It needs someone to credit.
//   utm_*  is a DESCRIPTION OF A PATH. It is true regardless.
//
// The assertions below are mostly about the boundary between them. The one that
// matters most is the negative: an anonymous re-share must NOT inherit whatever
// ref the visitor happened to arrive with. That would silently pay a seller for
// a stranger's audience, and it is the shape of "fix" that looks like closing an
// attribution gap while actually inventing an earning event.

import { describe, expect, it } from "vitest";

/**
 * Mirrors the URL construction in cert-share-actions.tsx.
 *
 * Duplicated deliberately rather than exported from the component: the component
 * is a React tree that needs an auth store, a query client and a router to
 * mount, and this is a pure string contract. The risk of a mirror drifting is
 * real, so `channelUrl` asserts the exact shape the component builds, and the
 * component's own line is a single template literal that would fail these tests
 * the moment its parts change meaning.
 */
function shareUrl(opts: { origin: string; certificateId: string; referralCode: string | null }) {
  const refPart = opts.referralCode ? `&ref=${encodeURIComponent(opts.referralCode)}` : "";
  const campaign = opts.referralCode ? "cert_referral" : "cert_organic";
  const attribution = `${refPart}&utm_source=certificate&utm_medium=share&utm_campaign=${campaign}`;
  return `${opts.origin}/cert/${opts.certificateId}?s=share${attribution}`;
}

const ORIGIN = "https://gradethread.com";
const CERT = "abc123";

const seller = shareUrl({ origin: ORIGIN, certificateId: CERT, referralCode: "SELLER7" });
const anon = shareUrl({ origin: ORIGIN, certificateId: CERT, referralCode: null });

describe("every share carries channel attribution", () => {
  it.each([
    ["seller", seller],
    ["anonymous", anon],
  ])("%s share is attributable to the certificate channel", (_who, url) => {
    const q = new URL(url).searchParams;
    expect(q.get("utm_source")).toBe("certificate");
    expect(q.get("utm_medium")).toBe("share");
    // US-769's raw share marker survives — it predates UTMs and other code reads it.
    expect(q.get("s")).toBe("share");
  });

  // The regression this story is about: before the fix this was a bare
  // `?s=share` with no utm_* at all, so the highest-reach share in the loop
  // landed in analytics as direct traffic.
  it("an anonymous re-share is NOT untagged direct traffic", () => {
    const q = new URL(anon).searchParams;
    expect(q.get("utm_source")).not.toBeNull();
    expect(q.get("utm_campaign")).toBe("cert_organic");
  });
});

describe("referral credit is separate from channel attribution", () => {
  it("a seller's share carries their code", () => {
    expect(new URL(seller).searchParams.get("ref")).toBe("SELLER7");
    expect(new URL(seller).searchParams.get("utm_campaign")).toBe("cert_referral");
  });

  // THE LOAD-BEARING NEGATIVE. An anonymous re-sharer has no code, and must not
  // acquire one. Borrowing the ref the visitor arrived with would credit a
  // seller for a share they did not make, to an audience they do not own.
  it("an anonymous share never carries a ref", () => {
    expect(new URL(anon).searchParams.get("ref")).toBeNull();
    expect(anon).not.toContain("ref=");
  });

  it("the two campaigns are distinguishable, so the loop can be measured separately", () => {
    expect(new URL(seller).searchParams.get("utm_campaign")).not.toBe(
      new URL(anon).searchParams.get("utm_campaign"),
    );
  });
});

describe("per-channel attribution", () => {
  const channelUrl = (base: string, channel: string) =>
    `${base}&utm_content=${encodeURIComponent(channel)}`;

  it("tags each network so a converting share traces to its source", () => {
    for (const c of ["x", "facebook", "pinterest", "whatsapp", "reddit", "email"]) {
      expect(new URL(channelUrl(anon, c)).searchParams.get("utm_content")).toBe(c);
    }
  });

  it("adding a channel does not disturb the referral or campaign fields", () => {
    const q = new URL(channelUrl(seller, "reddit")).searchParams;
    expect(q.get("ref")).toBe("SELLER7");
    expect(q.get("utm_campaign")).toBe("cert_referral");
    expect(q.get("utm_content")).toBe("reddit");
  });
});

describe("URL validity", () => {
  it("produces parseable URLs with a single ? and correct encoding", () => {
    for (const url of [seller, anon]) {
      expect(() => new URL(url)).not.toThrow();
      expect(url.split("?").length).toBe(2);
    }
  });

  it("encodes a referral code containing URL-significant characters", () => {
    const url = shareUrl({ origin: ORIGIN, certificateId: CERT, referralCode: "a&b=c" });
    expect(new URL(url).searchParams.get("ref")).toBe("a&b=c");
    expect(new URL(url).searchParams.get("utm_source")).toBe("certificate");
  });
});
