// US-1864: the IMPURE half of Thrift Radar's personal layer — the visit insert
// and the four reads that "my best stores" is folded from.
//
// The arithmetic lives in `radar-personal.ts` and is tested without a database.
// What lives here is the trip to Postgres, and one rule it exists to hold:
//
//   EVERY READ IS TENANT-SCOPED, EXPLICITLY (US-268). The edge talks to Supabase
//   with the service-role client, which bypasses RLS, so the `.eq("user_id", …)`
//   on each of the three owner-scoped reads is the ONLY thing separating one
//   reseller's sourcing history from another's. The fourth read (radar_venues)
//   is deliberately NOT tenant-scoped, because a venue belongs to the map rather
//   than to an account — it is constrained instead by `.in("id", …)` over ids
//   this tenant's OWN rows already contain, so it can only ever name a place the
//   caller has themselves scanned at or linked.
//
// Note what the venue read is not: a way around the k-anonymity floor. It
// returns a display name and a chain tag for places the caller has stood in, and
// no aggregate, count or rate. The floor governs what the SHARED numbers say
// about a place (rule 6); it was never a claim that a place's name is a secret
// from the person who walked into it.

import { supabaseAdmin } from "./supabase.ts";
import { captureException } from "./observability.ts";
import {
  buildPersonalScanRow,
  buildPersonalStores,
  DEFAULT_PERSONAL_STORE_SORT,
  type PersonalItemFact,
  type PersonalScanFact,
  type PersonalScanRowInput,
  type PersonalSourceSeed,
  type PersonalStoreSort,
  type PersonalStoresResult,
  type PersonalVenueSeed,
  sortPersonalStores,
} from "./radar-personal.ts";

/**
 * Read caps. A reseller with 40k items must get a bounded query rather than a
 * timeout, and the personal ranking is stable long before the cap: these are the
 * newest rows, so the cap costs the oldest history rather than a random slice.
 */
const ITEM_SCAN_CAP = 20_000;
const VISIT_SCAN_CAP = 20_000;
const SOURCE_CAP = 2_000;

const ITEM_COLUMNS =
  "source_id, brand, purchase_price, purchase_date, list_price, target_price, " +
  "net_profit, sale_price, sale_status, sale_date";

/**
 * Record one visit in the reseller's own history.
 *
 * Never throws. A failed personal write is a gap in a private history, which is
 * not something the reseller standing in the aisle should ever feel (rule 8
 * applies here for the same reason it applies to a contribution).
 */
export async function insertPersonalScan(
  input: PersonalScanRowInput,
): Promise<boolean> {
  const row = buildPersonalScanRow(input);
  if (!row) return false;
  const { error } = await supabaseAdmin
    .from("radar_personal_scans")
    .insert(row as never);
  if (error) {
    captureException(error, { level: "warn", route: "radar.personal.insert" });
    return false;
  }
  return true;
}

export interface PersonalStoresPayload extends PersonalStoresResult {
  sort: PersonalStoreSort;
  /** True when a read hit its cap, so the caller can say so rather than imply completeness. */
  truncated: boolean;
}

/**
 * Load and fold one tenant's stores.
 *
 * Three owner-scoped reads run together; the venue read has to wait because its
 * id set is derived from two of them. `items_full` is the canonical
 * item + latest-listing + sale join (00009 onward), so the money here is the same
 * money every other FlipDesk surface shows — deriving it from the base tables
 * again would be a second definition of profit.
 */
