// US-2704: the snapshot funnel.
//
// Every eBay description or aspect write goes through this file. Not because it
// is tidy — because a missed door means the evidence pack cites a description
// that was never live, asserted under our signature, which is worse than having
// no evidence at all. There are eight doors (publishOffer,
// publishOfferByInventoryItemGroup, updateOfferFields, updateOfferPrice,
// createOrReplaceInventoryItem, the aspect gap-fill revise, the forced resync,
// and the credentials-refresh cron) and this repo has the scar for exactly this
// shape twice, in lib/pending-delists.ts and in the EXTENSION_DELIST_PLATFORMS
// drift. So the write lives here and a source guard fails the build if any of
// those functions reaches the wire without calling it.
//
// WHAT IT RECORDS, AND WHAT IT REFUSES TO. This is what GradeThread PUBLISHED.
// It is never labelled as what eBay DISPLAYED: a seller editing in Seller Hub
// changes eBay's copy and not ours, and GetMyeBaySelling returns no description,
// so we often cannot tell. Nothing here or downstream may upgrade the first
// claim into the second.
//
// EVERY WRITE IS BEST-EFFORT. A snapshot that fails must never fail the publish
// it was recording. A seller losing a listing to a bookkeeping error is a worse
// outcome than a gap in the evidence.

import type { SupabaseClient } from "@supabase/supabase-js";

const TABLE = "listing_publications";

/** What one write to eBay changed. Every field is optional on purpose. */
export interface PublicationContent {
  description?: string | null;
  aspects?: Record<string, string[]> | null;
  price?: number | null;
}

export interface RecordPublicationInput extends PublicationContent {
  /** The tenant. Never a request field — the caller's resolved owner. */
  ownerUserId: string;
  channel?: string;
  /** The eBay Inventory SKU the listing was published under (listings.inventory_sku). */
  sku?: string | null;
  /** The Sell API offer id (listings.platform_offer_id). */
  offerId?: string | null;
}

/** A stored row, reduced to the parts the collapse check compares. */
export interface StoredSnapshot {
  id: string;
  description: string | null;
  aspects: Record<string, string[]> | null;
  price: number | null;
}

/**
 * Aspect maps as a comparable string.
 *
 * Key order out of eBay is not stable and neither is the order within a value
 * list, so a raw JSON.stringify would report a revision on a re-push that
 * changed nothing — which is the duplicate row this collapse exists to avoid.
 * Sorting both levels makes "same aspects" mean same aspects.
 */
export function canonicalAspects(
  aspects: Record<string, string[]> | null | undefined,
): string {
  if (!aspects) return "";
  const keys = Object.keys(aspects).sort();
  return JSON.stringify(
    keys.map((k) => [k, [...(aspects[k] ?? [])].sort()]),
  );
}

/** Money compared to the cent, so 12.5 and 12.50 are one price and not two. */
function samePrice(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.round(a * 100) === Math.round(b * 100);
}

/**
 * Is this write saying anything the stored row does not already say?
 *
 * A field the write did not touch is NOT a difference. `updateOfferPrice` sends
 * a price and no description; treating the absent description as "changed to
 * null" would write a new row on every reprice and record a listing that lost
 * its text, which is false.
 */
export function isSameSnapshot(
  prev: StoredSnapshot,
  next: PublicationContent,
): boolean {
  if (next.description !== undefined && next.description !== prev.description) {
    return false;
  }
  if (
    next.aspects !== undefined &&
    canonicalAspects(next.aspects) !== canonicalAspects(prev.aspects)
  ) {
    return false;
  }
  if (next.price !== undefined && !samePrice(next.price, prev.price)) {
    return false;
  }
  return true;
}

/** Does this write carry any content at all, or is it only a confirmation? */
export function isConfirmationOnly(content: PublicationContent): boolean {
  return content.description === undefined &&
    content.aspects === undefined &&
    content.price === undefined;
}

