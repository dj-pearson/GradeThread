// US-2227 AC3: which post-sale cases are still OPEN, and which are history.
//
// THE DEFECT THIS FIXES. The returns card fetched every return eBay returned,
// applied no filter, rendered them all with Approve / Decline / Refund buttons,
// and said "No open returns." when the list was empty. So a case eBay had
// already closed appeared indistinguishable from one waiting on the seller —
// with a destructive action attached whose own confirm text reads "This issues
// a refund to the buyer on eBay immediately. This can't be undone."
//
// The edge degrades gracefully (isAlreadyResolved swallows eBay's rejection),
// so this was not losing money. It was showing a seller work that did not
// exist, and hiding the work that did among it.
//
// WHY A PATTERN LIST AND NOT AN ENUM. eBay's Post-Order API state vocabulary is
// long, differs per case type, and is not published in this repo — the only
// values recorded anywhere here are three examples in an ebay-postorder.ts
// comment (RETURN_REQUESTED, ITEM_SHIPPED, REFUND_OVERDUE). Writing an
// exhaustive enum would mean guessing, and a guessed enum fails silently the
// first time eBay sends a state nobody anticipated.
//
// So the rule is a substring match on the words that only ever appear in a
// terminal state, and THE DEFAULT IS OPEN. That asymmetry is deliberate:
//
//   • Mis-classifying an open case as closed HIDES work the seller must do
//     before an eBay deadline, and they have no way to discover it.
//   • Mis-classifying a closed case as open shows one extra row with buttons
//     that turn into a no-op.
//
// The first costs the seller a case. The second costs them a glance.

/**
 * Words that appear only in a state eBay considers finished.
 *
 * `REFUND` is deliberately NOT here on its own: `REFUND_OVERDUE` is an OPEN
 * case and the most urgent kind there is — a refund the seller owes and has not
 * issued. Matching the bare word would bury exactly the row that needs action
 * most, which is the failure this list exists to avoid.
 */
const TERMINAL_MARKERS = [
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

/** A post-sale case as far as this rule is concerned. */
export interface CaseLike {
  state?: string | null;
  status?: string | null;
}

/**
 * True when the case is finished and needs no seller action.
 *
 * Reads `state` or `status` — returns and cancellations expose the former,
 * payment disputes the latter, and taking both keeps one rule for all three
 * cards rather than three rules that drift.
 */
export function isClosedCase(c: CaseLike): boolean {
  const raw = (c.state ?? c.status ?? "").toUpperCase();
  if (!raw) return false; // unknown → OPEN, per the asymmetry above
  return TERMINAL_MARKERS.some((m) => raw.includes(m));
}

/** Split a list into the cases still needing action and the ones that do not. */
export function splitByOpenState<T extends CaseLike>(
  cases: readonly T[],
): { open: T[]; closed: T[] } {
  const open: T[] = [];
  const closed: T[] = [];
  for (const c of cases) (isClosedCase(c) ? closed : open).push(c);
  return { open, closed };
}

/**
 * Whole days until an eBay deadline. Negative means it has passed; null means
 * there is no readable date, which renders no badge at all rather than an
 * "Overdue" invented from a parse failure.
 *
 * CEILING, not floor: a deadline eleven hours away is "1 day". Rounding down
 * would tell a seller they had run out of time on a day they could still act.
 *
 * US-2409 moved this out of the page so Android's port could be pinned against
 * the same fixture — `now` is a parameter for the same reason.
 */
export function daysUntil(
  iso: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.ceil((d.getTime() - now) / 86_400_000);
  // Math.ceil of a small negative is -0 in JS, which renders as "-0d" and does
  // not equal Kotlin's 0 under a strict comparison. Normalised so the two ports
  // agree and the badge never says minus zero.
  return days === 0 ? 0 : days;
}

/** A deadline already passed. An unknown date is never overdue. */
export function isOverdue(
  iso: string | null | undefined,
  now: number = Date.now(),
): boolean {
  const days = daysUntil(iso, now);
  return days != null && days < 0;
}
