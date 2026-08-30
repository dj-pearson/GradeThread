import { supabase } from "@/lib/supabase";

// US-2995 — closing a period.
//
// The enforcement is in the database (migration 00702) as BEFORE triggers, not
// as RLS policies and not here. The edge uses the service-role client, which
// bypasses RLS, so a guard anywhere above Postgres would hold against the
// browser and let every route, job and webhook rewrite a filed year unwatched.
// Nothing in this file is a check; it is all reads and two RPC calls.

export interface ClosedPeriod {
  id: string;
  period_start: string;
  period_end: string;
  label: string;
  closing_figures: Record<string, unknown>;
  closed_at: string;
  reopened_at: string | null;
  reopen_reason: string | null;
}

type Rpc = {
  rpc: ((
    fn: "close_period",
    args: { p_period_start: string; p_period_end: string; p_label: string },
  ) => Promise<{ data: string | null; error: { message: string } | null }>) &
    ((
      fn: "reopen_period",
      args: { p_id: string; p_reason: string },
    ) => Promise<{ data: null; error: { message: string } | null }>);
};

export async function fetchClosedPeriods(): Promise<ClosedPeriod[]> {
  const { data, error } = await supabase
    .from("closed_periods")
    .select(
      "id, period_start, period_end, label, closing_figures, closed_at, reopened_at, reopen_reason",
    )
    .order("period_start", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ClosedPeriod[];
}

export async function closePeriod(
  from: string,
  to: string,
  label: string,
): Promise<string> {
  const client = supabase as unknown as Rpc;
  const { data, error } = await client.rpc("close_period", {
    p_period_start: from,
    p_period_end: to,
    p_label: label,
  });
  if (error) throw new Error(error.message);
  return data ?? "";
}

export async function reopenPeriod(id: string, reason: string): Promise<void> {
  const client = supabase as unknown as Rpc;
  const { error } = await client.rpc("reopen_period", {
    p_id: id,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);
}

/** Is this date inside a period the seller has closed? */
export function isDateClosed(
  periods: readonly ClosedPeriod[],
  date: string,
): boolean {
  return periods.some(
    (p) => p.reopened_at === null && date >= p.period_start && date < p.period_end,
  );
}

/**
 * The active close covering a date, if any.
 *
 * Returns the PERIOD rather than a boolean so a screen can name it -- "2025 is
 * closed" is actionable and "this is locked" is not.
 */
export function closureFor(
  periods: readonly ClosedPeriod[],
  date: string,
): ClosedPeriod | null {
  return (
    periods.find(
      (p) => p.reopened_at === null && date >= p.period_start && date < p.period_end,
    ) ?? null
  );
}

/**
 * Turn the database's refusal into something a seller can act on.
 *
 * The trigger's message already names the escape hatch, but it arrives wrapped
 * in PostgREST's error envelope and reads like a fault. This detects it so the
 * screen can say what to do instead of showing a stack-shaped string.
 */
export function isClosedPeriodError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /closed period/i.test(message);
}
