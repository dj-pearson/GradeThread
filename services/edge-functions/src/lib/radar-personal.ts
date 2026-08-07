// US-1864: the PURE half of Thrift Radar's personal layer — how a reseller's own
// stores are scored, ranked and described.
//
// Same split as US-1861/1862 and for the same reason: nothing here touches
// Supabase or the environment, so the arithmetic that decides "your best store"
// is unit-testable directly rather than only through a route. The impure half
// (the four reads, the insert) lives in `radar-personal-history.ts`.
//
// This is the COLD-START answer (rule 7 in vault/20-domain/thrift-radar.md). It
// must be useful at n=1 with no network data anywhere, which shapes every
// decision below:
//
//   • The spine is the reseller's OWN `sources` rows joined to their items and
//     sales. Those exist from day one and need no consent, no venue and no
//     stranger. Scans are an ENRICHMENT — they add visits and a last-seen date
//     to a store that already has money in it.
//   • A venue the reseller has scanned at but never named still appears, so the
//     list is not empty on the first field trip. It carries visits and no money,
//     which is honest rather than a gap.
//   • Nothing here reads a network aggregate, so no k-anonymity floor applies.
//     A floor exists to stop one person's activity being inferred from a shared
//     number; this surface shows a person their own activity, where n=1 is the
//     normal case and suppressing it would be suppressing the feature.

/** Buy/pass verdicts a personal visit may carry (mirrors BuyRecommendation). */
export type PersonalVerdict = "buy" | "maybe" | "skip" | "unknown";

/**
 * How the list may be ordered. `roi` is the default and the one the story names;
 * the rest exist because "best" means different things while inventory is still
 * sitting on the rack.
 */
export const PERSONAL_STORE_SORTS = [
  "roi",
  "realized_roi",
  "profit",
  "spend",
  "items",
  "visits",
  "recent",
  "name",
] as const;
export type PersonalStoreSort = typeof PERSONAL_STORE_SORTS[number];

export const DEFAULT_PERSONAL_STORE_SORT: PersonalStoreSort = "roi";

export function isPersonalStoreSort(v: unknown): v is PersonalStoreSort {
  return typeof v === "string" &&
    (PERSONAL_STORE_SORTS as readonly string[]).includes(v);
}

/** A store the reseller named themselves. */
export interface PersonalSourceSeed {
  id: string;
  name: string;
  source_type: string | null;
  location: string | null;
  /** The shared Radar venue this source is linked to, when it is. */
  radar_venue_id: string | null;
}

/** A shared venue, as far as this surface needs to know one. */
export interface PersonalVenueSeed {
  id: string;
  display_name: string;
  chain: string | null;
}

/**
 * One sourced item, in the shape `items_full` returns it.
 *
 * Money arrives as DOLLARS (the view's columns are `decimal`) and leaves as
 * cents. Doing that conversion once, here, is the reason the route does no
 * arithmetic of its own.
 */
export interface PersonalItemFact {
  source_id: string | null;
  brand: string | null;
  /** inventory_items.acquired_price — what they paid, in dollars. */
  purchase_price: number | null;
  purchase_date: string | null;
  /** The most-recent listing's price, in dollars. */
  list_price: number | null;
  target_price: number | null;
  /** sales.net_profit, in dollars. Only meaningful for a completed sale. */
  net_profit: number | null;
  sale_price: number | null;
  sale_status: "completed" | "cancelled" | "refunded" | "pending" | null;
  sale_date: string | null;
}

/** One personal visit, in the shape `radar_personal_scans` returns it. */
export interface PersonalScanFact {
  venue_id: string | null;
  brand: string | null;
  verdict: PersonalVerdict;
  scanned_at: string;
}

export interface PersonalStoreBrand {
  brand: string;
  items: number;
  realized_profit_cents: number;
}

export interface PersonalStoreStats {
  /** Stable row key: the source id, or `venue:<id>` for an unnamed venue. */
  key: string;
  source_id: string | null;
  venue_id: string | null;
  name: string;
  source_type: string | null;
  location: string | null;
  chain: string | null;
  /** True once this store is joined to a shared Radar venue. */
  linked: boolean;
  items_sourced: number;
  items_sold: number;
  spend_cents: number;
  /** Spend on the items that actually sold — the denominator of realized ROI. */
  sold_spend_cents: number;
  realized_profit_cents: number;
  expected_profit_cents: number;
  /** (realized + expected) / spend, as a percentage. Null when spend is 0. */
  roi_pct: number | null;
  /** realized / sold_spend, as a percentage. Null until something sells. */
  realized_roi_pct: number | null;
  /** items_sold / items_sourced, as a percentage. Null with no items. */
  sell_through_pct: number | null;
  top_brands: PersonalStoreBrand[];
  visits: number;
  buy_visits: number;
  last_visit_at: string | null;
  /** How the last-visit date was established — a purchase or a scan. */
  last_visit_source: "purchase" | "scan" | null;
}

