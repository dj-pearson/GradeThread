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
async function postOrderFetch<T>(
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
}

interface RawReturn {
  returnId?: string;
  status?: { state?: string };
  state?: string;
  sellerLatestRefundInfo?: unknown;
  detail?: {
    buyerSelectedReturnReason?: string;
    item?: { itemId?: string };
  };
  buyerSelectedReturnReason?: string;
  creationInfo?: { creationDate?: { value?: string } };
}

// Normalize the (deeply nested, version-variant) Post-Order return shape into a
// flat summary the UI/local-state code can rely on. Pure — unit-tested.
export function normalizeReturn(raw: RawReturn): ReturnSummary {
  return {
    returnId: raw.returnId ?? "",
    state: raw.status?.state ?? raw.state ?? null,
    orderId: null,
    itemId: raw.detail?.item?.itemId ?? null,
    reason: raw.detail?.buyerSelectedReturnReason ??
      raw.buyerSelectedReturnReason ?? null,
    creationDate: raw.creationInfo?.creationDate?.value ?? null,
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
    orderId: raw.legacyOrderId ?? null,
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
