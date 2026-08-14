import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2506. MarketingLayout's footer renders on EVERY public page, and each
// FooterLink is a react-router <Link> — so a client-side click never reaches a
// Cloudflare Pages Function. A footer target that the router does not know falls
// through to the `*` catch-all and renders the 404 page on every page of the
// site at once.
//
// That is exactly what happened to /condition-index: it is served only by
// functions/condition-index/[[path]].ts, so it worked on a hard load and 404'd
// on every in-app click. /finds and /leaderboards already carried SPA fallback
// routes for this reason; this test is why the next one cannot be missed.

const layout = readFileSync(
  resolve(process.cwd(), "src/components/marketing/marketing-layout.tsx"),
  "utf8",
);
const router = readFileSync(
  resolve(process.cwd(), "src/routes/index.tsx"),
  "utf8",
);

/** Every `to="…"` on a FooterLink or a nav Link in the marketing chrome. */
function marketingLinkTargets(): string[] {
  const out = new Set<string>();
  for (const m of layout.matchAll(/<(?:FooterLink|Link)\s+to="(\/[^"]*)"/g)) {
    const target = m[1];
    if (target) out.add(target);
  }
  return [...out];
}

/** Path literals the router registers, e.g. `{ path: "/pricing", …`. */
function registeredPaths(): string[] {
  const out = new Set<string>();
  for (const m of router.matchAll(/path:\s*"(\/[^"]*)"/g)) {
    const p = m[1];
    if (p) out.add(p);
  }
  return [...out];
}

/** A registered path matches a concrete target, honouring `:param` segments. */
function isRouted(target: string, paths: string[]): boolean {
  const targetSegs = target.split("/").filter(Boolean);
  return paths.some((p) => {
    if (p === "*") return false; // the catch-all is the bug, not a match
    const segs = p.split("/").filter(Boolean);
    if (segs.length !== targetSegs.length) return false;
    return segs.every(
      (s, i) => s.startsWith(":") || s === targetSegs[i],
    );
  });
}

describe("marketing chrome links resolve in the SPA router", () => {
  const targets = marketingLinkTargets();
  const paths = registeredPaths();

  it("finds the footer links to check", () => {
    // Guard the guard: if the regex stops matching, this test must fail loudly
    // rather than silently pass over an empty list.
    expect(targets.length).toBeGreaterThan(10);
    expect(paths.length).toBeGreaterThan(50);
  });

  it("every marketing header/footer link has a router route", () => {
    const unrouted = targets.filter((t) => !isRouted(t, paths));
    expect(unrouted).toEqual([]);
  });

  it("keeps /condition-index routed (the US-2506 regression)", () => {
    expect(isRouted("/condition-index", paths)).toBe(true);
    expect(isRouted("/condition-index/some-item", paths)).toBe(true);
  });
});
