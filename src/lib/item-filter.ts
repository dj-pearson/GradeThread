import { MARKETPLACE_LABELS } from "@/lib/constants";
import type { ListingPlatform } from "@/types/database";
import type { ItemListRow } from "@/lib/item-list-columns";

export type FilterField =
  | "brand"
  | "category"
  | "size"
  | "source"
  | "sourced_by"
  | "color"
  | "location_bin"
  | "sku"
  | "marketplace"
  | "status"
  | "cost"
  | "target_price"
  | "grade"
  | "days_in_status"
  | "purchase_date"
  | "created_at"
  | "sale_date"
  | "photo_state";

export type FilterOp =
  | "eq"
  | "neq"
  | "lt"
  | "gt"
  | "lte"
  | "gte"
  | "in"
  | "nin"
  | "contains"
  | "isnull"
  | "notnull";

export interface FilterRule {
  id: string;
  field: FilterField;
  op: FilterOp;
  value: string;
}

export interface FilterQuery {
  combinator: "and" | "or";
  rules: FilterRule[];
}

export const EMPTY_QUERY: FilterQuery = { combinator: "and", rules: [] };

const DAY_MS = 24 * 60 * 60 * 1000;

export const FIELD_LABELS: Record<FilterField, string> = {
  brand: "Brand",
  category: "Category",
  size: "Size",
  source: "Source",
  sourced_by: "Sourced by",
  color: "Color",
  location_bin: "Location / bin",
  sku: "SKU",
  marketplace: "Marketplace",
  status: "Status",
  cost: "Cost",
  target_price: "Target price",
  grade: "Grade",
  days_in_status: "Days in status",
  purchase_date: "Purchase date",
  created_at: "Date added",
  sale_date: "Sale date",
  photo_state: "Photo state",
};

/**
 * Every field the filter builder offers, in menu order: text facets first, then
 * the marketplace/photo enums, then numeric, then dates.
 *
 * It lives here rather than in the builder component so a test can hold it
 * against FIELD_LABELS (src/test/item-filter-fields.test.ts). A field added to
 * the type but not to this list type-checks, evaluates correctly, and is
 * invisible in the UI — a feature nobody can reach.
 */
export const FILTER_FIELDS: FilterField[] = [
  "brand",
  "category",
  "size",
  "source",
  "sourced_by",
  "color",
  "location_bin",
  "sku",
  "status",
  "marketplace",
  "photo_state",
  "cost",
  "target_price",
  "grade",
  "days_in_status",
  "purchase_date",
  "created_at",
  "sale_date",
];

// Which field is numeric — drives the operator set the UI offers.
const NUMERIC_FIELDS: ReadonlySet<FilterField> = new Set<FilterField>([
  "cost",
  "target_price",
  "grade",
  "days_in_status",
]);

// Date fields take an absolute YYYY-MM-DD value and compare on calendar days.
export const DATE_FIELDS: ReadonlySet<FilterField> = new Set<FilterField>([
  "purchase_date",
  "created_at",
  "sale_date",
]);

// Fields with a fixed value set — rendered as a dropdown instead of a free
// text box (see ENUM_FIELD_OPTIONS).
export const ENUM_FIELDS: ReadonlySet<FilterField> = new Set<FilterField>([
  "marketplace",
  "photo_state",
]);

export const ENUM_FIELD_OPTIONS: Partial<
  Record<FilterField, ReadonlyArray<{ value: string; label: string }>>
> = {
  marketplace: (Object.keys(MARKETPLACE_LABELS) as ListingPlatform[]).map(
    (k) => ({ value: k, label: MARKETPLACE_LABELS[k] }),
  ),
  photo_state: [
    { value: "complete", label: "Has required photos" },
    { value: "incomplete", label: "Missing required photos" },
  ],
};

const OP_LABELS: Record<FilterOp, string> = {
  eq: "is",
  neq: "is not",
  lt: "<",
  gt: ">",
  lte: "≤",
  gte: "≥",
  in: "is any of",
  nin: "is none of",
  contains: "contains",
  isnull: "is empty",
  notnull: "is not empty",
};

// Date fields reuse the comparison operators but read more naturally with
// date-specific verbs.
const DATE_OP_LABELS: Partial<Record<FilterOp, string>> = {
  lt: "before",
  lte: "on or before",
  gt: "after",
  gte: "on or after",
  eq: "on",
};

const TEXT_OPS: FilterOp[] = [
  "eq",
  "neq",
  "contains",
  "in",
  "nin",
  "isnull",
  "notnull",
];
const NUMERIC_OPS: FilterOp[] = [
  "eq",
  "neq",
  "lt",
  "gt",
  "lte",
  "gte",
  "isnull",
  "notnull",
];
const DATE_OPS: FilterOp[] = [
  "lt",
  "lte",
  "gt",
  "gte",
  "eq",
  "isnull",
  "notnull",
];
// Enum fields snap to a single chosen value, so only equality + emptiness.
const ENUM_OPS: FilterOp[] = ["eq", "neq", "isnull", "notnull"];

// The valid operator list for a field, by its type. The UI uses this to render
// the operator dropdown and to snap a stale operator to a valid one when the
// field type changes.
export function opsForField(field: FilterField): FilterOp[] {
  if (NUMERIC_FIELDS.has(field)) return NUMERIC_OPS;
  if (DATE_FIELDS.has(field)) return DATE_OPS;
  if (ENUM_FIELDS.has(field)) return ENUM_OPS;
  return TEXT_OPS;
}

