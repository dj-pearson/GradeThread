// US-2188: the `items_full` LIST projection.
//
// `items_full` is 61 columns wide and four of them carry most of the bytes:
// `comps` and `ai_field_sources` are jsonb, `item_description` and `notes` are
// unbounded text. Nothing that renders a list, a kanban card, a chart or a
// match table reads any of them — only the detail canvases do (composer, item
// detail, the prep drawer, the CSV exporters). So the list read asks for
// everything EXCEPT those four and the detail surfaces keep the full row.
//
// `measurements` IS in the projection on purpose: it is a small numeric jsonb
// and the kanban's own drag validation (validateStatusChange) reads it to
// enforce the "needs measurements before Measured" prereq. Dropping it would
// silently turn that rule off.
//
// ItemListRow is a Pick<> of ItemFullRow rather than a hand-written interface
// on purpose: a column removed here becomes a tsc error at every consumer that
// still reads it, which is what makes a projection pass safe without runtime
// probes (same technique as the US-2204 pass).

import type { ItemFullRow } from "@/types/database";

export const ITEM_LIST_COLUMNS = [
  "id",
  "user_id",
  "item_number",
  "container",
  "item_title",
  "brand",
  "style",
  "size",
  "category",
  "color",
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
  // US-2790: the parcel estimator's two inputs. IN the list projection, not
  // detail-only, because item-card-list.tsx shows a per-item profit figure and
  // it is fed by the LIST read. Absent here they arrive `undefined`, the
  // estimator falls back to the `other` base weight for every row, and the card
  // still reports the number as category-derived — a confident wrong figure on
  // every card rather than a missing one on some.
  //
  // Both are small: garment_category is an enum, material is a short text.
  "garment_category",
  "material",
  "location_bin",
  "created_at",
  "updated_at",
  "buyer_id",
  "sold_at_raw",
  "payout_reference",
  "listing_status",
  "listing_id",
  "listing_watchers",
  "listing_views",
  "photo_count",
  "has_required_photos",
  "ai_enriched_at",
  "sale_status",
  "sale_cancelled_at",
  "listing_platform",
  "carrier",
  "shipped_at",
  "delivered_at",
  "listing_needs_review",
  "listing_reviewed_at",
  "listing_title",
  "quality_score",
] as const;

/** The columns deliberately left OUT of the list read — detail-only. */
export const ITEM_DETAIL_ONLY_COLUMNS = [
  "item_description",
  "notes",
  "comps",
  "ai_field_sources",
] as const satisfies readonly (keyof ItemFullRow)[];

/** A row as returned by `useItemsList()` — ItemFullRow minus the heavy columns. */
export type ItemListRow = Pick<ItemFullRow, (typeof ITEM_LIST_COLUMNS)[number]>;

export const ITEM_LIST_SELECT = ITEM_LIST_COLUMNS.join(",");
