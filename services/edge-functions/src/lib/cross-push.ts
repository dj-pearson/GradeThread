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
import { enqueueExtensionWork } from "./extension-enqueue.ts";
// Derived, not restated: the same set that decides how a sibling is ENDED
// decides how it is listed, so the two can never drift into a channel we can
// list to but not delist from — which is the oversell US-2165 exists about.
import { EXTENSION_DELIST_PLATFORMS } from "./cross-listing-sale.ts";
import {
  type AdapterResult,
  type CrossListingPlatform,
  resolveAdapter,
} from "./marketplace-adapters/index.ts";
import {
  mapSiblingListingFields,
  resolveSiblingPrice,
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
}

export interface CrossPushInput {
  ownerId: string;
  draft: CrossPushDraft;
  /** listings.draft_id for the group — the source draft's own id. */
  groupId: string;
  platform: CrossListingPlatform;
  /**
   * The item's SHARED price — the eBay draft's, else the item's target.
   *
   * US-2736: this is the fallback, not the answer. A per-channel price the
   * seller set beats it (`explicitPrice` on this push, or the one stored on the
   * sibling from an earlier one), and whichever wins is rounded to the
   * marketplace's own step before anything is written.
   */
  price: number;
  /** US-2736: the price the seller typed for THIS channel on THIS push. */
  explicitPrice?: number | null;
  /** Per-marketplace AI variant (US-721), or undefined to copy the draft. */
  variant?: StoredPlatformVariant;
}

export interface CrossPushOutcome {
  result: AdapterResult;
  /** The sibling row the attempt used — "" when the row couldn't be created. */
  listingRowId: string;
  /**
   * US-2736: the price this channel was actually pushed at, in dollars and in
   * the marketplace's own units.
   *
   * The caller used to report its own input back to the seller, which was the
   * shared price whatever the sibling ended up costing. A response that names a
   * number nothing was listed at is worse than no number.
   */
  price: number;
  /**
   * US-3213: the work went to the DESKTOP EXTENSION queue instead of an API.
   *
   * `result.ok` is true for these, because the enqueue succeeded and nothing
   * failed — but a queued job is not a live listing, and every caller that
   * treats "ok" as "it is up" has to be able to tell the difference. The
   * activeListings cap and the advance-to-listed write both key off this.
   */
  queued?: boolean;
  /**
   * US-3367: the channel was left alone on purpose. `ok` is true and nothing
   * was enqueued; `queued` mirrors whether a job is (still) waiting.
   */
  skipped?: CrossPushSkip;
}

/** Why an extension channel was NOT queued this push. */
export type CrossPushSkip = "already_live" | "already_queued";

/**
 * Should this push leave the channel alone?
 *
 * Re-queueing a channel whose listing is already live opens the create form
 * again in the seller's browser and mints a DUPLICATE listing; re-queueing one
 * with a job already waiting runs the fill twice. Both were possible before,
 * because the enqueue below was unconditional. Pure so the rule is tested;
 * the caller supplies the two facts.
 *
 * An `active` row with NO url is skipped only when it is RECORDED as listed but
 * unconfirmed (`listed_unconfirmed`, the founder's 2026-09-11 opt-out posture:
 * a filled form counts as listed until the seller says otherwise). An active
 * row with neither a URL nor that marker is a claim nothing made, so it is not
 * skipped.
 */
