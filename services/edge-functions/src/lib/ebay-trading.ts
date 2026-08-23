// eBay Trading API client — covers listings created outside the Sell
// Inventory API (Seller Hub, legacy ListItem, third-party tools). These
// listings never become "inventory_items" on the new REST surface, so
// /sell/inventory/v1/inventory_item can't see them.
//
// We use the Trading API GetMyeBaySelling call. Auth is the same OAuth user
// access token we already store — passed via the X-EBAY-API-IAF-TOKEN header
// (Trading API's name for "Identity Access Federation token", which is what
// eBay calls an OAuth bearer when used with the legacy XML surface).
//
// US-1476 — DEPRECATION WATCH: eBay is decommissioning the legacy Trading API.
// Every call in this file is tracked (purpose, REST-equivalent status, migration
// stance) in vault/30-platform/ebay-trading-api-watch.md — review it each eBay release-notes
// cycle and prefer REST wherever an equivalent exists (order sync already does:
// see ebay-client.listRecentOrders / Fulfillment getOrders).

import { XMLParser } from "fast-xml-parser";
import {
  ebayResilientFetch,
  getConnectionAccessToken,
  getEbayAccountHandle,
  getEbayEnv,
  getMarketplaceId,
  getUserAccessToken,
} from "./ebay-client.ts";

/**
 * US-2323: the deadline for a single Trading call.
 *
 * Longer than the Sell APIs' default because Trading genuinely is slower —
 * GetMyeBaySelling pages and GetItem with ReturnAll both routinely take
 * seconds. The number matters far less than its existence: before this there
 * was no bound at all, and a stalled connection held a worker until the process
 * restarted.
 */
export const TRADING_TIMEOUT_MS = 30_000;

// Compatibility level pins the XML schema we're targeting. eBay bumps this
// occasionally; 1193 is stable as of late 2024 and supports SKU in the
// response which is what we need for matching.
const COMPAT_LEVEL = "1193";

function tradingHost(): string {
  return getEbayEnv() === "production"
    ? "https://api.ebay.com"
    : "https://api.sandbox.ebay.com";
}

// Trading API uses numeric site IDs, not the X-EBAY-C-MARKETPLACE-ID strings.
// US is 0, UK 3, DE 77, etc. We only ship US/UK/DE today.
function siteId(): string {
  const m = getMarketplaceId();
  switch (m) {
    case "EBAY_GB": return "3";
    case "EBAY_DE": return "77";
    case "EBAY_FR": return "71";
    case "EBAY_IT": return "101";
    case "EBAY_ES": return "186";
    case "EBAY_AU": return "15";
    case "EBAY_CA": return "2";
    default: return "0"; // EBAY_US
  }
}

function devEnv() {
  const appId = Deno.env.get("EBAY_APP_ID")?.trim();
  const certId = Deno.env.get("EBAY_CERT_ID")?.trim();
  const devId = Deno.env.get("EBAY_DEV_ID")?.trim();
  if (!appId || !certId || !devId) {
    throw new Error(
      "EBAY_APP_ID / EBAY_CERT_ID / EBAY_DEV_ID must all be set for Trading API."
    );
  }
  return { appId, certId, devId };
}

// XML-escape five chars; eBay's parser is strict about &<> inside element text.
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface LegacyEbayListing {
  ebayItemId: string;
  title: string | null;
  sku: string | null;
  // currentPrice is the Buy It Now for fixed-price, or current bid for auctions.
  currentPrice: number | null;
  currency: string;
  quantity: number | null;
  quantityAvailable: number | null;
  listingType: string | null; // FixedPriceItem, Chinese, etc.
  listingUrl: string | null;
  startTime: string | null;
  endTime: string | null;
  watchCount: number | null;
  // Leaf-category id the listing is filed under. Trading API returns this
  // as <PrimaryCategory><CategoryID>… for Seller-Hub-created listings.
  primaryCategoryId: string | null;
}

interface RawItem {
  ItemID?: unknown;
  Title?: unknown;
  SKU?: unknown;
  BuyItNowPrice?: unknown;
  ConvertedBuyItNowPrice?: unknown;
  SellingStatus?: {
    CurrentPrice?: unknown;
    ConvertedCurrentPrice?: unknown;
  };
  Currency?: unknown;
  Quantity?: unknown;
  QuantityAvailable?: unknown;
  ListingType?: unknown;
  ListingDetails?: {
    StartTime?: unknown;
    EndTime?: unknown;
    ViewItemURL?: unknown;
  };
  WatchCount?: unknown;
  PrimaryCategory?: {
    CategoryID?: unknown;
  };
}

