// eBay routes: returns, inquiries, cases, cancellations, refunds, feedback, payment disputes and shipping.
//
// Split out of flipdesk-ebay.ts, which mounts this router at /api/flipdesk/ebay
// alongside its siblings. The local router keeps the name flipdeskEbayRoutes so
// every handler below is byte-for-byte the text it had before the split.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  getReturnShipment,
  markReturnReceived,
  sendReturnMessage,
  submitReturnFiles,
  uploadReturnFile,
} from "../lib/ebay-postorder.ts";
import {
  cancellationToCaseInput,
  chooseOrderId,
  disputeToCaseInput,
  isStoredInquiry,
  loadCachedSummaries,
  loadStoredCaseRef,
  type PostSaleCaseType,
  type StoredCaseRef,
  markPostSaleCaseClosed,
  mergePostSaleCaseRaw,
  recordPostSaleCases,
  returnToCaseInput,
  updatePostSaleCaseState,
} from "../lib/post-sale-store.ts";
import type { CancellationSummary, ReturnSummary } from "../lib/ebay-postorder.ts";
import type { PaymentDisputeSummary } from "../lib/ebay-disputes.ts";
import {
  closeInquiry,
  type InquirySummary,
  isInquiryAlreadySettled,
  issueInquiryRefund,
  provideInquiryShipmentInfo,
  searchInquiries,
} from "../lib/ebay-inquiries.ts";
import { caseToCaseInput, inquiryToCaseInput } from "../lib/post-sale-store.ts";
import {
  appealCase,
  type CaseSummary,
  closeCase,
  isCaseAlreadySettled,
  issueCaseRefund,
  provideCaseShipmentInfo,
  searchCases,
  submitCaseFiles,
  uploadCaseFile,
} from "../lib/ebay-cases.ts";
import { cleanEvidenceFiles, evidenceRefusalFor } from "../lib/evidence-send.ts";
import { MIN_SALES_FOR_RATE, summarizeReturns } from "../lib/post-sale-analytics.ts";
import { loadReturnAnalyticsInputs } from "../lib/post-sale-analytics-load.ts";
import {
  dryRunReturnRule,
  normalizeThresholdCents as normalizeReturnThresholdCents,
} from "../lib/return-rules.ts";
import { compositeReturnEvidenceSheet } from "../lib/defect-annotations.ts";
import { type EvidenceContext, planEvidence } from "../lib/evidence-plan.ts";
import { applyOutcomeToSale } from "../lib/post-sale-outcome.ts";
import {
  createShippingFulfillment,
  isEbayConfigured,
  issueOrderRefund,
  type IssueRefundInput,
  type IssueRefundResult,
  type RefundAmount,
} from "../lib/ebay-client.ts";
import { leaveFeedback, getOrderLegacyLineItems } from "../lib/ebay-trading.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog, writeSystemAuditLog } from "../lib/audit-log.ts";
import { getSetting } from "../lib/system-settings.ts";
import {
  approveCancellation,
  decideReturn,
  isItemNotReceivedCase,
  issueReturnRefund,
  rejectCancellation,
  searchCancellations,
  searchReturns,
} from "../lib/ebay-postorder.ts";
import {
  acceptPaymentDispute,
  addDisputeEvidence,
  contestPaymentDispute,
  getPaymentDispute,
  getPaymentDisputeActivity,
  isDisputeActionable,
  type PaymentDisputeDetail,
  searchPaymentDisputes,
  uploadDisputeEvidenceFile,
} from "../lib/ebay-disputes.ts";
import { validateImageUpload } from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";
import { EBAY_CONNECTION_SCAN_CAP, type EbayEnv } from "./flipdesk-ebay-shared.ts";


export const flipdeskEbayRoutes = new Hono<EbayEnv>();

/**
 * US-2706: how many images a return-evidence pack may carry.
 *
 * Not an eBay limit we have measured — a judgement. A pack that is mostly
 * filler argues worse than one that is only the flaw and the disclosure, and
 * the seller has already chosen what goes in it.
 */
const MAX_RETURN_EVIDENCE_FILES = 6;

// ── Returns & cancellations management (US-1043, Post-Order API) ─────
//
// The seller's eBay token only ever sees that seller's own returns/cancels, so
// listing is inherently tenant-scoped to the workspace owner. After an action we
// best-effort update the matching local sale (tenant-scoped by user_id +
// platform_order_id) and always write an audit row. The action calls are
// idempotent at the eBay layer (a second decide on a resolved case is treated as
// success).

// PS-04: the order an outcome acts on comes from our stored case, not from the
// request body. The body is the fallback only when we have no row for the case,
// and the audit row says so. A body that disagrees with the record is logged
// and ignored: acting on it could refund, restock and reverse the payout on a
// different one of this seller's sales.
async function resolveOutcomeOrder(
  ownerId: string,
  caseType: PostSaleCaseType,
  externalId: string,
  bodyOrderId: unknown,
  stored?: StoredCaseRef | null,
): Promise<{ orderId: string | null; audit: Record<string, unknown> }> {
  const ref = stored !== undefined
    ? stored
    : await loadStoredCaseRef(ownerId, caseType, externalId);
  const chosen = chooseOrderId(ref?.externalOrderId ?? null, bodyOrderId);
  if (chosen.mismatch) {
    console.warn(
      `[ebay.postorder] ${caseType} ${externalId}: body order_id disagrees with the stored case; using the stored one`,
    );
  }
  const audit: Record<string, unknown> = { order_id: chosen.orderId };
  if (chosen.source === "client") audit.order_source = "client";
  if (chosen.mismatch) audit.order_id_mismatch = true;
  return { orderId: chosen.orderId, audit };
}

// A 4xx whose body says the case is already resolved → treat the action as a
// successful no-op (idempotency) rather than surfacing an error to the user.
function isAlreadyResolved(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already (been )?(decided|closed|refunded|approved|rejected|processed)/i
    .test(msg);
}

// GET /returns — open returns for the seller.
flipdeskEbayRoutes.get("/returns", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  // US-2927: local first. A page reload inside the freshness window costs eBay
  // nothing; an empty cache is never treated as "no returns", because only eBay
  // can tell an empty cache from an empty account.
  const cached = await loadCachedSummaries<ReturnSummary>(ownerId, "return", { limit });
  if (cached.fresh) return c.json({ returns: cached.items, source: "cache" });
  try {
    const live = await searchReturns(ownerId, { limit });
    const nowIso = new Date().toISOString();
    await recordPostSaleCases(ownerId, live.map((r) => returnToCaseInput(r, nowIso)));
    return c.json({ returns: live, source: "ebay" });
  } catch (err) {
    // A live failure falls back to whatever we last stored rather than to an
    // error page — stale returns are more useful than none, and the response
    // says which it is so the UI can label it.
    if (cached.items.length > 0) {
      return c.json({ returns: cached.items, source: "cache_stale" });
    }
    return failSafe(c, 502, "Couldn't load eBay returns.", err, "ebay.returns.list");
  }
});

// POST /returns/:returnId/decide — body { decision: approve|decline, comments?, order_id? }
flipdeskEbayRoutes.post("/returns/:returnId/decide", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const returnId = c.req.param("returnId");
  let body: { decision?: unknown; comments?: unknown; order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const decision = String(body.decision ?? "").toLowerCase();
  if (decision !== "approve" && decision !== "decline") {
    return c.json({ error: "decision must be 'approve' or 'decline'." }, 400);
  }
  const comments = typeof body.comments === "string" ? body.comments : undefined;
  try {
    await decideReturn(
      ownerId,
      returnId,
      decision === "approve" ? "APPROVE" : "DECLINE",
      comments,
    );
  } catch (err) {
    if (!isAlreadyResolved(err)) {
      return failSafe(c, 502, "eBay rejected the return decision.", err, "ebay.returns.decide");
    }
  }
  const order = await resolveOutcomeOrder(ownerId, "return", returnId, body.order_id);
  if (decision === "decline") {
    await applyOutcomeToSale(ownerId, order.orderId, "return_declined");
    // US-2927: reflect the decision on the stored case now rather than waiting
    // for the next poll, so the page the seller acted from is not still showing
    // the return as needing them.
    await markPostSaleCaseClosed(ownerId, "return", returnId, "declined");
  } else {
    await updatePostSaleCaseState(ownerId, "return", returnId, { state: "RETURN_APPROVED" });
  }
  await writeAuditLog(c, {
    action: `ebay.return.${decision}`,
    targetType: "ebay_return",
    targetId: returnId,
    details: order.audit,
  });
  return c.json({ ok: true });
});

