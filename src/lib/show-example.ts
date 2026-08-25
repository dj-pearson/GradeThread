// US-2865. The one spelling of the way into the worked example.
//
// It is a shared constant rather than a copied <Link> for the reason PageHelp
// is a component: three call sites that each write their own label is how one
// action ends up called "Show me an example", "See an example" and "View
// sample" on three screens, which is exactly what US-2860 spent a story
// undoing for "Add item".
//
// PLACEMENT RULE: this is always the SECONDARY action on a ZERO-DATA empty
// state. The primary action is the user doing the real thing; the example is
// what you offer somebody not ready to press it yet. Never put it on a
// filtered-empty state -- a seller whose filter hid their rows has data, and
// telling them to go read about somebody else's garment is the US-2867 mistake
// in a new costume.

export const SHOW_EXAMPLE_LABEL = "Show me an example";
export const EXAMPLE_ROUTE = "/dashboard/example";

/** Hand this straight to EmptyState's `secondaryAction`. */
export const showExampleAction = {
  label: SHOW_EXAMPLE_LABEL,
  to: EXAMPLE_ROUTE,
} as const;
