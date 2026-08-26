// US-2888: every cached query that goes stale when an item's photos change.
//
// This exists because the list was a hand-written sequence of
// `invalidateQueries` calls inside PhotoManager, and one entry was missing. The
// MeasureCard panel reads its own row under `measure_photo` and its generated
// render under `measure_overlay`, so rotating the photo refreshed the gallery
// and left the measurements panel showing the pre-rotation image — until a full
// page reload. "Rotate, save, reload" became the ritual, and the missing
// refresh made a real geometry bug look worse than it was, because the lines
// appeared to have been abandoned in place.
//
// A list is testable; four calls in a row are not.

/**
 * Query keys to invalidate after any write that changes an item's photos —
 * a reorder, a retag, a delete, a rotate, a crop, a background removal.
 *
 * `items_full` is deliberately un-scoped: the Listings table renders each row's
 * cover from a query keyed under that prefix, so a cover change has to reach it
 * however that query is scoped.
 */
export function itemPhotoQueryKeys(itemId: string): readonly unknown[][] {
  return [
    ["item_photos", itemId],
    ["items_full"],
    ["measure_photo", itemId],
    ["measure_overlay", itemId],
  ];
}
