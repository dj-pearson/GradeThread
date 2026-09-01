// US-9202 — the pending-revise queue for extension channels.
//
// An edit made in FlipDesk reaches eBay and Shopify through their APIs
// (updateListing) and, until now, reached nothing else: Poshmark, Mercari,
// Vinted and Grailed have no write API, so every cross-listed item went stale
// the first time it was repriced. This module is the queue that closes that
// gap, modelled on pending-delists: the server records WHAT needs re-applying
// on which listing, and the seller's own desktop browser (the extension) does
// the applying in a tab it opens on their behalf, then confirms back.
//
// THE MARKER. `listings.platform_fields.revise_pending` is the queue entry,
// the same jsonb-marker shape as delist_unresolved / sync_drift / oversell
// (lib/cross-listings.ts) so every surface that already reads markers can
// render this one. It holds which FIELDS changed and when the first one was
// queued; the values themselves are read off the listing row at apply time,
// so a second edit before the first was applied never sends a stale number.
//
// NEVER MARK APPLIED BEFORE THE MARKETPLACE CONFIRMS. The extension reports
// `applied: true` only with positive evidence (the editor saved and the page
// returned to the listing, or the marketplace's own confirmation); an
// unverified run keeps the marker, bumps `attempts`, and the row keeps reading
// "Stale on Poshmark since ...". A false "applied" is a price the seller
// believes is live and is not, which is the failure this whole story exists to
// end.
//
// TENANCY (US-268): every read is scoped through inventory_items.user_id,
// following pending-delists.ts; a listing id from a request body only ever
// reaches a write after that scope.

import { supabaseAdmin } from "./supabase.ts";
import { EXTENSION_DELIST_PLATFORMS } from "./cross-listing-sale.ts";

/** The listing fields an edit can make stale on an extension channel. */
export const REVISABLE_FIELDS = ["price", "title", "description", "photos"] as const;
export type RevisableField = (typeof REVISABLE_FIELDS)[number];

export function isRevisableField(v: unknown): v is RevisableField {
  return typeof v === "string" && (REVISABLE_FIELDS as readonly string[]).includes(v);
}

/** Where a revise came from, for the row and the popup. */
export const REVISE_SOURCES = ["edit", "bulk_price", "automation", "mobile"] as const;
export type ReviseSource = (typeof REVISE_SOURCES)[number];

/**
 * Platforms whose listings can go stale. DERIVED from the delist set, for the
 * reason pending-delists.ts explains at length: a second hand-written list of
 * "the extension channels" is how Vinted silently dropped out of a queue once.
 */
export const EXTENSION_REVISE_PLATFORMS: readonly string[] = [...EXTENSION_DELIST_PLATFORMS];

export function isExtensionRevisePlatform(platform: string | null | undefined): boolean {
  return typeof platform === "string" && EXTENSION_REVISE_PLATFORMS.includes(platform);
}

/** After this many failed applies the queue stops retrying by itself. */
export const REVISE_MAX_ATTEMPTS = 5;

export interface RevisePendingMarker {
  fields: RevisableField[];
  queued_at: string;
  source: ReviseSource;
  attempts: number;
  last_attempt_at?: string;
  last_error?: string;
}

function readMarker(pf: Record<string, unknown> | null | undefined): RevisePendingMarker | null {
  const raw = pf?.revise_pending;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const fields = Array.isArray(m.fields) ? m.fields.filter(isRevisableField) : [];
  if (fields.length === 0 || typeof m.queued_at !== "string") return null;
  return {
    fields,
    queued_at: m.queued_at,
    source: (REVISE_SOURCES as readonly string[]).includes(String(m.source))
      ? (m.source as ReviseSource)
      : "edit",
    attempts: typeof m.attempts === "number" && m.attempts >= 0 ? Math.floor(m.attempts) : 0,
    last_attempt_at: typeof m.last_attempt_at === "string" ? m.last_attempt_at : undefined,
    last_error: typeof m.last_error === "string" ? m.last_error : undefined,
  };
}