// POST /returns/:returnId/refund — body { comments?, order_id? }
flipdeskEbayRoutes.post("/returns/:returnId/refund", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const returnId = c.req.param("returnId");
  let body: { comments?: unknown; order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const comments = typeof body.comments === "string" ? body.comments : undefined;
  try {
    await issueReturnRefund(ownerId, returnId, comments);
  } catch (err) {
    if (!isAlreadyResolved(err)) {
      return failSafe(c, 502, "eBay rejected the refund.", err, "ebay.returns.refund");
    }
  }
  const order = await resolveOutcomeOrder(ownerId, "return", returnId, body.order_id);
  await applyOutcomeToSale(ownerId, order.orderId, "return_refunded");
  await markPostSaleCaseClosed(ownerId, "return", returnId, "refunded");
  await writeAuditLog(c, {
    action: "ebay.return.refund",
    targetType: "ebay_return",
    targetId: returnId,
    details: order.audit,
  });
  return c.json({ ok: true });
});

// ── Item Not Received inquiries (US-2928, Post-Order v2) ────────────
//
// The first move a buyer makes when a parcel does not arrive. FlipDesk had no
// reader for it, so the webhook arrived, kicked off a poll with no inquiry
// source, and the seller learned nothing. Answered with tracking, an inquiry
// costs the seller nothing; ignored, it escalates into a case (US-2929) and a
// lost case is a defect.
//
// Every route resolves the owner the same way the rest of this file does, and
// eBay serves only that seller's own inquiries under their own token.

// GET /inquiries — open inquiries for the seller. Local-first like /returns.
flipdeskEbayRoutes.get("/inquiries", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const cached = await loadCachedSummaries<InquirySummary>(ownerId, "inquiry", { limit });
  if (cached.fresh) return c.json({ inquiries: cached.items, source: "cache" });
  try {
    const live = await searchInquiries(ownerId, { limit });
    const nowIso = new Date().toISOString();
    await recordPostSaleCases(ownerId, live.map((i) => inquiryToCaseInput(i, nowIso)));
    return c.json({ inquiries: live, source: "ebay" });
  } catch (err) {
    if (cached.items.length > 0) {
      return c.json({ inquiries: cached.items, source: "cache_stale" });
    }
    return failSafe(c, 502, "Couldn't load eBay inquiries.", err, "ebay.inquiries.list");
  }
});

// POST /inquiries/:inquiryId/shipment — body { carrier, tracking_number, shipped_date?, comments? }
//
// The action that settles most INR inquiries. Validated before the eBay call so
// a missing tracking number is a 400 here rather than an opaque 502 from eBay.
flipdeskEbayRoutes.post("/inquiries/:inquiryId/shipment", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const inquiryId = c.req.param("inquiryId");
  let body: {
    carrier?: unknown;
    tracking_number?: unknown;
    shipped_date?: unknown;
    comments?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const carrier = typeof body.carrier === "string" ? body.carrier.trim() : "";
  const trackingNumber = typeof body.tracking_number === "string"
    ? body.tracking_number.trim()
    : "";
  if (!carrier || !trackingNumber) {
    return c.json({ error: "carrier and tracking_number are both required." }, 400);
  }
  try {
    await provideInquiryShipmentInfo(ownerId, inquiryId, {
      carrier,
      trackingNumber,
      shippedDate: typeof body.shipped_date === "string" ? body.shipped_date : undefined,
      comments: typeof body.comments === "string" ? body.comments : undefined,
    });
  } catch (err) {
    if (!isInquiryAlreadySettled(err)) {
      return failSafe(c, 502, "eBay rejected the shipment details.", err, "ebay.inquiries.shipment");
    }
  }
  await updatePostSaleCaseState(ownerId, "inquiry", inquiryId, {
    state: "SHIPMENT_PROVIDED",
  });
  await writeAuditLog(c, {
    action: "ebay.inquiry.shipment",
    targetType: "ebay_inquiry",
    targetId: inquiryId,
    details: { carrier, tracking_number: trackingNumber },
  });
  return c.json({ ok: true });
});

// POST /inquiries/:inquiryId/refund — body { comments?, order_id? }
flipdeskEbayRoutes.post("/inquiries/:inquiryId/refund", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const inquiryId = c.req.param("inquiryId");
  let body: { comments?: unknown; order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await issueInquiryRefund(
      ownerId,
      inquiryId,
      typeof body.comments === "string" ? body.comments : undefined,
    );
  } catch (err) {
    if (!isInquiryAlreadySettled(err)) {
      return failSafe(c, 502, "eBay rejected the refund.", err, "ebay.inquiries.refund");
    }
  }
  // PS-03: the parcel never arrived, so the refund must not put the garment
  // back into stock. inr_refunded marks the sale refunded and leaves the item.
  const order = await resolveOutcomeOrder(ownerId, "inquiry", inquiryId, body.order_id);
  await applyOutcomeToSale(ownerId, order.orderId, "inr_refunded");
  await markPostSaleCaseClosed(ownerId, "inquiry", inquiryId, "refunded");
  await writeAuditLog(c, {
    action: "ebay.inquiry.refund",
    targetType: "ebay_inquiry",
    targetId: inquiryId,
    details: order.audit,
  });
  return c.json({ ok: true });
});

// POST /inquiries/:inquiryId/close — body { comments? }
flipdeskEbayRoutes.post("/inquiries/:inquiryId/close", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const inquiryId = c.req.param("inquiryId");
  let body: { comments?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await closeInquiry(
      ownerId,
      inquiryId,
      typeof body.comments === "string" ? body.comments : undefined,
    );
  } catch (err) {
    if (!isInquiryAlreadySettled(err)) {
      return failSafe(c, 502, "eBay rejected closing the inquiry.", err, "ebay.inquiries.close");
    }
  }
  await markPostSaleCaseClosed(ownerId, "inquiry", inquiryId, "closed");
  await writeAuditLog(c, {
    action: "ebay.inquiry.close",
    targetType: "ebay_inquiry",
    targetId: inquiryId,
    details: {},
  });
  return c.json({ ok: true });
});

// ── Escalated eBay cases (US-2929, Post-Order v2 case management) ───
//
// A case is a return or an inquiry the buyer escalated, and it is the only
// post-sale event that costs a seller defect. eBay decides it — there is no
// approve/decline — so the actions are: supply tracking, refund, appeal a
// decision, or close one settled privately.

// GET /cases — the seller's open cases. Local-first like the other three lists.
flipdeskEbayRoutes.get("/cases", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const cached = await loadCachedSummaries<CaseSummary>(ownerId, "case", { limit });
  if (cached.fresh) return c.json({ cases: cached.items, source: "cache" });
  try {
    const live = await searchCases(ownerId, { limit });
    const nowIso = new Date().toISOString();
    await recordPostSaleCases(ownerId, live.map((x) => caseToCaseInput(x, nowIso)));
    return c.json({ cases: live, source: "ebay" });
  } catch (err) {
    if (cached.items.length > 0) return c.json({ cases: cached.items, source: "cache_stale" });
    return failSafe(c, 502, "Couldn't load eBay cases.", err, "ebay.cases.list");
  }
});

