// US-1474: eBay Sell **Feed API** (LMS reports) for bulk sync at scale.
//
// The paged REST sync (`listRecentOrders`) is one 200-row page per call and is
// rate-limit-fragile for high-volume sellers. The Feed API instead runs an
// async report task (create → poll → download a gzipped report) that returns
// the whole set in one file. This module implements the **order report**
// (LMS_ORDER_REPORT) path only.
//
// ⚠️ SCOPE — the LMS **active-inventory** report is deliberately NOT implemented:
// eBay's active-inventory report carries only ItemID/SKU/Price/Quantity, so it
// CANNOT reconstruct a `RemoteOffer` (no offerId / listingStatus / category /
// description / aspects) and would blank those columns on the listings upsert.
// It is a price/quantity report, not an offer-sync replacement. See US-1474.
//
// ⚠️ ENABLEMENT — this path is gated behind `EBAY_FEED_SYNC` (default OFF) AND a
// catalog-size threshold; below either, sync uses the unchanged paged REST path.
// Two fidelity caveats MUST be validated against a real high-volume account
// before enabling in prod:
//   1. Order status fields (fulfillment/payment) are best-effort mapped from the
//      Trading-schema OrderReport, not the Sell `orderFulfillmentStatus` enum.
//   2. Line items are keyed by Trading `TransactionID` (the id the OrderReport
//      provides), NOT the Sell `lineItemId` the REST path uses. Since the
//      `sales` upsert dedupes on `line_item_id`, switching a seller between the
//      Feed and REST paths mid-history re-keys and can duplicate recent sales.
//      Keep a seller on ONE path; a threshold is stable per seller by design.

import { XMLParser } from "fast-xml-parser";
import {
  apiHost,
  countedEbayFetch,
  getMarketplaceId,
  getUserAccessToken,
} from "./ebay-client.ts";
import { isRetryableError, withRetry } from "./retry.ts";
import type { RemoteOrder, RemoteOrderLineItem } from "./ebay-client.ts";

// Feed report download can be a large file — give it a longer deadline than the
// 20s per-call budget the JSON endpoints use.
const FEED_JSON_TIMEOUT_MS = 20_000;
const FEED_DOWNLOAD_TIMEOUT_MS = 60_000;

// Catalog-size floor at/above which a seller is considered "high volume" and the
// Feed path is preferred (when the flag is on). Sized well above a typical
// reseller so the default paged path stays the norm. Env-overridable for tuning.
const DEFAULT_FEED_MIN_CATALOG = 1_000;

// LMS order reports cap the lookback window; clamp the "from" date to stay well
// inside eBay's limit on a first/backfill sync.
const ORDER_REPORT_MAX_LOOKBACK_DAYS = 90;

