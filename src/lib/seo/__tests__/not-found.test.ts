import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-422: unknown URLs must return a real HTTP 404 instead of the soft-404 SPA
// shell. The contract is encoded in public/_redirects (Cloudflare Pages) +
// public/404.html. These tests fail the build if that contract regresses — e.g.
// if someone reinstates the old "/* /index.html 200" catch-all.

const redirects = readFileSync(
  resolve(process.cwd(), "public/_redirects"),
  "utf8",
);
const notFoundHtml = readFileSync(
  resolve(process.cwd(), "public/404.html"),
  "utf8",
);

/** Non-comment, non-blank rules as [from, to, status] tuples (status optional). */
const rules = redirects
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"))
  .map((l) => l.split(/\s+/));

describe("soft-404 fix (US-422)", () => {
  it("the catch-all sends unknown URLs to 404.html with a real 404 status", () => {
    const catchAll = rules.find((r) => r[0] === "/*");
    expect(catchAll).toBeDefined();
    expect(catchAll?.[1]).toBe("/404.html");
    expect(catchAll?.[2]).toBe("404");
  });

  it("does NOT reinstate the soft-404 SPA fallback (/* → /index.html 200)", () => {
    const softFallback = rules.find(
      (r) => r[0] === "/*" && r[1] === "/index.html",
    );
    expect(softFallback).toBeUndefined();
  });

  it("the 404 catch-all is the LAST rule (first-match wins)", () => {
    expect(rules[rules.length - 1]?.[0]).toBe("/*");
  });

  it("authenticated/app namespaces are served as 200 by Pages Functions (not _redirects)", () => {
    // US-422 follow-up: app shells (/dashboard, /admin) are NO LONGER served via
    // _redirects — Cloudflare Pages canonicalizes a `→ /index.html 200` rewrite
    // into a 308 → / that broke hard-loads/refreshes of every app route. They're
    // now served as 200 by dedicated Pages Functions (functions/<ns>/[[path]].ts
    // → _shared/spa-shell.ts) wired in public/_routes.json. Assert THAT contract.
    const routes = JSON.parse(
      readFileSync(resolve(process.cwd(), "public/_routes.json"), "utf8"),
    ) as { include: string[] };
    for (const base of ["/dashboard", "/admin"]) {
      const fnPath = resolve(process.cwd(), `functions/${base.slice(1)}/[[path]].ts`);
      expect(existsSync(fnPath), `missing SPA-shell Pages Function for ${base}`).toBe(true);
      expect(routes.include, `_routes.json must route ${base}`).toContain(base);
      expect(routes.include, `_routes.json must route ${base}/*`).toContain(`${base}/*`);
      // And they must NOT be reintroduced as _redirects rules (the soft-404 trap
      // / the 308 hard-load break this whole contract exists to prevent).
      expect(rules.find((r) => r[0] === base)).toBeUndefined();
      expect(rules.find((r) => r[0] === `${base}/*`)).toBeUndefined();
    }
  });

  it("404.html is marked noindex so a stray crawl can't index it", () => {
    expect(notFoundHtml).toMatch(
      /<meta\s+name="robots"\s+content="noindex[^"]*"/i,
    );
  });

  it("404.html has no inline <script> (CSP forbids unhashed inline scripts)", () => {
    expect(notFoundHtml).not.toMatch(/<script(\s|>)/i);
  });
});
