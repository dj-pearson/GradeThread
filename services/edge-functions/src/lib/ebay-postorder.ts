// eBay Post-Order API v2 client (US-1043): returns + cancellations management.
//
// Until now FlipDesk only READ cancel/refund STATUS off the Fulfillment order
// pull (it could count a cancelled order but not act on it). This module adds
// the management actions sellers need:
//   • Returns:       search, get, decide (approve / decline), issue refund
//   • Cancellations: search, get, approve, reject
//
// AUTH QUIRK: the Post-Order API is an older eBay surface and does NOT use the
// `Bearer <token>` scheme the Sell APIs use — it requires `Authorization:
// IAF <user access token>`. So it can't go through ebay-client's fetchAuthed;
// this module has its own postOrderFetch built on the same getUserAccessToken.
// It lives at apiHost()/post-order/v2 (api.ebay.com in prod). No extra OAuth
// scope is required beyond the standard user grant.
//
// Every route that calls these MUST tenant-scope first (resolve the local sale
// and verify ownership) — these helpers take eBay-side ids only and perform no
// ownership checks themselves.

import {
  apiHost,
  ebayId,
  ebayResilientFetch,
  getMarketplaceId,
  getUserAccessToken,
} from "./ebay-client.ts";

const POST_ORDER_TIMEOUT_MS = 20_000;

export interface PostOrderError extends Error {
  status: number;
  ebayErrorIds?: number[];
}

// Single authed call to the Post-Order API. Mirrors ebay-client's
// fetchAuthedOnce error shape (status + parsed errorIds) so callers can branch
// on a stable id (e.g. an already-decided return) instead of message regexes.
// US-2928/US-2929: exported so the inquiry and case modules reuse this exact
// call shape rather than each re-deriving the IAF auth scheme, the /post-order/v2
// host and the errorId parsing. Three copies of that would be three chances to
// get the auth header wrong in a way that only shows up against real eBay.
export async function postOrderFetch<T>(
  userId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = await getUserAccessToken(userId);
  // US-1966: route through the hardened path (breaker + withRetry + Retry-After
  // + timeout) like the main Sell path, preserving the Post-Order IAF auth
  // scheme + /post-order/v2 host. 429/5xx back off; other responses (2xx, 404,
  // business 4xx) are returned unchanged so the errorId branch below still runs.
  const res = await ebayResilientFetch(
    `${apiHost()}/post-order/v2${path}`,
    {
      ...init,
      headers: {
        // Post-Order API requires the IAF scheme, NOT Bearer.
        Authorization: `IAF ${token}`,
        "Content-Type": "application/json",
        "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
        ...(init?.headers ?? {}),
      },
    },
    { label: `Post-Order ${init?.method ?? "GET"} ${path}`, timeoutMs: POST_ORDER_TIMEOUT_MS },
  );

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(
      `eBay Post-Order ${init?.method ?? "GET"} ${path} failed (${res.status}): ${
        text.slice(0, 500)
      }`,
    ) as PostOrderError;
    err.status = res.status;
    try {
      const parsed = JSON.parse(text) as {
        errors?: Array<{ errorId?: number }>;
      };
      if (Array.isArray(parsed.errors)) {
        err.ebayErrorIds = parsed.errors
          .map((e) => e.errorId)
          .filter((id): id is number => typeof id === "number");
      }
    } catch {
      // Non-JSON error body — leave ebayErrorIds undefined.
    }
    throw err;
  }
  const body = await res.text();
  return (body ? JSON.parse(body) : {}) as T;
}

// ── Returns ─────────────────────────────────────────────────────────

export type ReturnDecision = "APPROVE" | "DECLINE";

export interface ReturnSummary {
  returnId: string;
  state: string | null; // e.g. RETURN_REQUESTED, ITEM_SHIPPED, REFUND_OVERDUE…
  orderId: string | null;
  itemId: string | null;
  reason: string | null;
  creationDate: string | null;
  /**
   * US-2933: the date eBay acts on if the seller does not.
   *
   * Read here rather than only on the disputes surface because the deadline
   * clock is the same feature for all four case types, and a return with no
   * readable deadline renders no badge rather than an invented one.
   */
  respondBy: string | null;
  buyerUsername: string | null;
}