function readEnv(name: string): string | null {
  const v = Deno.env.get(name);
  if (v == null) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** True when the Feed sync path is switched on via env (default OFF). */
export function feedSyncEnabled(): boolean {
  const v = (readEnv("EBAY_FEED_SYNC") ?? "").toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

function feedMinCatalog(): number {
  const raw = Number(readEnv("EBAY_FEED_SYNC_MIN_CATALOG"));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FEED_MIN_CATALOG;
}

/**
 * Pure threshold decision: is this catalog big enough to prefer the Feed path?
 * Independent of the on/off flag so it's unit-testable in isolation.
 */
export function catalogAboveFeedThreshold(catalogSize: number): boolean {
  return catalogSize >= feedMinCatalog();
}

/** Combined gate: flag ON and catalog above the threshold. */
export function shouldUseFeedForOrders(catalogSize: number): boolean {
  return feedSyncEnabled() && catalogAboveFeedThreshold(catalogSize);
}

// ── HTTP: authed JSON create/poll + raw gzipped download ─────────────────────
//
// Reuses the client's token entry point + host + marketplace header, but does
// NOT route through the internal `fetchAuthed` (which JSON.parses every body —
// wrong for the gzipped result file). Retries transient errors via `withRetry`.

function feedRequest(
  userId: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return withRetry(async () => {
    const token = await getUserAccessToken(userId);
    // US-3042: counted per attempt, inside withRetry.
    const res = await countedEbayFetch(
      `${apiHost()}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
      },
      timeoutMs,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(
        `eBay Feed ${path} failed (${res.status}): ${body.slice(0, 300)}`,
      ) as Error & { status?: number; retryAfterMs?: number | null };
      err.status = res.status;
      const ra = res.headers.get("retry-after");
      if (ra) {
        const secs = Number(ra);
        if (Number.isFinite(secs)) err.retryAfterMs = secs * 1000;
      }
      throw err;
    }
    return res;
  }, { isRetryable: isRetryableError, maxRetryAfterMs: 30_000 });
}

export interface FeedTaskStatus {
  taskId: string;
  status: string; // QUEUED | IN_PROCESS | COMPLETED | COMPLETED_WITH_ERROR | FAILED
}

/**
 * Create an LMS order-report task covering orders modified since `sinceISO`
 * (clamped to the report's max lookback). Returns the taskId (parsed from the
 * Location header, falling back to the JSON body).
 */
export async function createOrderReportTask(
  userId: string,
  sinceISO: string | null,
  nowMs: number,
): Promise<string> {
  const to = new Date(nowMs).toISOString();
  const floorMs = nowMs - ORDER_REPORT_MAX_LOOKBACK_DAYS * 86_400_000;
  const fromMs = sinceISO ? Math.max(new Date(sinceISO).getTime(), floorMs) : floorMs;
  const from = new Date(fromMs).toISOString();

  const res = await feedRequest(
    userId,
    "/sell/feed/v1/order_task",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feedType: "LMS_ORDER_REPORT",
        schemaVersion: "1.0",
        filterCriteria: { modifiedDateRange: { from, to } },
      }),
    },
    FEED_JSON_TIMEOUT_MS,
  );

  // 202/201 Created: the taskId is the last segment of the Location header.
  const loc = res.headers.get("location");
  if (loc) {
    const id = loc.split("/").filter(Boolean).pop();
    if (id) return id;
  }
  const body = await res.json().catch(() => ({})) as { taskId?: string };
  if (body.taskId) return body.taskId;
  throw new Error("eBay Feed order_task created but returned no taskId.");
}

/** Poll a single task's status. */
export async function getFeedTask(
  userId: string,
  taskId: string,
): Promise<FeedTaskStatus> {
  const res = await feedRequest(
    userId,
    `/sell/feed/v1/task/${encodeURIComponent(taskId)}`,
    { method: "GET" },
    FEED_JSON_TIMEOUT_MS,
  );
  const json = await res.json().catch(() => ({})) as {
    taskId?: string;
    status?: string;
  };
  return { taskId: json.taskId ?? taskId, status: json.status ?? "UNKNOWN" };
}

/** Download + gunzip the completed task's result file, returning report text. */
export async function downloadFeedResultFile(
  userId: string,
  taskId: string,
): Promise<string> {
  const res = await feedRequest(
    userId,
    `/sell/feed/v1/task/${encodeURIComponent(taskId)}/download_result_file`,
    { method: "GET", headers: { Accept: "application/octet-stream" } },
    FEED_DOWNLOAD_TIMEOUT_MS,
  );
  return gunzipResponseText(res);
}

/**
 * Decompress a gzipped response body to UTF-8 text via Deno's native
 * DecompressionStream (no dependency). Extracted so it's unit-testable with a
 * canned gzipped Response, independent of auth/network.
 */
export async function gunzipResponseText(res: Response): Promise<string> {
  if (!res.body) return "";
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  return new TextDecoder().decode(buf);
}

// ── Poll loop + orchestration (DI-friendly for tests) ────────────────────────

export interface FeedReportDeps {
  createTask: (userId: string, sinceISO: string | null, nowMs: number) => Promise<string>;
  getTask: (userId: string, taskId: string) => Promise<FeedTaskStatus>;
  download: (userId: string, taskId: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDeps: FeedReportDeps = {
  createTask: createOrderReportTask,
  getTask: getFeedTask,
  download: downloadFeedResultFile,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 60; // ~3 min at 3s — reports for a sync window are quick

const TERMINAL_OK = new Set(["COMPLETED", "COMPLETED_WITH_ERROR"]);
const TERMINAL_FAIL = new Set(["FAILED"]);

/** Poll until the task reaches a terminal state or the attempt budget runs out. */
export async function pollFeedTask(
  userId: string,
  taskId: string,
  deps: FeedReportDeps = defaultDeps,
): Promise<FeedTaskStatus> {
  let last: FeedTaskStatus = { taskId, status: "UNKNOWN" };
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    last = await deps.getTask(userId, taskId);
    if (TERMINAL_OK.has(last.status) || TERMINAL_FAIL.has(last.status)) return last;
    await deps.sleep(POLL_INTERVAL_MS);
  }
  return last;
}

/**
 * Run the full order-report cycle (create → poll → download → parse) and return
 * orders in the SAME `RemoteOrder[]` shape the paged sync produces, so the
 * downstream consumer needs no changes. Throws on task failure/timeout so the
 * caller can fall back to the paged path.
 */
export async function runOrderReport(
  userId: string,
  sinceISO: string | null,
  deps: FeedReportDeps = defaultDeps,
): Promise<RemoteOrder[]> {
  const taskId = await deps.createTask(userId, sinceISO, deps.now());
  const task = await pollFeedTask(userId, taskId, deps);
  if (!TERMINAL_OK.has(task.status)) {
    throw new Error(`eBay Feed order report did not complete (status ${task.status}).`);
  }
  const text = await deps.download(userId, taskId);
  return parseOrderReport(text);
}

// ── OrderReport XML → RemoteOrder[] ──────────────────────────────────────────
//
// The LMS OrderReport uses eBay's eBLBaseComponents schema — the same
// <Order>/<TransactionArray>/<Transaction>/<Item> shape the Trading API returns
// (see ebay-trading.ts). Parse defensively: skip malformed orders, never throw.

const reportParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "_",
  textNodeName: "#text",
  parseTagValue: false, // keep values as strings; we coerce explicitly
  isArray: (name) => name === "Order" || name === "Transaction",
});

function asString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function asNumber(v: unknown, fallback: number): number {
  const n = Number(asString(v));
  return Number.isFinite(n) ? n : fallback;
}

// A money node is either a bare value or { "#text", "_currencyID" }.
function money(node: unknown): { value: string; currency: string } | null {
  if (node == null) return null;
  if (typeof node === "string" || typeof node === "number") {
    const v = String(node).trim();
    return v ? { value: v, currency: "USD" } : null;
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    const v = asString(o["#text"]);
    if (v == null) return null;
    return { value: v, currency: asString(o["_currencyID"]) ?? "USD" };
  }
  return null;
}

interface RawTxn {
  TransactionID?: unknown;
  Item?: { ItemID?: unknown; SKU?: unknown; Title?: unknown };
  QuantityPurchased?: unknown;
  TransactionPrice?: unknown;
  Taxes?: { TotalTaxAmount?: unknown };
  ShippedTime?: unknown;
}
interface RawOrder {
  OrderID?: unknown;
  OrderStatus?: unknown;
  CreatedTime?: unknown;
  CheckoutStatus?: { Status?: unknown };
  BuyerUserID?: unknown;
  Total?: unknown;
  ShippingServiceSelected?: { ShippingServiceCost?: unknown };
  TransactionArray?: { Transaction?: RawTxn[] };
}

export function parseOrderReport(xml: string): RemoteOrder[] {
  if (!xml || !xml.trim()) return [];
  let root: { OrderReport?: { Order?: RawOrder[] } };
  try {
    root = reportParser.parse(xml) as { OrderReport?: { Order?: RawOrder[] } };
  } catch {
    return [];
  }
  const orders = root.OrderReport?.Order ?? [];
  const out: RemoteOrder[] = [];
  for (const o of orders) {
    const orderId = asString(o.OrderID);
    if (!orderId) continue;

    const txns = o.TransactionArray?.Transaction ?? [];
    const lineItems: RemoteOrderLineItem[] = txns.map((t) => {
      const itemCost = money(t.TransactionPrice);
      return {
        // ⚠️ Trading TransactionID, NOT the Sell lineItemId — see module header.
        lineItemId: asString(t.TransactionID),
        sku: asString(t.Item?.SKU),
        legacyItemId: asString(t.Item?.ItemID),
        title: asString(t.Item?.Title),
        quantity: asNumber(t.QuantityPurchased, 1),
        itemCost,
        shippingCost: null, // OrderReport carries shipping at the order level only
        taxes: money(t.Taxes?.TotalTaxAmount),
      };
    });

    // Best-effort status mapping from the Trading schema (documented caveat).
    const orderStatus = (asString(o.OrderStatus) ?? "").toLowerCase();
    const cancelState = orderStatus.includes("cancel") ? "CANCELED" : "NONE_REQUESTED";
    const checkout = (asString(o.CheckoutStatus?.Status) ?? "").toLowerCase();
    const orderPaymentStatus = checkout === "complete" ? "PAID" : null;
    const allShipped = txns.length > 0 && txns.every((t) => asString(t.ShippedTime) != null);
    const orderFulfillmentStatus = allShipped ? "FULFILLED" : null;
    const created = asString(o.CreatedTime);

    out.push({
      orderId,
      creationDate: created,
      // OrderReport has no reliable per-order modified time; reuse created so
      // the incremental cursor still advances.
      lastModifiedDate: created,
      orderFulfillmentStatus,
      orderPaymentStatus,
      cancelState,
      buyerUsername: asString(o.BuyerUserID),
      totalAmount: money(o.Total),
      shippingTotal: money(o.ShippingServiceSelected?.ShippingServiceCost),
      lineItems,
    });
  }
  return out;
}
