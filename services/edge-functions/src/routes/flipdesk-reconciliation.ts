import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { saleNetEstimate } from "../lib/reconciliation-scoring.ts";
import {
  applyConflictResolutions,
  type SyncConflictRow,
  WINNING_SOURCES,
  type WinningSource,
} from "../lib/sync-conflict-resolve.ts";

// Payout reconciliation: matches payout_imports rows to sales rows by listing ID
// and timestamp window. Never silently mis-matches — unmatched rows stay queued.

type ReconciliationEnv = {
  Variables: {
    userId: string;
    workspaceOwnerId: string;
    workspaceRole:
      | "viewer"
      | "member"
      | "listing_manager"
      | "admin"
      | "owner";
  };
};

export const flipdeskReconciliationRoutes = new Hono<ReconciliationEnv>();

// US-382: reconciliation is a Business-tier feature. Enforce it server-side on
// EVERY reconciliation endpoint (was UI-only) — a Free/Starter/Pro caller gets
// 402 FEATURE_LOCKED, which the frontend renders as the upgrade dialog.
flipdeskReconciliationRoutes.use("*", async (c, next) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const gate = await requireFlipdesk(c, { feature: "reconciliation", userId });
  if (gate) return gate;
  await next();
});

// Tolerance constants for candidate scoring. eBay typically pays out 1–3
// business days after a sale settles, with occasional 5–7 day delays for
// new sellers or weekends. Tight amount window catches single-sale payouts;
// the wider date window catches the delayed-payout case.
const AMOUNT_EXACT_DELTA = 0.50; // dollars
const AMOUNT_FUZZY_PCT = 0.10; // 10% of payout amount
const DATE_TIGHT_DAYS = 3;
const DATE_WIDE_DAYS = 14;
const CANDIDATES_PER_PAYOUT = 5;
const QUEUE_LIMIT = 100;

interface PayoutRow {
  id: string;
  user_id: string;
  payout_date: string | null;
  amount: number | null;
  reconciled: boolean;
  sale_id: string | null;
  raw_payload: Record<string, unknown>;
  created_at: string;
}

interface SaleCandidateRow {
  id: string;
  inventory_item_id: string;
  sale_price: number | null;
  sale_date: string | null;
  payout_amount: number | null;
  payout_reference: string | null;
  platform_fees: number | null;
  shipping_collected: number | null;
  // US-461: needed to estimate the eBay payout net for UNENRICHED sales (those
  // without payout_amount). eBay's managed-payments payout deducts the shipping
  // label the seller buys through eBay and adds the shipping the buyer paid.
  shipping_cost: number | null;
  payment_processing_fees: number | null;
}

// US-461: columns the candidate-net estimate needs. Shared by both the /queue
// and /auto-match sale queries (minus their per-query join columns) so the two
// can never drift out of sync.
const SALE_CANDIDATE_COLUMNS =
  "id, inventory_item_id, sale_price, sale_date, payout_amount, payout_reference, " +
  "platform_fees, shipping_collected, shipping_cost, payment_processing_fees";

interface Candidate {
  sale_id: string;
  item_id: string;
  item_title: string | null;
  sale_date: string | null;
  sale_price: number | null;
  payout_amount: number | null;
  payout_reference: string | null;
  score: number;
  reasons: string[];
}

interface QueueEntry {
  payout_import: {
    id: string;
    payout_date: string | null;
    amount: number | null;
    raw_payload: Record<string, unknown>;
    created_at: string;
  };
  candidates: Candidate[];
}

