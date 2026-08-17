// US-2330: the SPA shell's security headers, and the fact that there are now
// two copies of one CSP.
//
// Cloudflare `_headers` applies to STATIC responses only, so a Pages Function
// serving the app shell has to emit its own headers. That means the app-shell
// CSP necessarily exists twice — once in public/_headers for static routes and
// once in functions/_shared/app-shell-headers.ts for Function-served ones. Two
// copies of an allowlist drift, and the drift presents in the worst possible
// way: a feature works on the marketing pages and breaks once you sign in.
//
// So these assert the two are token-identical, and pin the four specific
// choices this repo has already paid for.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  APP_SHELL_CSP_DIRECTIVES,
  appShellSecurityHeaders,
  inlineBootstrapHash,
} from "../../functions/_shared/app-shell-headers";
import { cspHashForScript, extractInlineBootstrap } from "../../scripts/csp-hash.mjs";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/** The `/*` block's Content-Security-Policy line from public/_headers. */
function staticCsp(): string {
  const line = read("public/_headers")
    .split("\n")
    .find((l) => l.trim().startsWith("Content-Security-Policy:"));
  if (!line) throw new Error("public/_headers has no Content-Security-Policy");
  return line.trim().replace(/^Content-Security-Policy:\s*/, "");
}

/** Directive name → sources, with the sha256 token normalised away. */
function directiveMap(csp: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of csp.split(";")) {
    const d = raw.trim().replace(/sha256-[A-Za-z0-9+/]+=*/, "HASH").replace("__HASH__", "HASH");
    if (!d) continue;
    const sp = d.indexOf(" ");
    out.set(sp === -1 ? d : d.slice(0, sp), sp === -1 ? "" : d.slice(sp + 1));
  }
  return out;
}

describe("US-2330: the app shell ships the same policy the static surface does", () => {
  it("every directive matches public/_headers exactly", () => {
    const staticDirectives = directiveMap(staticCsp());
    const shellDirectives = directiveMap(APP_SHELL_CSP_DIRECTIVES.join("; "));

    // Both directions. A directive present in one and absent from the other is
    // the drift this guard exists for, and it can happen either way round.
    expect([...shellDirectives.keys()].sort()).toEqual(
      [...staticDirectives.keys()].sort(),
    );
    for (const [name, sources] of staticDirectives) {
      expect(shellDirectives.get(name), `${name} differs from public/_headers`).toBe(
        sources,
      );
    }
  });

  it("the inline-bootstrap hash is computed the same way the build computes it", () => {
    // The Function hashes at runtime; scripts/prerender.mjs hashes at build
    // time. If those two ever disagreed the bootstrap would be allowed on
    // static routes and blocked on signed-in ones — so they are checked against
    // each other, on the same input, rather than each against itself.
    const html = `<html><head><script type="module" src="/x.js"></script>` +
      `<script>window.x=1;</script></head></html>`;
    const script = extractInlineBootstrap(html);
    expect(script).toBe("window.x=1;");
    return inlineBootstrapHash(html).then((h) => {
      expect(h).toBe(cspHashForScript(script as string));
    });
  });

  it("a shell with no inline bootstrap drops the hash source entirely", async () => {
    // Not left as a literal '__HASH__' source: that would be a dead allowance
    // that reads like a working one.
    const headers = appShellSecurityHeaders(await inlineBootstrapHash("<html></html>"));
    const csp = headers["Content-Security-Policy"] ?? "";
    expect(csp).not.toContain("__HASH__");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' https://js.stripe.com");
  });

  it("COOP allows popups, because bare same-origin broke closing them", () => {
    // public/_headers carries a written explanation: bare `same-origin` severs
    // the window handle, so popup.close() silently no-ops and the Google Photos
    // picker and the Stripe/eBay/Google OAuth popups are left open.
    const h = appShellSecurityHeaders(null);
    expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin-allow-popups");
    expect(read("public/_headers")).toContain("same-origin-allow-popups");
  });

  it("camera is allowed to self, because camera=() broke capture in production", () => {
    // Shipping an empty allowlist blocks our OWN origin, and getUserMedia then
    // rejects — the grading photo capture and the barcode scanner both fail
    // with no feature-detect able to see it coming.
    const h = appShellSecurityHeaders(null);
    expect(h["Permissions-Policy"]).toContain("camera=(self)");
    expect(h["Permissions-Policy"]).toContain("microphone=()");
    expect(h["Permissions-Policy"]).toContain("geolocation=()");
  });

  it("the headers the shell was missing are all present and enforced", () => {
    // These were the finding: /login and /dashboard returned none of them.
    const h = appShellSecurityHeaders("sha256-x");
    for (
      const name of [
        "X-Frame-Options",
        "X-Content-Type-Options",
        "Referrer-Policy",
        "Permissions-Policy",
        "Strict-Transport-Security",
        "Cross-Origin-Opener-Policy",
      ]
    ) {
      expect(h[name], `${name} is missing`).toBeTruthy();
    }
  });

  it("the CSP is ENFORCED on the authenticated shell", () => {
    // AC2, flipped 2026-08-17 on the owner's call. This case used to assert the
    // opposite, and its comment said it existed so the flip would show up in a
    // diff rather than happening by accident. It did exactly that — the flip
    // reddened this test, and inverting it is the deliberate half of the change.
    //
    // What settled the flip: the enforced policy on `/` and the report-only
    // policy on `/login` and `/dashboard` were fetched from production and are
    // BYTE-IDENTICAL, 1674 bytes and the same digest. A CSP belongs to the
    // document that loaded it, and this is a SPA — so anyone entering through
    // `/`, a static enforced response, was already navigating the whole
    // signed-in app under this policy enforced.
    //
    // Now it guards the other direction: a silent revert to report-only fails
    // here, so backing this out has to be a decision someone writes down.
    const h = appShellSecurityHeaders("sha256-x");
    expect(h["Content-Security-Policy"]).toBeTruthy();
    expect(h["Content-Security-Policy-Report-Only"]).toBeUndefined();
    expect(h["Content-Security-Policy"]).toContain("report-uri /csp-report");
    // The reporting endpoint stays wired after the flip. A violation now BLOCKS
    // as well as reports, which makes the report more useful, not less — losing
    // it here would trade the only signal we get for nothing.
    expect(h["Reporting-Endpoints"]).toContain("/csp-report");
  });

  it("the shell actually applies them", () => {
    // The parity above is worthless if serveSpaShell never calls it. That is
    // precisely the shape of the original bug: a correct helper with one
    // consumer that was not this one.
    const src = read("functions/_shared/spa-shell.ts");
    expect(src).toContain("appShellSecurityHeaders(scriptHash)");
    expect(src).toContain("inlineBootstrapHash(html)");
  });
});

