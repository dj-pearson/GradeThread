// US-2494: what an AI negotiation draft may write into a form the seller has
// already touched. Drafting spends a billable AI action, so the seller asks for
// it explicitly, but the answer still must not overwrite words they typed
// themselves. Pure, so the rule is pinned without rendering the page.

export interface NegotiationDraftFields {
  /** Raw counter-price input text; "" when the seller hasn't typed a price. */
  price: string;
  /** Note to the buyer (counter) or reply body (message). */
  note: string;
}

export interface NegotiationDraftValues {
  message: string;
  suggested_counter: number | null;
}

export function applyNegotiationDraft(
  current: NegotiationDraftFields,
  draft: NegotiationDraftValues,
): NegotiationDraftFields {
  const suggested = draft.suggested_counter;
  const canSeedPrice =
    current.price.trim() === "" &&
    suggested != null &&
    Number.isFinite(suggested) &&
    suggested > 0;
  return {
    // Two decimals so the seeded value matches what the number input submits.
    price: canSeedPrice ? suggested.toFixed(2) : current.price,
    note: current.note.trim() === "" ? draft.message : current.note,
  };
}