// POST /cases/:caseId/shipment — body { carrier, tracking_number, shipped_date?, comments? }
flipdeskEbayRoutes.post("/cases/:caseId/shipment", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const caseId = c.req.param("caseId");
  let body: {
    carrier?: unknown;
    tracking_number?: unknown;
    shipped_date?: unknown;
    comments?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const carrier = typeof body.carrier === "string" ? body.carrier.trim() : "";
  const trackingNumber = typeof body.tracking_number === "string"
    ? body.tracking_number.trim()
    : "";
  if (!carrier || !trackingNumber) {
    return c.json({ error: "carrier and tracking_number are both required." }, 400);
  }
  try {
    await provideCaseShipmentInfo(ownerId, caseId, {
      carrier,
      trackingNumber,
      shippedDate: typeof body.shipped_date === "string" ? body.shipped_date : undefined,
      comments: typeof body.comments === "string" ? body.comments : undefined,
    });
  } catch (err) {
    if (!isCaseAlreadySettled(err)) {
      return failSafe(c, 502, "eBay rejected the shipment details.", err, "ebay.cases.shipment");
    }
  }
  await updatePostSaleCaseState(ownerId, "case", caseId, { state: "SHIPMENT_PROVIDED" });
  await writeAuditLog(c, {
    action: "ebay.case.shipment",
    targetType: "ebay_case",
    targetId: caseId,
    details: { carrier, tracking_number: trackingNumber },
  });
  return c.json({ ok: true });
});

// POST /cases/:caseId/refund — body { comments?, order_id? }
flipdeskEbayRoutes.post("/cases/:caseId/refund", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const caseId = c.req.param("caseId");
  let body: { comments?: unknown; order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await issueCaseRefund(
      ownerId,
      caseId,
      typeof body.comments === "string" ? body.comments : undefined,
    );
  } catch (err) {
    if (!isCaseAlreadySettled(err)) {
      return failSafe(c, 502, "eBay rejected the refund.", err, "ebay.cases.refund");
    }
  }
  // PS-03: a case escalated from an item-not-received inquiry is about a parcel
  // that never arrived; one escalated from a return is about an item the buyer
  // has. Only the second restocks.
  const stored = await loadStoredCaseRef(ownerId, "case", caseId);
  const escalatedFromInquiry = stored?.escalatedFrom
    ? await isStoredInquiry(ownerId, stored.escalatedFrom)
    : false;
  const outcome = isItemNotReceivedCase({ reason: stored?.reason, escalatedFromInquiry })
    ? "inr_refunded"
    : "return_refunded";
  const order = await resolveOutcomeOrder(ownerId, "case", caseId, body.order_id, stored);
  await applyOutcomeToSale(ownerId, order.orderId, outcome);
  await markPostSaleCaseClosed(ownerId, "case", caseId, "refunded");
  await writeAuditLog(c, {
    action: "ebay.case.refund",
    targetType: "ebay_case",
    targetId: caseId,
    details: { ...order.audit, outcome },
  });
  return c.json({ ok: true });
});

// POST /returns/rule-dry-run — US-2938. What a return rule WOULD have done.
//
// Not a nicety. These rules refund buyers, and a seller who cannot see the item
// list before switching one on is being asked to trust a number they typed
// against data they have not looked at. Reads only: no eBay call, no write, and
// no rule is created here.
//
// body { approve_at_or_below_cents?, refund_without_return_at_or_below_cents?, days? }
flipdeskEbayRoutes.post("/returns/rule-dry-run", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: {
    approve_at_or_below_cents?: unknown;
    refund_without_return_at_or_below_cents?: unknown;
    days?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const cfg = {
    approveAtOrBelowCents: normalizeReturnThresholdCents(body.approve_at_or_below_cents),
    refundWithoutReturnAtOrBelowCents: normalizeReturnThresholdCents(
      body.refund_without_return_at_or_below_cents,
    ),
  };
  if (cfg.approveAtOrBelowCents == null && cfg.refundWithoutReturnAtOrBelowCents == null) {
    return c.json({ error: "Set an auto-approve or a refund-without-return limit." }, 400);
  }
  const days = Math.min(Math.max(Number(body.days) || 30, 1), 180);
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

  try {
    const { data, error } = await supabaseAdmin
      .from("marketplace_post_sale_cases")
      .select("external_id, reason, state, sale_id, opened_at")
      .eq("user_id", ownerId)
      .eq("platform", "ebay")
      .eq("case_type", "return")
      .gte("opened_at", sinceIso)
      .order("opened_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as Array<{
      external_id: string;
      reason: string | null;
      state: string | null;
      sale_id: string | null;
    }>;

    // The order total comes through the linked sale. A return with no linked
    // sale has none, and the evaluator skips it rather than treating unknown as
    // zero — which the preview then shows as a skip with its reason.
    const saleIds = [...new Set(rows.map((r) => r.sale_id).filter(Boolean))] as string[];
    const totalBySale = new Map<string, number>();
    if (saleIds.length > 0) {
      const { data: sales } = await supabaseAdmin
        .from("sales")
        .select("id, sale_price")
        .eq("user_id", ownerId)
        .in("id", saleIds);
      for (
        const sale of (sales ?? []) as unknown as Array<{
          id: string;
          sale_price: number | null;
        }>
      ) {
        const n = sale.sale_price == null ? Number.NaN : Number(sale.sale_price);
        if (Number.isFinite(n)) totalBySale.set(sale.id, Math.round(n * 100));
      }
    }

    return c.json({
      days,
      ...dryRunReturnRule(
        cfg,
        rows.map((r) => ({
          externalId: r.external_id,
          reason: r.reason,
          state: r.state,
          orderTotalCents: r.sale_id ? (totalBySale.get(r.sale_id) ?? null) : null,
        })),
      ),
    });
  } catch (err) {
    return failSafe(c, 500, "Couldn't run the preview.", err, "ebay.returns.dry_run");
  }
});

// GET /post-sale/analytics — US-2936. Return outcomes against the grade.
//
// The analysis no other reseller tool can run: every marketplace shows a seller
// their return RATE, and none of them knows what condition the item was in when
// it went out, because none of them graded it.
//
// Local tables only. No eBay call on page load, which is also what makes a
// ninety-day window affordable.
flipdeskEbayRoutes.get("/post-sale/analytics", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const days = Math.min(Math.max(Number(c.req.query("days")) || 90, 7), 365);
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  try {
    const { sales, cases, truncated } = await loadReturnAnalyticsInputs(ownerId, sinceIso);
    return c.json({
      days,
      truncated,
      // Echoed so the UI can say why a slice reads "not enough sales yet"
      // instead of leaving the reader to guess the threshold.
      minSalesForRate: MIN_SALES_FOR_RATE,
      ...summarizeReturns(sales, cases),
    });
  } catch (err) {
    return failSafe(c, 500, "Couldn't build the return analytics.", err, "ebay.postsale.analytics");
  }
});

