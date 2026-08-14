import { supabase } from "@/lib/supabase";

// US-1053 stored recent search terms behind two RLS-scoped RPCs and called them
// inline from the command palette. US-2517 needs the same terms on the Search
// page, so the calls live here once instead of twice.
//
// Both are best-effort: a seller who cannot read their history still gets to
// search, and a term that fails to record is not worth an error.

type RpcFn<Args, Data> = (
  fn: string,
  args: Args,
) => Promise<{ data: Data; error: Error | null }>;

export async function fetchRecentSearches(limit = 8): Promise<string[]> {
  try {
    const { data } = await (
      supabase.rpc as unknown as RpcFn<
        { p_limit: number },
        { query: string }[] | null
      >
    )("recent_searches", { p_limit: limit });
    return (data ?? []).map((r) => r.query).filter(Boolean);
  } catch {
    return [];
  }
}

/** Fire-and-forget. Terms shorter than two characters are not worth keeping. */
export function recordSearch(term: string, scope = "all"): void {
  const t = term.trim();
  if (t.length < 2) return;
  void (async () => {
    try {
      await (
        supabase.rpc as unknown as RpcFn<
          { p_query: string; p_scope: string },
          null
        >
      )("record_search", { p_query: t, p_scope: scope });
    } catch {
      // ignore — the user still got their search
    }
  })();
}
