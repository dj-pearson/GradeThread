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
 * Stamp the effective unit onto every measurement block that lacks one.
 *
 * US-2963. `renderBlock` reads `block.unit ?? ctx.unit`, so a block with no unit
 * renders in WHATEVER unit the caller happened to pass. That was harmless while
 * the only caller was a browser carrying the seller's own preference, and stops
 * being harmless the moment a background job re-renders: the credentials cron
 * has no seller preference to pass, so a listing a centimetre seller published
 * would come back in inches, and the numbers a buyer is reading would change
 * because a badge needed refreshing.
 *
 * Stamping at the single write path makes every stored description
 * self-describing: any later render reproduces it regardless of who asked.
 * Blocks that already carry a unit are left alone, so an explicit choice wins.
 */
function stampUnit(blocks: DescriptionBlock[], unit: LengthUnit): DescriptionBlock[] {
  let changed = false;
  const out = blocks.map((b) => {
    if (b.key !== "measurements" || b.unit) return b;
    changed = true;
    return { ...b, unit };
  });
  return changed ? out : blocks;
}

export interface RenderedListing {
  listing: OwnedListing;
  blocks: DescriptionBlock[];
  description: string;
}

/**
 * Render a listing's description WITHOUT writing anything.
 *
 * The read half of `renderAndPersistDescription`, split out for US-2963: the
 * credentials cron has to see what a re-render would produce, decide whether to
 * push it to eBay, and only then persist. A job that wrote first would leave the
 * database ahead of the live listing whenever the push failed.
 *
 * Returns null when the listing is not owned by `ownerId`.
 */
export async function renderListingDescription(
  listingId: string,
  ownerId: string,
  blocks?: DescriptionBlock[],
  unit: LengthUnit = "in",
): Promise<RenderedListing | null> {
  const listing = await loadOwnedListing(listingId, ownerId);
  if (!listing) return null;

  const ctx = await buildRenderContext(listing, ownerId, unit);
  const next = stampUnit(blocks ?? blocksForListing(listing, ctx), unit);
  const description = renderDescription(next, ctx);
  return { listing, blocks: next, description };
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
  const rendered = await renderListingDescription(listingId, ownerId, blocks, unit);
  if (!rendered) return null;
  const { listing, blocks: next, description } = rendered;

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

// ─── US-2961: apply a snippet edit to the drafts that reference it ──

/**
 * The most drafts one "apply" pass will re-render.
 *
 * A cap rather than a page loop, because each listing here is a full render
 * with its own grade-report read, and a seller with two thousand drafts asking
 * for all of them inside one request would hold a connection open long past any
 * reasonable timeout. The response reports what was left, so the caller can say
 * so instead of quietly doing half the job.
 */
export const SNIPPET_APPLY_LIMIT = 200;

export interface SnippetApplyResult {
  /** Drafts re-rendered. */
  applied: number;
  /** Drafts that reference the snippet but only through an override. */
  skipped: number;
  /** True when more drafts matched than the cap allows in one pass. */
  truncated: boolean;
}

/**
 * Re-render every DRAFT listing whose blocks reference `snippetId`.
 *
 * DRAFTS ONLY, and that is the whole safety property. A published listing's
 * description is what a buyer is reading right now and what eBay holds; changing
 * it from a settings page — without the seller opening the listing, seeing the
 * preview and pushing a revise — would edit live copy as a side effect of
 * renaming a shipping line. So `listing_status = 'draft'` is a filter on the
 * query, not a check the caller can pass in.
 *
 * A block that carries its OWN text is an override, and a listing whose only
 * reference to this snippet is overridden renders identically either way. Those
 * are skipped rather than re-rendered: touching a listing to produce the same
 * bytes is pure risk, and the count is reported so nothing looks lost.
 *
 * Returns null when the snippet is not this owner's, which the caller turns into
 * a 404 — the same answer as a snippet that does not exist.
 */
export async function applySnippetToDrafts(
  snippetId: string,
  ownerId: string,
): Promise<SnippetApplyResult | null> {
  // Rule 1 of US-268 on the snippet itself. Without this an id from the URL
  // would decide which rows get rewritten, and a foreign id would report a
  // count that tells the caller how many drafts another tenant has.
  const { data: snippet } = await supabaseAdmin
    .from("listing_snippets")
    .select("id")
    .eq("id", snippetId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!snippet) return null;

  // Ownership via the parent item, the same `!inner` join every other read in
  // this module uses. `description_blocks` comes back so the reference check
  // happens here rather than as a jsonb containment filter: `cs.` on a jsonb
  // array of objects behaves differently across the PostgREST versions this
  // project runs (the local stack is newer than self-hosted prod), and a
  // containment filter that silently matches nothing would make "apply" report
  // success having done nothing at all.
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select("id, description_blocks, inventory_items!inner(user_id)")
    .eq("inventory_items.user_id", ownerId)
    .eq("listing_status", "draft")
    .not("description_blocks", "is", null)
    .limit(SNIPPET_APPLY_LIMIT + 1);
  if (error) return { applied: 0, skipped: 0, truncated: false };

  const rows = (data ?? []) as unknown as {
    id: string;
    description_blocks: DescriptionBlock[] | null;
  }[];

  let skipped = 0;
  const targets: string[] = [];
  for (const row of rows) {
    const blocks = row.description_blocks ?? [];
    const refs = blocks.filter((b) => b.key === "snippet" && b.ref === snippetId);
    if (refs.length === 0) continue;
    if (refs.every((b) => (b.text ?? "").trim().length > 0)) {
      skipped++;
      continue;
    }
    targets.push(row.id);
  }

  const truncated = targets.length > SNIPPET_APPLY_LIMIT;
  const batch = targets.slice(0, SNIPPET_APPLY_LIMIT);

  let applied = 0;
  for (const id of batch) {
    // Sequential, not Promise.all. Each render reads a grade report and writes a
    // row; two hundred of those at once is a connection-pool incident on the
    // self-hosted stack, and the seller is waiting on a settings dialog, not a
    // batch job.
    const result = await renderAndPersistDescription(id, ownerId);
    if (result) applied++;
  }

  return { applied, skipped, truncated };
}