// Scoring: payout_reference exact match wins (1.0); otherwise we weigh
// amount proximity (60%) and date proximity (40%). Anything under 0.3 is
// noise — kept out of the candidate list so the UI isn't cluttered.
function scoreCandidate(
  payout: PayoutRow,
  sale: SaleCandidateRow,
): { score: number; reasons: string[] } | null {
  const reasons: string[] = [];

  // Tier 1: payout_id exact match — the eBay enrichment path writes this
  // directly so when it's set we have ground truth.
  const payoutId =
    typeof payout.raw_payload?.payoutid === "string"
      ? (payout.raw_payload.payoutid as string)
      : null;
  if (payoutId && sale.payout_reference === payoutId) {
    return { score: 1.0, reasons: ["payout id matches"] };
  }

  // Amount proximity. Prefer the enriched net payout_amount; otherwise estimate
  // the net from the sale's fields INCLUDING the shipping label cost + buyer-paid
  // shipping (US-461). An estimate is flagged and scored slightly lower so an
  // enriched (ground-truth) candidate always outranks an estimated one at the
  // same delta, rather than the estimate silently winning on a wrong number.
  const payoutAmt = payout.amount ?? 0;
  const { net: saleNet, estimated } = saleNetEstimate(sale);
  // Estimated nets carry more error, so widen the exact-window a touch and
  // discount the score.
  const estimatePenalty = estimated ? 0.85 : 1;

  let amountScore = 0;
  if (payoutAmt > 0 && saleNet != null) {
    const delta = Math.abs(saleNet - payoutAmt);
    if (delta <= AMOUNT_EXACT_DELTA) {
      amountScore = 0.6 * estimatePenalty;
      reasons.push(
        `amount within $${delta.toFixed(2)}${estimated ? " (estimated net)" : ""}`,
      );
    } else if (delta <= payoutAmt * AMOUNT_FUZZY_PCT) {
      amountScore = 0.35 * estimatePenalty;
      reasons.push(
        `amount within ${((delta / payoutAmt) * 100).toFixed(0)}%${
          estimated ? " (estimated net)" : ""
        }`,
      );
    }
  }

  // Date proximity. eBay payouts settle 1–3 days after sale; widen window
  // for slower-settling accounts.
  let dateScore = 0;
  if (payout.payout_date && sale.sale_date) {
    const ms =
      new Date(payout.payout_date).getTime() -
      new Date(sale.sale_date).getTime();
    const days = ms / (24 * 60 * 60 * 1000);
    const absDays = Math.abs(days);
    if (absDays <= DATE_TIGHT_DAYS) {
      dateScore = 0.4;
      reasons.push(
        days >= 0
          ? `paid out ${absDays.toFixed(0)}d after sale`
          : `paid out ${absDays.toFixed(0)}d before sale`,
      );
    } else if (absDays <= DATE_WIDE_DAYS) {
      dateScore = 0.2;
      reasons.push(`paid out ~${absDays.toFixed(0)}d from sale`);
    }
  }

  const score = amountScore + dateScore;
  // Floor: drop noisy results so the UI list stays useful.
  if (score < 0.3) return null;
  return { score, reasons };
}

