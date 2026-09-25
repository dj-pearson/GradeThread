import { describe, it, expect } from "vitest";
import {
  BADGE_FORMATS,
  certBadgeEmbedHtml,
  certBadgeEmbedText,
  certBadgeScriptEmbed,
  certBadgeScriptUrl,
  certificateShareUrl,
  parseCertificateRef,
  passportBadgeEmbedHtml,
  passportBadgeEmbedText,
  passportShareUrl,
  passportUrl,
  SELLER_BADGE_FORMAT_OPTIONS,
  validateHandle,
  verifiedSellerBadgeEmbedHtml,
  verifiedSellerBadgeEmbedText,
  verifiedSellerBadgeUrl,
} from "./verified";
import * as V from "./verified";

const UUID = "0f3a1b2c-4d5e-6f70-8a9b-0c1d2e3f4a5b";

describe("parseCertificateRef (US-593 buyer verify lookup)", () => {
  it("accepts a bare certificate id", () => {
    expect(parseCertificateRef(UUID)).toBe(UUID);
  });

  it("uppercases are normalized to lowercase", () => {
    expect(parseCertificateRef(UUID.toUpperCase())).toBe(UUID);
  });

  it("extracts the id from a full certificate URL", () => {
    expect(parseCertificateRef(`https://gradethread.com/cert/${UUID}`)).toBe(UUID);
  });

  it("ignores the QR source query param and hash", () => {
    expect(parseCertificateRef(`https://gradethread.com/cert/${UUID}?s=qr`)).toBe(UUID);
    expect(parseCertificateRef(`https://gradethread.com/cert/${UUID}#grade`)).toBe(UUID);
  });

  it("works for any origin (preview/localhost) and a bare /cert/ path", () => {
    expect(parseCertificateRef(`http://localhost:5173/cert/${UUID}`)).toBe(UUID);
    expect(parseCertificateRef(`/cert/${UUID}`)).toBe(UUID);
  });

  it("trims surrounding whitespace from a paste", () => {
    expect(parseCertificateRef(`   ${UUID}  `)).toBe(UUID);
  });

  it("rejects empty / non-id input rather than navigating to a 404", () => {
    expect(parseCertificateRef("")).toBeNull();
    expect(parseCertificateRef("   ")).toBeNull();
    expect(parseCertificateRef("not-a-certificate")).toBeNull();
    expect(parseCertificateRef("https://gradethread.com/pricing")).toBeNull();
    // A truncated / malformed UUID is rejected.
    expect(parseCertificateRef("0f3a1b2c-4d5e")).toBeNull();
  });
});

describe("certificate embed badge (US-860)", () => {
  it("the share URL carries the source param for attribution", () => {
    expect(certificateShareUrl(UUID, "embed")).toBe(
      `https://gradethread.com/cert/${UUID}?s=embed`,
    );
  });

  it("the image embed snippet links through ?s=embed and uses the badge asset", () => {
    const html = certBadgeEmbedHtml(UUID);
    expect(html).toContain(`href="https://gradethread.com/cert/${UUID}?s=embed"`);
    expect(html).toContain(`src="https://gradethread.com/badge/cert/${UUID}"`);
    // No <script> — must survive marketplace HTML sanitizers.
    expect(html).not.toContain("<script");
  });

  it("the script embed points at the public widget endpoint", () => {
    expect(certBadgeScriptUrl(UUID)).toBe(
      `https://gradethread.com/embed/cert/${UUID}`,
    );
    const snippet = certBadgeScriptEmbed(UUID);
    expect(snippet).toBe(
      `<script async src="https://gradethread.com/embed/cert/${UUID}"></script>`,
    );
  });

  it("the plain-text fallback carries ?s=embed", () => {
    expect(certBadgeEmbedText(UUID)).toContain(
      `https://gradethread.com/cert/${UUID}?s=embed`,
    );
  });
});

describe("garment passport badge (US-1759)", () => {
  const SLUG = "ab12cd34";

  it("builds the public passport URL and share URL", () => {
    expect(passportUrl(SLUG)).toBe(`https://gradethread.com/passport/${SLUG}`);
    expect(passportShareUrl(SLUG, "embed")).toBe(
      `https://gradethread.com/passport/${SLUG}?s=embed`,
    );
  });

  it("the HTML badge links to the passport with ?s=embed and no script", () => {
    const html = passportBadgeEmbedHtml(SLUG);
    expect(html).toContain(`href="https://gradethread.com/passport/${SLUG}?s=embed"`);
    expect(html).toContain("Verified history");
    expect(html).not.toContain("<script");
  });

  it("the text badge carries the passport share link", () => {
    expect(passportBadgeEmbedText(SLUG)).toContain(
      `https://gradethread.com/passport/${SLUG}?s=embed`,
    );
  });
});

