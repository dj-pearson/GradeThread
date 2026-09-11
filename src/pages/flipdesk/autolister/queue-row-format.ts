// US-3309: the small formatting decisions the queue row makes, as pure
// functions.
//
// They live apart from the cells for the same reason queue-row-title.ts does: a
// test can import them without dragging a component graph into the run, and the
// fast-refresh rule wants a module to export components OR helpers, not both.
//
// The common thread is that each one turns an internal token into a WORD. The
// old row showed a bare coloured dot for the confidence tier and a bare
// coloured icon for the job status, side by side, meaning two different things,
// with neither labelled — a colour code is only legible to the person who wrote
// it.

export type QueueTier = "green" | "amber" | "red";

/**
 * The confidence tier as a label, or null when there is nothing to say.
 *
 * Red is null on purpose: a red tier means the generation FAILED, and the state
 * column already says so in more detail than "Failed" repeated next to the
 * title would.
 */
export function tierWord(tier: QueueTier | null | undefined): string | null {
  if (tier === "green") return "Ready";
  if (tier === "amber") return "Needs review";
  return null;
}

/** The dot beside that label, or null when there is no label to sit beside. */
export function tierDotClass(
  tier: QueueTier | null | undefined,
): string | null {
  if (tier === "green") return "bg-emerald-500";
  if (tier === "amber") return "bg-amber-500";
  return null;
}

/**
 * A draft's asking price for the Price column.
 *
 * An em dash, never `$0.00`: the queue has offered a price sort since US-554
 * while showing no price at all, and a draft the AI never priced is not a free
 * one.
 */
export function money(price: number | null | undefined): string {
  return price == null ? "—" : `$${price.toFixed(2)}`;
}
