// US-3297: tab identity for the Offers & Messages page.
//
// WHY THIS EXISTS. The page stacked six sections in one narrow column and drew
// every one of them at once: threshold conflicts, the Best Offers list, the
// watchers-worth-an-offer picker, the manual send-offer picker, the buyer
// message inbox, and the analytics card. Each was added by its own story and
// each was locally right. Nobody added up the result.
//
// Two of those sections are inboxes with their own clocks. An offer expires in
// hours; a buyer message costs a sale if it sits a day. Putting both in one
// scroll means the seller reads whichever one is nearer the top, and there was
// no way to sort either by the thing that decides the order of work.
//
// Same fix as post-sale-tabs.ts (US-3208): one section on screen, chosen by a
// tab that lives in `?tab=` so it survives a bookmark, and a count on the tab so
// a seller knows where the work is without scrolling to find out.
//
// Kept out of the page module for the same reason post-sale-tabs.ts is: a unit
// test can import the mapping without pulling the page's whole component graph
// (and its eBay hooks) into the test run.

export type OffersTabId = "offers" | "send" | "messages" | "insights";

export interface OffersTab {
  id: OffersTabId;
  label: string;
  /**
   * Whether this tab can carry a count badge at all.
   *
   * Insights is a chart of what already happened, and Send is a picker rather
   * than a queue, so neither has a "waiting on you" number. A tab with no
   * countable work gets no badge rather than a zero.
   */
  counted: boolean;
}

/**
 * Offers lead because they are the only clock on this page eBay itself runs
 * down: a Best Offer commonly expires in 48 hours whether or not the seller
 * looked. Messages come next (a slow reply loses the sale but nothing expires),
 * then the outbound picker, then the numbers.
 */
export const OFFERS_TABS: readonly OffersTab[] = [
  { id: "offers", label: "Offers", counted: true },
  { id: "messages", label: "Messages", counted: true },
  { id: "send", label: "Send offers", counted: false },
  { id: "insights", label: "Insights", counted: false },
] as const;

export const DEFAULT_OFFERS_TAB: OffersTabId = "offers";

/**
 * Anchors and aliases that still arrive in saved links.
 *
 * The stacked page gave nothing a DOM id, so these are not old anchors so much
 * as the names the sections were called in help articles and in the Needs-You
 * rail. Resolving them costs one object and means a link written against the
 * old page lands on the work rather than on the default tab.
 */
const TAB_ALIASES: Readonly<Record<string, OffersTabId>> = {
  "best-offers": "offers",
  offer: "offers",
  "buyer-messages": "messages",
  message: "messages",
  inbox: "messages",
  "send-offer": "send",
  "send-offers": "send",
  watchers: "send",
  analytics: "insights",
  "offer-analytics": "insights",
};

/** A `?tab=` (or alias) value as a current tab id, or null when it names none. */
export function resolveOffersTabId(
  raw: string | null | undefined,
): OffersTabId | null {
  if (!raw) return null;
  const key = raw.replace(/^#/, "").trim().toLowerCase();
  if (OFFERS_TABS.some((t) => t.id === key)) return key as OffersTabId;
  return TAB_ALIASES[key] ?? null;
}

export type OffersTabCounts = Record<OffersTabId, number>;

/**
 * What each tab has waiting.
 *
 * Both numbers are the ACTIONABLE subset rather than the list length: an offer
 * that has already expired is not work, and a message that has been answered is
 * not work. A badge counting rows instead of jobs sends the seller to a tab
 * where there is nothing to do, which teaches them to stop reading the badge.
 */
export function offersTabCounts(input: {
  openOffers: number;
  unansweredMessages: number;
}): OffersTabCounts {
  return {
    offers: input.openOffers,
    messages: input.unansweredMessages,
    send: 0,
    insights: 0,
  };
}