// POST /cases/:caseId/evidence — US-2935. The grade pack, on the surface that
// costs a defect.
//
// Multipart, exactly like the return route, and it shares that route's two
// rules through lib/evidence-send.ts: the sniff-then-strip pass, and the
// refusal when the grade report AGREES with the buyer. What differs is only the
// eBay upload API, which is the case surface's own.
//
// TENANT SCOPE (US-268): every eBay call runs under the OWNER's token, so a
// caseId belonging to another seller reaches eBay as this seller's case and
// comes back 404/403. There is no local query here that could read another
// tenant's row, and the audit entry is written against the same owner.
flipdeskEbayRoutes.post("/cases/:caseId/evidence", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const caseId = c.req.param("caseId");

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Invalid form data. Expected multipart/form-data." }, 400);
  }
  const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  const cleanResult = await cleanEvidenceFiles(files, MAX_RETURN_EVIDENCE_FILES);
  if (!cleanResult.ok) return c.json({ error: cleanResult.error }, cleanResult.status);
  const cleaned = cleanResult.files;

  const complaint = String(form.get("complaint") ?? "").trim();
  const orderId = String(form.get("order_id") ?? "").trim();
  let context: EvidenceContext | null = null;
  if (complaint && orderId) {
    context = await planEvidence(ownerId, orderId, complaint);
    const refusal = evidenceRefusalFor(context?.plan);
    if (refusal) return c.json({ error: "refused", ...refusal }, 409);
  }

  // The sheet goes first so the reviewer reads what this is before they look at
  // a close-up of a cuff, and only for a CERTIFIED grade — a cover page reading
  // "Not certified" argues against the seller on the one asset that exists to
  // argue for them.
  if (context?.stamp.certificateNumber) {
    try {
      cleaned.unshift({
        bytes: await compositeReturnEvidenceSheet(
          context.stamp,
          context.defectCount,
          context.gradedAt,
        ),
        filename: "condition-report.jpg",
        contentType: "image/jpeg",
      });
    } catch (err) {
      console.error(
        "[ebay.cases.evidence] sheet render failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const fileIds: string[] = [];
  try {
    for (const file of cleaned) {
      fileIds.push(
        await uploadCaseFile(ownerId, caseId, {
          bytes: file.bytes,
          filename: file.filename,
          purpose: "ITEM_RELATED",
        }),
      );
    }
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the evidence upload.", err, "ebay.cases.evidence.upload");
  }

  let removedFileIds: string[] = [];
  try {
    ({ removedFileIds } = await submitCaseFiles(ownerId, caseId, "ITEM_RELATED"));
  } catch (err) {
    return failSafe(c, 502, "eBay accepted the files but would not activate them.", err, "ebay.cases.evidence.submit");
  }

  await writeAuditLog(c, {
    action: "ebay.case.evidence",
    targetType: "ebay_case",
    targetId: caseId,
    details: { files: fileIds.length, removed: removedFileIds.length },
  });

  return c.json({
    ok: true,
    attached: fileIds.length - removedFileIds.length,
    removed: removedFileIds.length,
  });
});

// POST /cases/:caseId/appeal — body { comments }
//
// eBay requires an argument; a bare appeal is rejected, so the 400 happens here
// rather than as an opaque 502 after the round trip.
flipdeskEbayRoutes.post("/cases/:caseId/appeal", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const caseId = c.req.param("caseId");
  let body: { comments?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const comments = typeof body.comments === "string" ? body.comments.trim() : "";
  if (!comments) {
    return c.json({ error: "comments is required — eBay rejects an appeal with no argument." }, 400);
  }
  try {
    await appealCase(ownerId, caseId, comments);
  } catch (err) {
    if (!isCaseAlreadySettled(err)) {
      return failSafe(c, 502, "eBay rejected the appeal.", err, "ebay.cases.appeal");
    }
  }
  await updatePostSaleCaseState(ownerId, "case", caseId, { state: "APPEALED" });
  await writeAuditLog(c, {
    action: "ebay.case.appeal",
    targetType: "ebay_case",
    targetId: caseId,
    details: {},
  });
  return c.json({ ok: true });
});

// POST /cases/:caseId/close — body { comments? }
flipdeskEbayRoutes.post("/cases/:caseId/close", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const caseId = c.req.param("caseId");
  let body: { comments?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await closeCase(ownerId, caseId, typeof body.comments === "string" ? body.comments : undefined);
  } catch (err) {
    if (!isCaseAlreadySettled(err)) {
      return failSafe(c, 502, "eBay rejected closing the case.", err, "ebay.cases.close");
    }
  }
  await markPostSaleCaseClosed(ownerId, "case", caseId, "closed");
  await writeAuditLog(c, {
    action: "ebay.case.close",
    targetType: "ebay_case",
    targetId: caseId,
    details: {},
  });
  return c.json({ ok: true });
});

// POST /returns/:returnId/received — US-2930.
//
// The action whose absence costs money quietly: without it eBay's clock keeps
// running on an item already back in the seller's hands, and that clock ends in
// an automatic refund.
flipdeskEbayRoutes.post("/returns/:returnId/received", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const returnId = c.req.param("returnId");
  let body: { comments?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await markReturnReceived(
      ownerId,
      returnId,
      typeof body.comments === "string" ? body.comments : undefined,
    );
  } catch (err) {
    if (!isAlreadyResolved(err)) {
      return failSafe(c, 502, "eBay rejected marking the return received.", err, "ebay.returns.received");
    }
  }
  // Reflect it now rather than at the next poll, so the page the seller acted
  // from stops offering the action they just took.
  await updatePostSaleCaseState(ownerId, "return", returnId, { state: "ITEM_RECEIVED" });
  await writeAuditLog(c, {
    action: "ebay.return.received",
    targetType: "ebay_return",
    targetId: returnId,
    details: {},
  });
  return c.json({ ok: true });
});

// POST /returns/:returnId/message — US-2932. The return-scoped conversation.
//
// Not the member-message inbox. eBay reads THIS thread when it decides a case,
// so a keep-it agreement reached in the other inbox is one eBay cannot see.
flipdeskEbayRoutes.post("/returns/:returnId/message", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const returnId = c.req.param("returnId");
  let body: { message?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return c.json({ error: "message is required." }, 400);
  try {
    await sendReturnMessage(ownerId, returnId, message);
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the message.", err, "ebay.returns.message");
  }
  await writeAuditLog(c, {
    action: "ebay.return.message",
    targetType: "ebay_return",
    targetId: returnId,
    details: { length: message.length },
  });
  return c.json({ ok: true });
});

// GET /returns/:returnId/label — US-2931. The buyer's return shipment.
//
// `{ label: null }` is a real answer, not an error: it means the buyer has not
// posted the item yet, which is exactly what a seller deciding whether to wait
// needs to know. Only a failed READ is a 502.
flipdeskEbayRoutes.get("/returns/:returnId/label", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const returnId = c.req.param("returnId");
  try {
    const label = await getReturnShipment(ownerId, returnId);
    // Store it on the case so the list carries it on the next read and a page
    // reload costs no second eBay call.
    if (label) await mergePostSaleCaseRaw(ownerId, "return", returnId, { label });
    return c.json({ label });
  } catch (err) {
    return failSafe(c, 502, "Couldn't read the return shipment.", err, "ebay.returns.label");
  }
});

// US-2706 AC5 / US-2707 AC4: POST /evidence/preview — what the pack WOULD say,
// without sending anything.
//
// Reads only. It touches no eBay endpoint and writes nothing, which is what
// lets the seller see the verdict, the citations and the sheet's own facts
// before they decide. The send is a separate call behind a separate click;
// there is no timer here and nothing auto-submits.
//
// NOT scoped to a return or a dispute, because the plan never depended on
// either: it is built from the ORDER's graded item and the listing text we
// published. Mounting a second copy under each case type would be two routes
// that must agree about a verdict, and the one that drifted would be the rarer
// path — which is the gap US-2707 exists to close.
//
// body { order_id, complaint }
flipdeskEbayRoutes.post("/evidence/preview", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { order_id?: unknown; complaint?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const orderId = String(body.order_id ?? "").trim();
  const complaint = String(body.complaint ?? "").trim();
  if (!orderId || !complaint) {
    return c.json({ error: "order_id and complaint are both required." }, 400);
  }

  const context = await planEvidence(ownerId, orderId, complaint);
  if (!context) {
    // No grade report, or nothing linking this order to a graded item. Said
    // plainly rather than dressed up as a verdict: there is no evidence here,
    // and the seller should know that before they plan around it.
    return c.json({ available: false });
  }

  return c.json({
    available: true,
    verdict: context.plan.verdict,
    reason: context.plan.reason,
    mayAutoAssemble: context.plan.mayAutoAssemble,
    citations: context.plan.citations,
    // US-2706 AC6: whether the published listing text is on file at all. The
    // surface labels a pack without one as the weaker case rather than showing
    // it as equivalent — it can only argue from the grade report.
    hasPublicationSnapshot: context.hasSnapshot,
    certificateNumber: context.stamp.certificateNumber,
    gradedAt: context.gradedAt,
    defectCount: context.defectCount,
    // A sheet is only composited for a CERTIFIED grade.
    includesConditionSheet: Boolean(context.stamp.certificateNumber),
  });
});

