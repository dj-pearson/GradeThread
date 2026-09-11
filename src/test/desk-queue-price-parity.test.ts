// US-3317 AC3: the desk and the queue must price the same item the same way.
//
// A seller can send one item to one marketplace two ways: press "Send to
// extension" in the Listing Kit (the DESK path, listing-kit.tsx ->
// buildListerPayload), or queue it and let the desktop extension drain it (the
// QUEUED path, flipdesk-extension-queue.ts -> buildListPayload). Those are two
// separate implementations in two codebases that share no module graph, and
// until this story they disagreed: the desk read the eBay draft row with
// .eq("platform", "ebay") and sent the SHARED price, while the queue read the
// channel's own sibling row. The item a seller had deliberately priced at $40 on
// Poshmark went out at eBay's $52 when they pressed the button themselves.
//
// WHY THIS IS A REAL COMPARISON AND NOT TWO CALLS TO ONE HELPER. Each side is
// driven from the SAME fixture rows and then left alone:
//
//   desk  = readKitListings -> resolveKitPrice -> buildListerPayload  (src/)
//   queue = the route's channelPrice lookup -> buildListPayload        (edge)
//
// The two builders format the price string with their own copy of
// marketplacePriceString, and the two precedence rules are written out
// separately — buildListPayload's is inline in extension-queue.ts and owes
// nothing to resolveSiblingPrice. Nothing here calls one side through the other.
//
// EXACT CENTS, never a rounded dollar figure: `toBe(40)` would pass on a payload
// carrying "40.49" for a field that cannot hold a decimal point.
import { describe, expect, it } from "vitest";
import { dollarsToCents } from "@/lib/marketplace-price";
import { getMarketplaceSpec } from "@/lib/marketplace-specs";
import { buildListerPayload } from "@/lib/lister-extension";
import type { ExportablePhoto } from "@/lib/photo-export";
import type { PlatformKitVariant } from "@/hooks/use-autolister";
import {
  type KitListingRow,
  numericOr,
  readKitListings,
  resolveKitPrice,
} from "@/components/flipdesk/listing-kit";
// The edge half, imported and RUN rather than read as a string. It is reachable
// from vitest because extension-queue.ts was deliberately written with two pure
// imports and no Supabase client (see its header), which is the same property
// its own Deno tests rely on.
import { buildListPayload } from "../../services/edge-functions/src/lib/extension-queue.ts";

const PHOTO: ExportablePhoto = {
  id: "photo-1",
  photo_url: "https://example.test/front.jpg",
  photo_type: "front",
  sort_order: 0,
};

function variantFor(platform: string, price: number): PlatformKitVariant {
  return {
    platform,
    title: "Patagonia Better Sweater Fleece Jacket",
    description: "Grade 8.4. Light pilling at the cuffs.",
    condition: { value: "good", label: "Good" },
    category: "Women > Jackets & Coats",
    brand: "Patagonia",
    color: "Navy",
    size: "M",
    price,
    tags: ["fleece", "outdoor"],
    confidence: 0.9,
    validation: { platform, ok: true, issues: [] },
  };
}

interface Fixture {
  platform: "poshmark" | "grailed" | "mercari" | "vinted";
  /** This item's `listings` rows, newest first, as the SPA query returns them. */
  rows: KitListingRow[];
}

/**
 * The desk path, end to end: the rows the Listing Kit query returns, through
 * its own price resolution, into the payload the extension is handed.
 */
function deskCents(f: Fixture): number {
  const { draft, channelPrices } = readKitListings(f.rows);
  const stored = (draft?.platform_fields ?? {}) as Record<string, Record<string, unknown>>;
  const variant = variantFor(
    f.platform,
    numericOr(stored[f.platform]?.price, 0),
  );
  // The kit's shared-price fallback (US-2736): the eBay draft's price, then the
  // item's target price, then any priced listing row. Only the first is set in
  // these fixtures, which is the ordinary case.
  const fallbackPrice = numericOr(draft?.listing_price, 0);
  const price = resolveKitPrice(f.platform, {
    channelPrice: channelPrices[f.platform] ?? null,
    variantPrice: variant.price,
    fallbackPrice,
  }).price;
  const payload = buildListerPayload({
    platform: f.platform,
    itemId: "item-1",
    variant: { ...variant, price },
    photos: [PHOTO],
    primaryId: PHOTO.id,
  });
  return dollarsToCents(Number(payload.price));
}

