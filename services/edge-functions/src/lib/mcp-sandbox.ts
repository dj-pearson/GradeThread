// US-9124: try the connector without spending anything.
//
// THIS MODULE IMPORTS NO DATABASE CLIENT AND NO MARKETPLACE CLIENT DIRECTLY,
// and a test asserts the import list so the property survives someone adding a
// convenient import later. Everything defined here is a pure function of its
// arguments.
//
// The one caveat, stated rather than glossed: the two price-guide symbols below
// come from lib/price-guide.ts, which DOES have database access for its live
// paths. The two imported functions are not among them — both derive their
// whole answer from a seeded hash of the slug and touch nothing. They are
// imported rather than copied so a partner who built against the sandbox HTTP
// API (/api/v1/sandbox/price-guide) sees the same numbers through the
// connector; duplicating them would drift the day one side changed.
//
// EVERY RESULT SAYS IT IS A SANDBOX RESULT, in the text and in the payload. A
// model that reports a fake publish as real is worse than one that cannot
// publish at all, and the text is what it reads.

import {
  type PriceGuideCatalogItem,
  type PriceGuideEntry,
  sandboxPriceGuideCatalog,
  sandboxPriceGuideEntry,
} from "./price-guide.ts";

export const SANDBOX_NOTICE =
  "SANDBOX: this is sample data. Nothing was read from the seller's account and nothing was " +
  "changed on any marketplace.";

/** Stable 0..1 hash of a seed string (FNV-1a), mirroring the /api/v1 sandbox. */
function sandboxSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

const SANDBOX_TIERS = [
  { min: 9.5, tier: "NWT" },
  { min: 8.5, tier: "NWOT" },
  { min: 7.5, tier: "Excellent" },
  { min: 6.5, tier: "Very Good" },
  { min: 5.5, tier: "Good" },
  { min: 4.5, tier: "Fair" },
  { min: 0, tier: "Poor" },
] as const;

export interface SandboxGrade {
  sandbox: true;
  id: string;
  status: "completed";
  title: string;
  brand: string | null;
  overall_score: number;
  grade_tier: string;
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
  confidence_score: number;
  ai_summary: string;
}

/**
 * A deterministic sample grade. Same seed, same grade, so a partner building
 * against it can write an assertion that holds.
 */
export function sandboxGrade(title: string, brand?: string): SandboxGrade {
  const seed = title || "sample";
  const s = sandboxSeed(seed);
  const half = (n: number) => Math.round(n * 2) / 2;
  const overall = half(5 + s * 4.5);
  const jitter = (k: string) =>
    half(Math.max(1, Math.min(10, overall + (sandboxSeed(seed + k) - 0.5) * 2)));
  const tier = SANDBOX_TIERS.find((t) => overall >= t.min)?.tier ?? "Good";

  return {
    sandbox: true,
    id: `sandbox_${Math.floor(s * 1e9).toString(36)}`,
    status: "completed",
    title: title || "Sample garment",
    brand: brand ?? null,
    overall_score: overall,
    grade_tier: tier,
    fabric_condition_score: jitter("fabric"),
    structural_integrity_score: jitter("structural"),
    cosmetic_appearance_score: jitter("cosmetic"),
    functional_elements_score: jitter("functional"),
    odor_cleanliness_score: jitter("odor"),
    confidence_score: Math.round((0.7 + s * 0.25) * 100) / 100,
    ai_summary:
      `Sample condition report for a ${tier.toLowerCase()} garment. Light wear consistent with ` +
      `the grade; no structural faults noted.`,
  };
}

export interface SandboxListing {
  sandbox: true;
  listing_id: string;
  item_id: string;
  title: string;
  marketplace: string;
  status: "would_publish";
  price_cents: number;
  url: null;
}

/**
 * What a publish WOULD do. `status` is "would_publish" and `url` is null on
 * purpose: a sandbox result that carried a plausible listing URL is a result a
 * model will hand to a seller as a live listing.
 */
export function sandboxPublish(
  itemTitle: string,
  marketplace: string,
  priceCents: number,
): SandboxListing {
  const s = sandboxSeed(itemTitle + marketplace);
  return {
    sandbox: true,
    listing_id: `sandbox_listing_${Math.floor(s * 1e9).toString(36)}`,
    item_id: `sandbox_item_${Math.floor(s * 1e6).toString(36)}`,
    title: itemTitle || "Sample garment",
    marketplace,
    status: "would_publish",
    price_cents: priceCents,
    url: null,
  };
}

export function sandboxCatalog(): PriceGuideCatalogItem[] {
  return sandboxPriceGuideCatalog();
}

export function sandboxEntry(slug: string): PriceGuideEntry {
  return sandboxPriceGuideEntry(slug);
}
