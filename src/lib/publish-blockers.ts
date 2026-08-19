// US-954: map an eBay pre-flight blocker string to a deep-link target so a
// seller can jump straight to the offending field in the composer (or the
// Marketplaces page for account-level blockers) instead of hunting for it.
//
// The blocker strings come from `assemblePublishContext()` in
// services/edge-functions/src/routes/flipdesk-ebay.ts. We match on stable
// substrings rather than exact equality so wording tweaks don't silently break
// the deep-link. The `?focus=<field>` value is read by the composer
// (src/pages/flipdesk/composer.tsx), which scrolls/focuses the matching field.

export type BlockerField =
  | "title"
  | "category"
  | "specifics"
  | "photos"
  | "price"
  | "condition";

export interface BlockerTarget {
  /** React Router path (may include a `?focus=` query for the composer). */
  to: string;
  /** Short action label, e.g. "Pick category". */
  label: string;
}

const MARKETPLACES = "/dashboard/flipdesk/marketplaces";

function composerLink(
  itemId: string,
  field: BlockerField,
  label: string,
): BlockerTarget {
  return {
    to: `/dashboard/flipdesk/items/${itemId}/draft?focus=${field}`,
    label,
  };
}

/**
 * Resolve where a single blocker should deep-link to for the given item.
 * Order matters: more specific substrings are tested before broader ones
 * (e.g. "specifics" before "category", since the "could not load specifics
 * for this category" blocker contains both).
 */
export function blockerTarget(blocker: string, itemId: string): BlockerTarget {
  const b = blocker.toLowerCase();
  if (b.includes("specific")) {
    return composerLink(itemId, "specifics", "Fill specifics");
  }
  if (b.includes("category")) {
    return composerLink(itemId, "category", "Pick category");
  }
  if (b.includes("photo") || b.includes("picture") || b.includes("image")) {
    return composerLink(itemId, "photos", "Fix photos");
  }
  if (b.includes("price")) {
    return composerLink(itemId, "price", "Set price");
  }
  if (b.includes("title")) {
    return composerLink(itemId, "title", "Set title");
  }
  if (b.includes("condition")) {
    return composerLink(itemId, "condition", "Set condition");
  }
  // Account-level blockers (business policies, ship-from location, an expired
  // connection) are fixed on the Marketplaces page, not the composer.
  if (
    b.includes("business policies") ||
    b.includes("ship-from") ||
    b.includes("connection") ||
    b.includes("connect your ebay")
  ) {
    return { to: MARKETPLACES, label: "Open Marketplaces" };
  }
  // Fallback: open the composer with no specific field focused.
  return { to: `/dashboard/flipdesk/items/${itemId}/draft`, label: "Open composer" };
}

/** Map a `?focus=` field key to the composer DOM anchor id to scroll/focus. */
export const COMPOSER_FOCUS_ANCHORS: Record<string, string> = {
  title: "composer-title",
  category: "composer-category",
  specifics: "composer-category",
  photos: "composer-photos",
  price: "listing-price",
  condition: "ebay-condition",
  // US-2625: the drag-adjust measurement editor lives in the composer, and the
  // composer is deliberately the ONE item editor. A seller working an AutoLister
  // batch had no route to it, so "the inseam is wrong" had no fix — hence the
  // ask for a way to move the anchor points, for a thing that already existed
  // and could not be reached.
  measurements: "composer-measurements",
};

/**
 * US-2679: the Listing Quality Score's `fixSurface` values, mapped to the same
 * anchors above.
 *
 * A SECOND map rather than reusing the first, because they are keyed on
 * different vocabularies and merging them would mean one of the two callers
 * silently accepting keys meant for the other. The score speaks
 * "composer.aspects"; the publish-blocker deep link speaks "specifics". Both
 * land on the same element, and that is the only thing they share.
 *
 * Returns null for a surface the composer cannot scroll to. `settings.` is the
 * live one: business policies are configured in eBay Seller Hub and in account
 * settings, not in an item editor, so that fix is shown and NOT made clickable
 * rather than being wired to a button that scrolls nowhere.
 */
export function anchorForFixSurface(fixSurface: string): string | null {
  switch (fixSurface) {
    case "composer.title":
      return "composer-title";
    case "composer.photos":
      return "composer-photos";
    // Item specifics live inside the category section, which is where a seller
    // fills them; there is no separate specifics card to scroll to.
    case "composer.aspects":
    case "composer.category":
      return "composer-category";
    case "composer.price":
      return "listing-price";
    case "composer.condition":
      return "ebay-condition";
    default:
      return null;
  }
}
