// eBay Trading API client — covers listings created outside the Sell
// Inventory API (Seller Hub, legacy ListItem, third-party tools). These
// listings never become "inventory_items" on the new REST surface, so
// /sell/inventory/v1/inventory_item can't see them.
//
// We use the Trading API GetMyeBaySelling call. Auth is the same OAuth user
// access token we already store — passed via the X-EBAY-API-IAF-TOKEN header
// (Trading API's name for "Identity Access Federation token", which is what
// eBay calls an OAuth bearer when used with the legacy XML surface).

import { XMLParser } from "fast-xml-parser";
import {
  getEbayEnv,
  getMarketplaceId,
  getUserAccessToken,
} from "./ebay-client.ts";

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

  const res = await fetch(`${tradingHost()}/ws/api.dll`, {
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
  });

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

    const res = await fetch(`${tradingHost()}/ws/api.dll`, {
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
    });

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