// GET /queue — list unreconciled payout_imports with up to 5 candidate sales each.
flipdeskReconciliationRoutes.get("/queue", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  const { data: payoutsRaw, error: payoutsErr } = await supabaseAdmin
    .from("payout_imports")
    .select(
      "id, user_id, payout_date, amount, reconciled, sale_id, raw_payload, created_at",
    )
    .eq("user_id", userId)
    .eq("reconciled", false)
    .order("payout_date", { ascending: false, nullsFirst: false })
    .limit(QUEUE_LIMIT);
  if (payoutsErr) {
    return c.json({ error: "Failed to load queue", detail: payoutsErr.message }, 500);
  }
  const payouts = (payoutsRaw ?? []) as PayoutRow[];

  // US-793: the queue is capped at QUEUE_LIMIT. Return the TOTAL unreconciled
  // count + has_more so the client can show "showing first N of M" instead of
  // silently truncating (the iOS app surfaces this).
  const { count: totalUnreconciled } = await supabaseAdmin
    .from("payout_imports")
    .select("id", { head: true, count: "exact" })
    .eq("user_id", userId)
    .eq("reconciled", false);
  const total = totalUnreconciled ?? payouts.length;
  const hasMore = total > payouts.length;

  if (payouts.length === 0) {
    return c.json({
      queue: [] satisfies QueueEntry[],
      total,
      showing: 0,
      has_more: false,
      limit: QUEUE_LIMIT,
    });
  }

  // Find the date span of the queued payouts so the candidate-sale query
  // doesn't have to scan the whole history. Pad by DATE_WIDE_DAYS on each
  // side to catch slow-settling sales.
  let minDate: number | null = null;
  let maxDate: number | null = null;
  for (const p of payouts) {
    if (!p.payout_date) continue;
    const t = new Date(p.payout_date).getTime();
    if (Number.isNaN(t)) continue;
    if (minDate == null || t < minDate) minDate = t;
    if (maxDate == null || t > maxDate) maxDate = t;
  }
  const padMs = DATE_WIDE_DAYS * 24 * 60 * 60 * 1000;
  const lowerIso =
    minDate != null
      ? new Date(minDate - padMs).toISOString().slice(0, 10)
      : null;
  const upperIso =
    maxDate != null
      ? new Date(maxDate + padMs).toISOString().slice(0, 10)
      : null;

  // Pull candidate sales: this user's sales in the date window, excluding
  // sales already linked to a *different* reconciled payout (we keep ones
  // with NULL payout_reference and ones matching a queued payoutId).
  let saleQuery = supabaseAdmin
    .from("sales")
    .select(
      SALE_CANDIDATE_COLUMNS + ", inventory_items!inner(user_id, title)",
    )
    .eq("inventory_items.user_id", userId);
  if (lowerIso) saleQuery = saleQuery.gte("sale_date", lowerIso);
  if (upperIso) saleQuery = saleQuery.lte("sale_date", upperIso);

  const { data: salesRaw, error: salesErr } = await saleQuery;
  if (salesErr) {
    return c.json(
      { error: "Failed to load candidate sales", detail: salesErr.message },
      500,
    );
  }
  type SaleRowWithItem = SaleCandidateRow & {
    inventory_items: { user_id: string; title: string | null };
  };
  const sales = (salesRaw ?? []) as unknown as SaleRowWithItem[];

  const queue: QueueEntry[] = payouts.map((p) => {
    const scored: Candidate[] = [];
    for (const s of sales) {
      const result = scoreCandidate(p, s);
      if (!result) continue;
      scored.push({
        sale_id: s.id,
        item_id: s.inventory_item_id,
        item_title: s.inventory_items?.title ?? null,
        sale_date: s.sale_date,
        sale_price: s.sale_price,
        payout_amount: s.payout_amount,
        payout_reference: s.payout_reference,
        score: result.score,
        reasons: result.reasons,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return {
      payout_import: {
        id: p.id,
        payout_date: p.payout_date,
        amount: p.amount,
        raw_payload: p.raw_payload,
        created_at: p.created_at,
      },
      candidates: scored.slice(0, CANDIDATES_PER_PAYOUT),
    };
  });

  return c.json({
    queue,
    total,
    showing: queue.length,
    has_more: hasMore,
    limit: QUEUE_LIMIT,
  });
});

// Auto-match thresholds. Tight on purpose — anything that doesn't clearly
// dominate its alternatives stays queued for manual review. Better a
// queued row the user clicks than a silent mis-match in the books.
const AUTO_MATCH_MIN_SCORE = 0.85;
const AUTO_MATCH_MIN_MARGIN = 0.2;

// POST /run — sweep all unreconciled payouts and auto-match the unambiguous
// ones. "Unambiguous" = either a payout-id exact match OR a top candidate
// scoring ≥ AUTO_MATCH_MIN_SCORE with a margin of ≥ AUTO_MATCH_MIN_MARGIN
// over the next-best alternative. Returns counts; ambiguous rows stay in
// the queue for /queue + /match.
flipdeskReconciliationRoutes.post("/run", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  const { data: payoutsRaw } = await supabaseAdmin
    .from("payout_imports")
    .select("id, user_id, payout_date, amount, reconciled, sale_id, raw_payload, created_at")
    .eq("user_id", userId)
    .eq("reconciled", false)
    .order("payout_date", { ascending: false, nullsFirst: false })
    .limit(QUEUE_LIMIT);
  const payouts = (payoutsRaw ?? []) as PayoutRow[];

  if (payouts.length === 0) {
    return c.json({
      auto_matched: 0,
      ambiguous: 0,
      no_candidates: 0,
      scanned: 0,
    });
  }

  // Same date-windowed sales fetch as /queue.
  let minDate: number | null = null;
  let maxDate: number | null = null;
  for (const p of payouts) {
    if (!p.payout_date) continue;
    const t = new Date(p.payout_date).getTime();
    if (Number.isNaN(t)) continue;
    if (minDate == null || t < minDate) minDate = t;
    if (maxDate == null || t > maxDate) maxDate = t;
  }
  const padMs = DATE_WIDE_DAYS * 24 * 60 * 60 * 1000;
  const lowerIso =
    minDate != null ? new Date(minDate - padMs).toISOString().slice(0, 10) : null;
  const upperIso =
    maxDate != null ? new Date(maxDate + padMs).toISOString().slice(0, 10) : null;

  let saleQuery = supabaseAdmin
    .from("sales")
    .select(
      SALE_CANDIDATE_COLUMNS + ", inventory_items!inner(user_id)",
    )
    .eq("inventory_items.user_id", userId);
  if (lowerIso) saleQuery = saleQuery.gte("sale_date", lowerIso);
  if (upperIso) saleQuery = saleQuery.lte("sale_date", upperIso);

  const { data: salesRaw } = await saleQuery;
  type SaleRowWithItem = SaleCandidateRow & {
    inventory_items: { user_id: string };
  };
  const sales = (salesRaw ?? []) as unknown as SaleRowWithItem[];

  // Build a per-payout "claimed sale" set so a single auto-match pass
  // doesn't double-assign one sale to two different payouts.
  const claimedSales = new Set<string>();
  let autoMatched = 0;
  let ambiguous = 0;
  let noCandidates = 0;

  for (const p of payouts) {
    const scored: Array<{ sale: SaleRowWithItem; score: number; reasons: string[] }> = [];
    for (const s of sales) {
      if (claimedSales.has(s.id)) continue;
      const r = scoreCandidate(p, s);
      if (!r) continue;
      scored.push({ sale: s, score: r.score, reasons: r.reasons });
    }
    scored.sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      noCandidates++;
      continue;
    }

    const top = scored[0]!;
    const second = scored[1];
    const margin = second ? top.score - second.score : Infinity;
    const isExactPayoutId = top.score >= 1.0;
    const isClear =
      isExactPayoutId ||
      (top.score >= AUTO_MATCH_MIN_SCORE && margin >= AUTO_MATCH_MIN_MARGIN);

    if (!isClear) {
      ambiguous++;
      continue;
    }

    // Conflict guard mirrors /match — if the sale is already linked to a
    // different payoutId, leave it queued for manual review.
    const payoutId =
      typeof p.raw_payload?.payoutid === "string"
        ? (p.raw_payload.payoutid as string)
        : null;
    if (
      top.sale.payout_reference &&
      payoutId &&
      top.sale.payout_reference !== payoutId
    ) {
      ambiguous++;
      continue;
    }

    // Atomic two-table link via the RPC (US-462) — both writes commit together
    // or not at all, so the sweep can't create a half-linked row. Idempotent,
    // so re-running /run over an already-matched payout is a safe no-op.
    const { data: linkRes, error: linkErr } = await supabaseAdmin.rpc(
      "reconcile_payout_link",
      {
        p_user_id: userId,
        p_payout_import_id: p.id,
        p_sale_id: top.sale.id,
        p_payout_reference: payoutId,
      },
    );
    const res = (linkRes ?? {}) as { ok?: boolean; error?: string };
    if (linkErr || !res.ok) {
      // A conflict (sale/payout already linked elsewhere) isn't an error — leave
      // it for manual review; a real DB error is logged and skipped.
      if (linkErr) {
        console.error("[reconciliation/run] reconcile_payout_link failed:", linkErr);
      } else {
        ambiguous++;
      }
      continue;
    }
    claimedSales.add(top.sale.id);
    autoMatched++;
  }

  return c.json({
    auto_matched: autoMatched,
    ambiguous,
    no_candidates: noCandidates,
    scanned: payouts.length,
  });
});