export function planCrossPushSkip(
  existing:
    | { listing_status: string | null; listing_url: string | null; listed_unconfirmed?: boolean }
    | null,
  pendingListJob: boolean,
): CrossPushSkip | null {
  if (
    existing?.listing_status === "active" &&
    (existing.listing_url || existing.listed_unconfirmed === true)
  ) {
    return "already_live";
  }
  if (pendingListJob) return "already_queued";
  return null;
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
  const { ownerId, draft, groupId, platform, price, explicitPrice, variant } = input;

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
      price: 0,
    };
  }

  // The source draft IS this platform's row (eBay today) — publish it directly
  // rather than minting a duplicate.
  if (platform === draft.platform) {
    const own = resolveSiblingPrice(platform, { explicitPrice, sharedPrice: price });
    const result = await adapter.publish({
      ownerId,
      inventoryItemId: draft.inventory_item_id,
      listingRowId: draft.id,
      price: own.price,
    });
    return { result, listingRowId: draft.id, price: own.price };
  }

  // US-2736: read this channel's OWN price back before deciding what it costs.
  //
  // The lookup used to select `id` alone, so a re-push knew nothing about the
  // sibling except that it existed — and the only price to hand was the shared
  // eBay one. A seller who priced Depop $4 above their eBay draft therefore
  // watched that channel get repriced back every time anything touched the
  // item: an automation, a second cross-push, a bulk edit. The price was
  // written and never read.
  //
  // It is the stored OVERRIDE that is read here, not the row's current
  // `listing_price`. The row's price is rewritten by every push and by every
  // markdown rule, so it states what the listing costs today rather than what
  // the seller decided about this channel; letting it win would freeze a
  // channel at whatever it was first pushed at and there would be no way back.
  const { data: existing } = await supabaseAdmin
    .from("listings")
    // US-3367: status and URL feed planCrossPushSkip below.
    .select("id, platform_fields, listing_status, listing_url")
    .eq("draft_id", groupId)
    .eq("platform", platform)
    // US-1638: defense-in-depth — groupId already derives from the
    // owner-verified draft, but scope the sibling lookup to the tenant too
    // (free + index-backed via listings.user_id, migration 00146).
    .eq("user_id", ownerId)
    .maybeSingle();
  const existingRow = existing as
    | {
      id: string;
      platform_fields: Record<string, unknown> | null;
      listing_status: string | null;
      listing_url: string | null;
    }
    | null;
  let rowId = existingRow?.id ?? null;

  const priorBlob = readSiblingBlob(existingRow?.platform_fields ?? null, platform);
  const storedOverride = typeof priorBlob?.price_override === "number"
    ? priorBlob.price_override
    : null;
  // An explicit price on this push REPLACES the stored intent; otherwise the
  // stored one is carried forward untouched. There is no path here that clears
  // an override — a seller who wants this channel back on the shared price
  // needs a control that says so, and inferring it from a blank field would
  // silently reprice the listing (US-2736 note).
  const overrideToStore = typeof explicitPrice === "number" &&
      Number.isFinite(explicitPrice) && explicitPrice > 0
    ? explicitPrice
    : storedOverride;

  // US-564: map the shared draft onto this platform's requirements (title /
  // description clamped to its limits, condition/category/tags carried through)
  // instead of copying the eBay draft verbatim. US-2736: and onto its price
  // units — `mapped.listing_price` is the ONE number the row, the stored blob
  // and the adapter all get, so they cannot disagree about what this costs.
  const resolved = resolveSiblingPrice(platform, {
    explicitPrice,
    overridePrice: storedOverride,
    sharedPrice: price,
  });
  const mapped = mapSiblingListingFields(
    platform,
    {
      listing_title: draft.listing_title,
      listing_description: draft.listing_description,
    },
    resolved.price,
    variant,
    overrideToStore,
  );

  if (rowId) {
    const update: Record<string, unknown> = {
      listing_price: mapped.listing_price,
      listing_title: mapped.listing_title,
      listing_description: mapped.listing_description,
    };
    // Only overwrite platform_fields when we actually have a variant or an
    // override — never clobber a previously generated one with null, and MERGE
    // rather than replace so a price-only blob cannot erase the kit's words.
    const nextBlob = mergeSiblingBlob(
      existingRow?.platform_fields ?? null,
      platform,
      mapped.platform_fields?.[platform] ?? null,
    );
    if (nextBlob) update.platform_fields = nextBlob;
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
        listing_price: mapped.listing_price,
        listing_title: mapped.listing_title,
        listing_description: mapped.listing_description,
        platform_fields: mapped.platform_fields ?? undefined,
        primary_photo_id: draft.primary_photo_id,
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
        price: mapped.listing_price,
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
      price: mapped.listing_price,
    };
  }

  // US-3213: an extension channel is QUEUED, not published.
  //
  // Poshmark, Mercari, Grailed, Vinted and Facebook have no seller API we may
  // use, so their adapters are stubs that return 501. Cross-push therefore
  // created a local row, answered "publishing there ships soon", and stopped —
  // while `enqueueExtensionWork` sat one import away, already doing exactly this
  // job for the per-platform "Queue for my desktop" button on the listing kit.
  // The seller had to press one button to publish and then hunt for another,
  // per channel, to do the half the first button had quietly skipped.
  //
  // Nothing about the credential rule changes. The queue stores WHAT to do — a
  // platform and the seller's own ids — and the enqueue refuses any payload
  // carrying a password or session key. The marketplace session stays in the
  // seller's own browser, which is the entire reason this path exists instead
  // of a server-side login (adr-no-server-side-marketplace-automation).
  if (EXTENSION_DELIST_PLATFORMS.has(platform)) {
    // US-3367: do not queue what is already live or already waiting. The
    // sibling row was read above; the queue is asked here, scoped to the
    // tenant and to THIS row.
    const { data: pending } = await supabaseAdmin
      .from("extension_work_queue")
      .select("id")
      .eq("user_id", ownerId) // US-268
      .eq("listing_id", rowId)
      .eq("kind", "list")
      .in("status", ["queued", "claimed"])
      .limit(1)
      .maybeSingle();
    const skipped = planCrossPushSkip(
      existingRow
        ? {
          listing_status: existingRow.listing_status,
          listing_url: existingRow.listing_url,
          listed_unconfirmed: Boolean(existingRow.platform_fields?.listed_unconfirmed),
        }
        : null,
      Boolean(pending),
    );
    if (skipped) {
      return {
        result: { ok: true, listingUrl: existingRow?.listing_url ?? undefined },
        listingRowId: rowId,
        price: mapped.listing_price,
        queued: skipped === "already_queued",
        skipped,
      };
    }
    const enqueued = await enqueueExtensionWork(ownerId, {
      kind: "list",
      platform,
      inventory_item_id: draft.inventory_item_id,
      listing_id: rowId,
      payload: {},
      source: "cross_push",
    });
    if (!enqueued.ok) {
      return {
        result: {
          ok: false,
          status: enqueued.status,
          error: enqueued.error,
        },
        listingRowId: rowId,
        price: mapped.listing_price,
      };
    }
    return {
      result: { ok: true },
      listingRowId: rowId,
      price: mapped.listing_price,
      queued: true,
    };
  }

  const result = await adapter.publish({
    ownerId,
    inventoryItemId: draft.inventory_item_id,
    listingRowId: rowId,
    // US-2736: the SAME number the row records. An adapter handed the shared
    // price would put a figure on the marketplace that the listings row never
    // held, and the mismatch only surfaces as a payout that does not reconcile.
    price: mapped.listing_price,
  });
  return { result, listingRowId: rowId, price: mapped.listing_price };
}

/** This platform's slice of a sibling's `platform_fields`, or null. */
function readSiblingBlob(
  fields: Record<string, unknown> | null,
  platform: string,
): StoredPlatformVariant | null {
  const raw = fields?.[platform];
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as StoredPlatformVariant
    : null;
}

/**
 * Merge this platform's newly mapped blob over whatever the sibling already
 * held, dropping `undefined` values on the way in.
 *
 * The drop is load-bearing: `{ ...prior, title: undefined }` serializes to JSON
 * with NO title key, so spreading a price-only blob over a generated one would
 * delete the kit's words rather than leave them alone.
 */
function mergeSiblingBlob(
  existing: Record<string, unknown> | null,
  platform: string,
  next: StoredPlatformVariant | null,
): Record<string, unknown> | null {
  if (!next) return null;
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) defined[key] = value;
  }
  const prior = readSiblingBlob(existing, platform) ?? {};
  return { ...(existing ?? {}), [platform]: { ...prior, ...defined } };
}
