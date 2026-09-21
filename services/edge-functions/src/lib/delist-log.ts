// US-3452: the delist log. One ordered story per item of what a sale ended,
// where, when and by whom, built from columns that already exist.
//
// "Sold on eBay 14:02. Poshmark ended 14:06 (your browser). Mercari ended
// 14:07. Grailed: end it yourself." Auto-delist that does not fire is the
// loudest complaint in every crosslister thread, and the seller's only way to
// tell whether ours fired was to open each marketplace. This is the sentence
// that shows it working, and the same sentence support reads when a seller
// says it did not.
//
// PURE BUILDER + ONE LOADER. buildDelistLog takes the item's listings rows
// and its delist queue rows and returns events; loadDelistLog owner-checks
// the item and reads the two tables. No new column: every event is derived
// from listing_status, sold_at, delist_requested_at, the
// platform_fields.delist_unresolved marker (US-2165) and the queue's own
// timestamps.

import { supabaseAdmin } from "./supabase.ts";
import { delistMethodFor } from "./cross-listing-sale.ts";

export type DelistLogEventKind =
  | "sold"
  | "ended_api"
  | "ended_extension"
  | "ended_by_hand"
  | "queued"
  | "waiting"
  | "unresolved";

export type DelistLogActor = "server" | "browser" | "seller";

export interface DelistLogEvent {
  /** ISO time the event happened or the state began. */
  at: string;
  platform: string;
  listing_id: string | null;
  event: DelistLogEventKind;
  actor: DelistLogActor;
  /** The marketplace page when the row carries one, for the still-live rows. */
  url: string | null;
  /** A reason or error in the system's own words, when there is one. */
  note: string | null;
}

export interface DelistLogListingRow {
  id: string;
  platform: string;
  listing_status: string | null;
  listing_url: string | null;
  delist_requested_at: string | null;
  platform_fields: Record<string, unknown> | null;
  sold_at: string | null;
  updated_at: string | null;
}

export interface DelistLogJobRow {
  id: string;
  kind: string;
  platform: string;
  listing_id: string | null;
  status: string;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  result: { error?: string | null; manual?: boolean; unverified?: boolean } | null;
}

const PENDING_JOB = new Set(["queued", "claimed"]);
const DEAD_JOB = new Set(["failed", "expired"]);

function unresolvedMarker(row: DelistLogListingRow): { detected_at?: string; reason?: string } | null {
  const m = row.platform_fields?.delist_unresolved;
  return m && typeof m === "object" ? (m as { detected_at?: string; reason?: string }) : null;
}

