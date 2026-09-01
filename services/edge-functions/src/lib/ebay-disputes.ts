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
// the same auth the rest of the Sell APIs use. Despite the shared URL prefix,
// the payment_dispute resource is scoped to the DEDICATED
// `sell.payment.dispute` OAuth scope (NOT `sell.fulfillment`) — it is in the
// default getScopes() list (ebay-client.ts). Sellers whose consent predates
// that scope must reconnect at /oauth/start or every call here returns
// insufficient-scope.

import {
  apiHost,
  countedEbayFetch,
  ebayId,
  ebayResilientFetch,
  getMarketplaceId,
  getUserAccessToken,
} from "./ebay-client.ts";

const EBAY_TIMEOUT_MS = 20_000;

interface DisputeError extends Error {
  status: number;
  ebayErrorIds?: number[];
}

// eBay returns 404 on payment_dispute_summary for accounts that have never had
// a dispute or don't have the feature enabled — it's not a real failure.
export function isBenignDisputeNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    "status" in err &&
    (err as DisputeError).status === 404
  );
}

async function disputeFetch<T>(
  userId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = await getUserAccessToken(userId);
  // US-1966: go through the hardened path (breaker + withRetry + Retry-After)
  // like the main Sell path. 429/5xx are retried/backed-off; a benign 404 (see
  // isBenignDisputeNotFound) is a normal non-retryable response returned
  // unchanged, so the `!res.ok` branch below still handles it.
  const res = await ebayResilientFetch(
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
    { label: `PaymentDispute ${init?.method ?? "GET"} ${path}`, timeoutMs: EBAY_TIMEOUT_MS },
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
    orderId: ebayId(raw.orderId),
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
  try {
    const data = await disputeFetch<{ paymentDisputeSummaries?: RawDispute[] }>(
      userId,
      `/sell/fulfillment/v1/payment_dispute_summary?${params.toString()}`,
    );
    return (data.paymentDisputeSummaries ?? []).map(normalizePaymentDispute);
  } catch (err) {
    if (isBenignDisputeNotFound(err)) {
      // eBay returns 404 for accounts with no dispute history or when the
      // payment disputes feature is not yet active on the account.
      console.info("[ebay.disputes.list] 404 from eBay (no disputes on this account) — returning empty list");
      return [];
    }
    throw err;
  }
}

// ── Detail (line items + evidence requests) ─────────────────────────
//
// The dispute DETAIL response carries the line items and any open evidence
// requests; add_evidence requires the lineItems, so we surface them here.

export interface DisputeLineItem {
  itemId: string;
  lineItemId: string;
}

export interface DisputeEvidenceRequest {
  evidenceId: string | null;
  requestType: string | null; // e.g. PROOF_OF_DELIVERY, SHIPPING_LABEL
  respondByDate: string | null;
  lineItems: DisputeLineItem[];
}

export interface PaymentDisputeDetail extends PaymentDisputeSummary {
  lineItems: DisputeLineItem[];
  evidenceRequests: DisputeEvidenceRequest[];
}

interface RawLineItem {
  itemId?: string;
  lineItemId?: string;
}

interface RawEvidenceRequest {
  evidenceId?: string;
  requestType?: string;
  respondByDate?: string;
  lineItems?: RawLineItem[];
}

interface RawDisputeDetail extends RawDispute {
  lineItems?: RawLineItem[];
  evidenceRequests?: RawEvidenceRequest[];
}

// Keep only line items eBay can act on (both ids present). Pure.
function normalizeLineItems(raw: RawLineItem[] | undefined): DisputeLineItem[] {
  return (raw ?? [])
    .filter(
      (li): li is { itemId: string; lineItemId: string } =>
        typeof li.itemId === "string" && typeof li.lineItemId === "string",
    )
    .map((li) => ({ itemId: li.itemId, lineItemId: li.lineItemId }));
}

// Flatten the dispute DETAIL shape (superset of the summary). Pure.
export function normalizePaymentDisputeDetail(
  raw: RawDisputeDetail,
): PaymentDisputeDetail {
  return {
    ...normalizePaymentDispute(raw),
    lineItems: normalizeLineItems(raw.lineItems),
    evidenceRequests: (raw.evidenceRequests ?? []).map((er) => ({
      evidenceId: er.evidenceId ?? null,
      requestType: er.requestType ?? null,
      respondByDate: er.respondByDate ?? null,
      lineItems: normalizeLineItems(er.lineItems),
    })),
  };
}

export async function getPaymentDispute(
  userId: string,
  disputeId: string,
): Promise<PaymentDisputeDetail> {
  const data = await disputeFetch<RawDisputeDetail>(
    userId,
    `/sell/fulfillment/v1/payment_dispute/${encodeURIComponent(disputeId)}`,
  );
  return normalizePaymentDisputeDetail(data);
}

// ── Activity (timeline) ─────────────────────────────────────────────

export interface DisputeActivity {
  type: string | null; // activityType — e.g. SELLER_RESPONSE, BUYER_OPENED
  date: string | null;
  by: string | null; // who triggered it (BUYER / SELLER / EBAY)
  note: string | null;
}

interface RawActivity {
  activityType?: string;
  activityDate?: string;
  by?: string;
  note?: string;
}

// Flatten the activity response. Pure.
export function normalizeDisputeActivity(
  raw: { activity?: RawActivity[] },
): DisputeActivity[] {
  return (raw.activity ?? []).map((a) => ({
    type: a.activityType ?? null,
    date: a.activityDate ?? null,
    by: a.by ?? null,
    note: a.note ?? null,
  }));
}

export async function getPaymentDisputeActivity(
  userId: string,
  disputeId: string,
): Promise<DisputeActivity[]> {
  const data = await disputeFetch<{ activity?: RawActivity[] }>(
    userId,
    `/sell/fulfillment/v1/payment_dispute/${encodeURIComponent(disputeId)}/activity`,
  );
  return normalizeDisputeActivity(data);
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

// ── Evidence (upload file → add evidence) ───────────────────────────
//
// Contesting with proof is a two-step eBay flow: upload each file (multipart →
// returns a fileId), then add_evidence references those fileIds + the disputed
// line items. The multipart call must NOT carry a JSON Content-Type, so it
// bypasses disputeFetch.

export async function uploadDisputeEvidenceFile(
  userId: string,
  disputeId: string,
  file: { bytes: Uint8Array; filename: string; contentType: string },
): Promise<string> {
  const token = await getUserAccessToken(userId);
  const form = new FormData();
  // Cast: Deno's DOM lib types BlobPart as ArrayBuffer-backed, but a
  // Uint8Array<ArrayBufferLike> is a valid blob part at runtime.
  const blob = new Blob([file.bytes as BlobPart], { type: file.contentType });
  form.append("file", blob, file.filename);
  // US-3042: counted like every other eBay call (this multipart upload is the
  // one Fulfillment path that does not go through fetchAuthed).
  const res = await countedEbayFetch(
    `${apiHost()}/sell/fulfillment/v1/payment_dispute/${
      encodeURIComponent(disputeId)
    }/upload_evidence_file`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
        // NOTE: no Content-Type — fetch sets the multipart boundary itself.
      },
      body: form,
    },
    EBAY_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(
      `eBay PaymentDispute upload_evidence_file failed (${res.status}): ${
        text.slice(0, 400)
      }`,
    ) as DisputeError;
    err.status = res.status;
    throw err;
  }
  const body = (await res.json().catch(() => ({}))) as { fileId?: string };
  if (!body.fileId) {
    throw new Error("eBay did not return a fileId for the uploaded evidence.");
  }
  return body.fileId;
}