export interface PersonalStoresInput {
  sources: PersonalSourceSeed[];
  venues: PersonalVenueSeed[];
  items: PersonalItemFact[];
  scans: PersonalScanFact[];
}

export interface PersonalStoresResult {
  stores: PersonalStoreStats[];
  /**
   * Visits that resolved to no venue at all (the registry could not place the
   * cell). Reported as a number rather than folded into a fake "Unknown store"
   * row — a store nobody can go back to is not a store.
   */
  unplaced_visits: number;
  /** Items with no source_id, so attributable to no store. */
  unattributed_items: number;
}

/** How many brands a store row carries. Three fits a row without wrapping. */
const TOP_BRAND_LIMIT = 3;

function toCents(dollars: number | null | undefined): number {
  if (typeof dollars !== "number" || !Number.isFinite(dollars)) return 0;
  return Math.round(dollars * 100);
}

/** Round to one decimal place — percentages are read, not recomputed from. */
function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function normalizeBrand(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed.slice(0, 120) : null;
}

/**
 * A sale only counts when it COMPLETED.
 *
 * `sale_status` is null for an item that never sold, and a cancelled or refunded
 * sale must not be booked as realized profit — the same rule the money surfaces
 * have used since 00111. Counting one would tell somebody a store is their best
 * because of a sale that came back.
 */
function isRealizedSale(item: PersonalItemFact): boolean {
  return item.sale_status === "completed";
}

/**
 * What an unsold item is expected to clear, in cents: its ask minus its cost.
 *
 * Deliberately derived from a price the reseller SET (the live listing, else the
 * target they recorded) rather than from a comp lookup. This surface must work
 * offline and at n=1, and a number invented for them would make "expected
 * profit" mean something they cannot check.
 *
 * Returns null when there is no ask — an item priced at nothing has no
 * expectation, which is different from expecting nothing.
 */
export function expectedProfitCents(item: PersonalItemFact): number | null {
  const ask = item.list_price ?? item.target_price;
  if (typeof ask !== "number" || !Number.isFinite(ask) || ask <= 0) return null;
  return toCents(ask) - toCents(item.purchase_price);
}

interface Bucket {
  seed: {
    key: string;
    source_id: string | null;
    venue_id: string | null;
    name: string;
    source_type: string | null;
    location: string | null;
    chain: string | null;
  };
  items_sourced: number;
  items_sold: number;
  spend_cents: number;
  sold_spend_cents: number;
  realized_profit_cents: number;
  expected_profit_cents: number;
  visits: number;
  buy_visits: number;
  last_purchase_at: string | null;
  last_scan_at: string | null;
  itemBrands: Map<string, { items: number; realized_profit_cents: number }>;
  scanBrands: Map<string, number>;
}

function newBucket(seed: Bucket["seed"]): Bucket {
  return {
    seed,
    items_sourced: 0,
    items_sold: 0,
    spend_cents: 0,
    sold_spend_cents: 0,
    realized_profit_cents: 0,
    expected_profit_cents: 0,
    visits: 0,
    buy_visits: 0,
    last_purchase_at: null,
    last_scan_at: null,
    itemBrands: new Map(),
    scanBrands: new Map(),
  };
}

function topBrands(bucket: Bucket): PersonalStoreBrand[] {
  if (bucket.itemBrands.size > 0) {
    return [...bucket.itemBrands.entries()]
      .map(([brand, v]) => ({ brand, ...v }))
      .sort((a, b) =>
        b.realized_profit_cents - a.realized_profit_cents ||
        b.items - a.items ||
        a.brand.localeCompare(b.brand)
      )
      .slice(0, TOP_BRAND_LIMIT);
  }
  // A store you have only scanned at has no money in it yet, so "top brands"
  // can only mean what you kept picking up. Reported with items: 0 so the two
  // cases stay distinguishable rather than looking like unprofitable buys.
  return [...bucket.scanBrands.entries()]
    .map(([brand, items]) => ({ brand, items: 0, realized_profit_cents: 0, seen: items }))
    .sort((a, b) => b.seen - a.seen || a.brand.localeCompare(b.brand))
    .slice(0, TOP_BRAND_LIMIT)
    .map(({ brand, items, realized_profit_cents }) => ({
      brand,
      items,
      realized_profit_cents,
    }));
}

