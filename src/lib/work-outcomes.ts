// Worth My Time, R2 02/06 (US-3179): did the estimates match what sold?
//
// R1 told sellers a garment was "worth about $33 after costs, if it sells".
// This is the file that goes back and checks, and most of it is about the
// cases where the honest answer is "we cannot say yet" -- because the
// tempting version of this screen quietly turns every one of those into a
// zero and reports a model that is wrong in one direction.
//
// ── ONE LEDGER, NOT TWO (AC1) ───────────────────────────────────────────────
// The recorded result is saleNetCents from lib/ledger-math.ts, which is
// finances_dashboard's pnl_net term for term. Nothing here re-derives a
// profit. A second calculation would drift from the books within a quarter and
// the seller would have two numbers for one sale with no way to tell which is
// the real one.
//
// ── ONE ITEM, COUNTED ONCE (AC2) ────────────────────────────────────────────
// A garment can be planned in three sessions and cross-listed on four
// marketplaces and still be ONE sale. So the unit here is the INVENTORY ITEM,
// never the task and never the listing. It keeps the FIRST eligible estimate
// -- the one the seller was actually shown when they decided to do the work --
// and sums the confirmed minutes across every session that touched it.
//
// Matching is by inventory_item_id and by nothing else. A task whose item was
// deleted has a null id (the FK is ON DELETE SET NULL) and it keeps its title
// snapshot, which makes a title match look available and would be wrong: two
// sellers own "Levi 501 jeans" and so does the same seller, twice.
//
// ── A REFUND RESTATES, IT DOES NOT STAY A WIN (AC3) ─────────────────────────
// The failure this exists to prevent is a scorecard that books a sale, shows
// the seller a good number, and never moves when the buyer sends it back. A
// refunded sale is reported as refunded with the money restated, not quietly
// left in the win column and not silently deleted either -- the work still
// happened and the hours are still theirs.
//
// ── UNSOLD IS NOT ZERO (AC4) ────────────────────────────────────────────────
// An item that has not sold is `pending` inside R1's 30-day horizon and
// `not_sold_within_horizon` after it. Treating it as a $0 sale would drag
// every average down with garments that are still perfectly likely to sell,
// and hiding it forever would flatter the model by dropping its failures.
//
// ── THIS FILE SHOWS NOBODY ANYTHING (AC5) ───────────────────────────────────
// It computes and it classifies. The scorecard is R2 06/06. Nothing here
// rewrites a price or a sale probability, and it must not start: a median over
// four sales is not evidence, and a model that re-fits itself on one bad month
// is worse than one that does not move.

import { saleNetCents, type SaleMoney } from "@/lib/ledger-math";
import { EVIDENCE_SOURCES, PLANNING_HORIZON_DAYS } from "@/lib/work-value";

export const OUTCOMES_MODEL_VERSION = 1;

/** Where an estimate's evidence came from, plus the R1 tiers. */
export type EstimateSource = (typeof EVIDENCE_SOURCES)[number] | "unknown";

/**
 * What happened to an item that was planned.
 *
 * `incomplete_costs` is a separate answer from `sold` on purpose (AC3): the
 * garment did sell, and we still cannot say what it made. Collapsing the two
 * would either invent the missing costs or throw away a real sale.
 */
export const OUTCOME_STATES = [
  "sold",
  "refunded",
  "incomplete_costs",
  "pending",
  "not_sold_within_horizon",
  "cancelled",
  "unmatchable",
] as const;
export type OutcomeState = (typeof OUTCOME_STATES)[number];

/** One planned task, as the read model returns it. */
export interface PlannedTask {
  taskId: string;
  sessionId: string;
  inventoryItemId: string | null;
  /** Kept only for display of an unmatchable row. NEVER used to match (AC2). */
  itemTitleSnapshot: string | null;
  actionKey: string;
  taskState: string;
  sessionState: string;
  /** The conservative value the seller was shown, in cents. */
  estimateValueCents: number | null;
  estimateSource: string | null;
  /** When the estimate was taken. Decides which snapshot is FIRST. */
  estimateTakenAt: string | null;
  confirmedMinutes: number | null;
  correctionMinutes: number | null;
}