// ---------------------------------------------------------------------------
// The embed that is one content edit away from being blocked.
//
// src/components/marketing/guide-video.tsx renders an <iframe> at
// www.youtube-nocookie.com on the garment-guide pages. frame-src allows exactly
// Stripe and Turnstile, so that iframe is blocked — and nothing is broken today
// ONLY because zero shorts are published: publishedShort() returns undefined
// until a youtubeId and uploadDate are filled in, so the component renders null.
//
// The day someone publishes one (US-1689), the frame goes blank with a console
// error, on a page that is already CSP-ENFORCED for static responses. The person
// doing that is doing content work — filming, uploading, pasting an id — and has
// no reason to be looking at a header file.
//
// So: do NOT widen the policy for content that does not exist. Widening it now
// would loosen a live security header on a promise. Instead, make the two facts
// impossible to hold at once, and let CI say the one sentence that saves the
// afternoon.
describe("published video embeds and frame-src cannot disagree", () => {
  it("a published short requires youtube-nocookie in frame-src", async () => {
    const { publishedShorts } = await import("../lib/seo/grading-videos");
    const frameSrc = directiveMap(staticCsp()).get("frame-src") ?? "";
    const allowed = frameSrc.includes("youtube-nocookie.com");

    if (publishedShorts().length > 0 && !allowed) {
      throw new Error(
        "A grading short is published, so guide-video.tsx now renders an " +
          "<iframe> at https://www.youtube-nocookie.com — and frame-src does " +
          "not allow it, so the embed is blocked and shows an empty box. Add " +
          "https://www.youtube-nocookie.com to frame-src in BOTH public/_headers " +
          "and functions/_shared/app-shell-headers.ts (they are asserted " +
          "token-identical above).",
      );
    }
    // The other direction is not asserted. Allowing the origin before any short
    // exists is a judgement call about widening a live policy early, not a bug,
    // and failing on it would push someone to revert a header to get green.
    expect(true).toBe(true);
  });

  it("the component still embeds the origin this guard is about", () => {
    // Guard-the-guard. If guide-video.tsx stops using an iframe, or the URL
    // helper changes host, the case above silently protects nothing while
    // continuing to pass.
    const component = read("src/components/marketing/guide-video.tsx");
    expect(component).toContain("<iframe");
    expect(component).toContain("shortEmbedUrl");
    expect(read("src/lib/seo/grading-videos.ts")).toContain("www.youtube-nocookie.com/embed/");
  });
});