interface RawReturn {
  returnId?: string;
  status?: { state?: string };
  state?: string;
  sellerLatestRefundInfo?: unknown;
  legacyOrderId?: string;
  orderId?: string;
  buyerLoginName?: string;
  buyerUsername?: string;
  respondByDate?: { value?: string } | string;
  sellerResponseDue?: { value?: string } | string;
  detail?: {
    buyerSelectedReturnReason?: string;
    item?: { itemId?: string };
    respondByDate?: { value?: string } | string;
  };
  buyerSelectedReturnReason?: string;
  creationInfo?: { creationDate?: { value?: string } };
}

function returnDateValue(v: { value?: string } | string | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : (v.value ?? null);
}

// Normalize the (deeply nested, version-variant) Post-Order return shape into a
// flat summary the UI/local-state code can rely on. Pure — unit-tested.
export function normalizeReturn(raw: RawReturn): ReturnSummary {
  return {
    returnId: raw.returnId ?? "",
    state: raw.status?.state ?? raw.state ?? null,
    // US-2933: this was hard-coded null. Reading it can only improve on that —
    // every caller already handles a null order id, and a real one links the
    // return to the sale and the graded item.
    orderId: ebayId(raw.legacyOrderId) ?? ebayId(raw.orderId),
    itemId: ebayId(raw.detail?.item?.itemId),
    reason: raw.detail?.buyerSelectedReturnReason ??
      raw.buyerSelectedReturnReason ?? null,
    creationDate: raw.creationInfo?.creationDate?.value ?? null,
    respondBy: returnDateValue(raw.respondByDate) ??
      returnDateValue(raw.sellerResponseDue) ??
      returnDateValue(raw.detail?.respondByDate),
    buyerUsername: raw.buyerLoginName ?? raw.buyerUsername ?? null,
  };
}

export async function searchReturns(
  userId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<ReturnSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const data = await postOrderFetch<{ members?: RawReturn[] }>(
    userId,
    `/return/search?limit=${limit}&offset=${offset}`,
  );
  return (data.members ?? []).map(normalizeReturn);
}

// US-2363: `getReturn` was deleted here. Every caller reaches a return through
// the search above and then acts on it by id, so the single-resource GET was a
// round trip nobody needed — and re-adding it is five lines the day a surface
// wants to refresh one row. Same for `getCancellation` below.

