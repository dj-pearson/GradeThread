import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Guard for public/_routes.json (US-424): a custom Cloudflare Pages _routes.json
// is an ALLOWLIST — only `include` paths invoke a Pages Function; everything else
// (the SPA shell, prerendered static HTML, hashed assets) is served statically.
// If a dynamic route drops out of `include`, the SPA fallback shadows its
// Function and we ship a soft-404 / wrong markup. This test fails the build in
// that case.

const routes = JSON.parse(
  readFileSync(resolve(process.cwd(), "public/_routes.json"), "utf8"),
) as { version: number; include: string[]; exclude: string[] };

// Map a Pages Function file to the include pattern it needs. Top-level dynamic
// segments ([[path]], [id], [handle]) and nested ones collapse to a `/<dir>/*`
// prefix; flat files (robots.txt.ts) map to their exact route.
function expectedPatternFor(file: string): string {
  // file is repo-relative under functions/, POSIX-separated
  const rel = file.replace(/\\/g, "/").replace(/^functions\//, "");
  const segments = rel.split("/");
  const top = segments[0] ?? "";
  if (segments.length === 1) {
    // functions/robots.txt.ts → /robots.txt ; functions/csp-report.ts → /csp-report
    return "/" + top.replace(/\.ts$/, "");
  }
  // nested → allowlist the top-level prefix
  return "/" + top + "/*";
}

function listFunctionFiles(): string[] {
  const root = resolve(process.cwd(), "functions");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "_shared") continue; // shared libs, not routes
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        out.push(full.replace(root, "functions").replace(/\\/g, "/"));
      }
    }
  };
  walk(root);
  return out;
}

describe("public/_routes.json Pages Function allowlist (US-424)", () => {
  it("is a v1 allowlist with include + exclude arrays", () => {
    expect(routes.version).toBe(1);
    expect(Array.isArray(routes.include)).toBe(true);
    expect(Array.isArray(routes.exclude)).toBe(true);
    expect(routes.include.length).toBeGreaterThan(0);
  });

  it("includes every route the audit (AC) named", () => {
    for (const required of [
      "/cert/*",
      "/verified/*",
      "/blog/*",
      "/og/*",
      "/sitemap.xml",
      "/rss.xml",
      "/robots.txt",
      "/llms.txt",
      "/csp-report",
    ]) {
      expect(routes.include).toContain(required);
    }
  });

  it("excludes hashed build assets so the SPA bundle is never Function-routed", () => {
    expect(routes.exclude).toContain("/assets/*");
  });

  it("allowlists a Function pattern for every functions/ route file", () => {
    const required = new Set(listFunctionFiles().map(expectedPatternFor));
    const missing = [...required].filter((p) => !routes.include.includes(p));
    expect(missing).toEqual([]);
  });

  it("stays under Cloudflare's 100-rule limit", () => {
    expect(routes.include.length + routes.exclude.length).toBeLessThanOrEqual(100);
  });
});