// ── The state machine, pure ────────────────────────────────────────────────

/**
 * Queue (or re-queue) fields on a marker.
 *
 * A second edit before the first applied MERGES: the field set is the union,
 * `queued_at` stays at the FIRST edit (that is the date the listing has been
 * stale since, which is what the row shows), and the attempt count is kept so
 * a channel that keeps failing is not quietly reset to "fresh" by every new
 * edit. A previous error is dropped: the next apply is a new attempt at new
 * values.
 */
export function planReviseStamp(
  existing: RevisePendingMarker | null,
  fields: readonly RevisableField[],
  nowIso: string,
  source: ReviseSource,
): RevisePendingMarker {
  const wanted = fields.filter(isRevisableField);
  if (!existing) {
    return { fields: [...new Set(wanted)], queued_at: nowIso, source, attempts: 0 };
  }
  const merged = [...new Set([...existing.fields, ...wanted])];
  return {
    fields: merged,
    queued_at: existing.queued_at,
    // The first source keeps naming the marker; a bulk drop on top of a manual
    // edit is still "since the edit".
    source: existing.source,
    attempts: existing.attempts,
    last_attempt_at: existing.last_attempt_at,
  };
}

export interface ReviseOutcome {
  /** The extension saw the marketplace take the change. */
  applied: boolean;
  /** The extension could not run the flow; the seller must edit by hand. */
  manual?: boolean;
  /** The extension clicked save but could not prove it took. */
  unverified?: boolean;
  error?: string | null;
}

/**
 * What a reported outcome does to the marker.
 *
 * Only a positive `applied` clears it. Everything else keeps the listing
 * stale, records the attempt, and leaves the row telling the truth: the
 * marketplace has not confirmed, so nothing here may say it has.
 */
export function applyReviseOutcome(
  marker: RevisePendingMarker,
  outcome: ReviseOutcome,
  nowIso: string,
): { cleared: true } | { cleared: false; marker: RevisePendingMarker } {
  if (outcome.applied === true) return { cleared: true };
  const error = typeof outcome.error === "string" && outcome.error.trim()
    ? outcome.error.trim().slice(0, 300)
    : outcome.unverified
    ? "The extension saved the edit but could not confirm the marketplace took it."
    : outcome.manual
    ? "The extension could not apply this edit; edit the listing by hand."
    : "The edit was not applied.";
  return {
    cleared: false,
    marker: {
      ...marker,
      attempts: marker.attempts + 1,
      last_attempt_at: nowIso,
      last_error: error,
    },
  };
}

/**
 * May the extension try this row on its own (the background drain), or must a
 * person press the button? Auto-revisable needs a confirmed-live listing with
 * a URL to open, exactly like auto-delistable, and an attempt budget left; a
 * row past the budget stays visible as stale but stops being retried until the
 * seller re-queues it by editing again or presses Apply.
 */
export function isAutoRevisable(
  listingStatus: string | null,
  listingUrl: string | null,
  marker: RevisePendingMarker,
): boolean {
  return listingStatus === "active" && !!listingUrl && marker.attempts < REVISE_MAX_ATTEMPTS;
}

// ── IO ─────────────────────────────────────────────────────────────────────

interface StampRow {
  id: string;
  platform: string;
  listing_status: string | null;
  listing_url: string | null;
  platform_fields: Record<string, unknown> | null;
}

/**
 * Stamp one loaded listing row. The row must ALREADY be owner-scoped by the
 * caller; this writes by id and does not re-check, which is why it is not
 * exported.
 */
async function stampRow(
  row: StampRow,
  fields: readonly RevisableField[],
  source: ReviseSource,
  nowIso: string,
): Promise<boolean> {
  const pf = (row.platform_fields ?? {}) as Record<string, unknown>;
  const next = planReviseStamp(readMarker(pf), fields, nowIso, source);
  const { error } = await supabaseAdmin
    .from("listings")
    .update({ platform_fields: { ...pf, revise_pending: next } })
    .eq("id", row.id);
  if (error) {
    console.error("[pending-revises] stamp failed:", error.message);
    return false;
  }
  return true;
}

