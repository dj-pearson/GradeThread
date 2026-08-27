// US-2927: the local record of post-sale cases (marketplace_post_sale_cases).
//
// eBay stays the source of truth for a case's STATE. This module is the record
// of what we have seen, and it exists because three things were impossible
// without one: a deadline that survives a page reload, any history after eBay
// stops serving a closed case, and any analysis that joins a return to the
// grade we assigned the item.
//
// ── THE UPSERT RULE, WHICH IS THE WHOLE DESIGN ──────────────────────────────
//
// A poll re-reads eBay's SUMMARY shapes, and a summary carries fewer fields
// than a detail fetch. If the upsert wrote every column it would overwrite a
// field we already have with the null the summary happened to omit — which is
// how a respond_by, once known, disappears on the next poll. So `toCaseRow`
// emits only the keys it actually has a value for, and everything else is left
// untouched by the merge. A test asserts exactly this.
//
// Tenant-scoped by construction: every function here takes an ownerId and every
// query filters on it (US-268). The service-role client bypasses RLS, so the
// `.eq("user_id", ownerId)` is the real lock, not the policy.

import { supabaseAdmin } from "./supabase.ts";
import { isClosedCase } from "./post-sale-state.ts";
import type { CancellationSummary, ReturnSummary } from "./ebay-postorder.ts";
import type { PaymentDisputeSummary } from "./ebay-disputes.ts";
import type { InquirySummary } from "./ebay-inquiries.ts";
import type { CaseSummary } from "./ebay-cases.ts";

export type PostSaleCaseType =
  | "return"
  | "cancellation"
  | "payment_dispute"
  | "inquiry"
  | "case";

/** One post-sale case as the rest of the service reads it. */
export interface PostSaleCase {
  id: string;
  caseType: PostSaleCaseType;
  externalId: string;
  externalOrderId: string | null;
  itemExternalId: string | null;
  inventoryItemId: string | null;
  saleId: string | null;
  state: string | null;
  reason: string | null;
  buyerUsername: string | null;
  amountCents: number | null;
  currency: string | null;
  openedAt: string | null;
  respondBy: string | null;
  closedAt: string | null;
  outcome: string | null;
  lastSeenAt: string | null;
}

/** What a caller hands the store. Every field but the key three is optional. */
export interface PostSaleCaseInput {
  caseType: PostSaleCaseType;
  externalId: string;
  externalOrderId?: string | null;
  itemExternalId?: string | null;
  state?: string | null;
  reason?: string | null;
  buyerUsername?: string | null;
  amountCents?: number | null;
  currency?: string | null;
  openedAt?: string | null;
  respondBy?: string | null;
  closedAt?: string | null;
  outcome?: string | null;
  raw?: unknown;
}

/**
 * How stale a stored case may be before a read goes back to eBay.
 *
 * Named rather than inlined because two routes and the freshness test all have
 * to mean the same number. Five minutes is the poll cadence's own order of
 * magnitude: long enough that opening the page twice costs one eBay call, short
 * enough that a seller who just acted in Seller Hub sees it on a refresh.
 */
export const POST_SALE_FRESHNESS_MS = 5 * 60 * 1000;

/**
 * Turn an input into a database row, OMITTING every field the caller left
 * undefined so an upsert cannot null out a column a richer earlier read filled.
 *
 * Pure and exported for the test. Note the asymmetry: `undefined` means "I do
 * not know", and is dropped; an explicit `null` means "eBay says there is no
 * value", and IS written. Callers that normalize eBay payloads produce `null`
 * for a field eBay omitted, so pass `undefined` only for a field the call shape
 * genuinely cannot carry.
 */
export function toCaseRow(
  ownerId: string,
  input: PostSaleCaseInput,
  nowIso: string,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    user_id: ownerId,
    platform: "ebay",
    case_type: input.caseType,
    external_id: input.externalId,
    last_seen_at: nowIso,
  };
  const optional: Array<[string, unknown]> = [
    ["external_order_id", input.externalOrderId],
    ["item_external_id", input.itemExternalId],
    ["state", input.state],
    ["reason", input.reason],
    ["buyer_username", input.buyerUsername],
    ["amount_cents", input.amountCents],
    ["currency", input.currency],
    ["opened_at", input.openedAt],
    ["respond_by", input.respondBy],
    ["closed_at", input.closedAt],
    ["outcome", input.outcome],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) row[key] = value;
  }
  if (input.raw !== undefined) row.raw = input.raw;
  return row;
}