export interface AddEvidencePayload {
  evidenceType: string; // e.g. PROOF_OF_DELIVERY
  fileIds: string[];
  lineItems: DisputeLineItem[];
}

// Pure builder for the add_evidence request body. Exported for testing.
export function buildAddEvidenceBody(payload: AddEvidencePayload): {
  evidenceType: string;
  files: Array<{ fileId: string }>;
  lineItems: DisputeLineItem[];
} {
  return {
    evidenceType: payload.evidenceType,
    files: payload.fileIds.map((fileId) => ({ fileId })),
    lineItems: payload.lineItems,
  };
}

// Associates uploaded files with the dispute as a piece of evidence. Returns
// the new evidenceId (eBay echoes it back), or null when eBay omits it.
export async function addDisputeEvidence(
  userId: string,
  disputeId: string,
  payload: AddEvidencePayload,
): Promise<string | null> {
  const data = await disputeFetch<{ evidenceId?: string }>(
    userId,
    `/sell/fulfillment/v1/payment_dispute/${
      encodeURIComponent(disputeId)
    }/add_evidence`,
    { method: "POST", body: JSON.stringify(buildAddEvidenceBody(payload)) },
  );
  return data.evidenceId ?? null;
}

// ── Idempotency ─────────────────────────────────────────────────────

// Terminal statuses where accept/contest are no longer possible. Anything else
// (including unknown values) we let eBay decide on, so we only short-circuit
// when the dispute is clearly already resolved. Pure.
const RESOLVED_STATUSES = new Set([
  "CLOSED",
  "RESOLVED",
  "DISPUTE_CLOSED",
]);

export function isDisputeActionable(
  status: string | null | undefined,
): boolean {
  if (!status) return true;
  return !RESOLVED_STATUSES.has(status.toUpperCase());
}

// ── Local-state mapping (pure) ──────────────────────────────────────

// Accepting a dispute refunds the buyer → the sale stops counting as revenue.
// Contesting leaves it pending the case outcome.
export function disputeOutcomeToSaleStatus(
  outcome: "accepted" | "contested",
): "refunded" | null {
  return outcome === "accepted" ? "refunded" : null;
}
