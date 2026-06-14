import { supabaseAdmin } from "./supabase.ts";

// US-889: reusable cross-tenant moderation queue for listings + item_photos.
//
// The fraud console, user-report endpoints, and abuse scans all enqueue
// listings/photos here via `enqueueModerationFlag`; the admin moderation page
// drains the queue and takes audited, REVERSIBLE actions. The takedown helpers
// return both the mutating patch and its exact inverse so "every write path is
// logged and reversible" (AC5) is a property of the code, not a convention.

export type ModerationContentType = "listing" | "photo";
export type ModerationFlagStatus = "open" | "resolved" | "dismissed";

export interface ContentModerationFlagRow {
  id: string;
  content_type: ModerationContentType;
  content_id: string;
  owner_user_id: string | null;
  reason: string;
  source: string;
  status: ModerationFlagStatus;
  flagged_by: string | null;
  resolved_by: string | null;
  resolution_action: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueFlagInput {
  contentType: ModerationContentType;
  contentId: string;
  reason: string;
  /** 'fraud_console' | 'user_report' | 'abuse_scan' | 'manual' */
  source: string;
  /** The flagging actor (admin or reporting user); null for system scans. */
  flaggedBy?: string | null;
  /** Owning tenant; resolved automatically when omitted. */
  ownerUserId?: string | null;
}

// ── Ownership resolution (id -> owner) ─────────────────────────────────────
// Every write path resolves the owning tenant from the content id BEFORE
// mutating (CLAUDE.md US-268), even though the moderation reads are
// intentionally cross-tenant.

// listings carries a denormalized user_id (00146 set_listings_tenant trigger).
export async function resolveListingOwner(
  listingId: string,
): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("listings")
    .select("user_id")
    .eq("id", listingId)
    .maybeSingle();
  return (data as { user_id: string } | null)?.user_id ?? null;
}

// item_photos has no user_id — ownership flows through the parent inventory item.
export async function resolvePhotoOwner(
  photoId: string,
): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("item_photos")
    .select("inventory_item_id, inventory_items!inner(user_id)")
    .eq("id", photoId)
    .maybeSingle();
  // The embedded relation is typed as an array by the generated types.
  const inv = (data as
    | { inventory_items?: { user_id?: string } | { user_id?: string }[] }
    | null)?.inventory_items;
  const owner = Array.isArray(inv) ? inv[0]?.user_id : inv?.user_id;
  return owner ?? null;
}

export function resolveOwner(
  contentType: ModerationContentType,
  contentId: string,
): Promise<string | null> {
  return contentType === "listing"
    ? resolveListingOwner(contentId)
    : resolvePhotoOwner(contentId);
}

// ── Reversible takedown patches ────────────────────────────────────────────
// Each `*Patch` is paired with its `*RestorePatch` inverse. The route audits
// the prior row state as `before` and applies these as `after`; restore applies
// the inverse, so a takedown is always undoable.

export interface ListingTakedownState {
  is_active: boolean;
  listing_status: string;
  moderation_hidden: boolean;
}

export function listingTakedownPatch(): ListingTakedownState {
  return { is_active: false, listing_status: "ended", moderation_hidden: true };
}

export function listingRestorePatch(): ListingTakedownState {
  return { is_active: true, listing_status: "active", moderation_hidden: false };
}

export function photoHidePatch(): { is_hidden: boolean } {
  return { is_hidden: true };
}

export function photoRestorePatch(): { is_hidden: boolean } {
  return { is_hidden: false };
}

// ── Flag enqueue (reusable producer API) ───────────────────────────────────

export function flagDedupeKey(
  contentType: ModerationContentType,
  contentId: string,
): string {
  return `${contentType}:${contentId}`;
}

// Enqueue (or refresh) an OPEN moderation flag for a listing/photo. Idempotent:
// the partial unique index keeps a single open flag per content item, so a
// re-flag updates the existing open row's reason/source rather than duplicating.
// Returns the flag id, or null if the enqueue failed (logged, never throws — a
// flag problem must not break the caller's primary action).
export async function enqueueModerationFlag(
  input: EnqueueFlagInput,
): Promise<string | null> {
  try {
    const ownerUserId = input.ownerUserId === undefined
      ? await resolveOwner(input.contentType, input.contentId)
      : input.ownerUserId;

    // Upsert against the open-flag uniqueness: try update-in-place first, then
    // insert when there is no open flag yet.
    const { data: existing } = await supabaseAdmin
      .from("content_moderation_flags")
      .select("id")
      .eq("content_type", input.contentType)
      .eq("content_id", input.contentId)
      .eq("status", "open")
      .maybeSingle();

    if (existing) {
      const id = (existing as { id: string }).id;
      const { error } = await supabaseAdmin
        .from("content_moderation_flags")
        .update({
          reason: input.reason,
          source: input.source,
          owner_user_id: ownerUserId,
          flagged_by: input.flaggedBy ?? null,
        })
        .eq("id", id);
      if (error) throw new Error(error.message);
      return id;
    }

    const { data, error } = await supabaseAdmin
      .from("content_moderation_flags")
      .insert({
        content_type: input.contentType,
        content_id: input.contentId,
        owner_user_id: ownerUserId,
        reason: input.reason,
        source: input.source,
        flagged_by: input.flaggedBy ?? null,
      })
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as { id: string } | null)?.id ?? null;
  } catch (err) {
    console.error(
      `[moderation-queue] enqueue failed for ${input.contentType}:${input.contentId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// Mark the open flag (if any) for a content item resolved/dismissed once an
// operator acts on it, recording WHAT was done. Best-effort.
export async function closeFlagForContent(
  contentType: ModerationContentType,
  contentId: string,
  resolvedBy: string,
  resolutionAction: string,
  status: Exclude<ModerationFlagStatus, "open"> = "resolved",
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("content_moderation_flags")
    .update({
      status,
      resolved_by: resolvedBy,
      resolution_action: resolutionAction,
      resolved_at: new Date().toISOString(),
    })
    .eq("content_type", contentType)
    .eq("content_id", contentId)
    .eq("status", "open");
  if (error) {
    console.error(
      `[moderation-queue] close flag failed for ${contentType}:${contentId}:`,
      error.message,
    );
  }
}