// Manually apply a payout row to a specific sale. Writes the link both
// directions: payout_imports.sale_id ↔ sales.payout_reference. We *don't*
// overwrite an existing sales.payout_reference — if it already points
// somewhere else, that's a conflict the user needs to resolve explicitly.
// Body: { payout_import_id: string; sale_id: string }
flipdeskReconciliationRoutes.post("/match", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { payout_import_id?: unknown; sale_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const payoutImportId =
    typeof body.payout_import_id === "string" ? body.payout_import_id : null;
  const saleId = typeof body.sale_id === "string" ? body.sale_id : null;
  if (!payoutImportId || !saleId) {
    return c.json(
      { error: "payout_import_id and sale_id are required" },
      400,
    );
  }

  // 1. Load + ownership-check payout
  const { data: payout, error: payoutErr } = await supabaseAdmin
    .from("payout_imports")
    .select("id, user_id, reconciled, raw_payload")
    .eq("id", payoutImportId)
    .maybeSingle();
  if (payoutErr || !payout) {
    return c.json({ error: "Payout not found" }, 404);
  }
  const p = payout as {
    id: string;
    user_id: string;
    reconciled: boolean;
    raw_payload: Record<string, unknown>;
  };
  if (p.user_id !== userId) {
    return c.json({ error: "Payout not found" }, 404);
  }
  if (p.reconciled) {
    return c.json(
      { error: "Payout is already reconciled. Un-match it first to reassign." },
      409,
    );
  }

  // 2. Load + ownership-check sale (via the joined inventory_item)
  const { data: sale, error: saleErr } = await supabaseAdmin
    .from("sales")
    .select(
      "id, payout_reference, inventory_items!inner(user_id)",
    )
    .eq("id", saleId)
    .maybeSingle();
  if (saleErr || !sale) {
    return c.json({ error: "Sale not found" }, 404);
  }
  const s = sale as unknown as {
    id: string;
    payout_reference: string | null;
    inventory_items: { user_id: string };
  };
  if (s.inventory_items.user_id !== userId) {
    return c.json({ error: "Sale not found" }, 404);
  }

  const payoutId =
    typeof p.raw_payload?.payoutid === "string"
      ? (p.raw_payload.payoutid as string)
      : null;

  // 3. Conflict guard: if sale.payout_reference is already set to a *different*
  //    payoutId, refuse — the user needs to consciously override.
  if (s.payout_reference && payoutId && s.payout_reference !== payoutId) {
    return c.json(
      {
        error:
          "This sale is already linked to a different payout. Un-match the existing link first.",
        existing_payout_reference: s.payout_reference,
      },
      409,
    );
  }

  // 4. Link both directions ATOMICALLY (US-462). The RPC writes payout_imports
  //    + sales in one transaction (re-verifying tenant ownership of both rows),
  //    so a partial failure can't leave a payout reconciled with an unlinked
  //    sale. It is idempotent + self-repairing on re-run.
  const { data: linkRes, error: linkErr } = await supabaseAdmin.rpc(
    "reconcile_payout_link",
    {
      p_user_id: userId,
      p_payout_import_id: payoutImportId,
      p_sale_id: saleId,
      p_payout_reference: payoutId,
    },
  );
  if (linkErr) {
    return c.json(
      { error: "Failed to reconcile payout", detail: linkErr.message },
      500,
    );
  }
  const res = (linkRes ?? {}) as { ok?: boolean; error?: string };
  if (!res.ok) {
    // Ownership/conflict outcomes from the RPC → 404/409.
    if (res.error === "payout_not_found" || res.error === "sale_not_found") {
      return c.json({ error: "Payout or sale not found" }, 404);
    }
    return c.json(
      { error: "This sale or payout is already linked elsewhere. Un-match first.", reason: res.error },
      409,
    );
  }

  return c.json({ ok: true, payout_import_id: payoutImportId, sale_id: saleId });
});

