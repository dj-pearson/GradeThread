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
    const csp = headers["Content-Security-Policy-Report-Only"] ?? "";
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

  it("the CSP ships report-only until it has been verified live", () => {
    // AC2. The static surface has enforced this policy for a long time, but
    // never against the Function-served authenticated routes, so an origin only
    // the signed-in app uses would break at the worst moment. Flipping to
    // enforced is deliberately one line, and this case is what makes the flip
    // show up in a diff rather than happening by accident.
    const h = appShellSecurityHeaders("sha256-x");
    expect(h["Content-Security-Policy-Report-Only"]).toBeTruthy();
    expect(h["Content-Security-Policy"]).toBeUndefined();
    expect(h["Content-Security-Policy-Report-Only"]).toContain("report-uri /csp-report");
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
