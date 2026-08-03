// US-2326 AC2: a replay window for webhook receivers.
//
// Signature verification proves a payload was signed by the provider. It does
// NOT prove it is recent — a captured delivery stays validly signed forever, so
// anyone who obtains one can replay it indefinitely. The receivers relied
// entirely on event-id dedupe for that, which is skipped when the provider's id
// header is absent and fails OPEN on a database error.
//
// Both providers already send the timestamp needed and neither receiver read
// it: eBay declares `notification.publishDate` in its own payload type, and
// Shopify sends `X-Shopify-Triggered-At`. This turns those into a bound.
//
// TWO DELIBERATE ASYMMETRIES, and they matter more than the window size:
//
//   ABSENT timestamp → ACCEPT. Rejecting one would make this a new outage
//   surface the day a provider changes a header name or a topic ships without
//   it. The signature has already been checked; freshness is a second line, and
//   a second line that can take the service down on its own is a worse trade
//   than the replay risk it removes.
//
//   PRESENT but unparseable → REJECT. That is not a provider dropping a field,
//   it is a value that does not mean what it claims, which is exactly the shape
//   a forged replay would have.
//
// The window is symmetric because clock skew runs both ways: a provider clock a
// few minutes ahead would otherwise have every delivery rejected as "future".

/** Default tolerance either side of now. */
export const DEFAULT_FRESHNESS_WINDOW_MS = 5 * 60_000;

export type FreshnessVerdict =
  | { fresh: true; reason: "absent" | "within_window" }
  | { fresh: false; reason: "unparseable" | "too_old" | "too_new"; ageMs?: number };

/**
 * Decide whether a webhook's own timestamp is recent enough to act on.
 *
 * Pure and injectable (`nowMs`) so the boundaries are testable — an off-by-one
 * at the edge of the window is the kind of thing that only shows up as
 * intermittent rejections in production.
 */
export function checkFreshness(
  timestamp: string | null | undefined,
  nowMs: number,
  windowMs: number = DEFAULT_FRESHNESS_WINDOW_MS,
): FreshnessVerdict {
  if (timestamp == null || timestamp.trim() === "") {
    return { fresh: true, reason: "absent" };
  }
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return { fresh: false, reason: "unparseable" };

  const ageMs = nowMs - t;
  if (ageMs > windowMs) return { fresh: false, reason: "too_old", ageMs };
  if (-ageMs > windowMs) return { fresh: false, reason: "too_new", ageMs };
  return { fresh: true, reason: "within_window" };
}
