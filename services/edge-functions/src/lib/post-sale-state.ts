// US-2560: which eBay post-sale case still needs the seller, on the EDGE side.
//
// This is a deliberate second implementation of the rule in
// src/pages/flipdesk/post-sale-state.ts, and the duplication is the point of the
// guard rather than an oversight. The edge is a separate Deno project and cannot
// import the SPA module, but the two must not disagree, because a disagreement
// is worse than either rule being wrong on its own:
//
//   The poll decides whether to NOTIFY. The page decides whether to show the row
//   under "open" or behind "Show closed". If the poll notified on a state the
//   page files as closed, the seller clicks the notification, lands on Post-sale
//   and finds nothing — a notification about work that appears not to exist.
//
// src/test/post-sale-state-parity.test.ts compares the two marker lists, so the
// next state eBay invents gets handled in one place or fails in CI.
//
// The reasoning behind the rule itself lives in the SPA copy and is not repeated
// here: eBay's Post-Order state vocabulary is long, per-case-type and unpublished,
// so this is a substring match on words that only appear in a finished state, and
// THE DEFAULT IS OPEN. Mis-reading an open case as closed hides work before an
// eBay deadline; mis-reading a closed one as open costs a glance.

/** Mirrors TERMINAL_MARKERS in src/pages/flipdesk/post-sale-state.ts. */
export const TERMINAL_MARKERS = [
  "CLOSED",
  "COMPLETED",
  "CANCELLED",
  "CANCELED",
  "DECLINED",
  "REJECTED",
  "REFUNDED",
  "RESOLVED",
  "FINISHED",
] as const;

/**
 * True when the case is finished and needs no seller action.
 *
 * ⚠ A CANCELLATION IS THE ONE CASE THIS RULE READS BACKWARDS IF YOU ARE CARELESS.
 * `CANCELLED` and `CANCELED` are terminal MARKERS, and a cancellation request in
 * state `CANCEL_REQUESTED` contains neither — but `CANCEL_CLOSED` contains
 * "CLOSED" and a completed one reports `CANCEL_COMPLETE`. So the rule works, and
 * it works for a reason worth stating: it matches the STATE, not the case type.
 * Do not "fix" it by matching the word cancel.
 */
export function isClosedCase(state: string | null | undefined): boolean {
  const raw = (state ?? "").toUpperCase();
  if (!raw) return false; // unknown → OPEN, per the asymmetry above
  return TERMINAL_MARKERS.some((m) => raw.includes(m));
}