/** One sale row, exactly as the books hold it. */
export interface SaleRecord {
  saleId: string;
  inventoryItemId: string | null;
  status: string;
  cancelledAt: string | null;
  soldAt: string | null;
  money: SaleMoney;
  acquiredPrice: number | string | null;
  legacyShipTotal: number | string | null;
  marketplace: string | null;
}

/** The item itself, for the horizon clock and the acquisition basis. */
export interface PlannedItem {
  inventoryItemId: string;
  /** When the item entered stock. The horizon is measured from the PLAN. */
  createdAt: string | null;
}

export interface OutcomeInput {
  tasks: readonly PlannedTask[];
  sales: readonly SaleRecord[];
  items: readonly PlannedItem[];
  /** Server time. Passed in so the result is deterministic and testable. */
  now: string;
  horizonDays?: number;
}

export interface Outcome {
  inventoryItemId: string;
  state: OutcomeState;
  /** The FIRST estimate this item was planned with, in cents (AC2). */
  estimatedNetCents: number | null;
  estimateSource: EstimateSource;
  /** When that first estimate was taken. */
  estimatedAt: string | null;
  /** Confirmed minutes across EVERY session that touched this item (AC2). */
  confirmedMinutes: number;
  /** How many sessions planned it. A repeat is not a second sale. */
  sessionCount: number;
  /** The books' own net, in cents. Null whenever it cannot be stated. */
  recordedNetCents: number | null;
  /** Why it cannot be stated, when it cannot. */
  incompleteReason: string | null;
  saleId: string | null;
  marketplace: string | null;
  soldAt: string | null;
  /** Days between the first estimate and now, for the horizon call. */
  ageDays: number | null;
}

function effectiveMinutes(t: PlannedTask): number {
  if (t.correctionMinutes != null) return t.correctionMinutes;
  if (t.confirmedMinutes != null) return t.confirmedMinutes;
  return 0;
}

function toSource(raw: string | null): EstimateSource {
  return (EVIDENCE_SOURCES as readonly string[]).includes(raw ?? "")
    ? (raw as EstimateSource)
    : "unknown";
}

function daysBetween(fromIso: string | null, toIso: string): number | null {
  if (!fromIso) return null;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return (to - from) / 86_400_000;
}

/**
 * Is every figure the net calculation needs actually recorded?
 *
 * INCOMPLETE MEANS INCOMPLETE (AC3). A missing fee is not a zero fee: eBay
 * takes its cut whether or not the row says so, and treating an absent number
 * as nothing would report a profit the seller never made.
 *
 * ⚠ WHICH OF THESE CAN ACTUALLY BE ABSENT IN PRODUCTION, checked against the
 * schema rather than assumed, because the first version of this function read
 * as a safeguard over five fields and could only ever fire on one.
 *
 * EVERY money column on `sales` is NOT NULL with a DEFAULT 0 -- sale_price,
 * platform_fees, payment_processing_fees, shipping_cost and the rest. So the
 * sale-side checks below cannot fire against a row that came out of that
 * table, and they are kept only because this is a library function and its
 * caller is not guaranteed to be that one route: a hand-built row, a future
 * view, or a marketplace importer that has not filled a column yet all reach
 * it. Reading a zero platform fee as "missing" is the alternative and it would
 * be worse -- the books say zero, and second-guessing them is exactly the
 * separate ledger AC1 forbids.
 *
 * `inventory_items.acquired_price` IS nullable, and it is the one that fires
 * in practice: a seller who never recorded what they paid has a gross receipt,
 * not a profit, and this is what stops it being presented as one.
 *
 * `null` and `undefined` are missing. The string "0" and the number 0 are
 * recorded zeros and are fine -- exactly the distinction a truthy check loses.
 */
function missingCostFields(sale: SaleRecord): string[] {
  const required: (keyof SaleMoney)[] = [
    "sale_price",
    "platform_fees",
    "payment_processing_fees",
    "shipping_cost",
  ];
  const missing: string[] = required.filter((k) => {
    const v = sale.money[k];
    return v === null || v === undefined || v === "";
  });
  // The acquisition basis is a column on the ITEM rather than the sale, and it
  // is just as required: a net without it is a gross receipt wearing the word
  // "profit".
  if (sale.acquiredPrice === null || sale.acquiredPrice === undefined) {
    missing.push("acquired_price");
  }
  return missing;
}