export async function loadPersonalStores(
  userId: string,
  sort: PersonalStoreSort = DEFAULT_PERSONAL_STORE_SORT,
): Promise<PersonalStoresPayload> {
  const [sourceRes, itemRes, scanRes] = await Promise.all([
    supabaseAdmin
      .from("sources")
      .select("id, name, source_type, location, radar_venue_id")
      .eq("user_id", userId)
      .limit(SOURCE_CAP),
    supabaseAdmin
      .from("items_full")
      .select(ITEM_COLUMNS)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(ITEM_SCAN_CAP),
    supabaseAdmin
      .from("radar_personal_scans")
      .select("venue_id, brand, verdict, scanned_at")
      .eq("user_id", userId)
      .order("scanned_at", { ascending: false })
      .limit(VISIT_SCAN_CAP),
  ]);

  if (sourceRes.error) throw new Error(sourceRes.error.message);
  if (itemRes.error) throw new Error(itemRes.error.message);
  if (scanRes.error) throw new Error(scanRes.error.message);

  const sources = (sourceRes.data ?? []) as unknown as PersonalSourceSeed[];
  const items = (itemRes.data ?? []) as unknown as PersonalItemFact[];
  const scans = (scanRes.data ?? []) as unknown as PersonalScanFact[];

  const venueIds = new Set<string>();
  for (const s of sources) if (s.radar_venue_id) venueIds.add(s.radar_venue_id);
  for (const s of scans) if (s.venue_id) venueIds.add(s.venue_id);

  let venues: PersonalVenueSeed[] = [];
  if (venueIds.size > 0) {
    const { data, error } = await supabaseAdmin
      .from("radar_venues")
      // US-1865 adds lat/lng so these places can be drawn on the Radar map.
      // Still not a way around the k-floor: this is where the SHOP is, for shops
      // the caller has personally stood in, and carries no counts at all.
      .select("id, display_name, chain, lat, lng")
      .in("id", [...venueIds])
      .neq("status", "merged");
    if (error) throw new Error(error.message);
    venues = (data ?? []) as unknown as PersonalVenueSeed[];
  }

  const folded = buildPersonalStores({ sources, venues, items, scans });
  return {
    ...folded,
    stores: sortPersonalStores(folded.stores, sort),
    sort,
    truncated: items.length >= ITEM_SCAN_CAP || scans.length >= VISIT_SCAN_CAP,
  };
}

export type LinkOutcome =
  | { ok: true; venue_id: string | null }
  | { ok: false; reason: "unknown_source" | "unknown_venue" | "failed" };

/**
 * Point a reseller's own source at a shared Radar venue, or clear the link.
 *
 * Ownership is confirmed BEFORE the write and the write repeats the tenant
 * predicate — never `.eq("id", sourceId)` alone off a request-body id (US-268).
 * The venue check is separate and returns its own reason: "that isn't my store"
 * and "that place isn't on the map" are different problems for the caller to
 * fix, and collapsing them would make the UI guess.
 */
export async function linkSourceToVenue(
  userId: string,
  sourceId: string,
  venueId: string | null,
): Promise<LinkOutcome> {
  const owned = await supabaseAdmin
    .from("sources")
    .select("id")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (owned.error) {
    captureException(owned.error, { level: "warn", route: "radar.personal.link" });
    return { ok: false, reason: "failed" };
  }
  if (!owned.data) return { ok: false, reason: "unknown_source" };

  let resolved: string | null = null;
  if (venueId) {
    const venue = await supabaseAdmin
      .from("radar_venues")
      .select("id, status, merged_into_id")
      .eq("id", venueId)
      .maybeSingle();
    if (venue.error) {
      captureException(venue.error, { level: "warn", route: "radar.personal.link" });
      return { ok: false, reason: "failed" };
    }
    const row = venue.data as
      | { id: string; status: string; merged_into_id: string | null }
      | null;
    if (!row) return { ok: false, reason: "unknown_venue" };
    // A tombstoned loser keeps its row so an already-handed-out id cannot dangle
    // (US-1862). Follow it to the survivor rather than refusing: the reseller
    // linked the shop they were standing in, and a merge is our bookkeeping.
    resolved = row.status === "merged" ? row.merged_into_id : row.id;
    if (!resolved) return { ok: false, reason: "unknown_venue" };
  }

  const { error } = await supabaseAdmin
    .from("sources")
    .update({ radar_venue_id: resolved } as never)
    .eq("id", sourceId)
    .eq("user_id", userId);
  if (error) {
    captureException(error, { level: "warn", route: "radar.personal.link" });
    return { ok: false, reason: "failed" };
  }
  return { ok: true, venue_id: resolved };
}
