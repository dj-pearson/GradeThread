// US-2958: the ONE place a listing description is written.
//
// description-blocks.ts is pure and knows how to render. This module is the
// impure half: it loads the item, the grade report, the seller credential and
// the seller's snippets, hands them to the renderer, and writes the result.
//
// WHY ONE FUNCTION AND NOT FIVE. Before this, five separate places assembled a
// description — AutoLister generation, the composer save, the item page's
// measurement save, the credentials-refresh cron, and cross-listing. Each
// concatenated strings in its own order, and the only thing keeping them
// agreeing was that nobody had edited one of them lately. `description_blocks`
// and `listing_description` are written in a SINGLE update here, so the two
// columns cannot disagree: there is no window in which one has landed and the
// other has not, and no second caller that writes only the string.
//
// TENANT SAFETY (US-268). The service-role client bypasses RLS, so every load
// here is scoped. Ownership of a listing runs through `inventory_items.user_id`
// via an `!inner` join, which is the `loadListingOwned` pattern the rest of
// flipdesk uses — `listings` carries a `user_id` of its own, but the item is
// the row that actually owns the garment, and scoping on both would be two
// truths where the code needs one.

import { supabaseAdmin } from "./supabase.ts";
import {
  type DescriptionBlock,
  defaultBlocks,
  parseLegacyDescription,
  renderDescription,
  type RenderContext,
} from "./description-blocks.ts";
import { loadSellerCredential } from "./seller-credentials-job.ts";
import { factorScoresToFacts } from "./listing-facts-block.ts";
import type { LengthUnit } from "./measurements.ts";
import { hasCalibratedMeasurements } from "./measurements.ts";
import type { DisclosureInput, PerImageAnalysisLike } from "./disclosure.ts";

/** A listing plus the item that owns it, loaded together and tenant-scoped. */
export interface OwnedListing {
  id: string;
  inventory_item_id: string;
  listing_description: string | null;
  description_blocks: DescriptionBlock[] | null;
  ebay_condition_description: string | null;
  /** On inventory_items, not on listings — the garment is what carries a grade. */
  grade_report_id: string | null;
  item: {
    id: string;
    brand: string | null;
    size: string | null;
    color: string | null;
    material: string | null;
    style: string | null;
    measurements: Record<string, unknown> | null;
    ai_field_sources: Record<string, unknown> | null;
  };
}

const LISTING_COLUMNS =
  "id, inventory_item_id, listing_description, description_blocks, ebay_condition_description, " +
  "inventory_items!inner(id, user_id, brand, size, color, material, style, measurements, ai_field_sources, grade_report_id)";

/**
 * Load a listing this workspace owns, or null.
 *
 * Null covers both "no such listing" and "someone else's listing" ON PURPOSE:
 * distinguishing them in the response would confirm the existence of another
 * tenant's row to whoever guessed the id.
 */
export async function loadOwnedListing(
  listingId: string,
  ownerId: string,
): Promise<OwnedListing | null> {
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select(LISTING_COLUMNS)
    .eq("id", listingId)
    .eq("inventory_items.user_id", ownerId)
    .maybeSingle();
  if (error || !data) return null;

  const row = data as unknown as {
    id: string;
    inventory_item_id: string;
    listing_description: string | null;
    description_blocks: DescriptionBlock[] | null;
    ebay_condition_description: string | null;
    inventory_items: {
      id: string;
      grade_report_id: string | null;
      brand: string | null;
      size: string | null;
      color: string | null;
      material: string | null;
      style: string | null;
      measurements: Record<string, unknown> | null;
      ai_field_sources: Record<string, unknown> | null;
    };
  };

  return {
    id: row.id,
    inventory_item_id: row.inventory_item_id,
    listing_description: row.listing_description,
    description_blocks: row.description_blocks,
    ebay_condition_description: row.ebay_condition_description,
    grade_report_id: row.inventory_items.grade_report_id,
    item: {
      id: row.inventory_items.id,
      brand: row.inventory_items.brand,
      size: row.inventory_items.size,
      color: row.inventory_items.color,
      material: row.inventory_items.material,
      style: row.inventory_items.style,
      measurements: row.inventory_items.measurements,
      ai_field_sources: row.inventory_items.ai_field_sources,
    },
  };
}

/** The seller's snippets as the renderer wants them: id -> body. */
export async function loadSnippets(
  ownerId: string,
): Promise<Record<string, string>> {
  const { data } = await supabaseAdmin
    .from("listing_snippets")
    .select("id, body")
    .eq("user_id", ownerId);
  const out: Record<string, string> = {};
  for (const row of (data ?? []) as { id: string; body: string }[]) {
    out[row.id] = row.body;
  }
  return out;
}

