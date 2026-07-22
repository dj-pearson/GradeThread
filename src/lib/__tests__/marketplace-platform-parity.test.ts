// Durable guard: every marketplace with an API ADAPTER must also have a
// frontend label. The edge owns CROSS_LISTING_PLATFORMS (the platforms with a
// real publish/sync adapter, tsc-checked against the ADAPTERS map) and the
// frontend owns LISTING_PLATFORMS + MARKETPLACE_LABELS (everything the UI can
// name). These are DIFFERENT sets by design — not every listable marketplace has
// an adapter — so the invariant is a SUBSET, not equality: CROSS_LISTING_PLATFORMS
// ⊆ LISTING_PLATFORMS. Because the two live in separate projects that cannot
// import each other, nothing type-checks this. If someone adds a new adapter
// (as US-1662 did for Whatnot) without adding the platform to LISTING_PLATFORMS,
// a listing on that marketplace would render with no label / no MARKETPLACE_LABEL
// entry. This asserts the subset from the edge source itself, so that drift fails
// the build. Currently clean (all 7 adapter platforms are labelled).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LISTING_PLATFORMS } from "@/lib/constants";

const EDGE_TYPES = resolve(
  process.cwd(),
  "services/edge-functions/src/lib/marketplace-adapters/types.ts",
);

/** The CROSS_LISTING_PLATFORMS const array, parsed from the edge source. */
function crossListingPlatforms(): string[] {
  const src = readFileSync(EDGE_TYPES, "utf8");
  const m = src.match(
    /CROSS_LISTING_PLATFORMS:\s*readonly CrossListingPlatform\[\]\s*=\s*\[([^\]]*)\]/,
  );
  if (!m) throw new Error("could not parse CROSS_LISTING_PLATFORMS from edge source");
  return [...(m[1] ?? "").matchAll(/"([a-z_]+)"/g)]
    .map((x) => x[1])
    .filter((v): v is string => v != null);
}

describe("marketplace adapter platforms ⊆ frontend listing platforms", () => {
  it("every platform with an API adapter has a frontend label", () => {
    const cross = crossListingPlatforms();
    expect(cross.length, "no CROSS_LISTING_PLATFORMS parsed").toBeGreaterThan(0);
    const fe = new Set<string>(LISTING_PLATFORMS);

    const missing = cross.filter((p) => !fe.has(p));
    expect(
      missing,
      "marketplace adapter platform(s) have no entry in LISTING_PLATFORMS / " +
        "MARKETPLACE_LABELS — a listing on them would render unlabeled",
    ).toEqual([]);
  });
});