// Approve or decline a return request. Decline requires a reason+comment per
// eBay policy; approve is a bare decision.
export async function decideReturn(
  userId: string,
  returnId: string,
  decision: ReturnDecision,
  comments?: string,
): Promise<void> {
  const body: Record<string, unknown> = { decision };
  if (decision === "DECLINE") {
    body.declineReason = "OTHER";
    if (comments) body.comments = { content: comments.slice(0, 1000) };
  } else if (comments) {
    body.comments = { content: comments.slice(0, 1000) };
  }
  await postOrderFetch<unknown>(
    userId,
    `/return/${encodeURIComponent(returnId)}/decide`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

// Issue the buyer's refund for an approved return.
export async function issueReturnRefund(
  userId: string,
  returnId: string,
  comments?: string,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (comments) body.comments = { content: comments.slice(0, 1000) };
  await postOrderFetch<unknown>(
    userId,
    `/return/${encodeURIComponent(returnId)}/issue_refund`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/**
 * US-2930: tell eBay the returned item arrived.
 *
 * Not marking a return received leaves eBay's clock running on an item already
 * back in the seller's hands, and the clock ends in an automatic refund. This
 * is the one action in the return flow whose ABSENCE costs money silently.
 */
export async function markReturnReceived(
  userId: string,
  returnId: string,
  comments?: string,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (comments) body.comments = { content: comments.slice(0, 1000) };
  await postOrderFetch<unknown>(
    userId,
    `/return/${encodeURIComponent(returnId)}/mark_as_received`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/**
 * US-2932: message the buyer inside the return.
 *
 * A separate conversation from the member-message inbox on the Offers page, and
 * the distinction is not cosmetic: eBay reads the RETURN thread when it decides
 * a case, and a partial-refund offer made in a member message does not appear
 * there. So a seller who negotiates in the wrong inbox has an agreement eBay
 * cannot see.
 */
export async function sendReturnMessage(
  userId: string,
  returnId: string,
  body: string,
): Promise<void> {
  await postOrderFetch<unknown>(
    userId,
    `/return/${encodeURIComponent(returnId)}/message`,
    {
      method: "POST",
      // eBay caps the note; slice rather than let it 400 after the round trip.
      body: JSON.stringify({ message: { content: body.slice(0, 1000) } }),
    },
  );
}

// ── Return shipping label / tracking (US-2931) ──────────────────────
//
// A seller deciding what to do about a return needs to know whether the buyer
// has actually posted the item. That fact lives on the return DETAIL, not on
// the search summary, which is why this is a second call rather than another
// field on ReturnSummary.
//
// Read off the detail rather than the dedicated label endpoint on purpose: the
// detail read is one shape eBay has kept, and it carries the tracking whether
// the label was bought through eBay or supplied by the buyer. A label endpoint
// only answers for eBay-issued labels, so a buyer who posted it themselves
// would read as "not shipped" — the exact wrong answer.

export interface ReturnShipmentInfo {
  carrier: string | null;
  trackingNumber: string | null;
  labelStatus: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
}

interface RawShipmentTracking {
  shippingCarrierName?: string;
  carrierUsed?: string;
  trackingNumber?: string;
  status?: string;
  shipmentStatus?: string;
  shippedDate?: { value?: string } | string;
  deliveredDate?: { value?: string } | string;
}

interface RawReturnDetail {
  returnShipmentInfo?: RawShipmentTracking | RawShipmentTracking[];
  buyerShipmentTracking?: RawShipmentTracking | RawShipmentTracking[];
  detail?: {
    returnShipmentInfo?: RawShipmentTracking | RawShipmentTracking[];
    buyerShipmentTracking?: RawShipmentTracking | RawShipmentTracking[];
  };
}

function dateValue(v: { value?: string } | string | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : (v.value ?? null);
}

/**
 * Pull the buyer's shipment out of a return detail payload. Pure.
 *
 * Returns null when eBay carries no shipment at all, which is a real and common
 * state (the buyer has not posted it yet) and must be distinguishable from a
 * failed read — the route renders "buyer has not shipped yet" for null, and an
 * error for a throw.
 */
export function extractReturnShipment(raw: RawReturnDetail): ReturnShipmentInfo | null {
  const candidates = [
    raw.buyerShipmentTracking,
    raw.returnShipmentInfo,
    raw.detail?.buyerShipmentTracking,
    raw.detail?.returnShipmentInfo,
  ];
  for (const c of candidates) {
    if (!c) continue;
    // eBay serves this as an object on some shapes and a list on others. Take
    // the LAST entry of a list: a return re-shipped after a failed first
    // attempt carries both, and the current one is the later.
    const one = Array.isArray(c) ? c[c.length - 1] : c;
    if (!one) continue;
    const carrier = one.shippingCarrierName ?? one.carrierUsed ?? null;
    const trackingNumber = one.trackingNumber ?? null;
    if (!carrier && !trackingNumber) continue;
    return {
      carrier,
      trackingNumber,
      labelStatus: one.status ?? one.shipmentStatus ?? null,
      shippedAt: dateValue(one.shippedDate),
      deliveredAt: dateValue(one.deliveredDate),
    };
  }
  return null;
}

/** The buyer's return shipment, or null when they have not posted it yet. */
export async function getReturnShipment(
  userId: string,
  returnId: string,
): Promise<ReturnShipmentInfo | null> {
  const raw = await postOrderFetch<RawReturnDetail>(
    userId,
    `/return/${encodeURIComponent(returnId)}`,
  );
  return extractReturnShipment(raw);
}

// ── Return evidence files (US-2706) ─────────────────────────────────
//
// TWO CALLS, and the second is not optional. `file/upload` associates a file
// with the return and hands back a fileId; the file is INERT until
// `file/submit` activates it. An implementation that stops after the upload
// gets a 200, a fileId, and a seller who believes eBay has their evidence —
// which is the same silent-success shape as the photo attach in the Lister.
//
// The submit call takes a filePurpose and NOT a list of fileIds: it activates
// everything uploaded under that purpose. So a partial batch cannot be
// activated selectively, which is why the caller uploads the whole pack before
// submitting once.
//
// Verified against eBay's Post-Order v2 reference (Upload Return File / Submit
// Return File, UploadFileRequest / SubmitFileRequest), not inferred from the
// payment-dispute route next door — that is a different API on a different host
// with a multipart body.

/**
 * What the file is for. eBay's FilePurposeEnum; these are the three the return
 * flow uses.
 */
export type ReturnFilePurpose =
  | "ITEM_RELATED" // the condition of the item — what an INAD defence attaches
  | "REFUND_RELATED"
  | "SHIPMENT_RELATED";

export interface ReturnFileUpload {
  bytes: Uint8Array;
  /** eBay names the file by this. Extension matters; it sniffs the type. */
  filename: string;
  purpose?: ReturnFilePurpose;
}

/** base64 without a data: prefix, chunked so a large image cannot blow the stack. */
function toBase64(bytes: Uint8Array): string {
  // String.fromCharCode(...bytes) on a 2 MB image is ~2M arguments and throws
  // RangeError. Chunked at 8 KB, which is well under every engine's limit.
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Associate one file with a return. Returns eBay's fileId.
 *
 * The file is NOT visible to eBay's review until submitReturnFiles activates
 * it. Callers must not report success on this alone.
 */
export async function uploadReturnFile(
  userId: string,
  returnId: string,
  file: ReturnFileUpload,
): Promise<string> {
  const data = await postOrderFetch<{ fileId?: string }>(
    userId,
    `/return/${encodeURIComponent(returnId)}/file/upload`,
    {
      method: "POST",
      body: JSON.stringify({
        fileName: file.filename,
        data: toBase64(file.bytes),
        filePurpose: file.purpose ?? "ITEM_RELATED",
      }),
    },
  );
  const fileId = data.fileId;
  if (!fileId) {
    // eBay answered 2xx with no id. Treating that as success would activate
    // nothing and tell the seller their evidence is on the case.
    const err = new Error("eBay accepted the upload but returned no fileId");
    (err as PostOrderError).status = 502;
    throw err;
  }
  return fileId;
}

/**
 * Activate every file uploaded under this purpose.
 *
 * Returns the ids eBay REMOVED during activation — a file it rejected after
 * accepting the upload. The caller decides what to say about it; silently
 * dropping the list would report a complete pack that is missing pages.
 */
export async function submitReturnFiles(
  userId: string,
  returnId: string,
  purpose: ReturnFilePurpose = "ITEM_RELATED",
): Promise<{ removedFileIds: string[] }> {
  const data = await postOrderFetch<{ removedFileIds?: string[] }>(
    userId,
    `/return/${encodeURIComponent(returnId)}/file/submit`,
    { method: "POST", body: JSON.stringify({ filePurpose: purpose }) },
  );
  return { removedFileIds: data.removedFileIds ?? [] };
}

// ── Cancellations ───────────────────────────────────────────────────

export interface CancellationSummary {
  cancelId: string;
  state: string | null; // e.g. CANCEL_REQUESTED, CANCEL_CLOSED…
  orderId: string | null;
  reason: string | null;
  requestorType: string | null; // BUYER | SELLER
  creationDate: string | null;
}

interface RawCancellation {
  cancelId?: string;
  cancelStatus?: { state?: string };
  legacyOrderId?: string;
  cancelReason?: string;
  requestorType?: string;
  cancelRequestDate?: { value?: string };
}

export function normalizeCancellation(
  raw: RawCancellation,
): CancellationSummary {
  return {
    cancelId: raw.cancelId ?? "",
    state: raw.cancelStatus?.state ?? null,
    orderId: ebayId(raw.legacyOrderId),
    reason: raw.cancelReason ?? null,
    requestorType: raw.requestorType ?? null,
    creationDate: raw.cancelRequestDate?.value ?? null,
  };
}

export async function searchCancellations(
  userId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<CancellationSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const data = await postOrderFetch<{ cancellations?: RawCancellation[] }>(
    userId,
    `/cancellation/search?limit=${limit}&offset=${offset}`,
  );
  return (data.cancellations ?? []).map(normalizeCancellation);
}

// Approve a buyer's cancellation request (seller agrees to cancel + refund).
export async function approveCancellation(
  userId: string,
  cancelId: string,
): Promise<void> {
  await postOrderFetch<unknown>(
    userId,
    `/cancellation/${encodeURIComponent(cancelId)}/approve`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

// Reject a buyer's cancellation request (e.g. already shipped).
export async function rejectCancellation(
  userId: string,
  cancelId: string,
): Promise<void> {
  await postOrderFetch<unknown>(
    userId,
    `/cancellation/${encodeURIComponent(cancelId)}/reject`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

// ── Local-state mapping (pure, unit-tested) ─────────────────────────

// Map an eBay return/cancellation OUTCOME to the local sales.status value
// (00111: completed | cancelled | refunded | pending). A refunded return and an
// approved cancellation both stop the sale counting toward revenue/profit.
export function outcomeToSaleStatus(
  outcome: "return_refunded" | "return_declined" | "cancel_approved" | "cancel_rejected",
): "completed" | "cancelled" | "refunded" | null {
  switch (outcome) {
    case "return_refunded":
      return "refunded";
    case "cancel_approved":
      return "cancelled";
    // Declined return / rejected cancel leave the sale as-is (still a real sale).
    case "return_declined":
    case "cancel_rejected":
      return null;
  }
}