/**
 * Queue a revise on every LIVE extension-channel listing of one item.
 *
 * Returns the platforms queued. An item with no extension listing queues
 * nothing and returns [], which is the ordinary case and not an error. Drafts
 * are skipped: a draft the extension never saw go live has nothing on the
 * marketplace to bring up to date.
 */
export async function queueRevisesForItem(
  ownerId: string,
  inventoryItemId: string,
  fields: readonly RevisableField[],
  source: ReviseSource,
): Promise<{ platforms: string[]; listingIds: string[] }> {
  const wanted = fields.filter(isRevisableField);
  if (wanted.length === 0) return { platforms: [], listingIds: [] };
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select(
      "id, platform, listing_status, listing_url, platform_fields, inventory_items!inner(user_id)",
    )
    .eq("inventory_item_id", inventoryItemId)
    .eq("inventory_items.user_id", ownerId)
    .eq("listing_status", "active")
    .in("platform", [...EXTENSION_REVISE_PLATFORMS]);
  if (error) {
    console.error("[pending-revises] item listings read failed:", error.message);
    return { platforms: [], listingIds: [] };
  }
  const nowIso = new Date().toISOString();
  const platforms: string[] = [];
  const listingIds: string[] = [];
  for (const row of (data ?? []) as unknown as StampRow[]) {
    if (await stampRow(row, wanted, source, nowIso)) {
      platforms.push(row.platform);
      listingIds.push(row.id);
    }
  }
  return { platforms, listingIds };
}

/**
 * Queue a revise on ONE listing the caller has already loaded and owner-checked
 * (the price paths hold an OwnedListingRow, which carries no platform_fields,
 * so the marker is re-read here). Nothing is written unless the platform is an
 * extension channel.
 */
export async function queueReviseForListing(
  row: { id: string; platform: string | null },
  fields: readonly RevisableField[],
  source: ReviseSource,
): Promise<boolean> {
  if (!isExtensionRevisePlatform(row.platform)) return false;
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select("id, platform, listing_status, listing_url, platform_fields")
    .eq("id", row.id)
    .maybeSingle();
  if (error || !data) {
    console.error("[pending-revises] listing re-read failed:", error?.message ?? "no row");
    return false;
  }
  return stampRow(data as unknown as StampRow, fields, source, new Date().toISOString());
}

export interface PendingRevise {
  listing_id: string;
  platform: string;
  listing_url: string | null;
  listing_status: string | null;
  fields: RevisableField[];
  queued_at: string;
  source: ReviseSource;
  attempts: number;
  last_error: string | null;
  auto_revisable: boolean;
  item_id: string;
  item_title: string | null;
  /** The CURRENT values, which are what the extension writes. */
  listing_title: string | null;
  listing_description: string | null;
  listing_price: number | null;
  photo_count: number;
}

interface PendingRow {
  id: string;
  platform: string;
  listing_url: string | null;
  listing_status: string | null;
  listing_title: string | null;
  listing_description: string | null;
  listing_price: number | null;
  platform_fields: Record<string, unknown> | null;
  inventory_item_id: string;
  inventory_items: { user_id: string; item_title: string | null };
}

/**
 * The owner's pending revises, oldest first. `ownerId` MUST come from a
 * verified token or the workspace middleware, never from the request.
 *
 * Filtered in code rather than with a jsonb operator: a marker is a small
 * object on a column the row already carries, the tenant's extension listings
 * are a bounded set, and the read stays one query the two auth doors share.
 */
