// US-2173: the listings table's column projection, in its own module.
//
// It sat in the middle of a 3,500-line component, which made "which columns
// does this page actually read?" a question you answered by scrolling. It is
// also the one thing on this page that a projection pass has to change, so it
// is worth being able to find.

// US-404: explicit projection instead of `select("*")` on the wide items_full
// view. We drop the columns this triage surface never reads in bulk — the two
// per-row photo correlated-subqueries (photo_count, has_required_photos) and
// the AI-provenance fields (ai_field_sources, ai_enriched_at) — which lets
// Postgres prune those subqueries from the plan. The detail canvas lazy-loads
// those four for the single open item (see src/pages/flipdesk/composer.tsx).
// comps/measurements
// stay: listability scoring + the editor need them across the loaded set.
export const LISTINGS_COLUMN_LIST = [
  "id",
  "user_id",
  "item_number",
  "container",
  "item_title",
  "item_description",
  "brand",
  "style",
  "size",
  "notes",
  "comps",
  "category",
  "source_name",
  "source_id",
  "sourced_by",
  "purchase_date",
  "purchase_price",
  "listed",
  "list_date",
  "link",
  "list_price",
  "sale_date",
  "sale_price",
  "fees",
  "tax",
  "shipping_cost",
  "net_profit",
  "payout",
  "status",
  "days_to_sell",
  "tracking",
  "target_price",
  "grade_value",
  "grade_label",
  "certificate_url",
  "measurements",
  "location_bin",
  // US-1051: color + marketplace drive the advanced filter's new facets.
  "color",
  "listing_platform",
  "created_at",
  "updated_at",
  "buyer_id",
  "sold_at_raw",
  "payout_reference",
  "listing_status",
  "listing_id",
  "listing_watchers",
  "listing_views",
  "sale_status",
  "sale_cancelled_at",
  // US-960: Shipped-tab fulfillment (carrier + shipped/delivered timestamps).
  "carrier",
  "shipped_at",
  "delivered_at",
  // US-1569 (00349): draft-review fields for the Drafts tab.
  "listing_needs_review",
  "listing_reviewed_at",
  "listing_title",
] as const;

/**
 * The same list as a PostgREST select string.
 *
 * US-2168 turned the array into the primary form: the listings page now sends
 * the column names to `flipdesk_listing_page` as `p_columns`, so the projection
 * is decided in one place here rather than restated in SQL where it would drift
 * the first time someone added a column. This joined form stays for any caller
 * that still builds a `.select()` by hand.
 */
export const LISTINGS_COLUMNS = LISTINGS_COLUMN_LIST.join(",");