function asPriceValue(p: unknown): { value: number | null; currency: string } {
  // fast-xml-parser folds attributes into a `:@` map by default; we use
  // attributeNamePrefix:'_'. So a <Price currencyID="USD">12.50</Price>
  // becomes { "#text": "12.50", "_currencyID": "USD" } when textNodeName is "#text".
  if (typeof p === "number") return { value: p, currency: "USD" };
  if (typeof p === "string") return { value: Number(p), currency: "USD" };
  if (p && typeof p === "object") {
    const obj = p as Record<string, unknown>;
    const v = obj["#text"] ?? obj["_text"];
    const c = obj["_currencyID"];
    return {
      value: v != null ? Number(v) : null,
      currency: typeof c === "string" ? c : "USD",
    };
  }
  return { value: null, currency: "USD" };
}

function asString(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeItem(raw: RawItem): LegacyEbayListing | null {
  const id = asString(raw.ItemID);
  if (!id) return null;
  // For fixed-price look at BuyItNowPrice; for auctions, SellingStatus.CurrentPrice.
  const buyNow = asPriceValue(
    raw.BuyItNowPrice ?? raw.ConvertedBuyItNowPrice
  );
  const current = asPriceValue(
    raw.SellingStatus?.CurrentPrice ?? raw.SellingStatus?.ConvertedCurrentPrice
  );
  const price = buyNow.value ?? current.value;
  const currency = buyNow.currency || current.currency || "USD";
  return {
    ebayItemId: id,
    title: asString(raw.Title),
    sku: asString(raw.SKU),
    currentPrice: price,
    currency,
    quantity: asNumber(raw.Quantity),
    quantityAvailable: asNumber(raw.QuantityAvailable),
    listingType: asString(raw.ListingType),
    listingUrl: asString(raw.ListingDetails?.ViewItemURL),
    startTime: asString(raw.ListingDetails?.StartTime),
    endTime: asString(raw.ListingDetails?.EndTime),
    watchCount: asNumber(raw.WatchCount),
    primaryCategoryId: asString(raw.PrimaryCategory?.CategoryID),
  };
}

// Builds the GetMyeBaySelling request body. Uses ActiveList to fetch
// currently-live items only. DetailLevel=ReturnAll gives us SKU + URL.
function buildRequestXml(page: number, entriesPerPage: number): string {
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">`,
    `  <ActiveList>`,
    `    <Sort>TimeLeft</Sort>`,
    `    <Pagination>`,
    `      <EntriesPerPage>${xmlEscape(String(entriesPerPage))}</EntriesPerPage>`,
    `      <PageNumber>${xmlEscape(String(page))}</PageNumber>`,
    `    </Pagination>`,
    `    <Include>true</Include>`,
    `    <DetailLevel>ReturnAll</DetailLevel>`,
    `  </ActiveList>`,
    `</GetMyeBaySellingRequest>`,
  ].join("\n");
}

interface ParsedResponse {
  GetMyeBaySellingResponse?: {
    Ack?: string;
    Errors?: Array<{
      ShortMessage?: string;
      LongMessage?: string;
      ErrorCode?: string;
      SeverityCode?: string;
    }>;
    ActiveList?: {
      ItemArray?: { Item?: RawItem | RawItem[] };
      PaginationResult?: {
        TotalNumberOfPages?: string;
        TotalNumberOfEntries?: string;
      };
    };
  };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "_",
  textNodeName: "#text",
  // Trading API returns a single <Item> as one object when there's one
  // listing on the page; force it to always be an array if we descend
  // into ItemArray. Easier than special-casing the path.
  isArray: (name) => name === "Errors" || name === "Item",
});