/**
 * Which sale is THE sale for an item, when it has more than one row.
 *
 * Cross-listing means one garment can carry a sale row per marketplace; only
 * one of them is real. A completed or refunded row always beats a cancelled
 * one, because a cancelled row is the cross-post being withdrawn. Among the
 * rest the earliest wins, since that is the one that actually transacted.
 */
function pickSale(sales: readonly SaleRecord[]): SaleRecord | null {
  if (sales.length === 0) return null;
  const live = sales.filter((s) => s.status !== "cancelled");
  const pool = live.length > 0 ? live : sales;
  return [...pool].sort((a, b) => {
    const at = a.soldAt ?? "9999";
    const bt = b.soldAt ?? "9999";
    return at < bt ? -1 : at > bt ? 1 : a.saleId < b.saleId ? -1 : 1;
  })[0]!;
}

/**
 * Compare what was planned with what the books recorded.
 *
 * PURE and deterministic: `now` is a parameter, so the same rows produce the
 * same answer in a test, in a browser and a week later.
 */
export function compareOutcomes(input: OutcomeInput): {
  outcomes: Outcome[];
  version: number;
} {
  const horizon = input.horizonDays ?? PLANNING_HORIZON_DAYS;

  // ── group the work by ITEM, never by task or listing (AC2) ──────────
  const byItem = new Map<string, PlannedTask[]>();
  const unmatchable: Outcome[] = [];
  for (const t of input.tasks) {
    if (t.inventoryItemId === null) {
      // The item was deleted or transferred. Its title snapshot survives and
      // is NOT used to find a replacement: the same seller can own two "Levi
      // 501 jeans", so a title match would attribute one garment's sale to
      // another's work.
      unmatchable.push({
        inventoryItemId: "",
        state: "unmatchable",
        estimatedNetCents: t.estimateValueCents,
        estimateSource: toSource(t.estimateSource),
        estimatedAt: t.estimateTakenAt,
        confirmedMinutes: effectiveMinutes(t),
        sessionCount: 1,
        recordedNetCents: null,
        incompleteReason: "The item this work was planned for no longer exists.",
        saleId: null,
        marketplace: null,
        soldAt: null,
        ageDays: null,
      });
      continue;
    }
    const list = byItem.get(t.inventoryItemId) ?? [];
    list.push(t);
    byItem.set(t.inventoryItemId, list);
  }

  const salesByItem = new Map<string, SaleRecord[]>();
  for (const s of input.sales) {
    if (!s.inventoryItemId) continue;
    const list = salesByItem.get(s.inventoryItemId) ?? [];
    list.push(s);
    salesByItem.set(s.inventoryItemId, list);
  }

  const itemById = new Map(input.items.map((i) => [i.inventoryItemId, i]));

  const outcomes: Outcome[] = [];
  for (const [itemId, tasks] of byItem) {
    // THE FIRST ELIGIBLE SNAPSHOT (AC2): the estimate the seller was actually
    // shown when they decided to spend the evening on this garment. A later
    // session's estimate is a different decision and re-scoring against it
    // would judge the model on information it did not have.
    const withEstimate = tasks
      .filter((t) => t.estimateValueCents != null && t.estimateTakenAt != null)
      .sort((a, b) => (a.estimateTakenAt! < b.estimateTakenAt! ? -1 : 1));
    const first = withEstimate[0] ?? null;

    const base: Outcome = {
      inventoryItemId: itemId,
      estimatedNetCents: first?.estimateValueCents ?? null,
      estimateSource: toSource(first?.estimateSource ?? null),
      estimatedAt: first?.estimateTakenAt ?? null,
      // EVERY session's confirmed minutes, because the seller really did spend
      // them all on this garment (AC2).
      confirmedMinutes: tasks.reduce((sum, t) => sum + effectiveMinutes(t), 0),
      sessionCount: new Set(tasks.map((t) => t.sessionId)).size,
      recordedNetCents: null,
      incompleteReason: null,
      saleId: null,
      marketplace: null,
      soldAt: null,
      ageDays: daysBetween(first?.estimateTakenAt ?? itemById.get(itemId)?.createdAt ?? null, input.now),
      state: "pending",
    };

    const sale = pickSale(salesByItem.get(itemId) ?? []);

    if (!sale || sale.status === "pending") {
      // AC4: unsold is NOT a zero-dollar sale. Inside the horizon it is still
      // running; outside it, the answer is that it did not sell in the window
      // the estimate was made for.
      base.state = base.ageDays != null && base.ageDays > horizon
        ? "not_sold_within_horizon"
        : "pending";
      outcomes.push(base);
      continue;
    }

    if (sale.status === "cancelled" || sale.cancelledAt !== null) {
      // Excluded from the comparison outright (AC3). A cancelled sale is not
      // a failure of the estimate; nothing transacted.
      outcomes.push({ ...base, state: "cancelled", saleId: sale.saleId, marketplace: sale.marketplace });
      outcomes[outcomes.length - 1]!.incompleteReason =
        "The sale was cancelled, so there is nothing to compare against.";
      continue;
    }

    const missing = missingCostFields(sale);
    if (missing.length > 0) {
      outcomes.push({
        ...base,
        state: "incomplete_costs",
        saleId: sale.saleId,
        marketplace: sale.marketplace,
        soldAt: sale.soldAt,
        incompleteReason: `Not enough recorded to state a result: ${missing.join(", ")}.`,
      });
      continue;
    }

    // ONE LEDGER (AC1). This is finances_dashboard's pnl_net, not a second
    // opinion about it.
    const net = saleNetCents(sale.money, sale.acquiredPrice, sale.legacyShipTotal);
    outcomes.push({
      ...base,
      // A refund RESTATES rather than staying a win (AC3). The money is the
      // books' own figure either way; what changes is that the row says so.
      state: sale.status === "refunded" ? "refunded" : "sold",
      recordedNetCents: net,
      saleId: sale.saleId,
      marketplace: sale.marketplace,
      soldAt: sale.soldAt,
    });
  }

  return {
    outcomes: [...outcomes, ...unmatchable],
    version: OUTCOMES_MODEL_VERSION,
  };
}

