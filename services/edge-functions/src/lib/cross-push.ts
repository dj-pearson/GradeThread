// One platform's slice of a cross-listing fan-out (US-149 / US-564 / US-708),
// extracted from flipdesk-listings.ts POST /cross-push so it has a second
// caller: the crosslist_to automation action (US-2156).
//
// What lives here is everything that is the SAME whether a human clicked
// "cross-push" or a rule fired: find-or-create the platform's sibling `listings`
// row inside the group, map the shared draft onto that platform's field limits,
// pre-flight it against the requirements registry, and hand it to the adapter to
// publish.
//
// What deliberately does NOT live here:
//   • The AI variant generation (US-721). It needs the AI quota/metering path,
//     which lives in the routes layer — so the resolved variant is passed IN.
//     A caller with no variant (the automation runner) falls back to the source
//     draft copy, exactly like the route does when generation fails.
//   • The activeListings cap gate and the "advance the item to listed" write.
//     Both are per-FAN-OUT decisions, not per-platform ones, so they stay with
//     the caller that knows the whole batch.
//
// SECURITY (US-268): every query here is scoped by the `ownerId` the caller
// verified — the service-role client bypasses RLS, so the sibling lookup, the
// sibling update, and the group read all carry .eq("user_id", ownerId).

import { supabaseAdmin } from "./supabase.ts";
import {
  type AdapterResult,
  type CrossListingPlatform,
  resolveAdapter,
} from "./marketplace-adapters/index.ts";
import {
  mapSiblingListingFields,
  type StoredPlatformVariant,
  validateSiblingForPublish,
} from "./cross-listing-fields.ts";
import { recordRelist } from "./passport-relist.ts";

/** The source draft fields a cross-push copies onto each sibling. */
export interface CrossPushDraft {
  id: string;
  inventory_item_id: string;
  platform: string;
  listing_title: string | null;
  listing_description: string | null;
  primary_photo_id: string | null;
  badge_enabled: boolean | null;
}

export interface CrossPushInput {
  ownerId: string;
  draft: CrossPushDraft;
  /** listings.draft_id for the group — the source draft's own id. */
  groupId: string;
  platform: CrossListingPlatform;
  price: number;
  /** Per-marketplace AI variant (US-721), or undefined to copy the draft. */
  variant?: StoredPlatformVariant;
}

export interface CrossPushOutcome {
  result: AdapterResult;
  /** The sibling row the attempt used — "" when the row couldn't be created. */
  listingRowId: string;
}

/**
 * Ensure the source draft is the anchor of its own cross-listing group.
 *
 * The group key is the source draft's own id and the source row points at
 * itself, so every member (including the source) is found with one draft_id
 * lookup. Returns the group id, or null when the self-link write failed.
 */
export async function ensureCrossListingGroup(
  ownerId: string,
  draftId: string,
  existingGroupId: string | null,
): Promise<string | null> {
  if (existingGroupId) return existingGroupId;
  const { error } = await supabaseAdmin
    .from("listings")
    .update({ draft_id: draftId })
    .eq("id", draftId)
    .eq("user_id", ownerId);
  return error ? null : draftId;
}

/**
 * Publish one platform's sibling for a cross-listing group.
 *
 * Idempotent by design: a group that already has a row for `platform` REUSES
 * it (re-pushing updates price/title/description rather than minting a
 * duplicate), so calling this repeatedly — which an hourly automation will —
 * converges instead of accumulating rows.
 */
