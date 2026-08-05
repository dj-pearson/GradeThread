// US-1936: white-label grade embed script widget (functions/embed/grade/[id].ts).
//
// The widget replaces the never-worked iframe embed (blocked by the zone's
// X-Frame-Options: DENY + CSP frame-ancestors 'none'). We can't run the
// Cloudflare worker in a unit test, but the delivery is built from pure,
// exported helpers — asserting them proves the card is well-formed, the branding
// is validated (no javascript:/data: injection, no host XSS), and the injector
// JS is safe to drop onto an arbitrary partner page.

import { describe, it, expect } from "vitest";
import {
  aiDisclosureBody,
  aiDisclosureTitle,
  gradeEmbedCardHtml,
  gradeEmbedWidgetJs,
  readEmbedBranding,
  safeEmbedColor,
  safeEmbedHttpsUrl,
  type EmbedBranding,
} from "../../functions/embed/grade/widget";

const CERT = {
  id: "abcdef01-2345-6789-abcd-ef0123456789",
  title: "Vintage Denim Jacket",
  brand: "Levi's",
  overall_score: 8.4,
  grade_tier: "Excellent",
  fabric_condition_score: 8.5,
  structural_integrity_score: 8.0,
  cosmetic_appearance_score: 9.0,
  functional_elements_score: 7.5,
  odor_cleanliness_score: 8.5,
};

const PLAIN: EmbedBranding = { company: null, color: "#0F3460", logo: null, support: null };
const CERT_URL = `https://gradethread.com/cert/${CERT.id}`;

describe("safeEmbedHttpsUrl", () => {
  it("accepts an absolute https URL and returns the normalized href", () => {
    expect(safeEmbedHttpsUrl("https://acme.com/logo.png")).toBe("https://acme.com/logo.png");
  });

  it("rejects dangerous / non-https schemes and relative refs", () => {
    expect(safeEmbedHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeEmbedHttpsUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeEmbedHttpsUrl("http://acme.com/logo.png")).toBeNull(); // downgrade
    expect(safeEmbedHttpsUrl("//acme.com/logo.png")).toBeNull(); // protocol-relative
    expect(safeEmbedHttpsUrl("/logo.png")).toBeNull(); // relative
    expect(safeEmbedHttpsUrl("")).toBeNull();
    expect(safeEmbedHttpsUrl(null)).toBeNull();
  });
});

describe("safeEmbedColor", () => {
  it("accepts a #rrggbb hex and falls back to brand navy otherwise", () => {
    expect(safeEmbedColor("#E94560")).toBe("#E94560");
    expect(safeEmbedColor("red")).toBe("#0F3460");
    expect(safeEmbedColor("#fff")).toBe("#0F3460"); // shorthand not accepted
    expect(safeEmbedColor("#12345g")).toBe("#0F3460");
    expect(safeEmbedColor(null)).toBe("#0F3460");
  });
});

describe("readEmbedBranding", () => {
  it("parses + validates every branding param from the request URL", () => {
    const url = new URL(
      "https://gradethread.com/embed/grade/x.js?company=Acme%20Resale&color=%23E94560&logo=https://acme.com/l.png&support=https://acme.com/help",
    );
    expect(readEmbedBranding(url)).toEqual({
      company: "Acme Resale",
      color: "#E94560",
      logo: "https://acme.com/l.png",
      support: "https://acme.com/help",
    });
  });

  it("drops an unsafe logo/support and a bad color, and caps the company name", () => {
    const url = new URL(
      "https://gradethread.com/embed/grade/x.js?company=" +
        "A".repeat(200) +
        "&color=notacolor&logo=javascript:alert(1)&support=http://acme.com",
    );
    const b = readEmbedBranding(url);
    expect(b.company).toHaveLength(80);
    expect(b.color).toBe("#0F3460");
    expect(b.logo).toBeNull();
    expect(b.support).toBeNull();
  });
});

