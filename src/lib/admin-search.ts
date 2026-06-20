// US-901: shared types + helpers for the global admin search / command palette.
// Kept free of React so the grouping/flattening logic stays unit-testable.

export type AdminSearchResultType =
  | "user"
  | "submission"
  | "certificate"
  | "listing"
  | "sale"
  | "ticket"
  // US-910: client-side bundled operational runbooks (not a server result type).
  | "runbook";

export interface AdminSearchResult {
  type: AdminSearchResultType;
  id: string;
  title: string;
  subtitle: string;
  /** Admin deep link to route to on select. */
  href: string;
  /** Which field matched, for display. */
  matched_on: string;
}

export interface AdminSearchGroups {
  users: AdminSearchResult[];
  submissions: AdminSearchResult[];
  certificates: AdminSearchResult[];
  listings: AdminSearchResult[];
  sales: AdminSearchResult[];
  tickets: AdminSearchResult[];
  // US-910: operational runbooks, matched client-side from the bundled set.
  runbooks: AdminSearchResult[];
}

export interface AdminSearchResponse {
  query: string;
  total: number;
  results: AdminSearchGroups;
}

// Display order + heading labels for each group. Drives both render order and
// the flat keyboard-navigation list below, so they never drift apart.
export const ADMIN_SEARCH_GROUP_ORDER: Array<{
  key: keyof AdminSearchGroups;
  label: string;
}> = [
  { key: "users", label: "Users" },
  { key: "submissions", label: "Submissions" },
  { key: "certificates", label: "Certificates" },
  { key: "listings", label: "Listings" },
  { key: "sales", label: "Sales" },
  { key: "tickets", label: "Tickets" },
  { key: "runbooks", label: "Runbooks" },
];

const EMPTY_GROUPS: AdminSearchGroups = {
  users: [],
  submissions: [],
  certificates: [],
  listings: [],
  sales: [],
  tickets: [],
  runbooks: [],
};

/**
 * Flatten the grouped results into a single ordered list (matching the group
 * display order) for arrow-key navigation. Empty groups contribute nothing.
 */
export function flattenAdminSearch(
  groups: AdminSearchGroups | null | undefined,
): AdminSearchResult[] {
  if (!groups) return [];
  const out: AdminSearchResult[] = [];
  for (const { key } of ADMIN_SEARCH_GROUP_ORDER) {
    for (const r of groups[key] ?? []) out.push(r);
  }
  return out;
}

/** Total result count across every group. */
export function countAdminSearch(
  groups: AdminSearchGroups | null | undefined,
): number {
  return flattenAdminSearch(groups).length;
}

/** A safe, fully-empty groups object (used as the initial / error state). */
export function emptyAdminSearchGroups(): AdminSearchGroups {
  return { ...EMPTY_GROUPS };
}
