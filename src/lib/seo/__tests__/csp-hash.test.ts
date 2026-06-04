// US-358: CSP inline-script hash-sync helper tests.
//
// These pin the build-time hash sync (scripts/csp-hash.mjs, invoked by
// scripts/prerender.mjs) so the drift footgun stays fixed: editing the inline
// bootstrap can never silently break the production CSP, because the hash is
// regenerated from the built script at build time and asserted here.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  cspHashForScript,
  extractInlineBootstrap,
  replaceCspScriptHash,
  syncCspHash,
} from "../../../../scripts/csp-hash.mjs";

const repoRoot = resolve(__dirname, "../../../..");

describe("csp inline-script hash sync", () => {
  it("extracts only the bare <script> bootstrap, not the module loader", () => {
    const html =
      `<head><script>doThing(1);</script><script type="module" src="/main.js"></script></head>`;
    expect(extractInlineBootstrap(html)).toBe("doThing(1);");
  });

  it("returns null when there is no bare inline script", () => {
    expect(extractInlineBootstrap('<script src="/x.js"></script>')).toBeNull();
  });

  it("computes a stable sha256 CSP token", () => {
    // Reference value for an empty script body.
    expect(cspHashForScript("")).toBe(
      "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    );
    expect(cspHashForScript("a")).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
  });

  it("replaces the script-src token and is idempotent", () => {
    const headers =
      "  Content-Security-Policy: script-src 'self' 'sha256-OLD=' https://js.stripe.com";
    const once = replaceCspScriptHash(headers, "sha256-NEW=");
    expect(once).toContain("'sha256-NEW='");
    expect(once).not.toContain("sha256-OLD=");
    // Other directives untouched.
    expect(once).toContain("https://js.stripe.com");
    expect(replaceCspScriptHash(once, "sha256-NEW=")).toBe(once);
  });

  it("throws when _headers has no sha256 token (fails the build loudly)", () => {
    expect(() => replaceCspScriptHash("no token", "sha256-x")).toThrow(/sha256/);
  });

  it("throws when index.html has no inline bootstrap", () => {
    expect(() => syncCspHash("<head></head>", "x 'sha256-y='")).toThrow(/bootstrap/);
  });

  it("end-to-end: syncs the hash to match the inline script", () => {
    const html = `<script>window.x=1;</script>`;
    const headers = "script-src 'self' 'sha256-STALE='";
    const synced = syncCspHash(html, headers);
    expect(synced).toContain(`'${cspHashForScript("window.x=1;")}'`);
  });

  // Guard: source index.html has exactly one bare inline bootstrap + the CSP
  // header carries exactly one script-src sha256 token, so the build-time sync
  // has a single, unambiguous target.
  it("repo index.html + _headers are shaped for a single-hash sync", () => {
    const html = readFileSync(resolve(repoRoot, "index.html"), "utf8");
    expect(extractInlineBootstrap(html)).not.toBeNull();

    const headers = readFileSync(resolve(repoRoot, "public/_headers"), "utf8");
    const tokens = headers.match(/sha256-[A-Za-z0-9+/]+=*/g) ?? [];
    expect(tokens).toHaveLength(1);
  });
});
