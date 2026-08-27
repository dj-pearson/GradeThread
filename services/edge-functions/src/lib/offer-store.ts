// US-2939: the local record of marketplace offers (marketplace_offers).
//
// eBay stays the source of truth for a live offer's STATE. This table is the
// record of what happened, and it exists because three things were impossible
// without one: seeing what a buyer has already offered, knowing what our own
// counters convert at, and putting a margin or an expiry countdown on a row
// without a second round trip.
//
// ── THE SNAPSHOT RULE ───────────────────────────────────────────────────────
//
// `list_price_cents` is stored WITH the offer, not read back from the listing.
// A later reprice would otherwise rewrite history: an offer at 70% of a $24 ask
// must not become an offer at 6% of a $298 one the day the seller raises the
// price. Every discount-depth figure in the analytics rests on this.
//
// ── THE SAME UPSERT RULE AS post-sale-store ─────────────────────────────────
//
// `toOfferRow` emits only the keys it has a value for. `undefined` means "I do
// not know" and is dropped; an explicit `null` means "eBay says there is none"
// and IS written. Without that, a poll built from a summary erases a
// responded_at that the responder wrote thirty seconds earlier.
//
// Tenant-scoped by construction: every function takes an ownerId and every query
// filters on it (US-268). The service-role client bypasses RLS, so the
// `.eq("user_id", ownerId)` is the real lock.

import { supabaseAdmin } from "./supabase.ts";

/**
 * Which way the offer went.
 *
 * `received` is a buyer bidding on a listing. `counter_sent` is our answer to
 * one. `offer_sent` is an unprompted discount to interested buyers. Collapsing
 * them would let our own counter be read as a buyer's bid, which is the number
 * every conversion figure divides by.
 */
export type OfferDirection = "received" | "counter_sent" | "offer_sent";

export interface OfferInput {
  direction: OfferDirection;
  externalOfferId: string;
  itemExternalId?: string | null;
  buyerUsername?: string | null;
  amountCents?: number | null;
  currency?: string | null;
  listPriceCents?: number | null;
  state?: string | null;
  expiresAt?: string | null;
  respondedAt?: string | null;
  response?: string | null;
  responseAmountCents?: number | null;
  ruleId?: string | null;
  raw?: unknown;
}

export interface StoredOffer {
  id: string;
  direction: OfferDirection;
  externalOfferId: string;
  itemExternalId: string | null;
  buyerUsername: string | null;
  amountCents: number | null;
  currency: string | null;
  listPriceCents: number | null;
  state: string | null;
  expiresAt: string | null;
  respondedAt: string | null;
  response: string | null;
  responseAmountCents: number | null;
  createdAt: string;
}

/** Pure. Drops undefined, keeps null — see the header. */
export function toOfferRow(
  ownerId: string,
  input: OfferInput,
  nowIso: string,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    user_id: ownerId,
    platform: "ebay",
    external_offer_id: input.externalOfferId,
    direction: input.direction,
    last_seen_at: nowIso,
  };
  const optional: Array<[string, unknown]> = [
    ["item_external_id", input.itemExternalId],
    ["buyer_username", input.buyerUsername],
    ["amount_cents", input.amountCents],
    ["currency", input.currency],
    ["list_price_cents", input.listPriceCents],
    ["state", input.state],
    ["expires_at", input.expiresAt],
    ["responded_at", input.respondedAt],
    ["response", input.response],
    ["response_amount_cents", input.responseAmountCents],
    ["rule_id", input.ruleId],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) row[key] = value;
  }
  if (input.raw !== undefined) row.raw = input.raw;
  return row;
}

/**
 * eBay's incoming-offer summary → a stored row. Pure.
 *
 * `listPriceCents` is NOT on eBay's offer payload, so the caller passes it from
 * the local listing at the moment the offer is seen. Passing `undefined` (the
 * default) leaves any already-stored snapshot alone, which is the whole point
 * of the snapshot rule: the FIRST reading is the true one.
 */
export function incomingOfferToInput(
  offer: {
    bestOfferId: string;
    itemId: string;
    buyerUsername: string | null;
    price: number | null;
    currency: string;
    status: string | null;
    expiresAt: string | null;
  },
  listPriceCents?: number | null,
): OfferInput {
  const amount = offer.price;
  return {
    direction: "received",
    externalOfferId: offer.bestOfferId,
    itemExternalId: offer.itemId || null,
    buyerUsername: offer.buyerUsername,
    amountCents: amount != null && Number.isFinite(amount) ? Math.round(amount * 100) : null,
    currency: offer.currency,
    ...(listPriceCents === undefined ? {} : { listPriceCents }),
    state: offer.status,
    expiresAt: offer.expiresAt,
    raw: offer,
  };
}

/**
 * The asking price of each listing, in cents, keyed by eBay item id.
 *
 * Read at the moment the offer is recorded so `list_price_cents` is a SNAPSHOT.
 * Without it the discount-depth analytics would divide by whatever the listing
 * costs today, and a seller who repriced would see their own history rewritten.
 */
