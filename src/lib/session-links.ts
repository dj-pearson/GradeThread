// Worth My Time, R1 11/12 (US-3176): where a session's links go, and where
// they come back to.
//
// Its own module rather than a pair of exports from the runner component,
// because the page imports it too and a component file that also exports
// constants breaks Fast Refresh for everything in it.

/** Where an item opened from a session returns to. */
export const SESSION_RETURN_PATH = "/dashboard/flipdesk/worth-my-time";

/**
 * The item route, carrying where to come back to (AC2).
 *
 * THE DESTINATION RIDES IN THE URL and not in router state, because an item
 * route is a full page load and router state does not survive one. It also
 * means opening the link in a new tab still knows the way back, which state
 * never would.
 *
 * The param is read by the item page through `sanitizeReturnTo`, the same
 * validation the login redirect uses: anything in a URL is attacker-suppliable
 * and an unchecked return destination is an open redirect.
 */
export function itemHref(itemId: string | null): string {
  return itemId
    ? `/dashboard/flipdesk/items/${itemId}?back=${encodeURIComponent(SESSION_RETURN_PATH)}`
    : "/dashboard/flipdesk/inventory";
}