/**
 * The queued path, end to end. `channelPrice` is derived exactly as
 * `hydrateListRows` derives it in services/edge-functions/src/routes/
 * flipdesk-extension-queue.ts — the sibling row's own `listing_price` when that
 * is positive, nothing otherwise. The source scan at the bottom of this file
 * fails if that route stops doing it.
 */
function queueCents(f: Fixture): number {
  const spec = getMarketplaceSpec(f.platform);
  const draft = f.rows.find((r) => r.platform === "ebay") ?? null;
  const sibling = f.rows.find((r) => r.platform === f.platform) ?? null;
  const channelPrice = typeof sibling?.listing_price === "number" &&
      sibling.listing_price > 0
    ? sibling.listing_price
    : null;
  const stored = (draft?.platform_fields ?? {}) as Record<string, Record<string, unknown>>;
  const payload = buildListPayload({
    platform: f.platform,
    itemId: "item-1",
    item: { id: "item-1", title: "Patagonia fleece", brand: "Patagonia", color: "Navy", size: "M" },
    photos: [{ id: PHOTO.id, photo_url: PHOTO.photo_url, sort_order: 0, photo_type: "front" }],
    platformFields: stored[f.platform] ?? null,
    draft: draft
      ? {
        listing_title: "Patagonia fleece",
        listing_description: "Grade 8.4.",
        listing_price: draft.listing_price,
        primary_photo_id: PHOTO.id,
      }
      : null,
    channelPrice,
    maxPhotos: spec?.maxPhotos ?? 12,
    priceStep: spec?.priceStep ?? 0,
    platformLabel: spec?.label ?? f.platform,
  });
  return dollarsToCents(Number(payload.price));
}

function ebayDraft(sharedPrice: number, variantPrice: number, platform: string): KitListingRow {
  return {
    id: "listing-ebay",
    platform: "ebay",
    platform_fields: { [platform]: { price: variantPrice, title: "kit title" } },
    primary_photo_id: PHOTO.id,
    listing_price: sharedPrice,
  };
}

function sibling(platform: string, listingPrice: number | null): KitListingRow {
  return {
    id: `listing-${platform}`,
    platform,
    platform_fields: null,
    primary_photo_id: null,
    listing_price: listingPrice,
  };
}