// Calls Trading API once. Returns the parsed response object plus the
// page metadata so the paginator knows when to stop.
async function fetchActiveListPage(
  userId: string,
  page: number,
  entriesPerPage = 200
): Promise<{
  items: LegacyEbayListing[];
  totalPages: number;
  totalEntries: number;
}> {
  const token = await getUserAccessToken(userId);
  const { appId, certId, devId } = devEnv();
  const body = buildRequestXml(page, entriesPerPage);

  // US-2323: the legacy pull walks this page by page, so a bare fetch meant one
  // transient 500 partway through aborted the WHOLE sync and a stall held the
  // worker until the process restarted. Retrying a single page is cheap and
  // safe — GetMyeBaySelling is a read.
  const res = await ebayResilientFetch(`${tradingHost()}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-DEV-NAME": devId,
      "X-EBAY-API-APP-NAME": appId,
      "X-EBAY-API-CERT-NAME": certId,
      "X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
      "X-EBAY-API-SITEID": siteId(),
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body,
  }, { timeoutMs: TRADING_TIMEOUT_MS, label: "Trading GetMyeBaySelling" });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `eBay Trading GetMyeBaySelling failed (${res.status}): ${text.slice(0, 500)}`
    );
  }

  const parsed = parser.parse(text) as ParsedResponse;
  const root = parsed.GetMyeBaySellingResponse;
  if (!root) {
    throw new Error(
      `eBay Trading: unrecognized response: ${text.slice(0, 300)}`
    );
  }
  // Ack is "Success", "Warning", or "Failure". Errors[] may be present
  // even on a partial success — only throw on hard Failure.
  if (root.Ack === "Failure") {
    const firstError = root.Errors?.[0];
    throw new Error(
      `eBay Trading (Failure): ${firstError?.LongMessage ?? "no message"} ` +
        `(code ${firstError?.ErrorCode ?? "?"})`
    );
  }

  const itemNode = root.ActiveList?.ItemArray?.Item;
  const items: RawItem[] = Array.isArray(itemNode)
    ? itemNode
    : itemNode != null
    ? [itemNode as RawItem]
    : [];

  const totalPages = Number(
    root.ActiveList?.PaginationResult?.TotalNumberOfPages ?? "0"
  );
  const totalEntries = Number(
    root.ActiveList?.PaginationResult?.TotalNumberOfEntries ?? "0"
  );

  const normalized = items
    .map(normalizeItem)
    .filter((it): it is LegacyEbayListing => !!it);

  return { items: normalized, totalPages, totalEntries };
}

// Walks every page of GetMyeBaySelling.ActiveList until exhausted. Hard
// ceiling on pages so a buggy paginator can't loop forever.
export async function getAllActiveEbaySelling(
  userId: string
): Promise<LegacyEbayListing[]> {
  const ENTRIES_PER_PAGE = 200;
  const MAX_PAGES = 25; // 5000 listings — covers virtually every seller.

  const first = await fetchActiveListPage(userId, 1, ENTRIES_PER_PAGE);
  const all: LegacyEbayListing[] = [...first.items];
  if (first.totalPages <= 1 || all.length >= first.totalEntries) return all;

  const lastPage = Math.min(first.totalPages, MAX_PAGES);
  for (let page = 2; page <= lastPage; page++) {
    const next = await fetchActiveListPage(userId, page, ENTRIES_PER_PAGE);
    all.push(...next.items);
    if (next.items.length === 0) break;
  }
  return all;
}

// ── GetItem (item specifics) ────────────────────────────────────────────
//
// GetMyeBaySelling.ActiveList does NOT return ItemSpecifics, so the catalog
// backfill (brand/size/color/style/material → inventory_items) fetches them
// per item via GetItem. The sync gates + caps these calls (only items still
// missing a field, capped per run), so volume tapers to ~0 once populated.

// Dedicated parser: force NameValueList + Value to arrays (a single specific or
// single value otherwise parses as an object/string). NOTE: we must NOT force
// `Item` to an array here (unlike the GetMyeBaySelling parser) — GetItem
// returns exactly one <Item>.
const getItemParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "_",
  textNodeName: "#text",
  isArray: (name) =>
    name === "Errors" || name === "NameValueList" || name === "Value",
});

interface GetItemResponse {
  GetItemResponse?: {
    Ack?: string;
    Errors?: Array<{ LongMessage?: string; ErrorCode?: string }>;
    Item?: {
      ItemSpecifics?: {
        NameValueList?: Array<{ Name?: unknown; Value?: unknown }>;
      };
    };
  };
}

// Returns eBay item specifics for one listing as { [Name]: firstValue }.
// Best-effort: any failure logs + returns {} so one bad item can't fail the
// whole sync.
export async function getItemSpecifics(
  userId: string,
  itemId: string,
): Promise<Record<string, string>> {
  try {
    const token = await getUserAccessToken(userId);
    const { appId, certId, devId } = devEnv();
    const body = [
      `<?xml version="1.0" encoding="utf-8"?>`,
      `<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">`,
      `  <ItemID>${xmlEscape(itemId)}</ItemID>`,
      `  <IncludeItemSpecifics>true</IncludeItemSpecifics>`,
      `  <DetailLevel>ReturnAll</DetailLevel>`,
      `</GetItemRequest>`,
    ].join("\n");

    // US-2323: same resilient path as tradingCall. This one runs once PER ITEM
    // in a sync loop, so an unbounded call here multiplies by the batch size.
    const res = await ebayResilientFetch(`${tradingHost()}/ws/api.dll`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
        "X-EBAY-API-DEV-NAME": devId,
        "X-EBAY-API-APP-NAME": appId,
        "X-EBAY-API-CERT-NAME": certId,
        "X-EBAY-API-CALL-NAME": "GetItem",
        "X-EBAY-API-SITEID": siteId(),
        "X-EBAY-API-IAF-TOKEN": token,
      },
      body,
    }, { timeoutMs: TRADING_TIMEOUT_MS, label: `Trading GetItem` });

    const text = await res.text();
    if (!res.ok) {
      console.warn(
        `[ebay-trading] GetItem(${itemId}) HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
      return {};
    }

    const root = (getItemParser.parse(text) as GetItemResponse).GetItemResponse;
    if (!root || root.Ack === "Failure") {
      console.warn(
        `[ebay-trading] GetItem(${itemId}) failed: ${root?.Errors?.[0]?.LongMessage ?? "no message"}`,
      );
      return {};
    }

    const nvl = root.Item?.ItemSpecifics?.NameValueList ?? [];
    const out: Record<string, string> = {};
    for (const nv of nvl) {
      const name = asString(nv.Name);
      if (!name) continue;
      // Value may be a single string or an array (multi-value specific).
      const values = Array.isArray(nv.Value) ? nv.Value : [nv.Value];
      const first = values.map(asString).find((v) => v && v.trim());
      if (first) out[name] = first;
    }
    return out;
  } catch (err) {
    console.warn(
      `[ebay-trading] GetItem(${itemId}) threw:`,
      err instanceof Error ? err.message : String(err),
    );
    return {};
  }
}

// ── US-673: Best offers + buyer messages (Trading API) ─────────────────────
//
// Incoming best-offers (review / accept / decline / counter) and member-to-
// member buyer messages live on the legacy Trading XML API, not the modern REST
// surfaces. Shared call helper keeps the headers in one place.

/// Makes one Trading API call and returns the raw XML text + HTTP status.
/// US-1507: `connectionId` auths via that specific connection (the account that
/// owns the listing being acted on); omitted → the user's primary connection.
async function tradingCall(
  userId: string,
  callName: string,
  body: string,
  connectionId?: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  const token = connectionId
    ? await getConnectionAccessToken(connectionId, userId)
    : await getUserAccessToken(userId);
  const { appId, certId, devId } = devEnv();
  // US-2323: through the shared resilient path (breaker → retry → timeout)
  // rather than a bare fetch. Trading is eBay's slowest and least reliable
  // surface and this is the single entry point for eight callers, so a hang
  // here tied up a worker indefinitely and one transient 500 aborted an entire
  // legacy pull. TRADING_TIMEOUT_MS is deliberately longer than the Sell
  // default — GetMyeBaySelling pages are genuinely slow — but it is a bound,
  // which is the part that was missing.
  const res = await ebayResilientFetch(`${tradingHost()}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-DEV-NAME": devId,
      "X-EBAY-API-APP-NAME": appId,
      "X-EBAY-API-CERT-NAME": certId,
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-SITEID": siteId(),
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body,
  }, { timeoutMs: TRADING_TIMEOUT_MS, label: `Trading ${callName}` });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

const offersParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "_",
  textNodeName: "#text",
  isArray: (name) =>
    name === "Errors" || name === "ItemBestOffers" || name === "BestOffer",
});

export interface IncomingBestOffer {
  bestOfferId: string;
  itemId: string;
  itemTitle: string | null;
  buyerUsername: string | null;
  price: number | null;
  currency: string;
  quantity: number | null;
  status: string | null; // Active, Accepted, Declined, Expired, Countered, …
  message: string | null;
  expiresAt: string | null;
}

/**
 * Lists active INCOMING best offers across the seller's listings.
 *
 * US-2816: GetBestOffers, called without an ItemID, returns offers this
 * account SENT as a buyer alongside the ones it received, and the response
 * carries no direction field. Every row used to be mapped straight to an
 * inbound offer, so the owner was emailed "You have a new offer" naming
 * THEMSELVES as the buyer, and the offers page invited them to Accept or
 * Decline their own bid.
 *
 * The only thing separating the two is whether the offer's Buyer is this
 * account, so that is the filter. It is applied HERE rather than in the two
 * callers (the notification poll and GET /negotiation/offers) because two
 * copies of a direction rule are two chances to disagree about it.
 *
 * FAILS OPEN, deliberately: an unknown account_handle means the comparison
 * cannot be made, and the old behaviour is restored rather than dropping
 * everything. account_handle is nullable and has a US-315 backfill, so
 * 'unknown' is a real state — and hiding every genuine offer would be a far
 * worse bug than the one being fixed.
 */