// US-2706: POST /returns/:returnId/evidence — attach the grade evidence to an
// item-not-as-described return.
//
// Multipart: one or more `file` parts (images). The seller has already reviewed
// the pack on the post-sale surface; this route sends it. There is no timer and
// no auto-submit, and there is no path here that fires without a request.
//
// TWO EBAY CALLS, and the second is what makes the evidence real. `file/upload`
// associates each image and returns a fileId; the files stay INERT until
// `file/submit` activates them. Reporting success after the uploads alone would
// tell a seller their evidence is on the case when eBay has not been shown it —
// the same silent-success shape as a photo attach that never landed.
//
// TENANT SCOPE (US-268): every eBay call runs under the OWNER's own token
// (`workspaceOwnerId ?? userId`), so a returnId belonging to another seller
// reaches eBay as this seller's return and comes back 404/403 — there is no
// query here that could read another tenant's row. The audit row is written
// against the same owner.
flipdeskEbayRoutes.post("/returns/:returnId/evidence", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const returnId = c.req.param("returnId");

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Invalid form data. Expected multipart/form-data." }, 400);
  }
  const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  // US-2935: the sniff-then-strip pass is shared with the case and dispute
  // routes. It used to be copied per surface, and the copies had already
  // drifted on the file cap.
  const cleanResult = await cleanEvidenceFiles(files, MAX_RETURN_EVIDENCE_FILES);
  if (!cleanResult.ok) return c.json({ error: cleanResult.error }, cleanResult.status);
  const cleaned = cleanResult.files;

  // US-2706 + the epic's standing safety constraint (US-2703 AC5): REFUSE when
  // the grade report agrees with the buyer.
  //
  // The pack is assembled from the item's own grade report and the listing text
  // GradeThread published (US-2704). When the report documents a flaw the
  // listing did not disclose, sending this pack hands eBay a signed document
  // proving our own user sold an undisclosed flaw. That is not a weak case, it
  // is evidence for the other side, and the design says we do not send it.
  //
  // Best-effort in ONE direction only: if the report or the snapshot cannot be
  // loaded, the plan is not built and the send proceeds on the seller's own
  // judgement. A lookup failure must not silently become a refusal, and it must
  // never become an assembly either — which is why the refusal is keyed on a
  // verdict we actually computed rather than on the absence of one.
  const complaint = String(form.get("complaint") ?? "").trim();
  const orderId = String(form.get("order_id") ?? "").trim();
  let context: EvidenceContext | null = null;
  if (complaint && orderId) {
    context = await planEvidence(ownerId, orderId, complaint);
    const refusal = evidenceRefusalFor(context?.plan);
    if (refusal) return c.json({ error: "refused", ...refusal }, 409);
  }

  // US-2706 AC3: the sheet goes FIRST, so the reviewer opening the pack reads
  // what this is before they look at a close-up of a cuff. It is composited
  // here rather than uploaded by the client because the certificate number and
  // the grade date must come from the report, not from a form field a browser
  // could be persuaded to change.
  //
  // Only when the grade is CERTIFIED: an uncertified report has no number to
  // print, and a sheet whose certificate line reads "Not certified" argues
  // against the seller on the one asset that exists to argue for them.
  if (context?.stamp.certificateNumber) {
    try {
      cleaned.unshift({
        bytes: await compositeReturnEvidenceSheet(
          context.stamp,
          context.defectCount,
          context.gradedAt,
        ),
        filename: "condition-report.jpg",
        contentType: "image/jpeg",
      });
    } catch (err) {
      // The photographs are still the evidence. A failed sheet costs the pack
      // its cover page, not its argument.
      console.error(
        "[ebay.returns.evidence] sheet render failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const fileIds: string[] = [];
  try {
    for (const file of cleaned) {
      fileIds.push(
        await uploadReturnFile(ownerId, returnId, {
          bytes: file.bytes,
          filename: file.filename,
          purpose: "ITEM_RELATED",
        }),
      );
    }
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the evidence upload.", err, "ebay.returns.evidence.upload");
  }

  let removedFileIds: string[] = [];
  try {
    // Submit activates by PURPOSE, not by id, so the whole pack goes up first
    // and this runs once. A partial batch cannot be activated selectively.
    ({ removedFileIds } = await submitReturnFiles(ownerId, returnId, "ITEM_RELATED"));
  } catch (err) {
    return failSafe(c, 502, "eBay accepted the files but would not activate them.", err, "ebay.returns.evidence.submit");
  }

  await writeAuditLog(c, {
    action: "ebay.return.evidence",
    targetType: "ebay_return",
    targetId: returnId,
    details: { files: fileIds.length, removed: removedFileIds.length },
  });

  // `removed` is reported rather than swallowed: eBay accepted the upload and
  // then dropped the file at activation, so the pack on the case is smaller
  // than the one the seller reviewed. Saying "sent" over that is the lie this
  // route is here to avoid.
  return c.json({
    ok: true,
    attached: fileIds.length - removedFileIds.length,
    removed: removedFileIds.length,
  });
});

// US-1978 (AC3): POST /orders/:orderId/refund — a PROACTIVE or PARTIAL refund,
// outside any return case.
//
// body { reason, comment?, amount?: { currency, value }, line_items?: [{ line_item_id, currency, value }] }
//
// Distinct from /returns/:returnId/refund, which only exists once a buyer has
// opened a return and the seller approved it. Until now a seller who just wanted
// to make it right ("there's a mark I missed — keep it, here's $10 back") had to
// push the buyer into opening a return first: worse for both sides, and it drags
// the seller's return metrics.
//
// TENANT ISOLATION (US-268). orderId is attacker-controlled input, and this route
// MOVES MONEY, so eBay's own token scoping is not leaned on as the only check. We
// prove locally that a sales row for this order belongs to THIS tenant before
// calling eBay. Without that, the failure mode is a workspace member (or anyone
// who can reach the route) issuing refunds against an order id they guessed, and
// the only thing standing in the way would be eBay's 404 — i.e. an external
// system's behaviour, not our access control.
flipdeskEbayRoutes.post("/orders/:orderId/refund", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const orderId = c.req.param("orderId");

  let body: {
    reason?: unknown;
    comment?: unknown;
    amount?: unknown;
    line_items?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  // Ownership FIRST — before any eBay call, and before any parsing that could
  // leak the order's existence through a differently-shaped error.
  // PostgREST returns an embed as an object for a to-one relationship and an
  // array for a to-many, and which one you get depends on how it reads the FK.
  // Handling both is cheaper than being wrong about it in a route that a seller
  // only reaches while trying to refund somebody.
  const saleConnectionId = (row: unknown): string | undefined => {
    const l = (row as { listings?: unknown } | null)?.listings;
    const one = Array.isArray(l) ? l[0] : l;
    const id = (one as { marketplace_connection_id?: string | null } | null)
      ?.marketplace_connection_id;
    return id ?? undefined;
  };

  // US-2804: `sales` has NO marketplace_connection_id column — it lives on
  // `listings` (00338), and sales reaches it through listing_id. Selecting it
  // directly answered 42703, so this ownership check errored on every call and
  // the refund route returned 500 to every seller who tried it.
  //
  // It fails CLOSED, which is the one piece of luck here: the check errored
  // rather than passing, so no foreign order was ever reachable. The route was
  // dead, not open.
  const { data: sale, error: saleErr } = await supabaseAdmin
    .from("sales")
    .select("id, listings(marketplace_connection_id)")
    .eq("user_id", ownerId)
    .eq("platform_order_id", orderId)
    .maybeSingle();
  if (saleErr) {
    console.error("[ebay.orders.refund] sale lookup failed:", saleErr.message);
    return c.json({ error: "Couldn't look up that order." }, 500);
  }
  if (!sale) {
    // Deliberately the same 404 a nonexistent order gets: a foreign order must not
    // be distinguishable from one that isn't there.
    return c.json({ error: "Order not found." }, 404);
  }

  const reason = typeof body.reason === "string" && body.reason ? body.reason : "";
  if (!reason) {
    return c.json(
      { error: "A refund reason is required (e.g. SELLER_CANCEL, ITEM_NOT_AS_DESCRIBED, OTHER_CAUSE)." },
      400,
    );
  }

  const input: IssueRefundInput = { reasonForRefund: reason };
  if (typeof body.comment === "string" && body.comment) input.comment = body.comment;

  const amount = parseRefundAmount(body.amount);
  const lineItems = parseRefundLineItems(body.line_items);
  // eBay treats order-level and line-item refunds as different requests and
  // rejects both together. Refuse explicitly rather than silently dropping one —
  // guessing which the seller meant is not a call code should make about money.
  if (amount && lineItems) {
    return c.json(
      { error: "Refund either the whole order (amount) or specific line items — not both." },
      400,
    );
  }
  if (!amount && !lineItems) {
    return c.json(
      { error: "Provide a refund amount, or the line items to refund." },
      400,
    );
  }
  if (amount) input.orderLevelRefundAmount = amount;
  if (lineItems) input.refundItems = lineItems;

  let result: IssueRefundResult;
  try {
    result = await issueOrderRefund(
      ownerId,
      orderId,
      input,
      // Through the embed, since the column is on `listings`. A sale with no
      // linked listing yields undefined, which is the same fallback the old
      // (never-reached) expression had: use the default connection.
      saleConnectionId(sale),
    );
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the refund.", err, "ebay.orders.refund");
  }

  await writeAuditLog(c, {
    action: "ebay.order.refund",
    targetType: "ebay_order",
    targetId: orderId,
    details: {
      reason,
      // Log WHAT moved — a refund is the kind of action someone reconstructs later.
      order_level_amount: amount ? `${amount.value} ${amount.currency}` : null,
      line_item_count: lineItems ? lineItems.length : 0,
      refund_id: result.refundId ?? null,
    },
  });

  return c.json({
    ok: true,
    refund_id: result.refundId ?? null,
    refund_status: result.refundStatus ?? null,
  });
});

// Parse an order-level refund amount. Returns null when absent; a malformed
// amount is null too, which the caller turns into a 400 rather than guessing.
function parseRefundAmount(raw: unknown): RefundAmount | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { currency?: unknown; value?: unknown };
  const currency = typeof o.currency === "string" ? o.currency.trim().toUpperCase() : "";
  const value = typeof o.value === "string" ? o.value.trim() : "";
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  // eBay wants a plain decimal string. Reject anything else outright — a refund is
  // not the place to be permissive about what a number looks like.
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  if (Number(value) <= 0) return null;
  return { currency, value };
}