describe("gradeEmbedCardHtml", () => {
  it("renders the score, tier, title/brand and all five factors", () => {
    const html = gradeEmbedCardHtml(CERT, PLAIN, CERT_URL);
    expect(html).toContain("8.4"); // overall score
    expect(html).toContain("Excellent"); // tier
    expect(html).toContain("Vintage Denim Jacket");
    expect(html).toContain("Levi&#39;s"); // brand, apostrophe escaped
    for (const label of [
      "Fabric Condition",
      "Structural Integrity",
      "Cosmetic Appearance",
      "Functional Elements",
      "Odor &amp; Cleanliness",
    ]) {
      expect(html).toContain(label);
    }
    // Attribution links to the live certificate.
    expect(html).toContain(`href="${CERT_URL}"`);
    expect(html).toContain("Verified by GradeThread");
  });

  it("applies partner branding: color header, logo img, company name, support link", () => {
    const b: EmbedBranding = {
      company: "Acme Resale",
      color: "#E94560",
      logo: "https://acme.com/logo.png",
      support: "https://acme.com/help",
    };
    const html = gradeEmbedCardHtml(CERT, b, CERT_URL);
    expect(html).toContain("#E94560"); // brand color in header
    expect(html).toContain('src="https://acme.com/logo.png"');
    expect(html).toContain("Acme Resale");
    expect(html).toContain('href="https://acme.com/help"');
  });

  it("falls back to the default header + hides support when unbranded", () => {
    const html = gradeEmbedCardHtml(CERT, PLAIN, CERT_URL);
    expect(html).toContain("Verified Condition Grade");
    expect(html).not.toContain(">Support<");
  });

  // US-2399: the widget is the buyer-facing surface furthest from our Terms, so
  // the AI disclosure has to be IN the card, and it has to describe what actually
  // happened to THIS grade.
  it("carries the AI disclosure inside the card", () => {
    const html = gradeEmbedCardHtml(CERT, PLAIN, CERT_URL);
    expect(html).toContain("automated AI system");
    expect(html).toContain("not a certified appraisal");
  });

  it("says human-finalized only when the grade actually was", () => {
    const reviewed = gradeEmbedCardHtml({ ...CERT, human_reviewed: true }, PLAIN, CERT_URL);
    expect(reviewed).toContain("finalized by a human reviewer");
    expect(reviewed).toContain("A GradeThread reviewer checked this grade");

    const aiOnly = gradeEmbedCardHtml({ ...CERT, human_reviewed: false }, PLAIN, CERT_URL);
    expect(aiOnly).toContain("AI-generated condition estimate");
    expect(aiOnly).not.toContain("human reviewer");
  });

  it("degrades to the AI-only wording when human_reviewed is absent or null", () => {
    // A partial/legacy payload must never be upgraded into a human-review claim.
    for (const cert of [CERT, { ...CERT, human_reviewed: null }]) {
      const html = gradeEmbedCardHtml(cert, PLAIN, CERT_URL);
      expect(html).toContain("AI-generated condition estimate");
      expect(html).not.toContain("human reviewer");
    }
  });

  it("keeps the widget disclosure copy identical to the React component", async () => {
    // The worker can't import from src/, so the strings are duplicated. This is
    // the guard that stops them drifting.
    const shared = await import("../lib/ai-disclosure-copy");
    for (const reviewed of [true, false]) {
      expect(aiDisclosureTitle(reviewed)).toBe(shared.aiDisclosureTitle(reviewed));
      expect(aiDisclosureBody(reviewed)).toBe(shared.aiDisclosureBody(reviewed));
    }
  });

  it("escapes hostile branding + cert text so the host page can't be XSS'd", () => {
    const b: EmbedBranding = { company: '<img src=x onerror=alert(1)>', color: "#0F3460", logo: null, support: null };
    const evilCert = { ...CERT, title: "</div><script>alert(1)</script>", grade_tier: "<b>x</b>" };
    const html = gradeEmbedCardHtml(evilCert, b, CERT_URL);
    expect(html).not.toContain("<img src=x onerror");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("gradeEmbedWidgetJs", () => {
  it("wraps the card in an idempotent self-locating injector", () => {
    const js = gradeEmbedWidgetJs(CERT.id, "<div>card</div>");
    expect(js).toContain("currentScript");
    expect(js).toContain(`"/embed/grade/" + ${JSON.stringify(CERT.id)}`);
    expect(js).toContain("data-gt-rendered"); // double-include guard
    expect(js).toContain("insertBefore"); // injects at the script's position
    // The card HTML is embedded as a JSON string literal (safe inside JS).
    expect(js).toContain(JSON.stringify("<div>card</div>"));
  });

  it("embeds the card only as a JSON string literal (served as external JS)", () => {
    // Served with Content-Type application/javascript (not inline in HTML), so a
    // literal </script> inside a JS string is inert; the invariant is that the
    // card is emitted solely via JSON.stringify, never spliced in raw.
    const card = '<div style="color:#0F3460">x</div>';
    const js = gradeEmbedWidgetJs("id", card);
    expect(js).toContain(JSON.stringify(card));
    // The only occurrence of the card content is the quoted literal.
    expect(js.split(JSON.stringify(card)).length - 1).toBe(1);
  });
});
