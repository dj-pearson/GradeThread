import { describe, it, expect, afterEach } from "vitest";
import {
  clearPrerenderSeed,
  escapeJsonForScript,
  getPrerenderSeed,
  resolvePrerenderSeed,
  seedDomId,
  setPrerenderSeed,
} from "@/lib/seo/prerender-seed";

// US-976 / US-1775 (indexability): the generic build-time seed registry that
// lets data-report pages bake their live figures into the crawlable HTML.

afterEach(() => clearPrerenderSeed());

describe("prerender-seed registry", () => {
  it("stores and reads a value by key", () => {
    setPrerenderSeed("alpha", { n: 1 });
    setPrerenderSeed("beta", { n: 2 });
    expect(getPrerenderSeed<{ n: number }>("alpha")).toEqual({ n: 1 });
    expect(getPrerenderSeed<{ n: number }>("beta")).toEqual({ n: 2 });
  });

  it("returns null for an unseeded key", () => {
    expect(getPrerenderSeed("missing")).toBeNull();
  });

  it("clears one key or the whole registry", () => {
    setPrerenderSeed("a", 1);
    setPrerenderSeed("b", 2);
    clearPrerenderSeed("a");
    expect(getPrerenderSeed("a")).toBeNull();
    expect(getPrerenderSeed("b")).toBe(2);
    clearPrerenderSeed();
    expect(getPrerenderSeed("b")).toBeNull();
  });

  it("namespaces the DOM id per key", () => {
    expect(seedDomId("resale-condition-report")).toBe(
      "prerender-seed-resale-condition-report",
    );
  });

  it("falls back to the module seed when no baked DOM node exists", () => {
    // In the test env there is no matching <script> node, so resolve should
    // fall through to the module-level seed (the SSR path).
    setPrerenderSeed("gamma", { ok: true });
    expect(resolvePrerenderSeed<{ ok: boolean }>("gamma")).toEqual({ ok: true });
  });

  it("escapes script-terminating sequences in the embedded JSON", () => {
    expect(escapeJsonForScript({ x: "</script><script>alert(1)" })).not.toContain(
      "</script>",
    );
    expect(escapeJsonForScript({ x: "</script>" })).toContain("\\u003c/script");
  });
});
