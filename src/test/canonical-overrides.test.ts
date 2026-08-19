import { describe, it, expect } from "vitest";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";
import {
  COMPARISON_CANONICAL_OVERRIDES,
  comparePath,
} from "@/lib/seo/comparison-guides";

// US-9008. A canonical override is a deliberate "this URL is not the one",
// which is easy to set and easy to leave dangling. These lock the three things
// that have to stay true about one: the target exists, the route still ships,
// and the override is carried into the registry the sitemap and the prerender
// both read.

describe("canonical overrides", () => {
  const overridden = PUBLIC_ROUTES.filter((r) => r.canonicalPath);

  it("points /compare/depop-vs-poshmark at the blog post that actually ranks", () => {
    expect(COMPARISON_CANONICAL_OVERRIDES["depop-vs-poshmark"]).toBe(
      "/blog/depop-vs-poshmark-which-should-you-use",
    );
  });

  it("carries every override into PUBLIC_ROUTES", () => {
    for (const [slug, target] of Object.entries(COMPARISON_CANONICAL_OVERRIDES)) {
      const route = PUBLIC_ROUTES.find((r) => r.path === comparePath(slug));
      expect(route, `${comparePath(slug)} is not in PUBLIC_ROUTES`).toBeDefined();
      expect(route!.canonicalPath).toBe(target);
    }
  });

  it("keeps the overridden page live and indexable-shaped, not deleted", () => {
    // The whole point is that the page stays reachable from the hub. If a
    // future edit removes it from the registry, this fails rather than the
    // page quietly disappearing.
    expect(overridden.length).toBeGreaterThan(0);
    for (const r of overridden) {
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
    }
  });

  it("never points a canonical at itself, which would be a no-op left behind", () => {
    for (const r of overridden) {
      expect(r.canonicalPath).not.toBe(r.path);
    }
  });

  it("never points a canonical at another overridden route", () => {
    // A chain of canonicals is a bug Google resolves by ignoring all of them.
    const overriddenPaths = new Set(overridden.map((r) => r.path));
    for (const r of overridden) {
      expect(overriddenPaths.has(r.canonicalPath!)).toBe(false);
    }
  });

  it("only overrides routes we meant to override", () => {
    // A guard against a stray canonicalPath appearing in a generated family.
    expect(overridden.map((r) => r.path)).toEqual(["/compare/depop-vs-poshmark"]);
  });
});
