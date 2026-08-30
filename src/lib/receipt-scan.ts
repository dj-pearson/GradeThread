import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import type { ExpenseCategory } from "@/types/database";

// US-2993 — the client half of receipt extraction.
//
// The model never writes an expense. It proposes one, and the seller confirms
// it. That is AC1 and it is not a formality: a wrong number the seller did not
// look at is worse than no number, because they will not check it again.

export interface ScannedLine {
  description: string | null;
  amount_cents: number;
}

export interface ScannedDraft {
  vendor: string | null;
  spent_on: string | null;
  total_cents: number | null;
  tax_cents: number | null;
  category: ExpenseCategory | null;
  lines: ScannedLine[];
}

export interface ScanResult {
  /** Where the photo is parked until an expense exists to attach it to. */
  staging_path: string;
  draft: ScannedDraft | null;
  confidence: Record<string, number>;
  low_confidence?: string[];
  /** Total less tax less the sum of lines. Non-zero means it read partially. */
  lines_gap_cents?: number | null;
  prompt_version?: string;
  warning: string | null;
}

/** Send a photo to be read. Never throws for a model failure -- see AC2. */
export async function scanReceipt(file: File): Promise<ScanResult> {
  const form = new FormData();
  form.append("receipt", file);
  const res = await edgeFetch("/api/flipdesk/expenses/extract", {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Couldn't upload that receipt.");
  }
  return (await res.json()) as ScanResult;
}

/** Attach a staged photo to the expense the seller just confirmed. */
export async function adoptStagedReceipt(
  expenseId: string,
  stagingPath: string,
): Promise<void> {
  const res = await edgeFetch(
    `/api/flipdesk/expenses/${expenseId}/adopt-staged`,
    // `json` rather than a stringified body: edgeFetch only sets the
    // Content-Type when it serialises the body itself, and the route reads JSON.
    { method: "POST", json: { staging_path: stagingPath } },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Couldn't attach the receipt.");
  }
}

export interface DuplicateExpense {
  id: string;
  description: string | null;
  amount: number;
  spent_on: string;
  has_receipt: boolean;
}

type Rpc = {
  rpc: (
    fn: "find_duplicate_expenses",
    args: { p_amount: number; p_spent_on: string; p_description: string | null },
  ) => Promise<{
    data: DuplicateExpense[] | null;
    error: { message: string } | null;
  }>;
};

/**
 * Anything already logged that looks like this one (AC4).
 *
 * Photographing the same receipt twice is the commonest way a total goes wrong,
 * and afterwards it is invisible: two identical expenses look like two real
 * purchases. Checked BEFORE the save, when it is still one click to abandon.
 */
export async function findDuplicates(
  amount: number,
  spentOn: string,
  description: string | null,
): Promise<DuplicateExpense[]> {
  const client = supabase as unknown as Rpc;
  const { data, error } = await client.rpc("find_duplicate_expenses", {
    p_amount: amount,
    p_spent_on: spentOn,
    p_description: description,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * How sure the model was about one field, as words rather than a number.
 *
 * A seller cannot act on "0.62". They can act on "check this". Returns null for
 * a field that is fine, so the screen shows nothing rather than a row of
 * reassurances nobody reads.
 */
export function confidenceHint(
  field: string,
  result: ScanResult | null,
): string | null {
  if (!result) return null;
  const low = result.low_confidence ?? [];
  if (!low.includes(field)) return null;
  return "Worth checking";
}

/** True when the scan produced nothing usable and the seller must type it. */
export function scanFailed(result: ScanResult | null): boolean {
  return !!result && (result.draft === null || result.draft.total_cents === null);
}
