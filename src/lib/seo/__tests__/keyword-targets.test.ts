import { describe, it, expect } from "vitest";
import { PUBLIC_ROUTES } from "../public-routes";
import { KEYWORD_TARGETS } from "../keyword-targets";

// US-1402: the keyword registry is ENFORCED, not just documentation — every
// target must point at a real public route, and the route's title/description
// must actually contain its primary keyword, so copy and keyword strategy can't
// silently drift apart.
describe("keyword-target registry (US-1402)", () => {
  const routeByPath = new Map(PUBLIC_ROUTES.map((r) => [r.path, r]));

  it("every keyword target points at a registered public route", () => {
    for (const t of KEYWORD_TARGETS) {
      expect(routeByPath.has(t.path), `no PUBLIC_ROUTES entry for ${t.path}`).toBe(
        true,
      );
    }
  });

  it("has no duplicate target paths", () => {
    const seen = new Set<string>();
    for (const t of KEYWORD_TARGETS) {
      expect(seen.has(t.path), `duplicate keyword target for ${t.path}`).toBe(false);
      seen.add(t.path);
    }
  });

  it("each route's title or description contains its primary keyword", () => {
    for (const t of KEYWORD_TARGETS) {
      const r = routeByPath.get(t.path);
      if (!r) continue; // covered by the existence test above
      const haystack = `${r.title} ${r.description}`.toLowerCase();
      const needle = t.primary.toLowerCase();
      expect(
        haystack.includes(needle),
        `primary keyword "${t.primary}" not found in title/description for ${t.path}: "${r.title}" / "${r.description}"`,
      ).toBe(true);
    }
  });

  it("primary, secondary, and questions are non-empty and well-formed", () => {
    for (const t of KEYWORD_TARGETS) {
      expect(t.primary.trim().length, `empty primary for ${t.path}`).toBeGreaterThan(2);
      expect(t.secondary.length, `no secondary keywords for ${t.path}`).toBeGreaterThan(0);
      expect(t.questions.length, `no question keywords for ${t.path}`).toBeGreaterThan(0);
      // Question keywords should read like questions (target FAQ/answer capsules).
      for (const q of t.questions) {
        expect(q.trim().length, `empty question for ${t.path}`).toBeGreaterThan(5);
      }
    }
  });
});