// Operator label, field-type aware (dates read as "before"/"after"/etc.).
export function opLabel(field: FilterField, op: FilterOp): string {
  if (DATE_FIELDS.has(field) && DATE_OP_LABELS[op]) return DATE_OP_LABELS[op]!;
  return OP_LABELS[op];
}

function fieldValue(it: ItemListRow, field: FilterField): string | number | null {
  switch (field) {
    case "brand":
      return it.brand;
    case "category":
      return it.category;
    case "size":
      return it.size;
    case "source":
      return it.source_name;
    // US-3122: WHO bought it, not WHERE it came from. Both words start with
    // "source", so the two rules sit next to each other in the menu with
    // labels that say which is which.
    case "sourced_by":
      return it.sourced_by;
    case "color":
      return it.color;
    case "location_bin":
      return it.location_bin;
    case "sku":
      return it.item_number;
    case "marketplace":
      return it.listing_platform;
    case "status":
      return it.status;
    case "cost":
      return it.purchase_price;
    case "target_price":
      return it.target_price;
    case "grade":
      return it.grade_value;
    case "purchase_date":
      return it.purchase_date;
    case "created_at":
      return it.created_at;
    case "sale_date":
      return it.sale_date;
    case "photo_state":
      return it.has_required_photos ? "complete" : "incomplete";
    case "days_in_status": {
      if (!it.updated_at) return null;
      const t = new Date(it.updated_at).getTime();
      if (isNaN(t)) return null;
      return Math.floor((Date.now() - t) / DAY_MS);
    }
  }
}

// Start-of-day (UTC) for a YYYY-MM-DD string (date <input> value). We anchor on
// UTC so the comparison is deterministic regardless of the viewer's timezone
// AND lines up with date-only DB columns (e.g. purchase_date "2026-06-18"),
// which also parse as UTC midnight — the two would otherwise drift by the TZ
// offset and a same-day `eq` could miss.
function dayStartMs(raw: string): number {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw;
  return new Date(iso).getTime();
}

function evalDateRule(value: string | number | null, rule: FilterRule): boolean {
  if (rule.op === "isnull") return value == null || value === "";
  if (rule.op === "notnull") return value != null && value !== "";
  if (value == null || value === "") return false;
  const vt = new Date(String(value)).getTime();
  if (isNaN(vt)) return false;
  const start = dayStartMs(rule.value.trim());
  if (isNaN(start)) return false;
  const end = start + DAY_MS;
  switch (rule.op) {
    case "eq":
      return vt >= start && vt < end;
    case "neq":
      return !(vt >= start && vt < end);
    case "lt":
      return vt < start; // before that day
    case "lte":
      return vt < end; // on or before that day
    case "gt":
      return vt >= end; // after that day
    case "gte":
      return vt >= start; // on or after that day
    default:
      return false;
  }
}

function evalRule(it: ItemListRow, rule: FilterRule): boolean {
  const v = fieldValue(it, rule.field);

  if (DATE_FIELDS.has(rule.field)) {
    return evalDateRule(v, rule);
  }

  const raw = rule.value.trim();

  switch (rule.op) {
    case "isnull":
      return v == null || v === "";
    case "notnull":
      return v != null && v !== "";
    case "contains":
      return v != null && String(v).toLowerCase().includes(raw.toLowerCase());
    case "in":
    case "nin": {
      const list = raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const hit = v != null && list.includes(String(v).toLowerCase());
      return rule.op === "in" ? hit : !hit;
    }
    case "eq":
    case "neq": {
      const equal =
        v != null && String(v).toLowerCase() === raw.toLowerCase();
      return rule.op === "eq" ? equal : !equal;
    }
    case "lt":
    case "gt":
    case "lte":
    case "gte": {
      const n = Number(raw);
      if (v == null || !Number.isFinite(n) || typeof v !== "number") {
        return false;
      }
      if (rule.op === "lt") return v < n;
      if (rule.op === "gt") return v > n;
      if (rule.op === "lte") return v <= n;
      return v >= n;
    }
  }
}

// US-2188: the advanced filter reads only projected display columns, so it
// takes the list row. A full ItemFullRow is structurally assignable to it.
export function evalQuery(it: ItemListRow, q: FilterQuery): boolean {
  if (q.rules.length === 0) return true;
  const results = q.rules.map((r) => evalRule(it, r));
  return q.combinator === "and"
    ? results.every(Boolean)
    : results.some(Boolean);
}

// ── URL serialization ───────────────────────────────────────────
// base64(JSON) — compact enough for a query param, survives copy-paste.

export function encodeQuery(q: FilterQuery): string {
  try {
    return btoa(encodeURIComponent(JSON.stringify(q)));
  } catch {
    return "";
  }
}

export function decodeQuery(s: string): FilterQuery | null {
  try {
    const parsed = JSON.parse(decodeURIComponent(atob(s)));
    if (
      parsed &&
      (parsed.combinator === "and" || parsed.combinator === "or") &&
      Array.isArray(parsed.rules)
    ) {
      return parsed as FilterQuery;
    }
    return null;
  } catch {
    return null;
  }
}

export function describeRule(rule: FilterRule): string {
  const field = FIELD_LABELS[rule.field];
  const op = opLabel(rule.field, rule.op);
  if (rule.op === "isnull" || rule.op === "notnull") {
    return `${field} ${op}`;
  }
  // For enum fields show the human label, not the stored value.
  const opts = ENUM_FIELD_OPTIONS[rule.field];
  const valueLabel =
    opts?.find((o) => o.value === rule.value)?.label ?? rule.value;
  return `${field} ${op} ${valueLabel}`;
}