function parseRefundLineItems(
  raw: unknown,
): Array<{ lineItemId: string; refundAmount: RefundAmount }> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Array<{ lineItemId: string; refundAmount: RefundAmount }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as { line_item_id?: unknown };
    const lineItemId = typeof e.line_item_id === "string" ? e.line_item_id.trim() : "";
    if (!lineItemId) return null;
    const refundAmount = parseRefundAmount(entry);
    if (!refundAmount) return null;
    out.push({ lineItemId, refundAmount });
  }
  return out;
}

// GET /cancellations — open cancellation requests for the seller.
flipdeskEbayRoutes.get("/cancellations", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const cached = await loadCachedSummaries<CancellationSummary>(ownerId, "cancellation", {
    limit,
  });
  if (cached.fresh) return c.json({ cancellations: cached.items, source: "cache" });
  try {
    const live = await searchCancellations(ownerId, { limit });
    const nowIso = new Date().toISOString();
    await recordPostSaleCases(ownerId, live.map((x) => cancellationToCaseInput(x, nowIso)));
    return c.json({ cancellations: live, source: "ebay" });
  } catch (err) {
    if (cached.items.length > 0) {
      return c.json({ cancellations: cached.items, source: "cache_stale" });
    }
    return failSafe(c, 502, "Couldn't load eBay cancellations.", err, "ebay.cancellations.list");
  }
});

// POST /cancellations/:cancelId/approve — body { order_id? }
flipdeskEbayRoutes.post("/cancellations/:cancelId/approve", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const cancelId = c.req.param("cancelId");
  let body: { order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await approveCancellation(ownerId, cancelId);
  } catch (err) {
    if (!isAlreadyResolved(err)) {
      return failSafe(c, 502, "eBay rejected the cancellation approval.", err, "ebay.cancel.approve");
    }
  }
  const order = await resolveOutcomeOrder(ownerId, "cancellation", cancelId, body.order_id);
  await applyOutcomeToSale(ownerId, order.orderId, "cancel_approved");
  await markPostSaleCaseClosed(ownerId, "cancellation", cancelId, "approved");
  await writeAuditLog(c, {
    action: "ebay.cancellation.approve",
    targetType: "ebay_cancellation",
    targetId: cancelId,
    details: order.audit,
  });
  return c.json({ ok: true });
});

// POST /cancellations/:cancelId/reject — body { order_id? }
flipdeskEbayRoutes.post("/cancellations/:cancelId/reject", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const cancelId = c.req.param("cancelId");
  let body: { order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await rejectCancellation(ownerId, cancelId);
  } catch (err) {
    if (!isAlreadyResolved(err)) {
      return failSafe(c, 502, "eBay rejected the cancellation rejection.", err, "ebay.cancel.reject");
    }
  }
  await markPostSaleCaseClosed(ownerId, "cancellation", cancelId, "rejected");
  await writeAuditLog(c, {
    action: "ebay.cancellation.reject",
    targetType: "ebay_cancellation",
    targetId: cancelId,
    details: { order_id: body.order_id ?? null },
  });
  return c.json({ ok: true });
});

// ── Leave buyer feedback (US-1047, Trading API) ─────────────────────
// POST /feedback — body { buyer_username, comment?, order_line_item_id? OR
// item_id+transaction_id }. Sellers may only leave POSITIVE feedback for buyers.
// Idempotent: eBay rejects a duplicate, which we report as already_left rather
// than an error. Inherently tenant-scoped (the owner's token can only leave
// feedback on the owner's own transactions).
flipdeskEbayRoutes.post("/feedback", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: {
    buyer_username?: unknown;
    comment?: unknown;
    item_id?: unknown;
    transaction_id?: unknown;
    order_line_item_id?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const bodyOrderId = typeof (body as { order_id?: unknown }).order_id === "string"
    ? ((body as { order_id?: string }).order_id as string)
    : undefined;
  const explicitUser = String(body.buyer_username ?? "").trim();
  const itemId = typeof body.item_id === "string" ? body.item_id : undefined;
  const transactionId = typeof body.transaction_id === "string"
    ? body.transaction_id
    : undefined;
  const orderLineItemId = typeof body.order_line_item_id === "string"
    ? body.order_line_item_id
    : undefined;
  const comment = typeof body.comment === "string" && body.comment.trim()
    ? body.comment.trim()
    : "Great buyer — fast payment, smooth transaction. Thank you!";

  // Build the list of transactions to leave feedback for. Either the caller
  // passed explicit legacy ids, or we resolve them from the order id via the
  // Trading GetOrders bridge (the modern lineItemId we store isn't a legacy id).
  type Target = { itemId?: string; transactionId?: string; orderLineItemId?: string; user: string };
  let targets: Target[] = [];
  if (orderLineItemId && explicitUser) {
    targets = [{ orderLineItemId, user: explicitUser }];
  } else if (itemId && transactionId && explicitUser) {
    targets = [{ itemId, transactionId, user: explicitUser }];
  } else if (bodyOrderId) {
    try {
      const lineItems = await getOrderLegacyLineItems(userId, bodyOrderId);
      targets = lineItems
        .filter((li) => li.buyerUsername || explicitUser)
        .map((li) => ({
          itemId: li.itemId,
          transactionId: li.transactionId,
          user: li.buyerUsername ?? explicitUser,
        }));
    } catch (err) {
      return failSafe(c, 502, "Couldn't resolve the order for feedback.", err, "ebay.feedback.resolve");
    }
    if (targets.length === 0) {
      return c.json({ error: "No completed transactions found for that order." }, 404);
    }
  } else {
    return c.json(
      { error: "Provide order_id, or buyer_username + (order_line_item_id OR item_id + transaction_id)." },
      400,
    );
  }

  try {
    let alreadyLeftAll = true;
    for (const t of targets) {
      const { alreadyLeft } = await leaveFeedback(userId, {
        itemId: t.itemId,
        transactionId: t.transactionId,
        orderLineItemId: t.orderLineItemId,
        targetUser: t.user,
        comment,
      });
      if (!alreadyLeft) alreadyLeftAll = false;
    }
    await writeAuditLog(c, {
      action: "ebay.feedback.leave",
      targetType: "ebay_feedback",
      targetId: bodyOrderId ?? orderLineItemId ?? `${itemId}:${transactionId}`,
      details: { count: targets.length, already_left: alreadyLeftAll },
    });
    return c.json({ ok: true, count: targets.length, already_left: alreadyLeftAll });
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the feedback.", err, "ebay.feedback");
  }
});