describe("BADGE_FORMATS studio guidance (US-1759)", () => {
  it("exposes the three formats with per-marketplace guidance", () => {
    const ids = BADGE_FORMATS.map((f) => f.id);
    expect(ids).toEqual(["image", "script", "text"]);
    for (const f of BADGE_FORMATS) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.worksOn.length).toBeGreaterThan(0);
    }
    // Text is the format that must survive HTML-stripping marketplaces.
    const text = BADGE_FORMATS.find((f) => f.id === "text")!;
    expect(text.worksOn).toContain("Poshmark");
    expect(text.worksOn).toContain("Grailed");
  });
});

describe("verified-seller storefront badge (US-1761)", () => {
  const HANDLE = "thrift-king";

  it("builds the badge image URL with the format query", () => {
    expect(verifiedSellerBadgeUrl(HANDLE)).toBe(
      `https://gradethread.com/badge/verified/${HANDLE}?format=wide`,
    );
    expect(verifiedSellerBadgeUrl(HANDLE, "listing_header")).toBe(
      `https://gradethread.com/badge/verified/${HANDLE}?format=listing_header`,
    );
  });

  it("the HTML embed links to the profile (?s=embed), uses the badge asset, no script", () => {
    const html = verifiedSellerBadgeEmbedHtml(HANDLE, "compact");
    expect(html).toContain(`href="https://gradethread.com/verified/${HANDLE}?s=embed"`);
    expect(html).toContain(`src="https://gradethread.com/badge/verified/${HANDLE}?format=compact"`);
    // The compact size's dimensions are reflected for correct layout.
    expect(html).toContain(`width="520"`);
    expect(html).toContain(`height="120"`);
    expect(html).not.toContain("<script");
  });

  it("the text embed links to the profile with ?s=embed", () => {
    expect(verifiedSellerBadgeEmbedText(HANDLE)).toContain(
      `https://gradethread.com/verified/${HANDLE}?s=embed`,
    );
  });

  it("exposes the three marketplace-optimized formats", () => {
    expect(SELLER_BADGE_FORMAT_OPTIONS.map((o) => o.id)).toEqual([
      "wide",
      "compact",
      "listing_header",
    ]);
  });
});

describe("validateHandle", () => {
  it("accepts a valid handle and rejects bad shapes", () => {
    expect(validateHandle("jane-doe").ok).toBe(true);
    expect(validateHandle("ab").ok).toBe(false);
    expect(validateHandle("-leading").ok).toBe(false);
  });
});

// V9: every embed builder carries attribution, encodes its path segment, and
// pastes clean text.

describe("embed builders (V9)", () => {
  const builders: Array<[string, string]> = [
    ["certBadgeEmbedHtml", V.certBadgeEmbedHtml(UUID)],
    ["certBadgeEmbedHtml status", V.certBadgeEmbedHtml(UUID, "status")],
    ["certBadgeEmbedText", V.certBadgeEmbedText(UUID)],
    ["profileLinkEmbedHtml", V.profileLinkEmbedHtml("jane")],
    ["passportBadgeEmbedHtml", V.passportBadgeEmbedHtml("ab12")],
    ["passportBadgeEmbedText", V.passportBadgeEmbedText("ab12")],
    ["verifiedSellerBadgeEmbedHtml", V.verifiedSellerBadgeEmbedHtml("jane")],
    ["verifiedSellerBadgeEmbedText", V.verifiedSellerBadgeEmbedText("jane")],
  ];

  it.each(builders)("%s links with a ?s= source", (_name, out) => {
    const href = /href="([^"]+)"/.exec(out)?.[1] ?? /(https:\/\/\S+)$/.exec(out)?.[1];
    expect(href).toBeDefined();
    expect(href).toContain("?s=");
  });

  it.each(builders)("%s contains no em dash", (_name, out) => {
    expect(out).not.toContain("—");
  });

  it("the profile link badge is attributed as an embed", () => {
    expect(V.profileLinkEmbedHtml("jane")).toContain('href="https://gradethread.com/verified/jane?s=embed"');
  });

  it("uses brand navy for the pill badges", () => {
    expect(V.profileLinkEmbedHtml("jane")).toContain("#0F3460");
    expect(V.passportBadgeEmbedHtml("ab12")).toContain("#0F3460");
  });

  it("percent-encodes a hostile slug, handle or cert id", () => {
    const bad = '"><script>';
    for (const out of [
      V.passportBadgeEmbedHtml(bad),
      V.profileLinkEmbedHtml(bad),
      V.verifiedSellerBadgeEmbedHtml(bad),
      V.certBadgeEmbedHtml(bad),
      V.certBadgeScriptEmbed(bad),
    ]) {
      expect(out).not.toContain(bad);
      expect(out).toContain("%22%3E%3Cscript%3E");
    }
  });
});
