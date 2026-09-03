// The AutoLister queue row's label (US-2520 ratchet extraction, 2026-09-03).
//
// An AutoLister item is seeded as "Item 3" before anything is known about it,
// and that placeholder is all the inventory row carries until the seller edits
// it. The AI writes its title to the LISTING, not the item, so once a job
// succeeds the generated title wins; otherwise the item title, then the batch
// position. This is what the seller reads before clicking "Review", so it has
// to name the garment, not the upload slot.

export interface QueueRowTitleInput {
  /** listings.listing_title for the job's draft, once it exists. */
  generated: string | null | undefined;
  /** inventory_items.title, which is the "Item N" placeholder until edited. */
  itemTitle: string | null | undefined;
  /** 1-based position in the batch, for the untitled fallback. */
  ordinal: number | undefined;
}

export function queueRowTitle(input: QueueRowTitleInput): string {
  const generated = input.generated?.trim();
  if (generated) return generated;
  const item = input.itemTitle?.trim();
  if (item) return item;
  return input.ordinal ? `Generation ${input.ordinal}` : "Generation";
}
