// eBay Payment Disputes API client (US-1049).
//
// A payment dispute is a buyer-opened case / chargeback escalated to eBay
// ("item not received", "not as described", or a card chargeback). The seller
// must ACCEPT (refund) or CONTEST (with evidence) before respondByDate — miss it
// and eBay decides against the seller by default. FlipDesk previously did nothing
// with these (the only payment_disputed marker in the repo is an unrelated Stripe
// fraud flag), so this module adds the read + decision surface.
//
// These methods are part of the Sell Fulfillment API
// (/sell/fulfillment/v1/payment_dispute) and use the standard Bearer user token —
// the same auth the rest of the Sell APIs use. The scope is expected to be the
// already-granted `sell.fulfillment`; if eBay returns insufficient-scope, add
// `sell.payment.dispute` to EBAY_SCOPES and have sellers re-consent (AC4).

import { fetchWithTimeout } from "./circuit-breaker.ts";
import { apiHost, getMarketplaceId, getUserAccessToken } from "./ebay-client.ts";

const EBAY_TIMEOUT_MS = 20_000;

interface DisputeError extends Error {
  status: number;
  ebayErrorIds?: number[];
}

async function disputeFetch<T>(
  userId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = await getUserAccessToken(userId);
  const res = await fetchWithTimeout(
    `${apiHost()}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
        ...(init?.headers ?? {}),
      },
    },
    EBAY_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(
      `eBay PaymentDispute ${init?.method ?? "GET"} ${path} failed (${res.status}): ${
        text.slice(0, 400)
      }`,
    ) as DisputeError;
    err.status = res.status;
    try {
      const parsed = JSON.parse(text) as { errors?: Array<{ errorId?: number }> };
      if (Array.isArray(parsed.errors)) {
        err.ebayErrorIds = parsed.errors
          .map((e) => e.errorId)
          .filter((id): id is number => typeof id === "number");
      }
    } catch {
      // non-JSON error body
    }
    throw err;
  }
  const body = await res.text();
  return (body ? JSON.parse(body) : {}) as T;
}

// ── Read ────────────────────────────────────────────────────────────

export interface PaymentDisputeSummary {
  paymentDisputeId: string;
  orderId: string | null;
  status: string | null; // OPEN, ACTION_NEEDED, CLOSED, …
  reason: string | null; // ITEM_NOT_RECEIVED, ITEM_NOT_AS_DESCRIBED, …
  amount: number | null;
  currency: string | null;
  openedDate: string | null;
  respondByDate: string | null; // the deadline that matters
  buyerUsername: string | null;
}

interface RawDispute {
  paymentDisputeId?: string;
  orderId?: string;
  paymentDisputeStatus?: string;
  reason?: string;
  amount?: { value?: string; currency?: string };
  openDate?: string;
  respondByDate?: string;
  buyerUsername?: string;
}

// Flatten eBay's dispute shape (summary or detail) into a stable record. Pure.
export function normalizePaymentDispute(raw: RawDispute): PaymentDisputeSummary {
  const amt = raw.amount?.value != null ? Number(raw.amount.value) : null;
  return {
    paymentDisputeId: raw.paymentDisputeId ?? "",
    orderId: raw.orderId ?? null,
    status: raw.paymentDisputeStatus ?? null,
    reason: raw.reason ?? null,
    amount: amt != null && Number.isFinite(amt) ? amt : null,
    currency: raw.amount?.currency ?? null,
    openedDate: raw.openDate ?? null,
    respondByDate: raw.respondByDate ?? null,
    buyerUsername: raw.buyerUsername ?? null,
  };
}

export async function searchPaymentDisputes(
  userId: string,
  opts: { status?: string; limit?: number; offset?: number } = {},
): Promise<PaymentDisputeSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (opts.status) params.set("payment_dispute_status", opts.status);
  const data = await disputeFetch<{ paymentDisputeSummaries?: RawDispute[] }>(
    userId,
    `/sell/fulfillment/v1/payment_dispute_summary?${params.toString()}`,
  );
  return (data.paymentDisputeSummaries ?? []).map(normalizePaymentDispute);
}

export async function getPaymentDispute(
  userId: string,
  disputeId: string,
): Promise<PaymentDisputeSummary> {
  const data = await disputeFetch<RawDispute>(
    userId,
    `/sell/fulfillment/v1/payment_dispute/${encodeURIComponent(disputeId)}`,
  );
  return normalizePaymentDispute(data);
}

// ── Decisions ───────────────────────────────────────────────────────

// Accept the dispute (refund the buyer, close the case in the buyer's favor).
export async function acceptPaymentDispute(
  userId: string,
  disputeId: string,
): Promise<void> {
  await disputeFetch<unknown>(
    userId,
    `/sell/fulfillment/v1/payment_dispute/${encodeURIComponent(disputeId)}/accept`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

// Contest the dispute. `note` is the seller's explanation; evidence files are
// added separately via addEvidence after upload_evidence_file (UI pass).
export async function contestPaymentDispute(
  userId: string,
  disputeId: string,
  note?: string,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (note) body.note = note.slice(0, 1000);
  await disputeFetch<unknown>(
    userId,
    `/sell/fulfillment/v1/payment_dispute/${encodeURIComponent(disputeId)}/contest`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

// ── Local-state mapping (pure) ──────────────────────────────────────

// Accepting a dispute refunds the buyer → the sale stops counting as revenue.
// Contesting leaves it pending the case outcome.
export function disputeOutcomeToSaleStatus(
  outcome: "accepted" | "contested",
): "refunded" | null {
  return outcome === "accepted" ? "refunded" : null;
}