export async function loadPendingRevises(
  ownerId: string,
  opts: { limit?: number } = {},
): Promise<{ pending: PendingRevise[]; error: unknown | null }> {
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select(
      "id, platform, listing_url, listing_status, listing_title, listing_description, listing_price, " +
        "platform_fields, inventory_item_id, inventory_items!inner(user_id, item_title:title)",
    )
    .eq("inventory_items.user_id", ownerId)
    .in("platform", [...EXTENSION_REVISE_PLATFORMS])
    .not("platform_fields", "is", null);
  if (error) return { pending: [], error };

  const rows = (data ?? []) as unknown as PendingRow[];
  const pending: PendingRevise[] = [];
  for (const r of rows) {
    const marker = readMarker(r.platform_fields);
    if (!marker) continue;
    pending.push({
      listing_id: r.id,
      platform: r.platform,
      listing_url: r.listing_url,
      listing_status: r.listing_status,
      fields: marker.fields,
      queued_at: marker.queued_at,
      source: marker.source,
      attempts: marker.attempts,
      last_error: marker.last_error ?? null,
      auto_revisable: isAutoRevisable(r.listing_status, r.listing_url, marker),
      item_id: r.inventory_item_id,
      item_title: r.inventory_items.item_title,
      listing_title: r.listing_title,
      listing_description: r.listing_description,
      listing_price: r.listing_price,
      photo_count: 0,
    });
  }
  pending.sort((a, b) => a.queued_at.localeCompare(b.queued_at));
  const limited = opts.limit ? pending.slice(0, opts.limit) : pending;

  // Photo counts only for rows whose photos went stale, so the extension knows
  // how many to expect; one query for the lot.
  const photoItems = [...new Set(limited.filter((p) => p.fields.includes("photos")).map((p) => p.item_id))];
  if (photoItems.length > 0) {
    const { data: photos } = await supabaseAdmin
      .from("item_photos")
      .select("inventory_item_id")
      .in("inventory_item_id", photoItems);
    const counts = new Map<string, number>();
    for (const p of (photos ?? []) as Array<{ inventory_item_id: string }>) {
      counts.set(p.inventory_item_id, (counts.get(p.inventory_item_id) ?? 0) + 1);
    }
    for (const p of limited) p.photo_count = counts.get(p.item_id) ?? 0;
  }
  return { pending: limited, error: null };
}

/**
 * Record what the extension reported for one listing. Owner-scoped through the
 * parent item; a foreign listing id is a 404, never a write.
 */
export async function confirmRevise(
  ownerId: string,
  listingId: string,
  outcome: ReviseOutcome,
): Promise<{ ok: true; cleared: boolean; attempts: number } | { ok: false; status: 404 | 500; error: string }> {
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select("id, platform_fields, inventory_items!inner(user_id)")
    .eq("id", listingId)
    .eq("inventory_items.user_id", ownerId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: "Could not load the listing." };
  const row = data as unknown as {
    id: string;
    platform_fields: Record<string, unknown> | null;
    inventory_items: { user_id: string };
  } | null;
  if (!row || row.inventory_items.user_id !== ownerId) {
    return { ok: false, status: 404, error: "Listing not found." };
  }
  const pf = (row.platform_fields ?? {}) as Record<string, unknown>;
  const marker = readMarker(pf);
  // Nothing pending: an applied report is a no-op success (a second confirm
  // for the same run), and a failure report has nothing to record against.
  if (!marker) return { ok: true, cleared: true, attempts: 0 };

  const next = applyReviseOutcome(marker, outcome, new Date().toISOString());
  const nextPf: Record<string, unknown> = { ...pf };
  if (next.cleared) delete nextPf.revise_pending;
  else nextPf.revise_pending = next.marker;
  const { error: upErr } = await supabaseAdmin
    .from("listings")
    .update({ platform_fields: nextPf })
    .eq("id", row.id);
  if (upErr) return { ok: false, status: 500, error: "Could not record the outcome." };
  return {
    ok: true,
    cleared: next.cleared,
    attempts: next.cleared ? 0 : next.marker.attempts,
  };
}
