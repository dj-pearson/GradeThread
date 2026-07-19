// US-2105 AC1: four commercially important routes shipped only the layout's
// Organization + a 2-level BreadcrumbList — no page-level schema at all.
//
// The parity guard (US-2044) proves a DECLARED type is prerendered, and the AC3
// guard proves a page passing jsonLd declares a type. Neither says anything
// about whether the markup is HONEST. These assert the two properties that
// could quietly rot: the type fits what the page actually is, and we do not
// claim structures the page cannot back.

import { describe, expect, it } from "vitest";
import { jsonLdForRoute } from "@/../src/prerender/head-builder";

const typesFor = (path: string): Set<string> => {
  const out = new Set<string>();
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const t = (n as { "@type"?: unknown })["@type"];
    if (typeof t === "string") out.add(t);
    Object.values(n as Record<string, unknown>).forEach(walk);
  };
  walk(jsonLdForRoute(path) ?? []);
  return out;
};

describe("US-2105 AC1: page-level schema on the four unguarded routes", () => {
  it.each([
    ["/for-brands", "Service"],
    ["/for-resellers", "Service"],
    ["/developers", "APIReference"],
    ["/verified", "CollectionPage"],
  ])("%s emits %s", (path, expected) => {
    expect(typesFor(path).has(expected), `${path} does not emit ${expected}`).toBe(true);
  });

  it("emits NO FAQPage on pages that carry no FAQ content", () => {
    // None of the three marketing pages has FAQ content. Authoring Q&A purely
    // to earn a rich result would be inventing claims the page does not make —
    // the same refusal as not fabricating grading tolerances (US-2107).
    for (const p of ["/for-brands", "/for-resellers", "/developers"]) {
      expect(typesFor(p).has("FAQPage"), `${p} claims FAQPage it cannot back`).toBe(false);
    }
  });

  it("/verified claims no ItemList it cannot enumerate", () => {
    // Sellers are fetched at runtime, so a build-time ItemList would be empty
    // or stale — a structured claim about a collection this page is not
    // actually listing. CollectionPage alone is true unconditionally.
    const t = typesFor("/verified");
    expect(t.has("CollectionPage")).toBe(true);
    expect(t.has("ItemList")).toBe(false);
  });
});