export async function getBestOffers(userId: string): Promise<IncomingBestOffer[]> {
  const body = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<GetBestOffersRequest xmlns="urn:ebay:apis:eBLBaseComponents">`,
    `  <BestOfferStatus>Active</BestOfferStatus>`,
    `  <DetailLevel>ReturnAll</DetailLevel>`,
    `</GetBestOffersRequest>`,
  ].join("\n");

  const { ok, status, text } = await tradingCall(userId, "GetBestOffers", body);
  if (!ok) {
    throw new Error(`eBay GetBestOffers failed (${status}): ${text.slice(0, 300)}`);
  }
  // Read before parsing: one lookup, not one per offer.
  const ownHandle = await getEbayAccountHandle(userId);
  return parseBestOffers(text, ownHandle);
}

/**
 * Parse a GetBestOffers response and keep only the offers this account
 * RECEIVED.
 *
 * US-2816: separated from the network call on purpose. The direction rule is
 * the part that was wrong and the part with no test — it decided that an offer
 * the owner SENT was one to email them about and offer them an Accept button.
 * Pure in, pure out: a recorded response and a handle, no eBay and no database.
 *
 * `ownHandle` null means the account's own username is unknown, and then
 * NOTHING is filtered. That is the safe direction: the cost of keeping a sent
 * offer is a wrong email, the cost of dropping wrongly is every real offer
 * disappearing in silence.
 */
export function parseBestOffers(
  text: string,
  ownHandle: string | null,
): IncomingBestOffer[] {
  const root = (offersParser.parse(text) as {
    GetBestOffersResponse?: {
      Ack?: string;
      Errors?: Array<{ LongMessage?: string; ErrorCode?: string }>;
      ItemBestOffersArray?: { ItemBestOffers?: RawItemBestOffers[] };
    };
  }).GetBestOffersResponse;
  if (!root || root.Ack === "Failure") {
    throw new Error(
      `eBay GetBestOffers (Failure): ${root?.Errors?.[0]?.LongMessage ?? "no message"}`,
    );
  }
  const own = ownHandle?.trim().toLowerCase() || null;
  const groups = root.ItemBestOffersArray?.ItemBestOffers ?? [];
  const out: IncomingBestOffer[] = [];
  let sentByUs = 0;
  for (const group of groups) {
    const itemId = asString(group.Item?.ItemID) ?? "";
    const itemTitle = asString(group.Item?.Title);
    const offers = group.BestOfferArray?.BestOffer ?? [];
    for (const offer of offers) {
      const id = asString(offer.BestOfferID);
      if (!id) continue;
      const buyer = asString(offer.Buyer?.UserID);
      // An offer whose buyer is this very account is one we SENT. eBay
      // usernames are case-insensitive, so compare folded.
      if (own && buyer && buyer.toLowerCase() === own) {
        sentByUs++;
        continue;
      }
      const price = asPriceValue(offer.Price);
      out.push({
        bestOfferId: id,
        itemId,
        itemTitle,
        buyerUsername: buyer,
        price: price.value,
        currency: price.currency,
        quantity: asNumber(offer.Quantity),
        status: asString(offer.Status),
        message: asString(offer.BuyerMessage),
        expiresAt: asString(offer.ExpirationTime),
      });
    }
  }
  if (sentByUs > 0) {
    // Worth a line: it is the only evidence that the filter is doing anything,
    // and its absence in a log where offers ARE being dropped would mean the
    // handle went missing.
    console.log(
      `[ebay-trading] getBestOffers dropped ${sentByUs} offer(s) this account sent`,
    );
  }
  return out;
}

interface RawItemBestOffers {
  Item?: { ItemID?: unknown; Title?: unknown };
  BestOfferArray?: { BestOffer?: RawBestOffer[] };
}
interface RawBestOffer {
  BestOfferID?: unknown;
  Buyer?: { UserID?: unknown };
  Price?: unknown;
  Quantity?: unknown;
  Status?: unknown;
  BuyerMessage?: unknown;
  ExpirationTime?: unknown;
}

export type BestOfferAction = "Accept" | "Decline" | "Counter";

/// Accepts, declines, or counters an incoming best offer. A counter requires
/// `counterPrice` (and optional `counterQuantity`, default 1).
export async function respondToBestOffer(
  userId: string,
  args: {
    itemId: string;
    bestOfferId: string;
    action: BestOfferAction;
    counterPrice?: number;
    counterQuantity?: number;
    sellerMessage?: string;
  },
  // US-1507: respond via the connection that owns the listing (null → primary),
  // so a multi-store seller's accept/counter lands on the account eBay expects.
  connectionId?: string,
): Promise<void> {
  const lines = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<RespondToBestOfferRequest xmlns="urn:ebay:apis:eBLBaseComponents">`,
    `  <ItemID>${xmlEscape(args.itemId)}</ItemID>`,
    `  <BestOfferID>${xmlEscape(args.bestOfferId)}</BestOfferID>`,
    `  <Action>${xmlEscape(args.action)}</Action>`,
  ];
  if (args.action === "Counter") {
    if (args.counterPrice == null) {
      throw new Error("counterPrice is required to counter a best offer.");
    }
    lines.push(
      `  <CounterOfferPrice currencyID="${xmlEscape(getMarketplaceCurrency())}">${xmlEscape(String(args.counterPrice))}</CounterOfferPrice>`,
      `  <CounterOfferQuantity>${xmlEscape(String(args.counterQuantity ?? 1))}</CounterOfferQuantity>`,
    );
  }
  if (args.sellerMessage) {
    lines.push(`  <SellerResponse>${xmlEscape(args.sellerMessage)}</SellerResponse>`);
  }
  lines.push(`</RespondToBestOfferRequest>`);

  const { ok, status, text } = await tradingCall(
    userId,
    "RespondToBestOffer",
    lines.join("\n"),
    connectionId,
  );
  if (!ok) {
    throw new Error(`eBay RespondToBestOffer failed (${status}): ${text.slice(0, 300)}`);
  }
  const root = (getItemParser.parse(text) as {
    RespondToBestOfferResponse?: {
      Ack?: string;
      Errors?: Array<{ LongMessage?: string }>;
    };
  }).RespondToBestOfferResponse;
  if (!root || root.Ack === "Failure") {
    throw new Error(
      `eBay RespondToBestOffer (Failure): ${root?.Errors?.[0]?.LongMessage ?? "no message"}`,
    );
  }
}

