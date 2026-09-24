import { supabase } from "@/lib/supabase";
import type { ItemFullRow } from "@/types/database";

// The Grid's one-page read of items_full (US-404), pulled out of grid.tsx so the
// tenant scope can be tested without rendering the whole spreadsheet.

export const GRID_PAGE_SIZE = 100;

// Only the columns this spreadsheet renders/edits — the items_full view is wide
// (jsonb comps/measurements, per-row photo subqueries) and loading all of it
// per page is wasteful (US-404). Selecting a slim projection lets Postgres
// prune the unused view columns from the plan.
export const GRID_COLUMNS =
  "id,item_number,item_title,brand,style,size,purchase_price,target_price," +
  "sourced_by,notes,status,color,material,location_bin,floor_price,listing_id,listing_platform,listing_status";

// Minimal typed view of the PostgREST builder for the (untyped) items_full
// view — supports the count + scope + search + range chain this page needs.
interface ItemsFullPageBuilder {
  eq: (col: string, val: string) => ItemsFullPageBuilder;
  or: (filter: string) => ItemsFullPageBuilder;
  order: (
    col: string,
    opts?: { ascending?: boolean; nullsFirst?: boolean },
  ) => ItemsFullPageBuilder;
  range: (
    from: number,
    to: number,
  ) => Promise<{
    data: ItemFullRow[] | null;
    error: Error | null;
    count: number | null;
  }>;
}

function itemsFullPage() {
  return (
    supabase.from as unknown as (name: "items_full") => {
      select: (
        cols: string,
        opts: { count: "exact" },
      ) => ItemsFullPageBuilder;
    }
  ).bind(supabase)("items_full");
}

// PostgREST `.or()` is a comma/parenthesis-delimited grammar, so strip the
// characters that would break the filter out of the user's search term.
export function sanitizeSearch(raw: string): string {
  return raw.trim().replace(/[,():*\\%]/g, " ").replace(/\s+/g, " ").trim();
}

export async function fetchGridPage(args: {
  ownerId: string;
  page: number;
  search: string;
  sort: { field: string; dir: "asc" | "desc" };
}): Promise<{ rows: ItemFullRow[]; total: number }> {
  const q = sanitizeSearch(args.search);
  const from = (args.page - 1) * GRID_PAGE_SIZE;
  // INV-1: items_full is security_invoker and its policy admits own rows OR
  // member rows, so without this a user who is in two workspaces sees both
  // tenants mixed together in one grid.
  let builder = itemsFullPage()
    .select(GRID_COLUMNS, { count: "exact" })
    .eq("user_id", args.ownerId);
  if (q) {
    builder = builder.or(
      `item_title.ilike.*${q}*,brand.ilike.*${q}*,` +
        `item_number.ilike.*${q}*,style.ilike.*${q}*`,
    );
  }
  const { data: rows, error, count } = await builder
    // NULLS LAST in BOTH directions, which is what flipdesk_listing_page
    // does for the table and what the client comparator does for the
    // Kanban. Postgres' own default puts NULLs FIRST on a descending sort,
    // so leaving this off would order the same items differently in two
    // views of the same list.
    .order(args.sort.field, {
      ascending: args.sort.dir === "asc",
      nullsFirst: false,
    })
    .range(from, from + GRID_PAGE_SIZE - 1);
  if (error) throw error;
  return { rows: rows ?? [], total: count ?? 0 };
}