// US-1047: scheduled auto-leave positive feedback on recently-completed orders.
// Gated by system_settings "feedback.auto_leave" (default off). Idempotent via an
// admin_audit_log marker per order (shared with manual leaves so neither repeats).
flipdeskEbayRoutes.post("/jobs/leave-feedback", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!(await getSetting<boolean>("feedback.auto_leave", false))) {
    return c.json({ skipped: true, reason: "disabled" });
  }
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const lock = await acquireJobLock("leave-feedback", 240);
  if (!lock.acquired) {
    return c.json({ skipped: true, reason: lock.reason });
  }
  try {
    const { data: conns } = await supabaseAdmin
      .from("marketplace_connections")
      .select("user_id")
      .eq("marketplace", "ebay")
      .eq("is_active", true)
      // US-2387: bounded, ordered so the swept set is stable run to run. This
      // job fans out per owner, so an unordered cap would sweep a different
      // arbitrary subset each tick and a seller could go unswept indefinitely.
      .order("user_id", { ascending: true })
      .limit(EBAY_CONNECTION_SCAN_CAP);
    const ownerIds = Array.from(
      new Set(((conns ?? []) as { user_id: string }[]).map((r) => r.user_id)),
    );
    // Leave a 2-day grace (payment settles) and look back 30 days.
    const windowStart = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const windowEnd = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const PER_OWNER = 50;
    let left = 0;
    let skipped = 0;
    let errors = 0;

    for (const ownerId of ownerIds) {
      const { data: saleRows } = await supabaseAdmin
        .from("sales")
        .select("platform_order_id")
        .eq("user_id", ownerId)
        .eq("status", "completed")
        .not("platform_order_id", "is", null)
        .gte("sold_at", windowStart)
        .lte("sold_at", windowEnd)
        .limit(PER_OWNER);
      const orderIds = Array.from(
        new Set(
          ((saleRows ?? []) as { platform_order_id: string }[]).map(
            (r) => r.platform_order_id,
          ),
        ),
      );
      for (const orderId of orderIds) {
        // Idempotency: skip if feedback was already left for this order.
        const { data: prior } = await supabaseAdmin
          .from("admin_audit_log")
          .select("id")
          .eq("action", "ebay.feedback.leave")
          .eq("target_id", orderId)
          .limit(1)
          .maybeSingle();
        if (prior) {
          skipped += 1;
          continue;
        }
        try {
          const lineItems = await getOrderLegacyLineItems(ownerId, orderId);
          for (const li of lineItems) {
            if (!li.buyerUsername) continue;
            await leaveFeedback(ownerId, {
              itemId: li.itemId,
              transactionId: li.transactionId,
              targetUser: li.buyerUsername,
              comment: "Great buyer — fast payment, smooth transaction. Thank you!",
            });
          }
          await writeSystemAuditLog({
            action: "ebay.feedback.leave",
            targetType: "ebay_feedback",
            targetId: orderId,
            details: { auto: true, count: lineItems.length },
          });
          left += 1;
        } catch (err) {
          errors += 1;
          console.error(
            "[ebay.jobs.leave-feedback]",
            orderId,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
    return c.json({ ok: true, owners: ownerIds.length, left, skipped, errors });
  } finally {
    await lock.release();
  }
});

// ── Payment disputes (US-1049, Fulfillment Payment Disputes API) ────
// Buyer-opened cases / chargebacks escalated to eBay. Seller must accept
// (refund) or contest before respondByDate. Listing is inherently tenant-scoped
// to the owner's token; accept best-effort marks the local sale refunded.

flipdeskEbayRoutes.get("/payment-disputes", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const status = c.req.query("status")?.trim() || undefined;
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  // A status filter is a different question from "all open disputes", and the
  // cache stores one set. Only the unfiltered call is served from it.
  const cached = status
    ? { items: [] as PaymentDisputeSummary[], fresh: false }
    : await loadCachedSummaries<PaymentDisputeSummary>(ownerId, "payment_dispute", { limit });
  if (cached.fresh) return c.json({ disputes: cached.items, source: "cache" });
  try {
    const live = await searchPaymentDisputes(ownerId, { status, limit });
    if (!status) {
      const nowIso = new Date().toISOString();
      await recordPostSaleCases(ownerId, live.map((d) => disputeToCaseInput(d, nowIso)));
    }
    return c.json({ disputes: live, source: "ebay" });
  } catch (err) {
    if (cached.items.length > 0) {
      return c.json({ disputes: cached.items, source: "cache_stale" });
    }
    return failSafe(c, 502, "Couldn't load eBay payment disputes.", err, "ebay.disputes.list");
  }
});

flipdeskEbayRoutes.get("/payment-disputes/:id", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    return c.json({ dispute: await getPaymentDispute(ownerId, c.req.param("id")) });
  } catch (err) {
    return failSafe(c, 502, "Couldn't load the payment dispute.", err, "ebay.disputes.get");
  }
});

flipdeskEbayRoutes.post("/payment-disputes/:id/accept", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const disputeId = c.req.param("id");
  let body: { order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  // Idempotent: if the dispute is already resolved, don't re-POST to eBay.
  try {
    const detail = await getPaymentDispute(ownerId, disputeId);
    if (!isDisputeActionable(detail.status)) {
      await writeAuditLog(c, {
        action: "ebay.dispute.accept",
        targetType: "ebay_payment_dispute",
        targetId: disputeId,
        details: { already_resolved: true, status: detail.status },
      });
      return c.json({ ok: true, alreadyResolved: true });
    }
  } catch (err) {
    // Couldn't read the dispute — fall through and let the action attempt.
    console.warn(
      "[ebay.disputes.accept] status pre-check failed:",
      err instanceof Error ? err.message : err,
    );
  }
  try {
    await acceptPaymentDispute(ownerId, disputeId);
  } catch (err) {
    return failSafe(c, 502, "eBay rejected accepting the dispute.", err, "ebay.disputes.accept");
  }
  // PS-03: the same helper as every other outcome, so an accepted dispute also
  // reverses the consignor payout. The buyer keeps the item, so nothing is
  // restocked (dispute_accepted has no item or listing write).
  const order = await resolveOutcomeOrder(ownerId, "payment_dispute", disputeId, body.order_id);
  await applyOutcomeToSale(ownerId, order.orderId, "dispute_accepted");
  await markPostSaleCaseClosed(ownerId, "payment_dispute", disputeId, "accepted");
  await writeAuditLog(c, {
    action: "ebay.dispute.accept",
    targetType: "ebay_payment_dispute",
    targetId: disputeId,
    details: order.audit,
  });
  return c.json({ ok: true });
});

flipdeskEbayRoutes.post("/payment-disputes/:id/contest", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const disputeId = c.req.param("id");
  let body: { note?: unknown; order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const note = typeof body.note === "string" ? body.note : undefined;
  // Idempotent: skip the eBay POST if the dispute is already resolved.
  try {
    const detail = await getPaymentDispute(ownerId, disputeId);
    if (!isDisputeActionable(detail.status)) {
      await writeAuditLog(c, {
        action: "ebay.dispute.contest",
        targetType: "ebay_payment_dispute",
        targetId: disputeId,
        details: { already_resolved: true, status: detail.status },
      });
      return c.json({ ok: true, alreadyResolved: true });
    }
  } catch (err) {
    console.warn(
      "[ebay.disputes.contest] status pre-check failed:",
      err instanceof Error ? err.message : err,
    );
  }
  try {
    await contestPaymentDispute(ownerId, disputeId, note);
  } catch (err) {
    return failSafe(c, 502, "eBay rejected contesting the dispute.", err, "ebay.disputes.contest");
  }
  await writeAuditLog(c, {
    action: "ebay.dispute.contest",
    targetType: "ebay_payment_dispute",
    targetId: disputeId,
    details: { order_id: body.order_id ?? null, has_note: !!note },
  });
  return c.json({ ok: true });
});