function finalize(bucket: Bucket): PersonalStoreStats {
  const last_visit_at = laterOf(bucket.last_purchase_at, bucket.last_scan_at);
  const last_visit_source: PersonalStoreStats["last_visit_source"] =
    last_visit_at == null
      ? null
      : last_visit_at === bucket.last_scan_at &&
          last_visit_at !== bucket.last_purchase_at
      ? "scan"
      : "purchase";
  return {
    ...bucket.seed,
    linked: bucket.seed.venue_id != null,
    items_sourced: bucket.items_sourced,
    items_sold: bucket.items_sold,
    spend_cents: bucket.spend_cents,
    sold_spend_cents: bucket.sold_spend_cents,
    realized_profit_cents: bucket.realized_profit_cents,
    expected_profit_cents: bucket.expected_profit_cents,
    roi_pct: pct(
      bucket.realized_profit_cents + bucket.expected_profit_cents,
      bucket.spend_cents,
    ),
    realized_roi_pct: pct(bucket.realized_profit_cents, bucket.sold_spend_cents),
    sell_through_pct: pct(bucket.items_sold, bucket.items_sourced),
    top_brands: topBrands(bucket),
    visits: bucket.visits,
    buy_visits: bucket.buy_visits,
    last_visit_at,
    last_visit_source,
  };
}

/**
 * Fold a tenant's sources, venues, items and visits into per-store stats.
 *
 * Every input is already tenant-scoped by the caller (US-268) — this function
 * has no notion of an account and cannot re-scope anything, which is why it is
 * safe for it to be pure.
 *
 * A store appears when it has at least one item OR at least one visit. A source
 * with neither is a name the reseller typed and nothing else; it belongs on the
 * Sources tab, not in a ranking of where their money came from.
 */
export function buildPersonalStores(
  input: PersonalStoresInput,
): PersonalStoresResult {
  const venueById = new Map(input.venues.map((v) => [v.id, v]));
  const buckets = new Map<string, Bucket>();
  /** venue id → the source key that has claimed it. */
  const claimedVenues = new Map<string, string>();

  for (const source of input.sources) {
    const venue = source.radar_venue_id
      ? venueById.get(source.radar_venue_id) ?? null
      : null;
    // A source may point at a venue id that no longer resolves (merged away,
    // deleted). It is still the reseller's store — the link is just cold, so it
    // reads as unlinked rather than vanishing.
    const venueId = venue ? venue.id : null;
    buckets.set(
      source.id,
      newBucket({
        key: source.id,
        source_id: source.id,
        venue_id: venueId,
        name: source.name,
        source_type: source.source_type,
        location: source.location,
        chain: venue?.chain ?? null,
      }),
    );
    if (venueId) claimedVenues.set(venueId, source.id);
  }

  let unattributed_items = 0;
  for (const item of input.items) {
    const bucket = item.source_id ? buckets.get(item.source_id) : undefined;
    if (!bucket) {
      unattributed_items++;
      continue;
    }
    const spend = toCents(item.purchase_price);
    bucket.items_sourced++;
    bucket.spend_cents += spend;
    bucket.last_purchase_at = laterOf(bucket.last_purchase_at, item.purchase_date);

    const brand = normalizeBrand(item.brand);
    const brandRow = brand
      ? bucket.itemBrands.get(brand) ?? { items: 0, realized_profit_cents: 0 }
      : null;
    if (brand && brandRow) {
      brandRow.items++;
      bucket.itemBrands.set(brand, brandRow);
    }

    if (isRealizedSale(item)) {
      const profit = toCents(item.net_profit);
      bucket.items_sold++;
      bucket.sold_spend_cents += spend;
      bucket.realized_profit_cents += profit;
      if (brandRow) brandRow.realized_profit_cents += profit;
      // A completed sale is also a visit-independent proof the store produced
      // something, but NOT evidence of a visit date — the purchase date is.
      continue;
    }
    const expected = expectedProfitCents(item);
    if (expected != null) bucket.expected_profit_cents += expected;
  }

  let unplaced_visits = 0;
  for (const scan of input.scans) {
    if (!scan.venue_id) {
      unplaced_visits++;
      continue;
    }
    const claimedBy = claimedVenues.get(scan.venue_id);
    let bucket = claimedBy ? buckets.get(claimedBy) : undefined;
    if (!bucket) {
      const key = `venue:${scan.venue_id}`;
      bucket = buckets.get(key);
      if (!bucket) {
        const venue = venueById.get(scan.venue_id);
        bucket = newBucket({
          key,
          source_id: null,
          venue_id: scan.venue_id,
          // An unnamed venue still needs something to call it. The registry's
          // placeholder name is what the map shows, so the two surfaces agree.
          name: venue?.display_name ?? "Unnamed store",
          source_type: null,
          location: null,
          chain: venue?.chain ?? null,
        });
        buckets.set(key, bucket);
      }
    }
    bucket.visits++;
    if (scan.verdict === "buy") bucket.buy_visits++;
    bucket.last_scan_at = laterOf(bucket.last_scan_at, scan.scanned_at);
    const brand = normalizeBrand(scan.brand);
    if (brand) bucket.scanBrands.set(brand, (bucket.scanBrands.get(brand) ?? 0) + 1);
  }

  const stores = [...buckets.values()]
    .filter((b) => b.items_sourced > 0 || b.visits > 0)
    .map(finalize);

  return { stores, unplaced_visits, unattributed_items };
}