// Site → ISO currency for the counter-offer amount (Trading wants currencyID).
function getMarketplaceCurrency(): string {
  switch (getMarketplaceId()) {
    case "EBAY_GB": return "GBP";
    case "EBAY_DE":
    case "EBAY_FR":
    case "EBAY_IT":
    case "EBAY_ES": return "EUR";
    case "EBAY_AU": return "AUD";
    case "EBAY_CA": return "CAD";
    default: return "USD";
  }
}

const messagesParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "_",
  textNodeName: "#text",
  isArray: (name) => name === "Errors" || name === "MemberMessage",
});

export interface BuyerMessage {
  messageId: string;
  itemId: string | null;
  senderUsername: string | null;
  subject: string | null;
  body: string | null;
  creationDate: string | null;
  answered: boolean;
}

/// Lists buyer member-messages from the last `days` (default 30).
export async function getMemberMessages(
  userId: string,
  days = 30,
): Promise<BuyerMessage[]> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const body = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<GetMemberMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">`,
    `  <MailMessageType>All</MailMessageType>`,
    `  <StartCreationTime>${start.toISOString()}</StartCreationTime>`,
    `  <EndCreationTime>${end.toISOString()}</EndCreationTime>`,
    `</GetMemberMessagesRequest>`,
  ].join("\n");

  const { ok, status, text } = await tradingCall(userId, "GetMemberMessages", body);
  if (!ok) {
    throw new Error(`eBay GetMemberMessages failed (${status}): ${text.slice(0, 300)}`);
  }
  const root = (messagesParser.parse(text) as {
    GetMemberMessagesResponse?: {
      Ack?: string;
      Errors?: Array<{ LongMessage?: string }>;
      MemberMessage?: { MemberMessageExchange?: RawMessageExchange[] };
    };
  }).GetMemberMessagesResponse;
  if (!root || root.Ack === "Failure") {
    throw new Error(
      `eBay GetMemberMessages (Failure): ${root?.Errors?.[0]?.LongMessage ?? "no message"}`,
    );
  }
  let exchanges = root.MemberMessage?.MemberMessageExchange ?? [];
  if (!Array.isArray(exchanges)) exchanges = [exchanges];
  const out: BuyerMessage[] = [];
  for (const ex of exchanges) {
    const q = ex.Question;
    const id = asString(q?.MessageID);
    if (!id) continue;
    out.push({
      messageId: id,
      itemId: asString(q?.ItemID),
      senderUsername: asString(q?.SenderID),
      subject: asString(q?.Subject),
      body: asString(q?.Body),
      creationDate: asString(q?.CreationDate),
      answered: asString(ex.MessageStatus) === "Answered",
    });
  }
  return out;
}