function newest<T extends { created_at: string }>(items: T[]): T | null {
  return items.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

/**
 * The events for one item, oldest first. Pure.
 *
 * A job belongs to a row when it names the row's listing_id; a job with no
 * listing_id belongs to the row on its platform, which is how the queue was
 * written before listing ids rode on every delist (US-3141).
 */
export function buildDelistLog(
  rows: readonly DelistLogListingRow[],
  jobs: readonly DelistLogJobRow[],
): DelistLogEvent[] {
  const events: DelistLogEvent[] = [];
  const delists = jobs.filter((j) => j.kind === "delist");
  const sold = rows.find((r) => r.listing_status === "sold") ?? null;

  const jobsFor = (row: DelistLogListingRow) =>
    delists.filter((j) =>
      j.listing_id ? j.listing_id === row.id : j.platform === row.platform
    );

  for (const row of rows) {
    const base = { platform: row.platform, listing_id: row.id, url: row.listing_url, note: null };
    const method = delistMethodFor(row.platform);
    const isApi = method !== "extension" && method !== "unsupported";

    if (row.listing_status === "sold") {
      // Who recorded the sale is not stored. An API channel's sale arrives by
      // webhook or sync; anything else was recorded by the seller or read
      // from their own sales page, and "seller" is the honest word for both.
      events.push({
        ...base,
        at: row.sold_at ?? row.updated_at ?? "",
        event: "sold",
        actor: isApi ? "server" : "seller",
      });
      continue;
    }

    const mine = jobsFor(row);
    const done = newest(mine.filter((j) => j.status === "done"));
    const pending = newest(mine.filter((j) => PENDING_JOB.has(j.status)));
    const dead = newest(mine.filter((j) => DEAD_JOB.has(j.status)));
    const marker = unresolvedMarker(row);
    const stamped = Boolean(row.delist_requested_at);

    if (row.listing_status === "ended" && !stamped) {
      if (isApi) {
        events.push({ ...base, at: row.updated_at ?? "", event: "ended_api", actor: "server" });
      } else if (done) {
        events.push({
          ...base,
          at: done.completed_at ?? done.created_at,
          event: "ended_extension",
          actor: "browser",
          note: done.result?.unverified ? "The browser could not confirm the page changed." : null,
        });
      } else if (method === "unsupported" && marker) {
        events.push({
          ...base,
          at: marker.detected_at ?? row.updated_at ?? "",
          event: "unresolved",
          actor: "server",
          note: marker.reason ?? null,
        });
      } else {
        events.push({ ...base, at: row.updated_at ?? "", event: "ended_by_hand", actor: "seller" });
      }
      continue;
    }

    // Still live on the marketplace as far as FlipDesk knows: an active row, or
    // an ended row that still carries its delist stamp (US-3369 sets both in
    // one write, so the stamp is what says "not yet").
    if (row.listing_status === "active" || stamped) {
      if (pending) {
        events.push({
          ...base,
          at: pending.created_at,
          event: "queued",
          actor: "browser",
          note: pending.status === "claimed" ? "A browser has picked it up." : null,
        });
      } else if (dead) {
        events.push({
          ...base,
          at: dead.completed_at ?? dead.created_at,
          event: "unresolved",
          actor: "browser",
          note: dead.result?.error ?? (dead.status === "expired" ? "The job expired before a browser ran it." : null),
        });
      } else if (marker) {
        events.push({
          ...base,
          at: marker.detected_at ?? row.delist_requested_at ?? row.updated_at ?? "",
          event: "unresolved",
          actor: "server",
          note: marker.reason ?? null,
        });
      } else if (stamped) {
        events.push({ ...base, at: row.delist_requested_at!, event: "waiting", actor: "seller" });
      } else if (sold) {
        // Live, unstamped, and the garment is sold: nothing has asked for it
        // to end. That is still a listing waiting on the seller.
        events.push({
          ...base,
          at: sold.sold_at ?? sold.updated_at ?? row.updated_at ?? "",
          event: "waiting",
          actor: "seller",
          note: "Nothing has asked for this listing to end.",
        });
      }
    }
  }

  return events.sort((a, b) => a.at.localeCompare(b.at));
}

export type DelistLogLoad =
  | { ok: true; events: DelistLogEvent[] }
  | { ok: false; status: 404 | 500; error: string };

/**
 * The item's log, owner-checked first (US-268): a foreign or unknown item is
 * a 404, and neither read below ever runs for it.
 */
export async function loadDelistLog(ownerId: string, itemId: string): Promise<DelistLogLoad> {
  const { data: item, error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .select("id")
    .eq("id", itemId)
    .eq("user_id", ownerId) // US-268
    .maybeSingle();
  if (itemErr) return { ok: false, status: 500, error: itemErr.message };
  if (!item) return { ok: false, status: 404, error: "Item not found." };

  const [{ data: rows, error: rowsErr }, { data: jobs, error: jobsErr }] = await Promise.all([
    supabaseAdmin
      .from("listings")
      .select(
        "id, platform, listing_status, listing_url, delist_requested_at, platform_fields, sold_at, updated_at",
      )
      .eq("inventory_item_id", itemId),
    supabaseAdmin
      .from("extension_work_queue")
      .select("id, kind, platform, listing_id, status, created_at, claimed_at, completed_at, result")
      .eq("user_id", ownerId) // US-268
      .eq("inventory_item_id", itemId)
      .eq("kind", "delist"),
  ]);
  if (rowsErr) return { ok: false, status: 500, error: rowsErr.message };
  if (jobsErr) return { ok: false, status: 500, error: jobsErr.message };

  return {
    ok: true,
    events: buildDelistLog(
      (rows ?? []) as DelistLogListingRow[],
      (jobs ?? []) as DelistLogJobRow[],
    ),
  };
}
