import { GARMENT_TYPES } from "@/lib/constants";
import { statusFilterFromSearch } from "@/lib/dashboard-grading-queue";

// SUB-12: where the seller is on the Submissions list lives in the URL, so
// Back from a submission, a refresh and open-in-new-tab all land on the same
// filters, sort and page. Every parameter is validated the way
// statusFilterFromSearch validates `status`: a hand-edited or stale link
// opens a working page, never an empty or broken one.

export type SortField = "created_at" | "overall_score";
export type SortDirection = "asc" | "desc";

export interface SubmissionsListParams {
  status: string;
  garmentType: string;
  search: string;
  dateFrom: string;
  dateTo: string;
  sortField: SortField;
  sortDirection: SortDirection;
  /** 0-based. The URL carries it 1-based, as `page`. */
  page: number;
}

export const DEFAULT_LIST_PARAMS: SubmissionsListParams = {
  status: "all",
  garmentType: "all",
  search: "",
  dateFrom: "",
  dateTo: "",
  sortField: "created_at",
  sortDirection: "desc",
  page: 0,
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function readListParams(search: URLSearchParams): SubmissionsListParams {
  const type = search.get("type") ?? "";
  const from = search.get("from") ?? "";
  const to = search.get("to") ?? "";
  const sort = search.get("sort");
  const dir = search.get("dir");
  const pageRaw = Number(search.get("page"));
  return {
    status: statusFilterFromSearch(search),
    garmentType: (GARMENT_TYPES as readonly string[]).includes(type) ? type : "all",
    search: (search.get("q") ?? "").slice(0, 200),
    dateFrom: DATE.test(from) ? from : "",
    dateTo: DATE.test(to) ? to : "",
    sortField: sort === "overall_score" ? "overall_score" : "created_at",
    sortDirection: dir === "asc" ? "asc" : "desc",
    page: Number.isInteger(pageRaw) && pageRaw > 1 ? pageRaw - 1 : 0,
  };
}

/** Apply a patch, dropping every parameter that is at its default. */
export function writeListParams(
  prev: URLSearchParams,
  patch: Partial<SubmissionsListParams>,
): URLSearchParams {
  const next = { ...readListParams(prev), ...patch };
  const out = new URLSearchParams(prev);
  const set = (key: string, value: string, fallback: string) => {
    if (value && value !== fallback) out.set(key, value);
    else out.delete(key);
  };
  set("status", next.status, "all");
  set("type", next.garmentType, "all");
  set("q", next.search.trim(), "");
  set("from", next.dateFrom, "");
  set("to", next.dateTo, "");
  set("sort", next.sortField, "created_at");
  set("dir", next.sortDirection, "desc");
  set("page", next.page > 0 ? String(next.page + 1) : "", "");
  return out;
}

/** The last valid 0-based page for a count, or null when `page` is fine. */
export function clampedPage(page: number, totalCount: number, pageSize: number): number | null {
  if (totalCount <= 0) return null;
  const last = Math.max(0, Math.ceil(totalCount / pageSize) - 1);
  return page > last ? last : null;
}
