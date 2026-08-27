// US-2929: eBay Post-Order v2 CASE MANAGEMENT — the Money Back Guarantee case.
//
// A case is what a return or an INR inquiry becomes when the buyer escalates
// it, and it is the only post-sale event on eBay that carries a SELLER DEFECT.
// FlipDesk had no implementation of this surface at all, so the one event that
// damages a seller's standing was the one they could only find in Seller Hub.
//
// Three things separate a case from a return, and each one is a reason this is
// its own module rather than a flag on ebay-postorder.ts:
//   • eBay decides it, not the seller. There is no approve/decline; the seller
//     supplies evidence and eBay rules.
//   • The seller can APPEAL a decision, which no other post-sale case allows.
//   • Losing it is a defect, so the copy around it has to say so.
//
// Auth and transport are the Post-Order module's: `IAF <token>`, not Bearer.
// Reuses postOrderFetch rather than re-deriving it.
//
// TENANT SCOPING: every function takes a userId and reads under that seller's
// own token. The functions take eBay-side ids and perform NO ownership check —
// the route resolves and verifies first (US-268).

import { postOrderFetch } from "./ebay-postorder.ts";

export interface CaseSummary {
  caseId: string;
  /** e.g. CS_OPEN, CS_CLOSED, WAITING_FOR_SELLER_RESPONSE */
  state: string | null;
  orderId: string | null;
  itemId: string | null;
  reason: string | null;
  buyerUsername: string | null;
  respondBy: string | null;
  creationDate: string | null;
  /**
   * The return or inquiry this case was escalated FROM, when eBay says.
   *
   * This is what lets the Post-sale page show one thread instead of two
   * unrelated rows — a seller looking at "a return" and "a case" on the same
   * order has no way to tell they are the same argument.
   */
  escalatedFrom: string | null;
  amountCents: number | null;
  currency: string | null;
}

interface RawCase {
  caseId?: string | { caseId?: string };
  caseStatus?: string;
  status?: { state?: string };
  state?: string;
  legacyOrderId?: string;
  orderId?: string;
  itemId?: string;
  buyerLoginName?: string;
  buyerUsername?: string;
  reason?: string;
  buyerSelectedReason?: string;
  respondByDate?: { value?: string } | string;
  sellerResponseDue?: { value?: string };
  creationDate?: { value?: string } | string;
  returnId?: string;
  inquiryId?: string;
  claimAmount?: { value?: string; currency?: string };
  detail?: {
    item?: { itemId?: string };
    reason?: string;
    returnId?: string;
    inquiryId?: string;
  };
}

function dateValue(v: { value?: string } | string | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : (v.value ?? null);
}

/**
 * Flatten eBay's case payload. Pure — unit-tested at both nesting depths.
 *
 * `caseId` gets its own unwrap because eBay serves it as a bare string on some
 * shapes and as `{ caseId }` on others; read only the string form and half the
 * cases arrive with an empty id and are silently dropped by the id filter.
 */
export function normalizeCase(raw: RawCase): CaseSummary {
  const rawAmount = raw.claimAmount?.value != null ? Number(raw.claimAmount.value) : null;
  return {
    caseId: typeof raw.caseId === "string" ? raw.caseId : (raw.caseId?.caseId ?? ""),
    state: raw.caseStatus ?? raw.status?.state ?? raw.state ?? null,
    orderId: raw.legacyOrderId ?? raw.orderId ?? null,
    itemId: raw.itemId ?? raw.detail?.item?.itemId ?? null,
    reason: raw.reason ?? raw.buyerSelectedReason ?? raw.detail?.reason ?? null,
    buyerUsername: raw.buyerLoginName ?? raw.buyerUsername ?? null,
    respondBy: dateValue(raw.respondByDate) ?? dateValue(raw.sellerResponseDue),
    creationDate: dateValue(raw.creationDate),
    escalatedFrom: raw.returnId ?? raw.inquiryId ?? raw.detail?.returnId ??
      raw.detail?.inquiryId ?? null,
    amountCents: rawAmount != null && Number.isFinite(rawAmount)
      ? Math.round(rawAmount * 100)
      : null,
    currency: raw.claimAmount?.currency ?? null,
  };
}

/** The seller's cases. Reads every array key eBay has used across versions. */
export async function searchCases(
  userId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<CaseSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const data = await postOrderFetch<{
    cases?: RawCase[];
    members?: RawCase[];
    caseSummaries?: RawCase[];
  }>(userId, `/casemanagement/search?limit=${limit}&offset=${offset}`);
  const rows = data.cases ?? data.members ?? data.caseSummaries ?? [];
  return rows.map(normalizeCase).filter((x) => x.caseId);
}

/** One case in full. */
export async function getCase(userId: string, caseId: string): Promise<CaseSummary> {
  const raw = await postOrderFetch<RawCase>(
    userId,
    `/casemanagement/${encodeURIComponent(caseId)}`,
  );
  return normalizeCase(raw);
}

/** Supply tracking — the answer to an Item Not Received case. */
export async function provideCaseShipmentInfo(
  userId: string,
  caseId: string,
  args: { carrier: string; trackingNumber: string; shippedDate?: string; comments?: string },
): Promise<void> {
  await postOrderFetch<unknown>(
    userId,
    `/casemanagement/${encodeURIComponent(caseId)}/provide_shipment_info`,
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

/** Refund the buyer and settle the case before eBay decides it. */
export async function issueCaseRefund(
  userId: string,
  caseId: string,
  comments?: string,
): Promise<void> {
  await postOrderFetch<unknown>(
    userId,
    `/casemanagement/${encodeURIComponent(caseId)}/issue_refund`,
    { method: "POST", body: JSON.stringify(comments ? { comments: { content: comments } } : {}) },
  );
}

/**
 * Appeal a case eBay decided against the seller.
 *
 * The only post-sale surface with an appeal, and the window is short. eBay
 * requires a reason; a bare appeal is rejected, so the argument is mandatory
 * here rather than optional.
 */
export async function appealCase(
  userId: string,
  caseId: string,
  comments: string,
): Promise<void> {
  await postOrderFetch<unknown>(
    userId,
    `/casemanagement/${encodeURIComponent(caseId)}/appeal`,
    { method: "POST", body: JSON.stringify({ comments: { content: comments } }) },
  );
}

/** Close a case the seller and buyer have settled between them. */
export async function closeCase(
  userId: string,
  caseId: string,
  comments?: string,
): Promise<void> {
  await postOrderFetch<unknown>(
    userId,
    `/casemanagement/${encodeURIComponent(caseId)}/close`,
    { method: "POST", body: JSON.stringify(comments ? { comments: { content: comments } } : {}) },
  );
}

const ALREADY_SETTLED_IDS = new Set([32000, 32001, 32002]);

/**
 * "Already in that state" versus a real failure.
 *
 * Narrow on purpose. Telling a seller their case is handled when the call
 * actually failed is the worst outcome this module can produce, because the one
 * thing a case costs is a defect for not responding.
 */
export function isCaseAlreadySettled(err: unknown): boolean {
  const e = err as { status?: number; ebayErrorIds?: number[]; message?: string };
  if (e?.status === 404) return true;
  if (Array.isArray(e?.ebayErrorIds) && e.ebayErrorIds.some((id) => ALREADY_SETTLED_IDS.has(id))) {
    return true;
  }
  return /already\s+(closed|refunded|resolved|appealed)/i.test(e?.message ?? "");
}