// Dismiss a payout row that doesn't correspond to a tracked sale (e.g. a
// refund-only payout, or one for a sale that exists outside FlipDesk).
// We mark it reconciled so it leaves the queue, with sale_id = null and a
// dismissed_at marker in raw_payload so the audit trail is preserved.
flipdeskReconciliationRoutes.post("/dismiss/:id", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");

  const { data: payout, error: payoutErr } = await supabaseAdmin
    .from("payout_imports")
    .select("id, user_id, reconciled, raw_payload")
    .eq("id", id)
    .maybeSingle();
  if (payoutErr || !payout) {
    return c.json({ error: "Payout not found" }, 404);
  }
  const p = payout as {
    id: string;
    user_id: string;
    reconciled: boolean;
    raw_payload: Record<string, unknown>;
  };
  if (p.user_id !== userId) {
    return c.json({ error: "Payout not found" }, 404);
  }
  if (p.reconciled) {
    return c.json({ ok: true, payout_import_id: id, already: true });
  }

  const nextRaw = {
    ...p.raw_payload,
    dismissed_at: new Date().toISOString(),
  };
  const { error } = await supabaseAdmin
    .from("payout_imports")
    .update({ reconciled: true, sale_id: null, raw_payload: nextRaw })
    .eq("id", id);
  if (error) {
    return failSafe(c, 500, "Failed to dismiss payout.", error, "reconciliation.dismiss-payout");
  }

  return c.json({ ok: true, payout_import_id: id });
});

