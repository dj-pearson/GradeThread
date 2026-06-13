import { describe, it, expect } from "vitest";
import {
  certBadgeEmbedHtml,
  certBadgeEmbedText,
  certBadgeScriptEmbed,
  certBadgeScriptUrl,
  certificateShareUrl,
  parseCertificateRef,
  validateHandle,
} from "./verified";

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

  it("the <img> embed snippet links through ?s=embed and uses the badge asset", () => {
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

describe("validateHandle", () => {
  it("accepts a valid handle and rejects bad shapes", () => {
    expect(validateHandle("jane-doe").ok).toBe(true);
    expect(validateHandle("ab").ok).toBe(false);
    expect(validateHandle("-leading").ok).toBe(false);
  });
});