/**
 * Everything the renderer needs, loaded for one listing.
 *
 * The grade report is read through `inventory_items.grade_report_id` — the
 * garment carries the grade, not the listing. That id arrives already
 * ownership-verified, because the only way to get an `OwnedListing` is through
 * `loadOwnedListing`, whose join is filtered on the owner. Reaching a report
 * only via a row this workspace owns is rule 2 of US-268.
 */
export async function buildRenderContext(
  listing: OwnedListing,
  ownerId: string,
  unit: LengthUnit = "in",
): Promise<RenderContext> {
  const [credential, snippets] = await Promise.all([
    loadSellerCredential(ownerId),
    loadSnippets(ownerId),
  ]);

  let grade: RenderContext["grade"] = null;
  if (listing.grade_report_id) {
    const { data } = await supabaseAdmin
      .from("grade_reports")
      .select(
        "overall_score, grade_tier, defects_found, detected_style_attributes, per_image_analysis, detailed_notes, certificate_id, " +
          "fabric_condition_score, structural_integrity_score, cosmetic_appearance_score, functional_elements_score, odor_cleanliness_score",
      )
      .eq("id", listing.grade_report_id)
      .maybeSingle();
    if (data) {
      const r = data as unknown as Record<string, unknown>;
      const score = Number(r.overall_score);
      const disclosure: DisclosureInput = {
        overall_score: Number(r.overall_score ?? 0),
        grade_tier: String(r.grade_tier ?? ""),
        defects_found: Array.isArray(r.defects_found)
          ? (r.defects_found as DisclosureInput["defects_found"])
          : [],
        detected_style_attributes: Array.isArray(r.detected_style_attributes)
          ? (r.detected_style_attributes as DisclosureInput["detected_style_attributes"])
          : [],
        per_image_analysis: Array.isArray(r.per_image_analysis)
          ? (r.per_image_analysis as PerImageAnalysisLike[])
          : [],
        certificate_id: (r.certificate_id as string | null) ?? null,
        legacy_defects_summary:
          (r.detailed_notes as Record<string, string> | null)?.defects_summary ?? null,
      };
      grade = {
        overall_score: Number.isFinite(score) ? score : null,
        factors: factorScoresToFacts(r),
        disclosure,
      };
    }
  }

  return {
    item: listing.item,
    grade,
    credential,
    snippets,
    unit,
    calibrated: hasCalibratedMeasurements(listing.item.ai_field_sources),
    conditionDescription: listing.ebay_condition_description,
  };
}

/**
 * The blocks for a listing, converting a legacy description on the way if this
 * listing has none yet.
 *
 * READ ONLY. A conversion is returned, never written: the seller's first save
 * is what persists it, so merely OPENING a live listing cannot change what a
 * buyer sees. That is also why the reconciling form of `parseLegacyDescription`
 * is used — a derived block that would not reproduce the stored bytes comes
 * back as verbatim text instead.
 */
export function blocksForListing(
  listing: OwnedListing,
  ctx: RenderContext,
): DescriptionBlock[] {
  if (listing.description_blocks?.length) return listing.description_blocks;
  if (listing.listing_description?.trim()) {
    return parseLegacyDescription(listing.listing_description, ctx);
  }
  return defaultBlocks();
}

export interface PersistResult {
  blocks: DescriptionBlock[];
  description: string;
}

/**
 * Render `blocks` for a listing and write BOTH columns in one update.
 *
 * One statement, deliberately. Two updates would leave a window where
 * `description_blocks` says one thing and `listing_description` says another,
 * and the string is what gets published — so that window is a window in which
 * eBay could receive a description nothing in the database claims to have
 * produced.
 *
 * Returns null when the listing is not owned by `ownerId`, which callers turn
 * into a 404.
 */
export async function renderAndPersistDescription(
  listingId: string,
  ownerId: string,
  blocks?: DescriptionBlock[],
  unit: LengthUnit = "in",
): Promise<PersistResult | null> {
  const listing = await loadOwnedListing(listingId, ownerId);
  if (!listing) return null;

  const ctx = await buildRenderContext(listing, ownerId, unit);
  const next = blocks ?? blocksForListing(listing, ctx);
  const description = renderDescription(next, ctx);

  const { error } = await supabaseAdmin
    .from("listings")
    .update({
      description_blocks: next,
      listing_description: description,
    } as never)
    .eq("id", listingId)
    // Belt and braces: the ownership check above already passed, and this makes
    // the WRITE itself unable to touch another tenant's row even if a future
    // edit moves the load.
    .eq("inventory_item_id", listing.inventory_item_id);
  if (error) return null;

  return { blocks: next, description };
}
