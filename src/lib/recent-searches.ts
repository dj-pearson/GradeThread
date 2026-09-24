import { supabase } from "@/lib/supabase";
import { captureException } from "@/lib/sentry";
import { normalizeScope, type SearchScope } from "@/lib/flipdesk-search";
import type { Database } from "@/types/database";

// US-1053 stored recent search terms behind two RLS-scoped RPCs and called them
// inline from the command palette. US-2517 needs the same terms on the Search
// page, so the calls live here once instead of twice.
//
// Both are best-effort, DELIBERATELY, and reported (US-3381). A seller who
// cannot read their history still gets to search, and a term that fails to
// record is not worth a toast in the middle of typing: there is nothing for
// them to do about either, and neither shows wrong data, only less of it.
//
// What was wrong was the SILENCE. supabase.rpc RESOLVES with { data: null,
// error }, it does not reject, so the try/catch around each call only ever
// fired on a network drop. A dead recent_searches RPC would have looked exactly
// like a seller who has never searched, forever, with nothing counting it.

type Fns = Database["public"]["Functions"];

/** One remembered search, with the tab it ran on (F7). */
export interface RecentSearch {
  query: string;
  scope: SearchScope;
  resultCount: number | null;
  updatedAt: string;
}

export async function fetchRecentSearches(limit = 8): Promise<RecentSearch[]> {
  try {
    const { data, error } = await supabase.rpc("recent_searches", {
      p_limit: limit,
    } as never);
    if (error) {
      captureException(error, {
        tags: { surface: "search" },
        extra: { user_action: "read recent searches" },
      });
      return [];
    }
    // F7: scope and result_count used to be dropped here, so a Sales search
    // came back under whatever tab was open.
    return ((data as Fns["recent_searches"]["Returns"] | null) ?? [])
      .filter((r) => !!r.query)
      .map((r) => ({
        query: r.query,
        scope: normalizeScope(r.scope),
        resultCount: r.result_count ?? null,
        updatedAt: r.updated_at,
      }));
  } catch (err) {
    captureException(err, {
      tags: { surface: "search" },
      extra: { user_action: "read recent searches" },
    });
    return [];
  }
}

/**
 * Best effort; the promise never rejects. Terms shorter than two characters
 * are not worth keeping.
 */
export async function recordSearch(
  term: string,
  opts: { scope?: string; resultCount?: number | null } = {},
): Promise<void> {
  const t = term.trim();
  if (t.length < 2) return;
  try {
    const { error } = await supabase.rpc("record_search", {
      p_query: t,
      p_scope: opts.scope ?? "all",
      p_result_count: opts.resultCount ?? null,
    } as never);
    if (error) {
      captureException(error, {
        tags: { surface: "search" },
        extra: { user_action: "record search term" },
      });
    }
  } catch (err) {
    // The user still got their search; only the suggestion is lost.
    captureException(err, {
      tags: { surface: "search" },
      extra: { user_action: "record search term" },
    });
  }
}

// F7: terms often hold buyer names, and the owner DELETE policy on
// search_history (00248) has always allowed removing them. These two are the
// first callers. user_id is passed explicitly as well as enforced by RLS, so a
// DELETE never goes out without a WHERE clause.

/** Forget one term. Matches the table's own lower(btrim(query)) key. */
export async function removeRecentSearch(userId: string, query: string): Promise<void> {
  const { error } = await supabase
    .from("search_history")
    .delete()
    .eq("user_id", userId)
    .eq("query_normalized", query.trim().toLowerCase());
  if (error) throw error;
}

/** Forget every term for this user. */
export async function clearRecentSearches(userId: string): Promise<void> {
  const { error } = await supabase
    .from("search_history")
    .delete()
    .eq("user_id", userId);
  if (error) throw error;
}