export async function crossPushPlatform(
  input: CrossPushInput,
): Promise<CrossPushOutcome> {
  const { ownerId, draft, groupId, platform, price, variant } = input;

  // US-708: resolve the adapter from the platform via the registry. An unknown
  // platform yields a typed 501 rather than silently falling through to eBay.
  const adapter = resolveAdapter(platform);
  if (!adapter) {
    return {
      result: {
        ok: false,
        status: 501,
        error: `${platform} cross-listing isn't supported yet.`,
      },
      listingRowId: "",
    };
  }

  // The source draft IS this platform's row (eBay today) — publish it directly
  // rather than minting a duplicate.
  if (platform === draft.platform) {
    const result = await adapter.publish({
      ownerId,
      inventoryItemId: draft.inventory_item_id,
      listingRowId: draft.id,
      price,
    });
    return { result, listingRowId: draft.id };
  }

  // US-564: map the shared draft onto this platform's requirements (title /
  // description clamped to its limits, condition/category/tags carried through)
  // instead of copying the eBay draft verbatim.
  const mapped = mapSiblingListingFields(
    platform,
    {
      listing_title: draft.listing_title,
      listing_description: draft.listing_description,
    },
    price,
    variant,
  );

  const { data: existing } = await supabaseAdmin
    .from("listings")
    .select("id")
    .eq("draft_id", groupId)
    .eq("platform", platform)
    // US-1638: defense-in-depth — groupId already derives from the
    // owner-verified draft, but scope the sibling lookup to the tenant too
    // (free + index-backed via listings.user_id, migration 00146).
    .eq("user_id", ownerId)
    .maybeSingle();
  let rowId = (existing as { id: string } | null)?.id ?? null;

  if (rowId) {
    const update: Record<string, unknown> = {
      listing_price: price,
      listing_title: mapped.listing_title,
      listing_description: mapped.listing_description,
    };
    // Only overwrite platform_fields when we actually have a variant — never
    // clobber a previously generated one with null.
    if (mapped.platform_fields) update.platform_fields = mapped.platform_fields;
    await supabaseAdmin
      .from("listings")
      .update(update)
      .eq("id", rowId)
      .eq("user_id", ownerId); // US-1638: tenant-scope the sibling update too
  } else {
    const { data: created, error: insErr } = await supabaseAdmin
      .from("listings")
      .insert({
        inventory_item_id: draft.inventory_item_id,
        platform,
        // US-1077: a FlipDesk cross-listing sibling is GradeThread-originated.
        listing_origin: "gradethread",
        listing_status: "draft",
        is_active: false,
        listing_price: price,
        listing_title: mapped.listing_title,
        listing_description: mapped.listing_description,
        platform_fields: mapped.platform_fields ?? undefined,
        primary_photo_id: draft.primary_photo_id,
        badge_enabled: draft.badge_enabled,
        draft_id: groupId,
      })
      .select("id")
      .single();
    if (insErr || !created) {
      return {
        result: {
          ok: false,
          status: 500,
          error: `Could not create the ${platform} listing row.`,
        },
        listingRowId: "",
      };
    }
    rowId = (created as { id: string }).id;

    // US-1095: a NEW listing for a passport-linked item CONTINUES the chain —
    // append a 'listed' event to the same garment (no new garment created;
    // tenant-scoped via the item's owner). US-1124: awaited (not
    // fire-and-forget) so the 'listed' event is reliably persisted before the
    // response returns — the next buyer's passport claim then includes this
    // relist. recordRelist is best-effort internally (never throws), so awaiting
    // can't fail the push.
    await recordRelist(draft.inventory_item_id, ownerId, platform);
  }

  // US-725: pre-flight the mapped sibling against the platform's requirements
  // registry before spending an API call on a draft the platform will reject
  // (over-limit title, missing required field, invalid condition, unmapped
  // category). Error-level issues block this platform's publish; the sibling row
  // stays a draft so the seller can fix it in the Listing Kit and re-push.
  const preflight = validateSiblingForPublish(platform, mapped);
  if (!preflight.ok) {
    const blockers = preflight.issues
      .filter((i) => i.level === "error")
      .map((i) => i.message);
    return {
      result: {
        ok: false,
        status: 422,
        error: blockers.join(" • "),
        blockers,
      },
      listingRowId: rowId,
    };
  }

  const result = await adapter.publish({
    ownerId,
    inventoryItemId: draft.inventory_item_id,
    listingRowId: rowId,
    price,
  });
  return { result, listingRowId: rowId };
}
