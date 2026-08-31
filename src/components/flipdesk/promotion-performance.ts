// US-3032. The one DECISION this card makes, kept out of the .tsx so it can be
// tested without a React tree and so the component file exports only a
// component (react-refresh/only-export-components).

/**
 * Whether this card has anything to say. US-3032.
 *
 * It used to render unconditionally, and for most sellers that meant a card
 * headed "Did your sales sell more?" whose entire body was "No promotions on
 * record yet" - on every visit, forever. A question nobody asked, answered
 * blank, above the cards that do have answers.
 *
 * Three inputs because the card has three reasons to exist, and only the first
 * is empty in the state above:
 *
 *   onRecord   promotions we have synced, which is what the lift table reads.
 *   breaching  cost-floor breaches. NOT gated on promotions: the stack check
 *              reads each listing's auto-accept offer against its purchase
 *              price, so it finds real breaches for a seller running no sale at
 *              all, and that half is worth interrupting somebody for.
 *   liveOnEbay promotions the seller has on eBay but has never synced here.
 *              Without this the card hides, and the "Refresh from eBay" button
 *              is INSIDE the card - the seller could never reach the one
 *              control that would have given them a lift table.
 *
 * `unchecked` is deliberately not a reason. "42 listings could not be checked
 * because there is no purchase price on record" is worth saying beside a
 * finding and is only a nag without one.
 */
export function promotionPerformanceHasContent(counts: {
  onRecord: number;
  breaching: number;
  liveOnEbay: number;
}): boolean {
  return counts.onRecord > 0 || counts.breaching > 0 || counts.liveOnEbay > 0;
}
