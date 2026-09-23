// Pure planning for the FlipDesk kanban board (src/pages/flipdesk/pipeline.tsx):
// which stage a card advances to, how a batch advance groups into writes, and
// where a column's "+N more" link points. Kept out of the page so each rule can
// be tested without rendering the board.

import { FLIPDESK_PIPELINE, ITEM_STATUS_LABELS } from "@/lib/constants";
import { validateStatusChange } from "@/lib/pipeline-rules";
import {
  encodeQuery,
  evalQuery,
  type FilterQuery,
  type FilterRule,
} from "@/lib/item-filter";
import type { ItemCategory, ItemStatus } from "@/types/database";
import type { ItemListRow } from "@/lib/item-list-columns";

// US-1428: 'acquired' is a real early status with no column of its own, so an
// item set to Acquired would silently vanish from the board. Surface it in the
// Sourced column and treat it as sourced when advancing.
export function pipelineColumnFor(s: ItemStatus): ItemStatus {
  return s === "acquired" ? "sourced" : s;
}

// The pipeline stage immediately after `s`, or null if `s` is last/off-pipeline.
export function nextPipelineStatus(s: ItemStatus): ItemStatus | null {
  const idx = FLIPDESK_PIPELINE.findIndex((p) => p.status === pipelineColumnFor(s));
  if (idx < 0 || idx >= FLIPDESK_PIPELINE.length - 1) return null;
  return FLIPDESK_PIPELINE[idx + 1]?.status ?? null;
}

export type BatchResult = { title: string; ok: boolean; detail: string };

export interface BatchAdvancePlan {
  // Cards that failed validation, already phrased for the results dialog.
  refused: BatchResult[];
  // Cards that passed, grouped by the stage they move to. One UPDATE per group
  // instead of one per card: 200 selected cards used to be 200 round trips.
  groups: Array<{ status: ItemStatus; items: ItemListRow[] }>;
}

export function planBatchAdvance(items: readonly ItemListRow[]): BatchAdvancePlan {
  const refused: BatchResult[] = [];
  const byStatus = new Map<ItemStatus, ItemListRow[]>();
  for (const it of items) {
    const next = nextPipelineStatus(it.status);
    if (!next) {
      refused.push({
        title: it.item_title,
        ok: false,
        detail: `No next stage after ${ITEM_STATUS_LABELS[it.status]}`,
      });
      continue;
    }
    const reason = validateStatusChange(it, next);
    if (reason) {
      refused.push({ title: it.item_title, ok: false, detail: reason });
      continue;
    }
    const group = byStatus.get(next);
    if (group) group.push(it);
    else byStatus.set(next, [it]);
  }
  return {
    refused,
    groups: Array.from(byStatus, ([status, grouped]) => ({ status, items: grouped })),
  };
}

export interface BoardFilters {
  q: string;
  category: ItemCategory | "all";
  brand: string;
  source: string;
  filterQuery: FilterQuery;
}

export function boardFiltersActive(f: BoardFilters): boolean {
  return (
    f.q.trim() !== "" ||
    f.category !== "all" ||
    f.brand !== "all" ||
    f.source !== "all" ||
    f.filterQuery.rules.length > 0
  );
}

function rule(field: FilterRule["field"], op: FilterRule["op"], value: string): FilterRule {
  return { id: `board-${field}`, field, op, value };
}

// The brand and source quick facets. The "+N more" link below carries each
// one to the table as an `eq` rule, and evalRule compares `eq`
// case-insensitively, so the board has to match the same way: an exact `!==`
// here showed only "Nike" on the board while the link opened "Nike" and "nike"
// together, and the count above the link did not match the list it opened.
export function matchesBoardFacet(
  it: ItemListRow,
  field: "brand" | "source",
  selected: string,
): boolean {
  if (selected === "all") return true;
  return evalQuery(it, { combinator: "and", rules: [rule(field, "eq", selected)] });
}

// The facet menu. Spellings that differ only in case are one entry, since the
// facet cannot tell them apart; the first one seen names it.
export function boardFacetOptions(values: Iterable<string | null | undefined>): string[] {
  const byKey = new Map<string, string>();
  for (const v of values) {
    if (!v) continue;
    const key = v.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, v);
  }
  return Array.from(byKey.values()).sort();
}

// The "+N more" link under a capped column. It used to be a bare
// ?status=<stage>, which dropped the search box, the three quick facets and the
// advanced filter, so the list it opened did not match the count the seller
// had just seen. The table reads ?q= itself; the facets and the stage have no
// URL param of their own there, so they ride in as advanced-filter rules. The
// table ignores ?status= for filtering once ?filter= is present, which is why
// the stage is a rule too (?status= stays for the tab).
export function boardMoreLink(status: ItemStatus, f: BoardFilters): string {
  const params = new URLSearchParams();
  params.set("status", status);
  const q = f.q.trim();
  if (q) params.set("q", q);

  const extra: FilterRule[] = [
    status === "sourced"
      ? rule("status", "in", "sourced,acquired")
      : rule("status", "eq", status),
  ];
  if (f.category !== "all") extra.push(rule("category", "eq", f.category));
  if (f.brand !== "all") extra.push(rule("brand", "eq", f.brand));
  if (f.source !== "all") extra.push(rule("source", "eq", f.source));

  const own = f.filterQuery.rules;
  // A flat query has one combinator. "Any of" with two or more rules cannot
  // take extra AND conditions without changing its meaning, so in that case
  // the seller's own filter goes through untouched and only the tab that
  // ?status= selects narrows it. Rare, and wider rather than wrong.
  const canAnd = f.filterQuery.combinator === "and" || own.length <= 1;
  const combined: FilterQuery = canAnd
    ? { combinator: "and", rules: [...own, ...extra] }
    : f.filterQuery;
  const encoded = encodeQuery(combined);
  if (encoded) params.set("filter", encoded);

  return `/dashboard/flipdesk/items?${params.toString()}`;
}
