// US-2928: eBay Post-Order v2 INQUIRIES — the Item Not Received flow.
//
// An INR inquiry is the first move a buyer makes when a parcel does not arrive.
// FlipDesk had no reader for it at all, which produced a specific and quiet
// failure: `classifyEbayTopic` already routes an INQUIRY_* topic to the return
// bucket, so the webhook arrived, triggered a sync and kicked off a poll — and
// the poll had no inquiry source, so the seller was told nothing and found out
// in Seller Hub, usually after it had escalated into a case.
//
// The order matters commercially. An inquiry the seller answers costs nothing.
// The same inquiry escalated becomes a Money Back Guarantee case (US-2929), and
// a case the seller loses is a defect against their account.
//
// Auth and transport are the Post-Order module's: `IAF <token>`, not Bearer, on
// apiHost()/post-order/v2. This module reuses postOrderFetch rather than
// re-deriving it.
//
// TENANT SCOPING: every function takes a userId and eBay serves only that
// seller's own inquiries under their own token. The functions take eBay-side
// ids and perform NO ownership check themselves — the route must resolve and
// verify before calling (US-268).

import { postOrderFetch } from "./ebay-postorder.ts";

export interface InquirySummary {
  inquiryId: string;
  /** e.g. INQUIRY_OPEN, WAITING_FOR_SELLER_RESPONSE, CLOSED */
  state: string | null;
  orderId: string | null;
  itemId: string | null;
  reason: string | null;
  buyerUsername: string | null;
  /** The deadline eBay will act on if the seller does not. */
  respondBy: string | null;
  creationDate: string | null;
}

// eBay serves these fields at more than one nesting depth depending on whether
// the payload came from search or from a detail read, and the shapes have moved
// between versions. Every accessor below is optional for that reason; the
// normalizer is the one place that knows about it.
interface RawInquiry {
  inquiryId?: string;
  status?: { state?: string };
  inquiryStatus?: string;
  state?: string;
  legacyOrderId?: string;
  orderId?: string;
  itemId?: string;
  buyerLoginName?: string;
  buyerUsername?: string;
  buyerSelectedReason?: string;
  reason?: string;
  respondByDate?: { value?: string } | string;
  sellerResponseDue?: { value?: string };
  creationDate?: { value?: string } | string;
  detail?: {
    item?: { itemId?: string };
    buyerSelectedReason?: string;
  };
}

// eBay wraps a date as { value } in some shapes and as a bare string in others.
function dateValue(v: { value?: string } | string | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : (v.value ?? null);
}

/**
 * Flatten eBay's inquiry payload to the flat shape the route, the store and the
 * page all read. Pure — unit-tested against both nesting depths.
 */
export function normalizeInquiry(raw: RawInquiry): InquirySummary {
  return {
    inquiryId: raw.inquiryId ?? "",
    state: raw.status?.state ?? raw.inquiryStatus ?? raw.state ?? null,
    orderId: raw.legacyOrderId ?? raw.orderId ?? null,
    itemId: raw.itemId ?? raw.detail?.item?.itemId ?? null,
    reason: raw.buyerSelectedReason ?? raw.detail?.buyerSelectedReason ?? raw.reason ?? null,
    buyerUsername: raw.buyerLoginName ?? raw.buyerUsername ?? null,
    respondBy: dateValue(raw.respondByDate) ?? dateValue(raw.sellerResponseDue),
    creationDate: dateValue(raw.creationDate),
  };
}

/**
 * The seller's inquiries, newest eBay serves first.
 *
 * eBay has used more than one key for the array across versions, so all three
 * spellings are read. A response with none of them is an empty list, not a
 * crash — the same defensive read the returns search already does.
 */
export async function searchInquiries(
  userId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<InquirySummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const data = await postOrderFetch<{
    inquiries?: RawInquiry[];
    members?: RawInquiry[];
    inquirySummaries?: RawInquiry[];
  }>(userId, `/inquiry/search?limit=${limit}&offset=${offset}`);
  const rows = data.inquiries ?? data.members ?? data.inquirySummaries ?? [];
  return rows.map(normalizeInquiry).filter((i) => i.inquiryId);
}

/** One inquiry in full. */
export async function getInquiry(
  userId: string,
  inquiryId: string,
): Promise<InquirySummary> {
  const raw = await postOrderFetch<RawInquiry>(
    userId,
    `/inquiry/${encodeURIComponent(inquiryId)}`,
  );
  return normalizeInquiry(raw);
}

/**
 * Tell eBay the parcel shipped, with tracking. This is the answer that closes
 * most INR inquiries without a refund, and it is the single most valuable
 * action in this module.
 */
export async function provideInquiryShipmentInfo(
  userId: string,
  inquiryId: string,
  args: { carrier: string; trackingNumber: string; shippedDate?: string; comments?: string },
): Promise<void> {
  await postOrderFetch<unknown>(
    userId,
    `/inquiry/${encodeURIComponent(inquiryId)}/provide_shipment_info`,
    {
      method: "POST",
      body: JSON.stringify({
        shipmentDate: args.shippedDate ? { value: args.shippedDate } : undefined,
        shippingCarrierName: args.carrier,
        trackingNumber: args.trackingNumber,
        ...(args.comments ? { comments: { content: args.comments } } : {}),
      }),
    },
  );
}

/** Refund the buyer and settle the inquiry. */
export async function issueInquiryRefund(
  userId: string,
  inquiryId: string,
  comments?: string,
): Promise<void> {
  await postOrderFetch<unknown>(
    userId,
    `/inquiry/${encodeURIComponent(inquiryId)}/issue_refund`,
    {
      method: "POST",
      body: JSON.stringify(comments ? { comments: { content: comments } } : {}),
    },
  );
}

/** Close an inquiry the seller and buyer have settled. */
export async function closeInquiry(
  userId: string,
  inquiryId: string,
  comments?: string,
): Promise<void> {
  await postOrderFetch<unknown>(
    userId,
    `/inquiry/${encodeURIComponent(inquiryId)}/close`,
    {
      method: "POST",
      body: JSON.stringify(comments ? { comments: { content: comments } } : {}),
    },
  );
}

/**
 * eBay error ids that mean "this inquiry is already in the state you asked
 * for". Treated as success by the routes, exactly as the returns routes treat
 * an already-decided return: a seller pressing Close on a settled inquiry
 * should see it settle, not a 502.
 */
const ALREADY_SETTLED_IDS = new Set([32000, 32001, 32002]);

export function isInquiryAlreadySettled(err: unknown): boolean {
  const e = err as { status?: number; ebayErrorIds?: number[]; message?: string };
  if (e?.status === 404) return true;
  if (Array.isArray(e?.ebayErrorIds) && e.ebayErrorIds.some((id) => ALREADY_SETTLED_IDS.has(id))) {
    return true;
  }
  // Message fallback, because eBay does not always attach an errorId to a
  // business rejection on this surface. Narrow on purpose: matching loosely
  // here would swallow a real failure as a success.
  return /already\s+(closed|refunded|resolved)/i.test(e?.message ?? "");
}
