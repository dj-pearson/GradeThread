import { supabase } from "@/lib/supabase";
import { captureException } from "@/lib/sentry";

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

type RpcFn<Args, Data> = (
  fn: string,
  args: Args,
) => Promise<{ data: Data; error: Error | null }>;

export async function fetchRecentSearches(limit = 8): Promise<string[]> {
  try {
    const { data, error } = await (
      supabase.rpc as unknown as RpcFn<
        { p_limit: number },
        { query: string }[] | null
      >
    )("recent_searches", { p_limit: limit });
    if (error) {
      captureException(error, {
        tags: { surface: "search" },
        extra: { user_action: "read recent searches" },
      });
      return [];
    }
    return (data ?? []).map((r) => r.query).filter(Boolean);
  } catch (err) {
    captureException(err, {
      tags: { surface: "search" },
      extra: { user_action: "read recent searches" },
    });
    return [];
  }
}

/** Fire-and-forget. Terms shorter than two characters are not worth keeping. */
export function recordSearch(term: string, scope = "all"): void {
  const t = term.trim();
  if (t.length < 2) return;
  void (async () => {
    try {
      const { error } = await (
        supabase.rpc as unknown as RpcFn<
          { p_query: string; p_scope: string },
          null
        >
      )("record_search", { p_query: t, p_scope: scope });
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
  })();
}