interface RawMessageExchange {
  Question?: {
    MessageID?: unknown;
    ItemID?: unknown;
    SenderID?: unknown;
    Subject?: unknown;
    Body?: unknown;
    CreationDate?: unknown;
  };
  MessageStatus?: unknown;
}

/// Replies to a buyer's member message (AddMemberMessageRTQ = respond to question).
export async function replyToMemberMessage(
  userId: string,
  args: {
    itemId: string;
    parentMessageId: string;
    recipientId: string;
    body: string;
  },
): Promise<void> {
  const xml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<AddMemberMessageRTQRequest xmlns="urn:ebay:apis:eBLBaseComponents">`,
    `  <ItemID>${xmlEscape(args.itemId)}</ItemID>`,
    `  <MemberMessage>`,
    `    <Body>${xmlEscape(args.body)}</Body>`,
    `    <ParentMessageID>${xmlEscape(args.parentMessageId)}</ParentMessageID>`,
    `    <RecipientID>${xmlEscape(args.recipientId)}</RecipientID>`,
    `  </MemberMessage>`,
    `</AddMemberMessageRTQRequest>`,
  ].join("\n");

  const { ok, status, text } = await tradingCall(userId, "AddMemberMessageRTQ", xml);
  if (!ok) {
    throw new Error(`eBay AddMemberMessageRTQ failed (${status}): ${text.slice(0, 300)}`);
  }
  const root = (getItemParser.parse(text) as {
    AddMemberMessageRTQResponse?: {
      Ack?: string;
      Errors?: Array<{ LongMessage?: string }>;
    };
  }).AddMemberMessageRTQResponse;
  if (!root || root.Ack === "Failure") {
    throw new Error(
      `eBay AddMemberMessageRTQ (Failure): ${root?.Errors?.[0]?.LongMessage ?? "no message"}`,
    );
  }
}

// ── US-1047: leave buyer feedback after a sale (Trading API) ─────────────────
//
// Leaving feedback is a legacy-only call (no REST equivalent). eBay policy:
// sellers may ONLY leave POSITIVE feedback for buyers, so CommentType is fixed.
// Identify the transaction by ItemID + TransactionID, or by OrderLineItemID.
// Idempotency: eBay rejects a second feedback for the same transaction; we treat
// that as success (alreadyLeft) so an automation never errors on a re-run.

export interface LeaveFeedbackArgs {
  itemId?: string;
  transactionId?: string;
  orderLineItemId?: string;
  targetUser: string; // buyer's eBay username
  comment: string;
}

// eBay's "feedback already left for this transaction" failure (code varies by
// locale/version) — match on the stable wording. Pure.
export function isFeedbackAlreadyLeft(message: string): boolean {
  return /feedback.*already|already.*feedback|duplicate feedback/i.test(message);
}

// Build the LeaveFeedback XML. Pure + unit-tested. Requires either an
// OrderLineItemID or an ItemID+TransactionID pair to identify the transaction.
export function buildLeaveFeedbackXml(args: LeaveFeedbackArgs): string {
  const lines = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<LeaveFeedbackRequest xmlns="urn:ebay:apis:eBLBaseComponents">`,
    `  <TargetUser>${xmlEscape(args.targetUser)}</TargetUser>`,
    `  <CommentType>Positive</CommentType>`,
    `  <CommentText>${xmlEscape(args.comment.slice(0, 500))}</CommentText>`,
  ];
  if (args.orderLineItemId) {
    lines.push(`  <OrderLineItemID>${xmlEscape(args.orderLineItemId)}</OrderLineItemID>`);
  } else {
    if (!args.itemId || !args.transactionId) {
      throw new Error(
        "leaveFeedback needs orderLineItemId OR itemId+transactionId.",
      );
    }
    lines.push(
      `  <ItemID>${xmlEscape(args.itemId)}</ItemID>`,
      `  <TransactionID>${xmlEscape(args.transactionId)}</TransactionID>`,
    );
  }
  lines.push(`</LeaveFeedbackRequest>`);
  return lines.join("\n");
}

