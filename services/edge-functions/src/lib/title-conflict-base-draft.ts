// The one listing a duplicate-title check is about — US-2728.
//
// WHY THIS IS ITS OWN MODULE. The query it holds is four lines, and it 500'd
// production for exactly the sellers who had just succeeded at the thing we
// built: a cross-post to Poshmark gave the item a second `listings` row, the
// route's `.maybeSingle()` met two rows, and PostgREST answered PGRST116
// ("Results contain 2 rows"). The composer's duplicate-title panel broke the
// moment cross-listing started working.
//
// Four lines inside a route handler cannot be unit tested — the handler reaches
// for the module-level service-role client, so there is nowhere to stand. That
// is why it went out untested, and it is the whole reason this file exists:
// `db` is a parameter, so the two-row case can be reproduced in a test instead
// of in front of a seller. `lib/pending-delists.ts` extracted a route query for
// a related reason (two callers, one answer); this one has a single caller and
// is extracted purely so the failure is reachable from a test.
//
// TENANCY (US-268): the read is scoped on `user_id` against the resolved owner.
// The service-role client bypasses RLS, so this filter is the only thing
// standing between one seller's composer and another seller's titles.

import { supabaseAdmin } from "./supabase.ts";

/** The base draft the composer edits, and the only row worth comparing from. */
export interface TitleConflictBaseDraft {
  id: string;
  listing_title: string | null;
  platform_category_id: string | null;
}

/**
 * The platform whose row is the base draft.
 *
 * eBay is the right row rather than merely the first. It is what the composer
 * edits, it is the row carrying `platform_category_id`, and the comparison runs
 * within that eBay category. Ordering newest-first WITHOUT pinning the platform
 * would pick the Poshmark row, whose category is null — and the route would
 * then return "no conflicts" forever. That is a silent wrong answer, which is
 * worse than the 500 it would have replaced.
 */
export const BASE_DRAFT_PLATFORM = "ebay";

/**
 * Minimal shape of the query builder, so a test can hand in a fake.
 *
 * The builder itself is `any` on purpose. supabase-js types its chain through
 * generated table generics that a hand-written fake cannot satisfy, and pinning
 * a narrower type here would only be a cast at the call site instead. The
 * SHAPE that matters is asserted by the test, which checks the filters, the
 * ordering and the limit that actually reached the builder.
 */
// deno-lint-ignore no-explicit-any
export type QueryBuilder = any;

export interface BaseDraftDb {
  from(table: string): { select(columns: string): QueryBuilder };
}

/**
 * Load the eBay base draft for one item, or null when there isn't one.
 *
 * Returns `{ row, error }` rather than throwing, because the caller
 * distinguishes three outcomes: a real error (500), no draft yet (an empty
 * conflict list, which is the common case), and a draft to compare against.
 */
export async function loadTitleConflictBaseDraft(
  ownerId: string,
  itemId: string,
  db: BaseDraftDb = supabaseAdmin as unknown as BaseDraftDb,
): Promise<{ row: TitleConflictBaseDraft | null; error: unknown | null }> {
  const { data, error } = await db
    .from("listings")
    .select("id, listing_title, platform_category_id")
    .eq("inventory_item_id", itemId)
    // The tenant filter. Not optional, not inferable from the item id.
    .eq("user_id", ownerId)
    .eq("platform", BASE_DRAFT_PLATFORM)
    .order("created_at", { ascending: false })
    // Belt and braces with the platform filter above. An item should not have
    // two eBay rows, but "should not" is what the original query assumed about
    // listings in general, and that assumption is what broke.
    .limit(1)
    .maybeSingle();

  if (error) return { row: null, error };
  return { row: (data as TitleConflictBaseDraft | null) ?? null, error: null };
}