// ── Cross-source conflicts (US-148): FlipDesk ↔ eBay ↔ Sheets ────────
//
// Open rows are written by the eBay pull / Sheets merge via
// lib/sync-conflicts.ts. These endpoints power the Cross-source tab:
// list the open disagreements and resolve them by picking a winning
// source per field (single, per-listing bulk, or multi-listing bulk —
// all the same /conflicts/resolve body, just more entries).

// ConflictFieldName / WinningSource / WINNING_SOURCES / SyncConflictRow and the
// resolution flow (applyConflictResolutions / conflictPatchFor) now live in
// lib/sync-conflict-resolve.ts so the admin sync console reuses the exact same
// logic (US-898).
const CONFLICT_LIST_LIMIT = 500;
const RESOLVE_BATCH_MAX = 200;

// GET /conflicts — open cross-source conflicts with listing context, newest
// first. The UI groups rows by listing client-side.
flipdeskReconciliationRoutes.get("/conflicts", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  const { data: rowsRaw, error } = await supabaseAdmin
    .from("flipdesk_sync_conflicts")
    .select(
      "id, listing_id, field_name, flipdesk_value, ebay_value, sheets_value, suggested_action, detected_at",
    )
    .eq("user_id", userId)
    .is("resolved_at", null)
    .order("detected_at", { ascending: false })
    .limit(CONFLICT_LIST_LIMIT);
  if (error) {
    return c.json({ error: "Failed to load conflicts", detail: error.message }, 500);
  }
  const rows = (rowsRaw ?? []) as SyncConflictRow[];

  const { count } = await supabaseAdmin
    .from("flipdesk_sync_conflicts")
    .select("id", { head: true, count: "exact" })
    .eq("user_id", userId)
    .is("resolved_at", null);
  const total = count ?? rows.length;

  // Listing context (title for display + current values so the FlipDesk
  // column reflects what's in the DB right now, not just the frozen snapshot).
  const listingIds = [...new Set(rows.map((r) => r.listing_id))];
  const listingById = new Map<
    string,
    {
      listing_title: string | null;
      listing_url: string | null;
      item_title: string | null;
      source_of_truth: Record<string, string>;
    }
  >();
  if (listingIds.length > 0) {
    const { data: listingsRaw } = await supabaseAdmin
      .from("listings")
      .select(
        "id, listing_title, listing_url, source_of_truth, inventory_items!inner(user_id, title)",
      )
      .in("id", listingIds)
      .eq("inventory_items.user_id", userId);
    for (const l of (listingsRaw ?? []) as unknown as Array<{
      id: string;
      listing_title: string | null;
      listing_url: string | null;
      source_of_truth: Record<string, string> | null;
      inventory_items: { user_id: string; title: string | null };
    }>) {
      listingById.set(l.id, {
        listing_title: l.listing_title,
        listing_url: l.listing_url,
        item_title: l.inventory_items?.title ?? null,
        source_of_truth: l.source_of_truth ?? {},
      });
    }
  }

  const conflicts = rows.map((r) => {
    const listing = listingById.get(r.listing_id);
    return {
      ...r,
      listing_title: listing?.listing_title ?? null,
      item_title: listing?.item_title ?? null,
      listing_url: listing?.listing_url ?? null,
    };
  });

  return c.json({
    conflicts,
    total,
    showing: conflicts.length,
    has_more: total > conflicts.length,
  });
});