export interface OutcomeSummary {
  /** Counts per state. Every state appears, including the zeroes. */
  counts: Record<OutcomeState, number>;
  /** Counts per estimate source, reported SEPARATELY (AC4). */
  bySource: Record<EstimateSource, number>;
  /** Only the rows where both numbers exist. */
  comparable: number;
  estimatedTotalCents: number;
  recordedTotalCents: number;
  confirmedMinutes: number;
  version: number;
}

/**
 * Add the outcomes up, without inventing any.
 *
 * ONLY `sold` AND `refunded` CONTRIBUTE MONEY. Everything else is counted and
 * contributes nothing, because the alternative is to decide what a pending
 * item is worth, and the honest answer is that nobody knows yet.
 *
 * `bySource` is reported separately because an estimate built on an active
 * asking price is a different claim from one built on a sold comp (AC4), and
 * an average over the two says nothing about either.
 */
export function summarize(outcomes: readonly Outcome[]): OutcomeSummary {
  const counts = Object.fromEntries(
    OUTCOME_STATES.map((s) => [s, 0]),
  ) as Record<OutcomeState, number>;
  const bySource = Object.fromEntries(
    [...EVIDENCE_SOURCES, "unknown"].map((s) => [s, 0]),
  ) as Record<EstimateSource, number>;

  let comparable = 0;
  let estimatedTotalCents = 0;
  let recordedTotalCents = 0;
  let confirmedMinutes = 0;

  for (const o of outcomes) {
    counts[o.state] += 1;
    bySource[o.estimateSource] += 1;
    confirmedMinutes += o.confirmedMinutes;
    if (
      (o.state === "sold" || o.state === "refunded") &&
      o.estimatedNetCents != null &&
      o.recordedNetCents != null
    ) {
      comparable += 1;
      estimatedTotalCents += o.estimatedNetCents;
      recordedTotalCents += o.recordedNetCents;
    }
  }

  return {
    counts,
    bySource,
    comparable,
    estimatedTotalCents,
    recordedTotalCents,
    confirmedMinutes,
    version: OUTCOMES_MODEL_VERSION,
  };
}