// Leave positive feedback for the buyer on a completed transaction. Returns
// { alreadyLeft } so callers can distinguish a fresh leave from an idempotent
// no-op. Throws only on a genuine (non-duplicate) failure.
export async function leaveFeedback(
  userId: string,
  args: LeaveFeedbackArgs,
): Promise<{ alreadyLeft: boolean }> {
  const xml = buildLeaveFeedbackXml(args);
  const { ok, status, text } = await tradingCall(userId, "LeaveFeedback", xml);
  if (!ok) {
    if (isFeedbackAlreadyLeft(text)) return { alreadyLeft: true };
    throw new Error(`eBay LeaveFeedback failed (${status}): ${text.slice(0, 300)}`);
  }
  const root = (getItemParser.parse(text) as {
    LeaveFeedbackResponse?: {
      Ack?: string;
      Errors?: Array<{ LongMessage?: string }>;
    };
  }).LeaveFeedbackResponse;
  if (!root || root.Ack === "Failure") {
    const msg = root?.Errors?.[0]?.LongMessage ?? "no message";
    if (isFeedbackAlreadyLeft(msg)) return { alreadyLeft: true };
    throw new Error(`eBay LeaveFeedback (Failure): ${msg}`);
  }
  return { alreadyLeft: false };
}

// US-1047 (id resolution): the modern Sell APIs give us a Fulfillment lineItemId,
// but LeaveFeedback needs the LEGACY ItemID + TransactionID. GetOrders bridges
// them: it accepts the same order id and returns each transaction's legacy ids +
// the buyer's username. Used by the /feedback route so the UI only needs the
// order id we already store on the sale.

const ordersParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "_",
  textNodeName: "#text",
  isArray: (name) =>
    name === "Errors" || name === "Order" || name === "Transaction",
});

export interface OrderLegacyLineItem {
  itemId: string;
  transactionId: string;
  buyerUsername: string | null;
}

interface RawTxn {
  TransactionID?: unknown;
  Item?: { ItemID?: unknown };
  Buyer?: { UserID?: unknown };
}
interface RawOrder {
  TransactionArray?: { Transaction?: RawTxn[] };
}

export async function getOrderLegacyLineItems(
  userId: string,
  orderId: string,
): Promise<OrderLegacyLineItem[]> {
  const body = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">`,
    `  <OrderIDArray><OrderID>${xmlEscape(orderId)}</OrderID></OrderIDArray>`,
    `  <OrderRole>Seller</OrderRole>`,
    `  <DetailLevel>ReturnAll</DetailLevel>`,
    `</GetOrdersRequest>`,
  ].join("\n");

  const { ok, status, text } = await tradingCall(userId, "GetOrders", body);
  if (!ok) {
    throw new Error(`eBay GetOrders failed (${status}): ${text.slice(0, 300)}`);
  }
  const root = (ordersParser.parse(text) as {
    GetOrdersResponse?: {
      Ack?: string;
      Errors?: Array<{ LongMessage?: string }>;
      OrderArray?: { Order?: RawOrder[] };
    };
  }).GetOrdersResponse;
  if (!root || root.Ack === "Failure") {
    throw new Error(
      `eBay GetOrders (Failure): ${root?.Errors?.[0]?.LongMessage ?? "no message"}`,
    );
  }
  const out: OrderLegacyLineItem[] = [];
  for (const order of root.OrderArray?.Order ?? []) {
    for (const t of order.TransactionArray?.Transaction ?? []) {
      const itemId = asString(t.Item?.ItemID);
      const transactionId = asString(t.TransactionID);
      if (itemId && transactionId) {
        out.push({
          itemId,
          transactionId,
          buyerUsername: asString(t.Buyer?.UserID),
        });
      }
    }
  }
  return out;
}
