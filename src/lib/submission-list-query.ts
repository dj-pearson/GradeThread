import { sanitizeSearch, localDayRangeIso } from "@/lib/search-filter";

// The Submissions list filters, in one place. The list's two sort branches
// and the CSV export all apply them, so a filter honoured by one and not the
// others would change the result set when a seller clicks a column header or
// exports what is on screen (US-2544 AC2, SUB-07).

export interface SubmissionListFilters {
  status: string;
  garmentType: string;
  search: string;
  dateFrom: string;
  dateTo: string;
}

export const NO_SUBMISSION_FILTERS: SubmissionListFilters = {
  status: "all",
  garmentType: "all",
  search: "",
  dateFrom: "",
  dateTo: "",
};

export function submissionFiltersActive(f: SubmissionListFilters): boolean {
  return (
    f.status !== "all" ||
    f.garmentType !== "all" ||
    f.search.trim() !== "" ||
    f.dateFrom !== "" ||
    f.dateTo !== ""
  );
}

interface FilterBuilder<T> {
  eq: (column: string, value: string) => T;
  or: (filter: string) => T;
  gte: (column: string, value: string) => T;
  lt: (column: string, value: string) => T;
}

/**
 * Apply status, garment type, search and date predicates.
 *
 * `.or()` on a SELECT is fine on prod PostgREST; it is only rejected on
 * UPDATE/DELETE (US-1552). sanitizeSearch strips what `.or()` parses as syntax.
 */
export function applySubmissionFilters<T extends FilterBuilder<T>>(
  q: T,
  f: SubmissionListFilters,
): T {
  let next = q;
  if (f.status !== "all") next = next.eq("status", f.status);
  if (f.garmentType !== "all") next = next.eq("garment_type", f.garmentType);
  const term = sanitizeSearch(f.search);
  if (term) next = next.or(`title.ilike.%${term}%,brand.ilike.%${term}%`);
  // SUB-08: the seller's local calendar days, matching the dates the rows show.
  const range = localDayRangeIso(f.dateFrom, f.dateTo);
  if (range.gte) next = next.gte("created_at", range.gte);
  if (range.lt) next = next.lt("created_at", range.lt);
  return next;
}