// Dispute activity timeline (read-only). Tenant-scoped via the owner's token.
flipdeskEbayRoutes.get("/payment-disputes/:id/activity", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    return c.json({
      activity: await getPaymentDisputeActivity(ownerId, c.req.param("id")),
    });
  } catch (err) {
    return failSafe(c, 502, "Couldn't load the dispute activity.", err, "ebay.disputes.activity");
  }
});

// Upload a supporting-evidence image and attach it to the dispute. Multipart:
// field `file` (image) + optional `evidence_type`. The line items + default
// evidence type are derived from the live dispute (eBay requires lineItems on
// add_evidence). Tenant-scoped: the dispute is read/written with the owner's
// own eBay token, so there is no cross-tenant surface.
flipdeskEbayRoutes.post("/payment-disputes/:id/evidence", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const disputeId = c.req.param("id");

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Invalid form data. Expected multipart/form-data." }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return c.json({ error: "Missing evidence file." }, 400);
  }

  const rawBytes = new Uint8Array(await file.arrayBuffer());
  // Sniff the magic bytes (don't trust the client MIME) and strip EXIF/GPS
  // before forwarding the buyer-facing image to eBay.
  const verdict = validateImageUpload(rawBytes, { allow: ["jpeg", "png"] });
  if (!verdict.ok) {
    return c.json({ error: `Invalid image: ${verdict.reason}` }, 400);
  }
  const { bytes: cleanBytes } = stripImageMetadata(rawBytes, verdict.format);

  // US-2707: FROM-PACK MODE. Present only when the caller sends order_id and
  // complaint; without them this route behaves exactly as it did — one file,
  // uploaded, attached. The rarer path must not be the one where the safety
  // rule is missing, so the SAME refusal applies here as on returns: when the
  // grade report documents a flaw the listing did not disclose, we do not hand
  // eBay a signed document proving our own user sold it undisclosed.
  const packOrderId = String(form.get("order_id") ?? "").trim();
  const packComplaint = String(form.get("complaint") ?? "").trim();
  let packContext: EvidenceContext | null = null;
  if (packOrderId && packComplaint) {
    packContext = await planEvidence(ownerId, packOrderId, packComplaint);
    // US-2935: the same arbiter the return and case routes use. Three surfaces,
    // one rule about whether to send at all.
    const refusal = evidenceRefusalFor(packContext?.plan);
    if (refusal) return c.json({ error: "refused", ...refusal }, 409);
  }

  let detail: PaymentDisputeDetail;
  try {
    detail = await getPaymentDispute(ownerId, disputeId);
  } catch (err) {
    return failSafe(c, 502, "Couldn't load the payment dispute.", err, "ebay.disputes.evidence.detail");
  }
  const request0 = detail.evidenceRequests[0];
  const evidenceType = (form.get("evidence_type") as string | null)?.trim() ||
    request0?.requestType || "PROOF_OF_DELIVERY";
  const lineItems = request0?.lineItems.length
    ? request0.lineItems
    : detail.lineItems;
  if (lineItems.length === 0) {
    return c.json(
      { error: "eBay has no line items on this dispute to attach evidence to." },
      422,
    );
  }

  try {
    const fileIds: string[] = [];
    // US-2707 AC3: the condition sheet joins the pack, and the evidence TYPE is
    // still whatever the live dispute asked for. eBay requested a category of
    // proof; sending it under a type of our choosing is answering a different
    // question from the one it asked.
    //
    // Only for a CERTIFIED grade, same rule as the return path: a cover page
    // reading "Not certified" argues against the seller on the one asset that
    // exists to argue for them.
    if (packContext?.stamp.certificateNumber) {
      try {
        const sheet = await compositeReturnEvidenceSheet(
          packContext.stamp,
          packContext.defectCount,
          packContext.gradedAt,
        );
        fileIds.push(
          await uploadDisputeEvidenceFile(ownerId, disputeId, {
            bytes: sheet,
            filename: "condition-report.jpg",
            contentType: "image/jpeg",
          }),
        );
      } catch (err) {
        // The photograph is still the evidence.
        console.error(
          "[ebay.disputes.evidence] sheet render failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    fileIds.push(
      await uploadDisputeEvidenceFile(ownerId, disputeId, {
        bytes: cleanBytes,
        filename: file.name || `evidence.${verdict.ext}`,
        contentType: verdict.contentType,
      }),
    );
    const evidenceId = await addDisputeEvidence(ownerId, disputeId, {
      evidenceType,
      fileIds,
      lineItems,
    });
    await writeAuditLog(c, {
      action: "ebay.dispute.evidence",
      targetType: "ebay_payment_dispute",
      targetId: disputeId,
      details: {
        evidence_type: evidenceType,
        evidence_id: evidenceId,
        files: fileIds.length,
        from_pack: packContext !== null,
      },
    });
    return c.json({ ok: true, evidenceId, attached: fileIds.length });
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the evidence upload.", err, "ebay.disputes.evidence");
  }
});


// US-1039: mark an eBay sale shipped + push the tracking number/carrier to eBay
// (Sell Fulfillment API). Without this, FlipDesk only recorded shipping locally
// — eBay never got the tracking, so the buyer saw none and the seller lost
// late-shipment / Seller Protection credit. Tenant-scoped: the sale is loaded
// THROUGH inventory_items.user_id, never by a raw id. Idempotent on a re-click
// with the same tracking (skips the eBay call).
flipdeskEbayRoutes.post("/orders/:saleId/ship", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const saleId = c.req.param("saleId");

  let body: { tracking_number?: unknown; carrier?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const trackingNumber =
    typeof body.tracking_number === "string" ? body.tracking_number.trim() : "";
  const carrier = typeof body.carrier === "string" ? body.carrier.trim() : null;
  if (!trackingNumber) {
    return c.json({ error: "tracking_number is required" }, 400);
  }

  // Tenant-scoped load (US-268): the sale must belong to the owner.
  const { data: saleRow } = await supabaseAdmin
    .from("sales")
    .select(
      "id, platform_order_id, shipped_at, tracking_number, inventory_items!inner(user_id)",
    )
    .eq("id", saleId)
    .eq("inventory_items.user_id", userId)
    .maybeSingle();
  const sale = saleRow as
    | {
      id: string;
      platform_order_id: string | null;
      shipped_at: string | null;
      tracking_number: string | null;
    }
    | null;
  if (!sale) return c.json({ error: "Sale not found." }, 404);
  if (!sale.platform_order_id) {
    return c.json(
      { error: "This sale has no eBay order id to mark shipped." },
      409,
    );
  }

  // Idempotent: an already-shipped sale with the same tracking just re-asserts
  // local state (eBay would reject a duplicate fulfillment).
  const alreadyShipped =
    sale.shipped_at != null && sale.tracking_number === trackingNumber;
  if (!alreadyShipped) {
    try {
      await createShippingFulfillment(userId, sale.platform_order_id, {
        trackingNumber,
        carrier,
      });
    } catch (err) {
      console.error("[flipdesk-ebay] createShippingFulfillment failed:", err);
      return c.json(
        {
          error: "eBay rejected the tracking upload.",
          detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
        },
        502,
      );
    }
  }

  const { error: updErr } = await supabaseAdmin
    .from("sales")
    .update({
      shipped_at: sale.shipped_at ?? new Date().toISOString(),
      tracking_number: trackingNumber,
      // US-960: persist the carrier alongside the tracking number (column added
      // in 00250) so the Shipped tab can show it. Keep an existing value when
      // the caller didn't send one.
      ...(carrier ? { carrier } : {}),
    })
    .eq("id", sale.id);
  if (updErr) {
    console.error("[flipdesk-ebay] sale ship write-back failed:", updErr.message);
  }
  return c.json({ ok: true, pushed_to_ebay: !alreadyShipped });
});
