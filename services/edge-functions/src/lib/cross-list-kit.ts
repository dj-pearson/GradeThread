// 2026-09-02: the cross-list copy kit, filled with every draft.
//
// Until now the kit (composer "Cross-list copy kit" card, listing-kit.tsx) was
// empty after AutoLister ran, and stayed empty until the seller opened the
// composer and pressed "Generate for all marketplaces" - a second AI action, a
// second wait, on every item they meant to cross-post. The copy was always
// going to be needed for any seller who picked a copy-paste channel; asking
// for it later only moved the cost and added a click.
//
// So the batch worker fills it right after the draft is written, as part of
// the same generation action, for exactly the channels the seller chose in
// Settings -> Marketplaces (flipdesk_settings.cross_post_channels). The text
// pass is the existing generatePlatformVariants on the lightweight tier
// (getPlatformVariantModel), so the whole kit costs a fraction of a cent.
//
// Who does NOT get one:
//   - a seller whose selection contains no copy-paste channel at all (eBay +
//     Shopify only). The web kit falls back to "every channel" there so it
//     never renders empty; five variants nobody asked for is the wrong default
//     on the paid path, so this returns [].
//
// NULL MEANS ALL, here as on the web. US-3046 tried to read NULL as "never
// chosen" and write no kit for it; that lasted a day. The picker
// (normalizeSelection) stores NULL when EVERY channel is ticked, on purpose,
// so a channel added later is included without a click - which means a seller
// who deliberately chose all five and one who never opened the page are the
// same row. Telling them apart needs a column, and until one exists the batch
// writes the kit for NULL, because the seller who ticked everything and got
// no copy is the one who noticed.
//
// Best-effort at every step: a failed kit never fails the draft.

import {
  getMarketplaceSpec,
  type MarketplacePlatform,
} from "./marketplace-specs.ts";
import { supabaseAdmin } from "./supabase.ts";
import { generatePlatformVariants } from "./ai-listing.ts";

/**
 * The copy-paste channels, in the order the web kit shows its tabs
 * (listing-kit.tsx KIT_PLATFORMS). eBay and Shopify push through adapters and
 * carry their own drafts; Facebook's lister flow is still "verifying" and is
 * absent from the web list for the same reason it is absent here.
 */
export const KIT_PLATFORMS: readonly MarketplacePlatform[] = [
  "poshmark",
  "mercari",
  "depop",
  "grailed",
  "vinted",
];

/**
 * Which kit channels to generate for this seller, unprompted.
 *
 * `selected` is flipdesk_settings.cross_post_channels: null when every
 * channel is on (never chosen, or all ticked - the picker stores both as
 * null), an array when they narrowed it. The web rule (src/lib/
 * cross-post-channels.ts): an empty selection means ALL, never none, so null
 * and [] both yield the full kit. A selection that names only API channels
 * yields [] - see the file comment. Pure.
 */
export function kitPlatformsForSeller(
  selected: readonly string[] | null | undefined,
): MarketplacePlatform[] {
  const specced = KIT_PLATFORMS.filter((p) => getMarketplaceSpec(p) != null);
  if (!selected || selected.length === 0) return [...specced];
  const chosen = new Set(selected);
  return specced.filter((p) => chosen.has(p));
}

/** The seller's channel selection; null when unset or unreadable. */
export async function loadCrossPostChannels(
  ownerId: string,
): Promise<string[] | null> {
  const { data, error } = await supabaseAdmin
    .from("flipdesk_settings")
    .select("cross_post_channels")
    .eq("user_id", ownerId)
    .maybeSingle();
  if (error) return null;
  const value = (data as { cross_post_channels?: unknown } | null)
    ?.cross_post_channels;
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : null;
}

export interface KitForDraftResult {
  platforms: MarketplacePlatform[];
  /** Null when no kit was generated (no copy-paste channel chosen). */
  costUsd: number | null;
}

/**
 * Fill the kit for a freshly generated draft. Tenant-scoped through
 * generatePlatformVariants, which re-loads the item and draft by ownerId.
 * Throws only what generatePlatformVariants throws; the batch worker catches.
 */
export async function generateKitForDraft(
  itemId: string,
  ownerId: string,
): Promise<KitForDraftResult> {
  const platforms = kitPlatformsForSeller(await loadCrossPostChannels(ownerId));
  if (platforms.length === 0) return { platforms, costUsd: null };
  const result = await generatePlatformVariants(itemId, ownerId, platforms, {
    source: "draft",
  });
  return { platforms, costUsd: result.costUsd };
}