// ── US-2927: eBay summary → stored case row ─────────────────────────
//
// Pure, and each one returns the SUMMARY's fields only. A field the summary
// shape cannot carry is left `undefined` rather than set to null, because
// toCaseRow drops undefined and writes null — so `undefined` here is what stops
// a later poll erasing a respond_by an earlier detail fetch already stored.
//
// closed_at is set from the state, using the observation time as the date. eBay
// gives no close timestamp on these summary shapes, so this column means "the
// first time we saw it closed", which is the honest reading and is what the
// column comment on the table says.

function moneyToCents(amount: number | null | undefined): number | null | undefined {
  if (amount == null) return amount === null ? null : undefined;
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

export function returnToCaseInput(r: ReturnSummary, nowIso: string): PostSaleCaseInput {
  return {
    caseType: "return",
    externalId: r.returnId,
    externalOrderId: r.orderId,
    itemExternalId: r.itemId,
    state: r.state,
    reason: r.reason,
    buyerUsername: r.buyerUsername,
    respondBy: r.respondBy,
    openedAt: r.creationDate,
    closedAt: isClosedCase(r.state) ? nowIso : null,
    raw: r,
  };
}

export function cancellationToCaseInput(
  c: CancellationSummary,
  nowIso: string,
): PostSaleCaseInput {
  return {
    caseType: "cancellation",
    externalId: c.cancelId,
    externalOrderId: c.orderId,
    state: c.state,
    reason: c.reason,
    openedAt: c.creationDate,
    closedAt: isClosedCase(c.state) ? nowIso : null,
    raw: c,
  };
}

export function disputeToCaseInput(
  d: PaymentDisputeSummary,
  nowIso: string,
): PostSaleCaseInput {
  return {
    caseType: "payment_dispute",
    externalId: d.paymentDisputeId,
    externalOrderId: d.orderId,
    state: d.status,
    reason: d.reason,
    buyerUsername: d.buyerUsername,
    amountCents: moneyToCents(d.amount),
    currency: d.currency,
    openedAt: d.openedDate,
    respondBy: d.respondByDate,
    closedAt: isClosedCase(d.status) ? nowIso : null,
    raw: d,
  };
}

export function inquiryToCaseInput(i: InquirySummary, nowIso: string): PostSaleCaseInput {
  return {
    caseType: "inquiry",
    externalId: i.inquiryId,
    externalOrderId: i.orderId,
    itemExternalId: i.itemId,
    state: i.state,
    reason: i.reason,
    buyerUsername: i.buyerUsername,
    respondBy: i.respondBy,
    openedAt: i.creationDate,
    closedAt: isClosedCase(i.state) ? nowIso : null,
    raw: i,
  };
}

export function caseToCaseInput(x: CaseSummary, nowIso: string): PostSaleCaseInput {
  return {
    caseType: "case",
    externalId: x.caseId,
    externalOrderId: x.orderId,
    itemExternalId: x.itemId,
    state: x.state,
    reason: x.reason,
    buyerUsername: x.buyerUsername,
    amountCents: x.amountCents,
    currency: x.currency,
    respondBy: x.respondBy,
    openedAt: x.creationDate,
    closedAt: isClosedCase(x.state) ? nowIso : null,
    // escalatedFrom has no column of its own; it rides in `raw` and the page
    // reads it back from there to thread the case to the return or inquiry it
    // grew out of.
    raw: x,
  };
}

/**
 * Record what a poll or a route just learned about a set of cases.
 *
 * Best-effort by design: a storage failure must never take down the poll that
 * was really there to notify. Returns the number of rows written, or 0 on a
 * failure it has already logged.
 */
export async function recordPostSaleCases(
  ownerId: string,
  inputs: PostSaleCaseInput[],
  nowIso: string = new Date().toISOString(),
): Promise<number> {
  const rows = inputs
    .filter((i) => i.externalId)
    .map((i) => toCaseRow(ownerId, i, nowIso));
  if (rows.length === 0) return 0;
  const { error } = await supabaseAdmin
    .from("marketplace_post_sale_cases")
    .upsert(rows, { onConflict: "user_id,platform,case_type,external_id" });
  if (error) {
    console.error("[post-sale-store] recordPostSaleCases:", error.message);
    return 0;
  }
  return rows.length;
}

/**
 * The cached eBay SUMMARY objects for one owner and case type, plus whether the
 * set is fresh enough to serve without calling eBay.
 *
 * Reads the stored `raw` payload rather than reassembling a summary from the
 * flat columns, and that is deliberate: the columns are a projection chosen for
 * querying, so a reassembled summary would silently lose every field the
 * projection does not carry (a cancellation's requestorType, for one, which the
 * poll uses to decide whether the seller started it). Reading `raw` back is
 * lossless by construction.
 */
export interface CachedSummaries<T> {
  items: T[];
  fresh: boolean;
}

export async function loadCachedSummaries<T>(
  ownerId: string,
  caseType: PostSaleCaseType,
  opts: { limit?: number; nowMs?: number; windowMs?: number } = {},
): Promise<CachedSummaries<T>> {
  const { data, error } = await supabaseAdmin
    .from("marketplace_post_sale_cases")
    .select("raw, last_seen_at")
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .eq("case_type", caseType)
    .order("opened_at", { ascending: false, nullsFirst: false })
    .limit(opts.limit ?? 100);
  if (error) {
    console.error("[post-sale-store] loadCachedSummaries:", error.message);
    return { items: [], fresh: false };
  }
  const rows = (data ?? []) as unknown as Array<{ raw: unknown; last_seen_at: string | null }>;
  const nowMs = opts.nowMs ?? Date.now();
  return {
    items: rows.map((r) => r.raw as T).filter((x) => x != null),
    fresh: isSummarySetFresh(rows, nowMs, opts.windowMs),
  };
}

/**
 * Freshness over the raw rows. Pure, so the rule is testable without a database.
 *
 * An EMPTY set is never fresh: "we have no rows" and "this seller has no cases"
 * are different claims and only eBay can tell them apart.
 */
export function isSummarySetFresh(
  rows: Array<{ last_seen_at: string | null }>,
  nowMs: number,
  windowMs: number = POST_SALE_FRESHNESS_MS,
): boolean {
  if (rows.length === 0) return false;
  for (const r of rows) {
    if (!r.last_seen_at) return false;
    const seen = Date.parse(r.last_seen_at);
    if (!Number.isFinite(seen) || nowMs - seen > windowMs) return false;
  }
  return true;
}

const SELECT_COLUMNS =
  "id, case_type, external_id, external_order_id, item_external_id, inventory_item_id, " +
  "sale_id, state, reason, buyer_username, amount_cents, currency, opened_at, respond_by, " +
  "closed_at, outcome, last_seen_at";

interface CaseRow {
  id: string;
  case_type: string;
  external_id: string;
  external_order_id: string | null;
  item_external_id: string | null;
  inventory_item_id: string | null;
  sale_id: string | null;
  state: string | null;
  reason: string | null;
  buyer_username: string | null;
  amount_cents: number | null;
  currency: string | null;
  opened_at: string | null;
  respond_by: string | null;
  closed_at: string | null;
  outcome: string | null;
  last_seen_at: string | null;
}

function fromRow(r: CaseRow): PostSaleCase {
  return {
    id: r.id,
    caseType: r.case_type as PostSaleCaseType,
    externalId: r.external_id,
    externalOrderId: r.external_order_id,
    itemExternalId: r.item_external_id,
    inventoryItemId: r.inventory_item_id,
    saleId: r.sale_id,
    state: r.state,
    reason: r.reason,
    buyerUsername: r.buyer_username,
    amountCents: r.amount_cents,
    currency: r.currency,
    openedAt: r.opened_at,
    respondBy: r.respond_by,
    closedAt: r.closed_at,
    outcome: r.outcome,
    lastSeenAt: r.last_seen_at,
  };
}

/** One owner's stored cases of a given type, newest first. */
export async function loadPostSaleCases(
  ownerId: string,
  caseType: PostSaleCaseType,
  opts: { limit?: number; includeClosed?: boolean } = {},
): Promise<PostSaleCase[]> {
  let q = supabaseAdmin
    .from("marketplace_post_sale_cases")
    .select(SELECT_COLUMNS)
    .eq("user_id", ownerId)
    .eq("case_type", caseType);
  if (!opts.includeClosed) q = q.is("closed_at", null);
  const { data, error } = await q
    .order("opened_at", { ascending: false, nullsFirst: false })
    .limit(opts.limit ?? 100);
  if (error) {
    console.error("[post-sale-store] loadPostSaleCases:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as CaseRow[]).map(fromRow);
}

/**
 * Is the stored set fresh enough to serve without calling eBay?
 *
 * Pure so the freshness rule is testable without a database. An EMPTY set is
 * never fresh — "we have no rows" and "this seller has no cases" are different
 * claims and only eBay can tell them apart.
 */
export function isFresh(
  cases: PostSaleCase[],
  nowMs: number,
  windowMs: number = POST_SALE_FRESHNESS_MS,
): boolean {
  if (cases.length === 0) return false;
  for (const c of cases) {
    if (!c.lastSeenAt) return false;
    const seen = Date.parse(c.lastSeenAt);
    if (!Number.isFinite(seen) || nowMs - seen > windowMs) return false;
  }
  return true;
}

/**
 * Mark one stored case closed without waiting for the next poll, so an action
 * the seller just took is reflected on the page they took it from.
 *
 * Owner-scoped. Silent on failure — the poll will correct it.
 */
export async function markPostSaleCaseClosed(
  ownerId: string,
  caseType: PostSaleCaseType,
  externalId: string,
  outcome: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("marketplace_post_sale_cases")
    .update({ closed_at: new Date().toISOString(), outcome })
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .eq("case_type", caseType)
    .eq("external_id", externalId);
  if (error) {
    console.error("[post-sale-store] markPostSaleCaseClosed:", error.message);
  }
}

/**
 * US-2936: fill in `inventory_item_id` / `sale_id` on stored cases that have
 * neither yet.
 *
 * eBay hands back an order id and (on some case types) its own item id, and
 * neither is a FlipDesk id. Without this step every stored case is an orphan:
 * the analytics join has nothing to join ON, and the whole point of the table —
 * measuring returns against the grade we assigned — cannot be computed.
 *
 * Runs as a step in the sweep rather than inline in each source, because the
 * link is the SAME question for all five case types and doing it per source
 * would be five copies of one lookup, free to drift.
 *
 * Only ever fills a NULL. A row already linked is left alone, so a later eBay
 * payload cannot re-point a case at a different item.
 */
export async function linkPostSaleCases(ownerId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("marketplace_post_sale_cases")
    .select("id, external_order_id, item_external_id")
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .is("inventory_item_id", null)
    .limit(LINK_SCAN_CAP);
  if (error) {
    console.error("[post-sale-store] linkPostSaleCases scan:", error.message);
    return 0;
  }
  const rows = (data ?? []) as unknown as Array<{
    id: string;
    external_order_id: string | null;
    item_external_id: string | null;
  }>;
  if (rows.length === 0) return 0;

  const orderIds = [...new Set(rows.map((r) => r.external_order_id).filter(Boolean))] as string[];
  const itemIds = [...new Set(rows.map((r) => r.item_external_id).filter(Boolean))] as string[];

  // Order id first — a sale is the stronger signal, and it is the only one that
  // also yields a sale_id.
  const byOrder = new Map<string, { itemId: string; saleId: string }>();
  if (orderIds.length > 0) {
    const { data: sales, error: salesError } = await supabaseAdmin
      .from("sales")
      .select("id, inventory_item_id, platform_order_id")
      .eq("user_id", ownerId)
      .in("platform_order_id", orderIds);
    if (salesError) {
      console.error("[post-sale-store] linkPostSaleCases sales:", salesError.message);
    } else {
      for (
        const s of (sales ?? []) as unknown as Array<{
          id: string;
          inventory_item_id: string | null;
          platform_order_id: string | null;
        }>
      ) {
        if (s.platform_order_id && s.inventory_item_id) {
          byOrder.set(s.platform_order_id, { itemId: s.inventory_item_id, saleId: s.id });
        }
      }
    }
  }

  const byItem = new Map<string, string>();
  if (itemIds.length > 0) {
    const { data: listings, error: listingsError } = await supabaseAdmin
      .from("listings")
      .select("inventory_item_id, platform_listing_id")
      .eq("user_id", ownerId)
      .eq("platform", "ebay")
      .in("platform_listing_id", itemIds);
    if (listingsError) {
      console.error("[post-sale-store] linkPostSaleCases listings:", listingsError.message);
    } else {
      for (
        const l of (listings ?? []) as unknown as Array<{
          inventory_item_id: string | null;
          platform_listing_id: string | null;
        }>
      ) {
        if (l.platform_listing_id && l.inventory_item_id) {
          byItem.set(l.platform_listing_id, l.inventory_item_id);
        }
      }
    }
  }

  let linked = 0;
  for (const row of rows) {
    const viaOrder = row.external_order_id ? byOrder.get(row.external_order_id) : undefined;
    const itemId = viaOrder?.itemId ??
      (row.item_external_id ? byItem.get(row.item_external_id) : undefined);
    if (!itemId) continue;
    const patch: Record<string, unknown> = { inventory_item_id: itemId };
    if (viaOrder?.saleId) patch.sale_id = viaOrder.saleId;
    const { error: writeError } = await supabaseAdmin
      .from("marketplace_post_sale_cases")
      .update(patch)
      .eq("id", row.id)
      .eq("user_id", ownerId);
    if (writeError) {
      console.error("[post-sale-store] linkPostSaleCases write:", writeError.message);
      continue;
    }
    linked++;
  }
  return linked;
}

/** Bound on one sweep's linking work. A backlog drains over successive sweeps. */
const LINK_SCAN_CAP = 200;

/**
 * Merge a patch into one stored case's `raw` payload.
 *
 * US-2931 needs this: the buyer's return shipment has no column of its own and
 * does not deserve one — it is read once per return, is not queried, and adding
 * a column per eBay field is how a projection turns into a second schema. It
 * rides in `raw`, and because `loadCachedSummaries` serves `raw` back verbatim,
 * the tracking reaches the page with the return list and survives a reload.
 *
 * Read-modify-write, which is safe here: the only writers are this seller's own
 * poll and their own route calls, so a lost update means one stale tracking
 * number until the next read, not corruption.
 */
export async function mergePostSaleCaseRaw(
  ownerId: string,
  caseType: PostSaleCaseType,
  externalId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("marketplace_post_sale_cases")
    .select("raw")
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .eq("case_type", caseType)
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) {
    console.error("[post-sale-store] mergePostSaleCaseRaw read:", error.message);
    return;
  }
  const current = ((data as { raw?: unknown } | null)?.raw ?? {}) as Record<string, unknown>;
  const { error: writeError } = await supabaseAdmin
    .from("marketplace_post_sale_cases")
    .update({ raw: { ...current, ...patch } })
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .eq("case_type", caseType)
    .eq("external_id", externalId);
  if (writeError) {
    console.error("[post-sale-store] mergePostSaleCaseRaw write:", writeError.message);
  }
}

/**
 * Patch one stored case's state, for an action whose result eBay reports
 * immediately (a return marked received, a label read). Owner-scoped.
 */
export async function updatePostSaleCaseState(
  ownerId: string,
  caseType: PostSaleCaseType,
  externalId: string,
  patch: Partial<Pick<PostSaleCaseInput, "state" | "respondBy" | "outcome">>,
): Promise<void> {
  const row: Record<string, unknown> = {};
  if (patch.state !== undefined) row.state = patch.state;
  if (patch.respondBy !== undefined) row.respond_by = patch.respondBy;
  if (patch.outcome !== undefined) row.outcome = patch.outcome;
  if (Object.keys(row).length === 0) return;
  const { error } = await supabaseAdmin
    .from("marketplace_post_sale_cases")
    .update(row)
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .eq("case_type", caseType)
    .eq("external_id", externalId);
  if (error) {
    console.error("[post-sale-store] updatePostSaleCaseState:", error.message);
  }
}