export async function loadListPricesByItemId(
  ownerId: string,
  itemExternalIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(itemExternalIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select("platform_listing_id, listing_price")
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .in("platform_listing_id", ids);
  if (error) {
    console.error("[offer-store] loadListPricesByItemId:", error.message);
    return out;
  }
  for (
    const r of (data ?? []) as unknown as Array<{
      platform_listing_id: string | null;
      listing_price: number | null;
    }>
  ) {
    const n = r.listing_price == null ? Number.NaN : Number(r.listing_price);
    if (r.platform_listing_id && Number.isFinite(n)) {
      out.set(r.platform_listing_id, Math.round(n * 100));
    }
  }
  return out;
}

/**
 * Record a set of offers. Best-effort: a storage failure must not take down the
 * poll or the responder it rides in.
 */
export async function recordOffers(
  ownerId: string,
  inputs: OfferInput[],
  nowIso: string = new Date().toISOString(),
): Promise<number> {
  const rows = inputs
    .filter((i) => i.externalOfferId)
    .map((i) => toOfferRow(ownerId, i, nowIso));
  if (rows.length === 0) return 0;
  const { error } = await supabaseAdmin
    .from("marketplace_offers")
    .upsert(rows, { onConflict: "user_id,platform,external_offer_id,direction" });
  if (error) {
    console.error("[offer-store] recordOffers:", error.message);
    return 0;
  }
  return rows.length;
}

/**
 * Record what we DID about one offer.
 *
 * A separate call from recordOffers on purpose: the response is ours and is
 * known the instant we make it, while eBay's own view of the offer catches up
 * on the next poll. Writing it here means the analytics never has to infer an
 * outcome from a state that disappeared.
 */
export async function recordOfferResponse(
  ownerId: string,
  externalOfferId: string,
  response: "accepted" | "declined" | "countered" | "expired",
  opts: { amountCents?: number | null; ruleId?: string | null } = {},
): Promise<void> {
  const patch: Record<string, unknown> = {
    responded_at: new Date().toISOString(),
    response,
  };
  if (opts.amountCents !== undefined) patch.response_amount_cents = opts.amountCents;
  if (opts.ruleId !== undefined) patch.rule_id = opts.ruleId;
  const { error } = await supabaseAdmin
    .from("marketplace_offers")
    .update(patch)
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .eq("external_offer_id", externalOfferId)
    .eq("direction", "received");
  if (error) {
    console.error("[offer-store] recordOfferResponse:", error.message);
  }
}

const SELECT_COLUMNS =
  "id, direction, external_offer_id, item_external_id, buyer_username, amount_cents, " +
  "currency, list_price_cents, state, expires_at, responded_at, response, " +
  "response_amount_cents, created_at";

interface OfferRow {
  id: string;
  direction: string;
  external_offer_id: string;
  item_external_id: string | null;
  buyer_username: string | null;
  amount_cents: number | null;
  currency: string | null;
  list_price_cents: number | null;
  state: string | null;
  expires_at: string | null;
  responded_at: string | null;
  response: string | null;
  response_amount_cents: number | null;
  created_at: string;
}

function fromRow(r: OfferRow): StoredOffer {
  return {
    id: r.id,
    direction: r.direction as OfferDirection,
    externalOfferId: r.external_offer_id,
    itemExternalId: r.item_external_id,
    buyerUsername: r.buyer_username,
    amountCents: r.amount_cents,
    currency: r.currency,
    listPriceCents: r.list_price_cents,
    state: r.state,
    expiresAt: r.expires_at,
    respondedAt: r.responded_at,
    response: r.response,
    responseAmountCents: r.response_amount_cents,
    createdAt: r.created_at,
  };
}

/** One owner's stored offers, newest first. */
export async function loadOffers(
  ownerId: string,
  opts: { direction?: OfferDirection; sinceIso?: string; limit?: number } = {},
): Promise<StoredOffer[]> {
  let q = supabaseAdmin
    .from("marketplace_offers")
    .select(SELECT_COLUMNS)
    .eq("user_id", ownerId)
    .eq("platform", "ebay");
  if (opts.direction) q = q.eq("direction", opts.direction);
  if (opts.sinceIso) q = q.gte("created_at", opts.sinceIso);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 500);
  if (error) {
    console.error("[offer-store] loadOffers:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as OfferRow[]).map(fromRow);
}

export interface BuyerHistory {
  /** How many offers this buyer has made before, across every item. */
  priorOffers: number;
  /** The highest they have ever offered, in cents. */
  bestPriorCents: number | null;
  /** Whether any of those was accepted. */
  everAccepted: boolean;
}

/**
 * What this seller already knows about a set of buyers.
 *
 * One query for every buyer on the page rather than one per row: the offers
 * list is the surface a seller works through at speed, and a per-row lookup
 * makes it as slow as the longest list they have.
 */
export async function loadBuyerHistory(
  ownerId: string,
  buyerUsernames: string[],
  excludeOfferIds: string[] = [],
): Promise<Map<string, BuyerHistory>> {
  const out = new Map<string, BuyerHistory>();
  const names = [...new Set(buyerUsernames.filter(Boolean))];
  if (names.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from("marketplace_offers")
    .select("external_offer_id, buyer_username, amount_cents, response")
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .eq("direction", "received")
    .in("buyer_username", names);
  if (error) {
    console.error("[offer-store] loadBuyerHistory:", error.message);
    return out;
  }
  const exclude = new Set(excludeOfferIds);
  for (
    const r of (data ?? []) as unknown as Array<{
      external_offer_id: string;
      buyer_username: string | null;
      amount_cents: number | null;
      response: string | null;
    }>
  ) {
    if (!r.buyer_username) continue;
    // The offer on the seller's screen right now is not "prior". Counting it
    // would tell every first-time buyer they had offered before.
    if (exclude.has(r.external_offer_id)) continue;
    const prev = out.get(r.buyer_username) ??
      { priorOffers: 0, bestPriorCents: null, everAccepted: false };
    prev.priorOffers++;
    if (r.amount_cents != null) {
      prev.bestPriorCents = prev.bestPriorCents == null
        ? r.amount_cents
        : Math.max(prev.bestPriorCents, r.amount_cents);
    }
    if (r.response === "accepted") prev.everAccepted = true;
    out.set(r.buyer_username, prev);
  }
  return out;
}