/** Numeric sort key for a store under each ordering. Null means "unranked". */
function sortValue(
  store: PersonalStoreStats,
  sort: PersonalStoreSort,
): number | null {
  switch (sort) {
    case "roi":
      return store.roi_pct;
    case "realized_roi":
      return store.realized_roi_pct;
    case "profit":
      return store.realized_profit_cents + store.expected_profit_cents;
    case "spend":
      return store.spend_cents;
    case "items":
      return store.items_sourced;
    case "visits":
      return store.visits;
    case "recent":
      return store.last_visit_at ? Date.parse(store.last_visit_at) : null;
    case "name":
      return null;
  }
}

/**
 * Order the list. Returns a NEW array — the caller may hold the unsorted one.
 *
 * An unrankable store (no spend, so no ROI; no date, so no recency) sorts LAST
 * rather than first or in the middle. Same rule as the backlog's `priority`
 * (see vault/70-agent/backlog-priority-contract.md): a missing value is not a
 * zero, and treating it as one puts a store nobody has bought from at the top
 * of "your best stores".
 */
export function sortPersonalStores(
  stores: PersonalStoreStats[],
  sort: PersonalStoreSort = DEFAULT_PERSONAL_STORE_SORT,
): PersonalStoreStats[] {
  const out = [...stores];
  out.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    const av = sortValue(a, sort);
    const bv = sortValue(b, sort);
    if (av == null && bv == null) return a.name.localeCompare(b.name);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (bv !== av) return bv - av;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/** The row written to `radar_personal_scans`. Note what is absent. */
export interface PersonalScanRow {
  user_id: string;
  venue_id: string | null;
  geohash: string | null;
  brand: string | null;
  category: string | null;
  grade_band: "high" | "mid" | "low" | "ungraded";
  verdict: PersonalVerdict;
  scanned_at: string;
}

export interface PersonalScanRowInput {
  accountId: string;
  venueId: string | null;
  /** The coarse cell the fix resolved to. Never the fix. */
  cell: string | null;
  brand: string | null;
  category: string | null;
  gradeBand: PersonalScanRow["grade_band"];
  verdict: PersonalVerdict;
  at: Date;
}

/**
 * Build the row a personal visit becomes, or null when it would be unlocatable.
 *
 * The signature is the guarantee, the same way `candidateVenueDraft(cell)`'s is
 * (US-1862): there is no `lat`/`lng` parameter, so no call site can pass a fix
 * through into the reseller's own history even though these rows — unlike a
 * contribution — carry their real account id.
 */
export function buildPersonalScanRow(
  input: PersonalScanRowInput,
): PersonalScanRow | null {
  if (!input.venueId && !input.cell) return null;
  return {
    user_id: input.accountId,
    venue_id: input.venueId,
    geohash: input.cell,
    brand: normalizeBrand(input.brand),
    category: normalizeBrand(input.category),
    grade_band: input.gradeBand,
    verdict: input.verdict,
    scanned_at: input.at.toISOString(),
  };
}
