import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CROSSLIST_PAIRS,
  canReadCloset,
  crosslistPairPath,
  crosslistPairRoutes,
  destinationMechanism,
  destinationSentence,
  pairAnswer,
  sourceSentence,
} from "@/lib/seo/crosslist-pairs";
import { CROSSLIST_PAIR_SLUGS } from "@/lib/seo/crosslist-pair-slugs";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";
import { KEYWORD_TARGETS } from "@/lib/seo/keyword-targets";
import { CLOSET_IMPORT_PLATFORMS } from "@/lib/marketplace-disclosure";
import {
  LIVE_CROSS_LISTING_PLATFORMS,
  MARKETPLACE_EXTENSION_FLOW,
  MARKETPLACE_TIER,
} from "@/lib/constants";
import { extensionCtaFor } from "@/lib/seo/extension-cta-copy";

// US-9214: a page per marketplace pair that actually earned impressions, and
// not one claim beyond what the constants support.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("crosslist pair pages (US-9214)", () => {
  it("covers the pairs from the export and never all 42", () => {
    expect(CROSSLIST_PAIRS).toHaveLength(14);
    expect(CROSSLIST_PAIRS.map((p) => p.slug).sort()).toEqual([...CROSSLIST_PAIR_SLUGS].sort());
    for (const p of CROSSLIST_PAIRS) {
      expect(p.impressions, p.slug).toBeGreaterThan(0);
      expect(p.queries.length, p.slug).toBeGreaterThan(0);
      // Every query really is the pair it claims.
      for (const q of p.queries) {
        expect(q, p.slug).toContain(p.from);
        expect(q, p.slug).toContain(p.to);
      }
    }
  });

  it("is registered as a route, prerendered and routed", () => {
    for (const r of crosslistPairRoutes()) {
      expect(PUBLIC_ROUTES.some((p) => p.path === r.path), r.path).toBe(true);
    }
    const entry = read("src/prerender/entry-server.tsx");
    expect(entry).toMatch(/CROSSLIST_PAIRS\.map/);
    expect(entry).toMatch(/marketing\/crosslist-pair`/);
    expect(read("src/routes/index.tsx")).toMatch(/CROSSLIST_PAIR_SLUGS\.map/);
    expect(read("src/prerender/head-builder.ts")).toMatch(/getCrosslistPairByPath/);
  });

  it("derives the mechanism from the constants, never from prose", () => {
    // eBay publishes over its API; Poshmark/Mercari/Grailed/Vinted go through
    // the extension; Whatnot has neither and must say so.
    expect(destinationMechanism("ebay")).toBe("api");
    expect(destinationMechanism("poshmark")).toBe("extension");
    expect(destinationMechanism("whatnot")).toBe("manual");
    for (const p of CROSSLIST_PAIRS) {
      const mech = destinationMechanism(p.to);
      const tier = MARKETPLACE_TIER[p.to as keyof typeof MARKETPLACE_TIER];
      if (mech === "api") {
        expect((LIVE_CROSS_LISTING_PLATFORMS as readonly string[]), p.to).toContain(p.to);
      }
      if (mech === "extension") {
        expect(tier, p.to).toBe("extension");
        expect((MARKETPLACE_EXTENSION_FLOW as Record<string, string>)[p.to], p.to).toBe("live");
      }
    }
  });

  it("never promises an API or an extension run the product does not have", () => {
    for (const p of CROSSLIST_PAIRS) {
      const copy = [pairAnswer(p), destinationSentence(p), sourceSentence(p)].join(" ");
      if (destinationMechanism(p.to) === "manual") {
        expect(copy, `${p.slug} must not claim an API`).not.toMatch(/over its API|over [A-Za-z]+'s own API/);
        expect(copy, `${p.slug} must say the last step is the seller's`).toMatch(/last step is yours|paste/);
      }
      if (!canReadCloset(p.from)) {
        expect(copy, `${p.slug} must not claim it reads that closet`).not.toMatch(/reads your own/);
      }
    }
  });

  it("the closet-readable list mirrors the capability", () => {
    const readable = CROSSLIST_PAIRS.map((p) => p.from).filter(canReadCloset);
    for (const p of new Set(readable)) {
      expect([...CLOSET_IMPORT_PLATFORMS] as string[], p).toContain(p);
    }
    for (const p of CLOSET_IMPORT_PLATFORMS) expect(canReadCloset(p), p).toBe(true);
  });

  it("the ten highest-impression pairs have a keyword target whose primary is the query", () => {
    const top = [...CROSSLIST_PAIRS].sort((a, b) => b.impressions - a.impressions).slice(0, 10);
    for (const p of top) {
      const target = KEYWORD_TARGETS.find((k) => k.path === crosslistPairPath(p.slug));
      expect(target, p.slug).toBeDefined();
      expect(target!.primary).toBe(`${p.from} to ${p.to}`);
      const route = PUBLIC_ROUTES.find((r) => r.path === target!.path)!;
      expect(
        `${route.title} ${route.description}`.toLowerCase(),
        `${p.slug}: the primary keyword must appear in the route metadata`,
      ).toContain(target!.primary);
    }
  });

  it("offers the extension install and links the product page", () => {
    for (const p of CROSSLIST_PAIRS) {
      expect(extensionCtaFor(crosslistPairPath(p.slug))?.role, p.slug).toBe("seller");
    }
    expect(read("src/pages/marketing/crosslist-pair.tsx")).toMatch(/\/flipdesk\/crosslisting/);
  });

  it("the listicle hands task intent to the pair pages", () => {
    const listicle = read("src/pages/marketing/crosslisting-apps.tsx");
    expect(listicle).toMatch(/CROSSLIST_PAIRS\.map/);
    expect(listicle).toMatch(/crosslistPairPath/);
  });

  it("the measurement table carries the family's own segment", () => {
    expect(read("vault/40-growth/seo-distribution-and-measurement.md")).toMatch(
      /\^\/reselling\/crosslist\//,
    );
  });
});