describe("US-3317: the desk and the queue price one channel identically", () => {
  it("a channel priced on its own row: both send the channel's price, not eBay's", () => {
    // THE BUG, in one fixture. eBay's draft says $52.00; the seller priced
    // Poshmark at $40.49 on its own row. The queue sent 4000c and the desk sent
    // 5200c, and the one a human pressed was the one that was wrong.
    const f: Fixture = {
      platform: "poshmark",
      rows: [ebayDraft(52, 0, "poshmark"), sibling("poshmark", 40.49)],
    };
    expect(deskCents(f)).toBe(queueCents(f));
    // 4000 and not 4049: Poshmark's price input is pattern="[0-9]*" (AC4).
    expect(deskCents(f)).toBe(4000);
  });

  it("no sibling row at all: both fall back to the shared price", () => {
    const f: Fixture = { platform: "poshmark", rows: [ebayDraft(52, 0, "poshmark")] };
    expect(deskCents(f)).toBe(queueCents(f));
    expect(deskCents(f)).toBe(5200);
  });

  it("a sibling row carrying 0 is not a price: both fall back", () => {
    // A row an extension writeback minted and nothing ever pushed. First
    // POSITIVE, not first non-null, on both sides.
    const f: Fixture = {
      platform: "poshmark",
      rows: [ebayDraft(52, 0, "poshmark"), sibling("poshmark", 0)],
    };
    expect(deskCents(f)).toBe(queueCents(f));
    expect(deskCents(f)).toBe(5200);
  });

  it("the kit variant's own price is used when the channel has no row", () => {
    const f: Fixture = {
      platform: "poshmark",
      rows: [ebayDraft(52, 44.6, "poshmark")],
    };
    expect(deskCents(f)).toBe(queueCents(f));
    // 44.60 stepped to Poshmark's whole dollar, rounded to NEAREST.
    expect(deskCents(f)).toBe(4500);
  });

  it("the channel's row still wins over a kit variant that has a price", () => {
    const f: Fixture = {
      platform: "poshmark",
      rows: [ebayDraft(52, 44.6, "poshmark"), sibling("poshmark", 38)],
    };
    expect(deskCents(f)).toBe(queueCents(f));
    expect(deskCents(f)).toBe(3800);
  });

  it("a marketplace that keeps its cents keeps them on both paths", () => {
    // Grailed has no priceStep, so it keeps its cents. The step rule must not
    // round a channel price the marketplace can hold exactly. (Depop would be
    // the other example and cannot be used here: it is not a ListerPlatform, so
    // the desk has no send-to-extension path to it at all.)
    const f: Fixture = {
      platform: "grailed",
      rows: [ebayDraft(52, 0, "grailed"), sibling("grailed", 36.49)],
    };
    expect(deskCents(f)).toBe(queueCents(f));
    expect(deskCents(f)).toBe(3649);
  });

  it("an item with no price anywhere sends nothing, on both paths", () => {
    // "" rather than "0" — a zero typed into a live listing is worse than a
    // blank field the seller has to fill.
    const f: Fixture = {
      platform: "mercari",
      rows: [ebayDraft(0, 0, "mercari"), sibling("mercari", 0)],
    };
    expect(deskCents(f)).toBe(queueCents(f));
    expect(deskCents(f)).toBe(0);
  });
});

describe("US-3317: the desk goes through the shared rule", () => {
  it("resolveKitPrice reaches for resolveSiblingPrice and nothing else", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/flipdesk/listing-kit.tsx", "utf8");
    // AC2: one rule, not a third opinion re-derived in the component.
    expect(src).toContain("resolveSiblingPrice(platform, {");
    expect(src).toContain('from "@/lib/cross-listing-price"');
    // AC1: the kit no longer reads only the eBay row. Comments stripped first —
    // the doc comment on readKitListings quotes the old filter on purpose, and a
    // raw substring scan would read that as the bug still being there.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(code).not.toContain('.eq("platform", "ebay")');
    expect(code).toContain('.select("id, platform, platform_fields');
  });

  it("the desk reads a per-channel price and never mints one (AC5)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/flipdesk/listing-kit.tsx", "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // THE DECISION (US-3317 AC5): the Listing Kit is a READER of this channel's
    // price, not a writer of it. Per-channel pricing is set where it is
    // recorded — the composer's explicit price, which cross-push stores as
    // `price_override` on the sibling's own blob. Making the kit's price row
    // editable without giving it somewhere to write would be worse than leaving
    // it read-only: the seller's number would survive exactly as long as the
    // tab, and the next read-back would put the old price on the listing with
    // nothing said.
    //
    // So this fails if anyone makes price editable here. Doing that is allowed
    // — it just has to arrive with the write that records it.
    const editable = /const editableKeys = new Set\(\[([^\]]*)\]\)/.exec(code);
    expect(editable, "editableKeys moved; this guard is now scanning nothing")
      .not.toBeNull();
    expect(editable![1]).not.toContain("price");
    // And the shared rule's `explicitPrice` slot — "the seller typed one on this
    // push" — stays empty from here, because there is no field to type into.
    expect(code).not.toMatch(/explicitPrice:/);
  });

  it("the queue route still hands the sibling row's own price to the builder", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync(
      "services/edge-functions/src/routes/flipdesk-extension-queue.ts",
      "utf8",
    );
    // `queueCents` above reproduces this lookup. If the route stops deriving
    // channelPrice from a positive listing_price, the parity proved above is
    // proof about a function nothing calls that way any more.
    expect(route).toContain("channelPriceById.set(r.id, r.listing_price)");
    expect(route).toMatch(/r\.listing_price === "number" && r\.listing_price > 0/);
  });
});