/**
 * The row a new snapshot writes: the previous row's values for anything this
 * write did not touch.
 *
 * A snapshot is a statement about the WHOLE listing at a moment, so a reprice
 * that carried no description must not record a listing with no description.
 */
export function mergedRow(
  prev: StoredSnapshot | null,
  next: PublicationContent,
): { description: string | null; aspects: Record<string, string[]> | null; price: number | null } {
  return {
    description: next.description !== undefined
      ? next.description
      : (prev?.description ?? null),
    aspects: next.aspects !== undefined ? next.aspects : (prev?.aspects ?? null),
    price: next.price !== undefined ? next.price : (prev?.price ?? null),
  };
}

/** Resolve the listing this write is about, tenant-scoped. */
async function findListingId(
  supabase: SupabaseClient,
  input: RecordPublicationInput,
): Promise<string | null> {
  const channel = input.channel ?? "ebay";
  // The offer id is the stronger key: it identifies one live offer, while a SKU
  // can be reused across a withdrawn listing and its relist.
  for (
    const [column, value] of [
      ["platform_offer_id", input.offerId],
      ["inventory_sku", input.sku],
    ] as const
  ) {
    if (!value) continue;
    const { data } = await supabase
      .from("listings")
      .select("id")
      .eq("user_id", input.ownerUserId)
      .eq("platform", channel)
      .eq(column, value)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const id = (data as { id: string } | null)?.id;
    if (id) return id;
  }
  return null;
}

/**
 * Record one publish or revise.
 *
 * Returns what it did, so a test can tell a collapse from an insert without
 * reading the table: "inserted", "confirmed" (the text was unchanged, so the
 * existing row's window was extended), or "skipped" (no listing to attach it
 * to, or the write failed — never a throw).
 */
export async function recordPublication(
  supabase: SupabaseClient,
  input: RecordPublicationInput,
): Promise<"inserted" | "confirmed" | "skipped"> {
  try {
    if (!input.ownerUserId) return "skipped";
    const listingId = await findListingId(supabase, input);
    // A draft that has never been published has no listings row keyed by SKU or
    // offer id yet. Nothing to attach a snapshot to, and inventing a row would
    // be a snapshot of a listing that does not exist.
    if (!listingId) return "skipped";

    const channel = input.channel ?? "ebay";
    const { data: prevRow } = await supabase
      .from(TABLE)
      .select("id, description, aspects, price")
      .eq("listing_id", listingId)
      .eq("owner_user_id", input.ownerUserId)
      .order("published_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const prev = (prevRow as StoredSnapshot | null) ?? null;

    const nowIso = new Date().toISOString();

    // Unchanged text, or a publish call that carries no text of its own: extend
    // the existing row's window rather than writing a duplicate. That is the
    // stronger record — this exact text was live and confirmed from A through B.
    if (prev && (isConfirmationOnly(input) || isSameSnapshot(prev, input))) {
      const { error } = await supabase
        .from(TABLE)
        .update({ last_confirmed_at: nowIso })
        .eq("id", prev.id)
        .eq("owner_user_id", input.ownerUserId);
      if (error) {
        console.error("[publication] confirm failed:", error.message);
        return "skipped";
      }
      return "confirmed";
    }

    const merged = mergedRow(prev, input);
    const { error } = await supabase.from(TABLE).insert({
      listing_id: listingId,
      owner_user_id: input.ownerUserId,
      channel,
      description: merged.description,
      aspects: merged.aspects,
      price: merged.price,
      published_at: nowIso,
      last_confirmed_at: nowIso,
    });
    if (error) {
      console.error("[publication] insert failed:", error.message);
      return "skipped";
    }
    return "inserted";
  } catch (err) {
    // Best-effort by contract: the publish it was recording must not fail
    // because the bookkeeping did.
    console.error(
      "[publication] snapshot threw:",
      err instanceof Error ? err.message : String(err),
    );
    return "skipped";
  }
}
