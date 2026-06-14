// US-892: credit-ledger invariant helpers (pure, unit-tested).
//
// The grade_credit_transactions ledger is append-only. Every balance-changing
// row records balance_after = the wallet balance immediately AFTER it; zero-delta
// audit rows (included_grant / included refund) carry balance_after = NULL.
//
// Over the COMPLETE ledger ordered oldest-first, the running cumulative sum of
// `delta` (starting from 0, since every user begins with a zero balance) must
// equal `balance_after` on every row that records one. This module proves that
// invariant and is shared by the admin ledger endpoint (defense-in-depth flag)
// and the AC5 invariant test.

export interface LedgerRowLike {
  delta: number;
  balance_after: number | null;
}

export interface LedgerInvariantViolation {
  /** 0-based position in the oldest-first sequence. */
  index: number;
  /** Running SUM(delta) up to and including this row. */
  expected: number;
  /** The row's recorded balance_after. */
  actual: number;
}

// Returns the FIRST row where the recorded balance_after diverges from the
// running sum of deltas, or null if the ledger is consistent. `rows` MUST be
// ordered oldest-first and start from the user's first-ever transaction.
export function findLedgerInvariantViolation(
  rows: readonly LedgerRowLike[],
): LedgerInvariantViolation | null {
  let running = 0;
  let index = 0;
  for (const row of rows) {
    running += row.delta;
    if (row.balance_after !== null && row.balance_after !== running) {
      return { index, expected: running, actual: row.balance_after };
    }
    index += 1;
  }
  return null;
}

// Convenience boolean wrapper.
export function isLedgerConsistent(rows: readonly LedgerRowLike[]): boolean {
  return findLedgerInvariantViolation(rows) === null;
}
