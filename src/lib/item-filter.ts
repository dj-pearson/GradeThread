import type { ItemFullRow } from "@/types/database";

export type FilterField =
  | "brand"
  | "category"
  | "size"
  | "source"
  | "cost"
  | "target_price"
  | "status"
  | "grade"
  | "days_in_status";

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
  cost: "Cost",
  target_price: "Target price",
  status: "Status",
  grade: "Grade",
  days_in_status: "Days in status",
};

// Which field is numeric — drives the operator set the UI offers.
export const NUMERIC_FIELDS: ReadonlySet<FilterField> = new Set<FilterField>([
  "cost",
  "target_price",
  "grade",
  "days_in_status",
]);

export const OP_LABELS: Record<FilterOp, string> = {
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

export const TEXT_OPS: FilterOp[] = [
  "eq",
  "neq",
  "contains",
  "in",
  "nin",
  "isnull",
  "notnull",
];
export const NUMERIC_OPS: FilterOp[] = [
  "eq",
  "neq",
  "lt",
  "gt",
  "lte",
  "gte",
  "isnull",
  "notnull",
];

function fieldValue(it: ItemFullRow, field: FilterField): string | number | null {
  switch (field) {
    case "brand":
      return it.brand;
    case "category":
      return it.category;
    case "size":
      return it.size;
    case "source":
      return it.source_name;
    case "cost":
      return it.purchase_price;
    case "target_price":
      return it.target_price;
    case "status":
      return it.status;
    case "grade":
      return it.grade_value;
    case "days_in_status": {
      if (!it.updated_at) return null;
      const t = new Date(it.updated_at).getTime();
      if (isNaN(t)) return null;
      return Math.floor((Date.now() - t) / DAY_MS);
    }
  }
}

function evalRule(it: ItemFullRow, rule: FilterRule): boolean {
  const v = fieldValue(it, rule.field);
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

export function evalQuery(it: ItemFullRow, q: FilterQuery): boolean {
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
  const op = OP_LABELS[rule.op];
  if (rule.op === "isnull" || rule.op === "notnull") {
    return `${field} ${op}`;
  }
  return `${field} ${op} ${rule.value}`;
}