// POST /conflicts/resolve — pick the winning source for one or more open
// conflicts. Applies the winning value to the listing row, pins the choice in
// listings.source_of_truth (so the eBay pull won't overwrite it and detection
// won't re-flag it), and closes the conflict with resolution = source. The
// per-listing apply/close flow is shared with the admin sync console
// (lib/sync-conflict-resolve.ts → applyConflictResolutions).
// Body: { resolutions: [{ conflict_id: string, source: "flipdesk"|"ebay"|"sheets" }] }
flipdeskReconciliationRoutes.post("/conflicts/resolve", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { resolutions?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!Array.isArray(body.resolutions) || body.resolutions.length === 0) {
    return c.json({ error: "resolutions[] is required" }, 400);
  }
  if (body.resolutions.length > RESOLVE_BATCH_MAX) {
    return c.json(
      { error: `Too many resolutions in one call (max ${RESOLVE_BATCH_MAX}).` },
      400,
    );
  }

  // Validate + dedupe (last entry wins if the same conflict appears twice).
  const seen = new Set<string>();
  const resolutions: Array<{ conflictId: string; source: WinningSource }> = [];
  for (const r of body.resolutions as Array<Record<string, unknown>>) {
    const conflictId = typeof r?.conflict_id === "string" ? r.conflict_id : null;
    const source = typeof r?.source === "string" ? r.source : null;
    if (!conflictId || !source || !WINNING_SOURCES.has(source)) {
      return c.json(
        { error: "Each resolution needs conflict_id and source (flipdesk|ebay|sheets)." },
        400,
      );
    }
    if (seen.has(conflictId)) {
      // Drop the earlier entry so the last one wins (mirrors map semantics).
      const idx = resolutions.findIndex((x) => x.conflictId === conflictId);
      if (idx >= 0) resolutions.splice(idx, 1);
    }
    seen.add(conflictId);
    resolutions.push({ conflictId, source: source as WinningSource });
  }

  const { resolved, failed } = await applyConflictResolutions(userId, resolutions);
  return c.json({ ok: failed.length === 0, resolved, failed });
});
