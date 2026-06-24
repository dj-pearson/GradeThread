import { describe, it, expect } from "vitest";
import { renderSsrResponse } from "../../functions/_shared/blog-render";
import {
  generateNonce,
  ssrSecurityHeaders,
} from "../../functions/_shared/security-headers";

// Defense-in-depth: the dynamic SSR content pages (blog, cert, passport, etc.)
// render server-injected HTML and are served by Pages Functions, which the
// static `_headers` CSP does NOT cover. renderSsrResponse must therefore ship a
// nonce-based CSP that (a) runs the page's own inline scripts via the nonce and
// (b) blocks anything injected via bodyHtml — i.e. no 'unsafe-inline' in
// script-src.

describe("ssrSecurityHeaders", () => {
  it("builds a nonce-scoped script-src with no unsafe-inline / unsafe-eval", () => {
    const h = ssrSecurityHeaders("ABC123");
    const csp = h["Content-Security-Policy"];
    expect(csp).toContain("script-src 'self' 'nonce-ABC123'");
    // 'unsafe-inline' in script-src would defeat the nonce (CSP3 ignores it when
    // a nonce is present, but assert it's absent so it can't be added). style-src
    // intentionally keeps 'unsafe-inline' for the one inline <style> block, so
    // check the script-src directive specifically.
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("sets the standard hardening headers", () => {
    const h = ssrSecurityHeaders("n");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });
});

describe("generateNonce", () => {
  it("returns a fresh base64 value each call", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe("renderSsrResponse", () => {
  it("stamps the SAME nonce on inline scripts and the CSP header", async () => {
    const res = renderSsrResponse(
      {
        title: "T",
        description: "D",
        canonicalUrl: "https://gradethread.com/blog/x",
        gaMeasurementId: "G-TEST123",
        jsonLd: [{ "@context": "https://schema.org", "@type": "Article" }],
        bodyHtml: "<main>hello</main>",
      },
      { cacheControl: "public, max-age=300" },
    );

    const csp = res.headers.get("Content-Security-Policy") ?? "";
    const m = csp.match(/'nonce-([^']+)'/);
    expect(m).not.toBeNull();
    const nonce = m![1];

    const html = await res.text();
    // The GA config inline script and the JSON-LD block both carry the nonce.
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<script type="application/ld+json" nonce="${nonce}">`);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("does NOT stamp the nonce onto injected bodyHtml content", async () => {
    // A script that slipped past sanitization into bodyHtml must NOT receive the
    // nonce, so the CSP blocks it.
    const res = renderSsrResponse(
      {
        title: "T",
        description: "D",
        canonicalUrl: "https://gradethread.com/blog/x",
        bodyHtml: `<main><script>alert(1)</script></main>`,
      },
      { cacheControl: "no-store" },
    );
    const html = await res.text();
    // The injected script stays bare (no nonce) → blocked by the nonce-only CSP.
    expect(html).toContain("<script>alert(1)</script>");
  });
});
