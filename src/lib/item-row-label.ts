// Naming the CONTROLS in a FlipDesk item row, so two rows never sound alike.
//
// THE DEFECT THIS EXISTS FOR. US-2335 ground the "control has no accessible
// name" count to zero, and the listings table passed that bar the whole time:
// every inline editor said "Edit value", every status control said "Change
// status", every checkbox said "Select row". Names, all of them. But the table
// renders up to a few hundred rows with ~14 controls each, so a screen reader
// user tabbing down a column hears the SAME four words over and over with
// nothing saying which garment they are about to reprice. A resolvable name is
// necessary and not sufficient; that sentence is written in
// src/test/control-labels.test.ts, and this module is the part of it that the
// count could never measure.
//
// So every per-row control names its row, and the row name comes from here
// rather than from each call site — because "which title do we show for an
// item?" already had two different answers in one file (see itemDisplayTitle).

/** The fields this module needs off an item row. Structural, so tests need no DB type. */
export interface ItemLike {
  item_title?: string | null;
  listing_title?: string | null;
  item_number?: string | null;
  id?: string | null;
}

/**
 * True when an item_title is a machine-generated stand-in rather than a name a
 * person would recognise: "Item 42", "Untitled draft", or blank.
 *
 * US-1569 introduced this test inline in listings-table.tsx. It lives here now
 * so the visible cell and the control labels cannot disagree about it.
 */
function isPlaceholderTitle(raw: string | null | undefined): boolean {
  const title = raw ?? "";
  return (
    /^item\s+\d+$/i.test(title) || /^untitled/i.test(title) || !title.trim()
  );
}

/**
 * The title to SHOW for an item, or null when there is nothing to show.
 *
 * Returns the raw stored value, untrimmed, because this feeds rendered output
 * and trimming here would be a silent visual change for no benefit. Callers
 * that need a guaranteed non-empty string want itemRowLabel instead.
 */
export function itemDisplayTitle(it: ItemLike): string | null {
  if (isPlaceholderTitle(it.item_title)) {
    return it.listing_title ?? it.item_title ?? null;
  }
  return it.item_title ?? null;
}

/**
 * A short name for the row, guaranteed non-empty and guaranteed to differ
 * between two different items.
 *
 * NEVER RETURNS A BARE CONSTANT for a real item. Falling back to "this item"
 * for an untitled row would put us straight back in the failure this module
 * exists to fix — many controls, one name — so an item with no usable title
 * falls back to its item number and then to a slice of its id. An id fragment
 * is ugly to hear and it is distinguishing, which is the whole job.
 *
 * DELIBERATELY NOT TRUNCATED. An eBay title runs to 80 characters and a long
 * label is tedious; a truncated one can make two listings that differ only in
 * their size or colourway announce identically, which is the defect again. The
 * label is read once, on focus, so length costs less than ambiguity.
 */
export function itemRowLabel(it: ItemLike): string {
  const title = itemDisplayTitle(it)?.trim();
  // A placeholder can survive itemDisplayTitle — a draft titled "Item 42" with
  // no generated listing title yet displays as "Item 42", which is correct to
  // SHOW and wrong to speak: "Untitled draft" is what a whole screen of fresh
  // drafts is called, so using it as a name would give them all the same one.
  if (title && !isPlaceholderTitle(title)) return title;
  const number = it.item_number?.trim();
  if (number) return `item ${number}`;
  const id = it.id?.trim();
  if (id) return `item ${id.slice(0, 8)}`;
  // Reachable only for a row with no title, no number and no id — which the
  // table cannot render, since id is the React key. Named rather than thrown:
  // a label is not worth crashing a table over.
  return "this item";
}

/**
 * Compose a control's accessible name: what the control does, then which row.
 *
 * Field first, row second. Within a row the field is what distinguishes
 * ("Cost" vs "Target"); across rows the item name is. Reading order follows
 * the more common movement, which is across a row, and the item name still
 * arrives before the user can act.
 */
export function rowControlLabel(action: string, it: ItemLike): string {
  return `${action} for ${itemRowLabel(it)}`;
}

/**
 * A name for one tile in a repeated grid — a staged photo, not an item row.
 *
 * Same defect, different shape. The AutoLister photo grid gave every tile
 * "Select photo (Shift-click selects the range)" and every delete button
 * "Delete photo", down a virtualized grid of a whole shoot.
 *
 * PREFERS THE TILE'S OWN NAME because that is what the seller is looking at: a
 * filename like IMG_9042.jpg is how they tell two shots of the same garment
 * apart, and the grid already sorts by it. Falls back to POSITION rather than to
 * an id fragment, which is the opposite choice from itemRowLabel and is right
 * here: a photo has no title to fall back on, and position is exactly how a
 * sighted user refers to one ("the third one"). An id fragment would be
 * distinguishing and meaningless.
 *
 * Position is 1-based and follows the CURRENT sort, so it matches what is on
 * screen rather than some stable underlying order. A label read on focus should
 * describe the thing the user can see.
 */
export function tileLabel(
  name: string | null | undefined,
  kind: string,
  position: number,
): string {
  return name?.trim() || `${kind} ${position}`;
}
