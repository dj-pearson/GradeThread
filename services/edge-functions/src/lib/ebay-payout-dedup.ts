// Shared payout-ingestion helper. Used by both /payouts/import-csv (F1)
// and the eBay payout webhook receiver (W2/W3). Centralizing the dedup
// + insert keeps the two ingestion paths idempotent against each other —
// uploading a CSV after a webhook fires (or vice versa) is a no-op.

import { supabaseAdmin } from "./supabase.ts";
import type { ParsedPayoutRow } from "./ebay-payouts-csv.ts";

export type PayoutImportMethod = "csv_upload" | "api_sync";

export interface IngestResult {
  inserted: number;
  duplicates: number;
}

// Pre-fetch existing payouts for the user that match any incoming payoutId,
// then in-memory dedupe on the (payoutId, date, amount) tuple. We don't
// rely on a DB unique constraint because the column is inside raw_payload
// jsonb — a future migration could add one and turn this into an UPSERT.
export async function ingestPayoutsForUser(
  userId: string,
  payouts: ParsedPayoutRow[],
  importMethod: PayoutImportMethod,
): Promise<IngestResult> {
  if (payouts.length === 0) {
    return { inserted: 0, duplicates: 0 };
  }

  const candidateIds = Array.from(new Set(payouts.map((p) => p.payoutId)));
  const { data: existing } = await supabaseAdmin
    .from("payout_imports")
    .select("raw_payload, payout_date, amount")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .in("raw_payload->>payoutid" as never, candidateIds as never);

  const seen = new Set<string>();
  for (const row of (existing ?? []) as Array<{
    raw_payload: Record<string, unknown>;
    payout_date: string | null;
    amount: number | null;
  }>) {
    const id = String(row.raw_payload?.payoutid ?? "");
    if (id) seen.add(`${id}|${row.payout_date}|${row.amount}`);
  }

  const toInsert = payouts
    .filter((p) => !seen.has(`${p.payoutId}|${p.payoutDate}|${p.amount}`))
    .map((p) => ({
      user_id: userId,
      marketplace: "ebay" as const,
      import_method: importMethod,
      raw_payload: {
        payoutid: p.payoutId,
        currency: p.currency,
        status: p.status,
        ...p.raw,
      },
      payout_date: p.payoutDate,
      amount: p.amount,
      reconciled: false,
    }));
  const duplicates = payouts.length - toInsert.length;

  if (toInsert.length === 0) {
    return { inserted: 0, duplicates };
  }

  const { error } = await supabaseAdmin
    .from("payout_imports")
    .insert(toInsert);
  if (error) {
    throw new Error(`payout_imports insert failed: ${error.message}`);
  }

  // US-1054: notification (in-app + push) is fired by the caller via
  // notifyPayoutImported() on its `inserted` count, so both the webhook and CSV
  // ingestion paths deliver one preference-gated notification per new payout
  // batch (and never on a deduped re-delivery).

  return { inserted: toInsert.length, duplicates };
}
